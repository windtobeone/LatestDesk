use hbb_common::{
    anyhow,
    bytes::{Bytes, BytesMut},
    bytes_codec::BytesCodec,
    config, log,
    tcp::{DynTcpStream, FramedStream},
    tokio::{self, net::UdpSocket, sync::mpsc, sync::oneshot},
    tokio_util, ResultType, Stream,
};
use kcp_sys::{
    endpoint::KcpEndpoint,
    ffi_safe::KcpConfig,
    packet_def::{KcpPacket, KcpPacketHeader},
    stream,
};
use std::{net::SocketAddr, sync::Arc, time::{Duration, Instant}};

pub static BASE_RTT_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(200);

#[repr(C, packed)]
#[derive(Debug, Clone, Copy)]
pub struct UdpSessionHeader {
    pub session_id: u64,
    pub packet_type: u8,
    pub channel_id: u8,
    pub direction: u8,
    pub reserved: u8,
    pub mac: u32,
}

fn derive_session_key(master_key: &str, session_id: u64) -> sodiumoxide::crypto::generichash::Digest {
    use sodiumoxide::crypto::generichash;
    let mut state = generichash::State::new(Some(32), None).unwrap();
    let _ = state.update(master_key.as_bytes());
    let _ = state.update(&session_id.to_le_bytes());
    state.finalize().unwrap()
}

fn calculate_mac(
    session_key: &sodiumoxide::crypto::generichash::Digest,
    header: &UdpSessionHeader,
    payload: &[u8],
) -> u32 {
    use sodiumoxide::crypto::generichash;
    let mut state = generichash::State::new(Some(32), Some(session_key.as_ref())).unwrap();
    
    // Hash the first 12 bytes of the header (excluding the mac field at offset 12)
    let header_bytes = unsafe {
        let ptr = header as *const UdpSessionHeader as *const u8;
        std::slice::from_raw_parts(ptr, 12)
    };
    let _ = state.update(header_bytes);
    
    if header.channel_id == 1 {
        let _ = state.update(payload);
    } else {
        let crc = crc32fast::hash(payload);
        let _ = state.update(&crc.to_le_bytes());
    }
    let digest = state.finalize().unwrap();
    
    let mut mac_bytes = [0u8; 4];
    mac_bytes.copy_from_slice(&digest.as_ref()[..4]);
    u32::from_le_bytes(mac_bytes)
}

pub struct PmtuDetector {
    socket: Arc<UdpSocket>,
    session_id: u64,
    master_key: String,
    base_rtt: Duration,
    direction: u8,
}

impl PmtuDetector {
    pub fn new(socket: Arc<UdpSocket>, session_id: u64, master_key: String, base_rtt: Duration, direction: u8) -> Self {
        Self { socket, session_id, master_key, base_rtt, direction }
    }

    pub async fn detect_pmtu(&self, target_addr: std::net::SocketAddr) -> usize {
        let probe_sizes = [1280, 1300, 1350, 1400];
        let mut max_stable_mtu = 1280; // Safety fallback
        let session_key = derive_session_key(&self.master_key, self.session_id);

        // 1. Send concurrent probes (2 rounds to mitigate WAN packet loss)
        for _ in 0..2 {
            for &size in &probe_sizes {
                let mut payload = vec![0u8; size];
                let mut header = UdpSessionHeader {
                    session_id: self.session_id.to_le(),
                    packet_type: 9, // PMTU Probe
                    channel_id: 0,
                    direction: self.direction,
                    reserved: 0,
                    mac: 0,
                };
                let mac = calculate_mac(&session_key, &header, &payload[16..]);
                header.mac = mac;
                unsafe {
                    std::ptr::write_unaligned(payload.as_mut_ptr() as *mut UdpSessionHeader, header);
                }
                let _ = self.socket.send_to(&payload, target_addr).await;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        // 2. Await Echo responses with adaptive timeout (max(300ms, base_rtt * 3))
        let mut buf = [0u8; 1500];
        let start = Instant::now();
        let timeout_dur = std::cmp::max(Duration::from_millis(300), self.base_rtt * 3);

        while start.elapsed() < timeout_dur {
            if let Ok(Ok((len, _))) = tokio::time::timeout(
                Duration::from_millis(10),
                self.socket.recv_from(&mut buf),
            ).await {
                if len >= 16 {
                    // Safe offset-based reading to prevent UB on ARM/MIPS
                    let header = unsafe { std::ptr::read_unaligned(buf.as_ptr() as *const UdpSessionHeader) };

                    if u64::from_le(header.session_id) == self.session_id && header.packet_type == 9 {
                        // Verify MAC
                        let expected_mac = calculate_mac(&session_key, &header, &buf[16..len]);
                        if header.mac == expected_mac && len > max_stable_mtu {
                            max_stable_mtu = len;
                            if max_stable_mtu == 1400 {
                                // Reached optimal MTU, can early exit
                                break;
                            }
                        }
                    }
                }
            }
        }
        
        log::info!("[PMTUD] Dynamic PMTU negotiation completed. Selected MTU: {} bytes", max_stable_mtu);
        max_stable_mtu
    }
}

pub struct KcpStreamWithEndpoint {
    pub(crate) stream: stream::KcpStream,
    pub(crate) _endpoint: KcpEndpoint,
    pub(crate) stop_sender: Option<oneshot::Sender<()>>,
}

impl tokio::io::AsyncRead for KcpStreamWithEndpoint {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.stream).poll_read(cx, buf)
    }
}

impl tokio::io::AsyncWrite for KcpStreamWithEndpoint {
    fn poll_write(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        std::pin::Pin::new(&mut self.stream).poll_write(cx, buf)
    }

    fn poll_flush(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.stream).poll_flush(cx)
    }

    fn poll_shutdown(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.stream).poll_shutdown(cx)
    }
}

impl Drop for KcpStreamWithEndpoint {
    fn drop(&mut self) {
        if let Some(sender) = self.stop_sender.take() {
            let _ = sender.send(());
        }
    }
}

pub struct KcpStream {
    _endpoint: Option<KcpEndpoint>,
    stop_sender: Option<oneshot::Sender<()>>,
}

impl KcpStream {
    fn create_framed(
        stream: stream::KcpStream,
        endpoint: KcpEndpoint,
        stop_sender: Option<oneshot::Sender<()>>,
        local_addr: Option<SocketAddr>,
    ) -> Stream {
        let stream_with_endpoint = KcpStreamWithEndpoint {
            stream,
            _endpoint: endpoint,
            stop_sender,
        };
        Stream::Tcp(FramedStream(
            tokio_util::codec::Framed::new(DynTcpStream(Box::new(stream_with_endpoint)), BytesCodec::new()),
            local_addr.unwrap_or(config::Config::get_any_listen_addr(true)),
            None,
            0,
        ))
    }

    pub async fn accept(
        udp_socket: Arc<UdpSocket>,
        timeout: std::time::Duration,
        init_packet: Option<BytesMut>,
        session_id: Option<u64>,
        master_key: Option<String>,
        channel_id: u8,
        direction: u8,
    ) -> ResultType<(Self, Stream)> {
        #[cfg(target_os = "windows")]
        if let Err(e) = disable_connection_reset(&udp_socket) {
            log::warn!("Failed to disable SIO_UDP_CONNRESET on accept: {:?}", e);
        }

        let mut endpoint = KcpEndpoint::new();
        endpoint.run().await;

        let (input, output) = (
            endpoint.input_sender(),
            endpoint
                .output_receiver()
                .ok_or_else(|| anyhow::anyhow!("Failed to get output receiver"))?,
        );
        let (stop_sender, stop_receiver) = oneshot::channel();
        if let Some(packet) = init_packet {
            if packet.len() >= std::mem::size_of::<KcpPacketHeader>() {
                input.send(packet.into()).await?;
            }
        }
        Self::kcp_io(udp_socket.clone(), input, output, stop_receiver, session_id, master_key, channel_id, direction).await;

        let conn_id = tokio::time::timeout(timeout, endpoint.accept()).await??;
        if let Some(stream) = stream::KcpStream::new(&endpoint, conn_id) {
            Ok((
                Self {
                    _endpoint: None,
                    stop_sender: None,
                },
                Self::create_framed(stream, endpoint, Some(stop_sender), udp_socket.local_addr().ok()),
            ))
        } else {
            Err(anyhow::anyhow!("Failed to create KcpStream"))
        }
    }

    pub async fn connect(
        udp_socket: Arc<UdpSocket>,
        timeout: std::time::Duration,
        session_id: Option<u64>,
        master_key: Option<String>,
        channel_id: u8,
        direction: u8,
    ) -> ResultType<(Self, Stream)> {
        #[cfg(target_os = "windows")]
        if let Err(e) = disable_connection_reset(&udp_socket) {
            log::warn!("Failed to disable SIO_UDP_CONNRESET on connect: {:?}", e);
        }

        let mut endpoint = KcpEndpoint::new();

        let mut negotiated_mtu = 1400;
        if let Some(sid) = session_id {
            if let Ok(target_addr) = udp_socket.peer_addr() {
                let base_rtt = Duration::from_millis(
                    BASE_RTT_MS.load(std::sync::atomic::Ordering::Relaxed)
                );
                let detector = PmtuDetector::new(
                    udp_socket.clone(),
                    sid,
                    master_key.clone().unwrap_or_default(),
                    base_rtt,
                    direction,
                );
                negotiated_mtu = detector.detect_pmtu(target_addr).await;
            }
        }

        endpoint.set_kcp_config_factory(Box::new(move |conv| {
            KcpConfig {
                conv,
                mtu: Some(negotiated_mtu as i32),
                sndwnd: Some(1024), // 刚性拓宽发送窗口，防止吞吐量天花板
                rcvwnd: Some(1024), // 刚性接收窗口，支持高频 4K@60FPS 传输
                nodelay: Some(1),
                interval: Some(10),
                resend: Some(2),
                nc: Some(1),
            }
        }));
        endpoint.run().await;

        let (input, output) = (
            endpoint.input_sender(),
            endpoint
                .output_receiver()
                .ok_or_else(|| anyhow::anyhow!("Failed to get output receiver"))?,
        );
        let (stop_sender, stop_receiver) = oneshot::channel();
        Self::kcp_io(udp_socket.clone(), input, output, stop_receiver, session_id, master_key, channel_id, direction).await;

        let conn_id = endpoint.connect(timeout, 0, 0, Bytes::new()).await?;
        log::debug!("KCP endpoint connected successfully, conn_id={:?}", conn_id);
        if let Some(stream) = stream::KcpStream::new(&endpoint, conn_id) {
            Ok((
                Self {
                    _endpoint: None,
                    stop_sender: None,
                },
                Self::create_framed(stream, endpoint, Some(stop_sender), udp_socket.local_addr().ok()),
            ))
        } else {
            Err(anyhow::anyhow!("Failed to create KcpStream"))
        }
    }

    async fn kcp_io(
        udp_socket: Arc<UdpSocket>,
        input: mpsc::Sender<KcpPacket>,
        mut output: mpsc::Receiver<KcpPacket>,
        mut stop_receiver: oneshot::Receiver<()>,
        session_id: Option<u64>,
        master_key: Option<String>,
        channel_id: u8,
        direction: u8,
    ) {
        #[cfg(target_os = "windows")]
        if let Err(e) = disable_connection_reset(&udp_socket) {
            log::warn!("Failed to disable SIO_UDP_CONNRESET on kcp_io: {:?}", e);
        }

        let udp = udp_socket.clone();
        tokio::spawn(async move {
            let mut buf = vec![0; 65536];
            loop {
                tokio::select! {
                    _ = &mut stop_receiver => {
                        log::debug!("KCP io loop received stop signal");
                        break;
                    }
                    Some(data) = output.recv() => {
                        let payload = data.inner();
                        let buf_to_send = if let Some(sid) = session_id {
                            // Calculate MAC
                            let session_key = derive_session_key(&master_key.clone().unwrap_or_default(), sid);
                            let mut header = UdpSessionHeader {
                                session_id: sid.to_le(),
                                packet_type: 2,
                                channel_id,
                                direction,
                                reserved: 0,
                                mac: 0,
                            };
                            let mac = calculate_mac(&session_key, &header, &payload); // packet_type = 2 (Data)
                            header.mac = mac;
                            
                            let mut resp = vec![0u8; 16 + payload.len()];
                            unsafe {
                                std::ptr::write_unaligned(resp.as_mut_ptr() as *mut UdpSessionHeader, header);
                            }
                            resp[16..].copy_from_slice(&payload);
                            resp
                        } else {
                            payload.to_vec()
                        };

                        if let Err(e) = udp.send(&buf_to_send).await {
                            log::debug!("KCP send error: {:?}", e);
                            break;
                        }
                    }
                    result = udp.recv_from(&mut buf) => {
                        match result {
                            Ok((size, _)) => {
                                let payload = if let Some(sid) = session_id {
                                    if size < 16 {
                                        continue;
                                    }
                                    let header = unsafe { std::ptr::read_unaligned(buf.as_ptr() as *const UdpSessionHeader) };
                                    let recv_sid = u64::from_le(header.session_id);
                                    if recv_sid != sid {
                                        continue;
                                    }
                                    
                                    // Verify MAC
                                    let session_key = derive_session_key(&master_key.clone().unwrap_or_default(), sid);
                                    let kcp_payload = &buf[16..size];
                                    let expected_mac = calculate_mac(&session_key, &header, kcp_payload);
                                    let header_mac = header.mac;
                                    let expected_bytes = expected_mac.to_le_bytes();
                                    let header_bytes = header_mac.to_le_bytes();
                                    let mut d = 0;
                                    for i in 0..4 {
                                        d |= std::hint::black_box(expected_bytes[i]) ^ std::hint::black_box(header_bytes[i]);
                                    }
                                    if std::hint::black_box(d) != 0 {
                                        log::warn!("KCP client MAC verification failed! expected={}, got={}", expected_mac, header_mac);
                                        continue;
                                    }
                                    log::debug!(
                                        "KCP client MAC verified successfully! len={}, flag={}, conv={}",
                                        size,
                                        kcp_payload.get(12).copied().unwrap_or_default(),
                                        u32::from_le_bytes(kcp_payload[0..4].try_into().unwrap_or_default())
                                    );
                                    kcp_payload
                                } else {
                                    if size < std::mem::size_of::<KcpPacketHeader>() {
                                        continue;
                                    }
                                    &buf[..size]
                                };

                                if let Err(e) = input.send(BytesMut::from(payload).into()).await {
                                    log::error!("KCP input send error: {:?}", e);
                                }
                            }
                            Err(e) => {
                                use std::io::ErrorKind;
                                match e.kind() {
                                    ErrorKind::ConnectionRefused
                                    | ErrorKind::ConnectionReset
                                    | ErrorKind::ConnectionAborted => {
                                        continue;
                                    }
                                    _ => {}
                                }
                                log::debug!("KCP recv_from error: {:?}", e);
                                break;
                            }
                        }
                    }
                    else => {
                        log::debug!("KCP endpoint input closed");
                        break;
                    }
                }
            }
        });
    }
}

impl Drop for KcpStream {
    fn drop(&mut self) {
        if let Some(sender) = self.stop_sender.take() {
            let _ = sender.send(());
        }
    }
}

#[cfg(target_os = "windows")]
fn disable_connection_reset(socket: &tokio::net::UdpSocket) -> std::io::Result<()> {
    use std::os::windows::io::AsRawSocket;
    use std::ffi::c_void;

    #[link(name = "ws2_32")]
    extern "system" {
        fn WSAIoctl(
            s: usize,
            dwIoControlCode: u32,
            lpvInBuffer: *const c_void,
            cbInBuffer: u32,
            lpvOutBuffer: *mut c_void,
            cbOutBuffer: u32,
            lpcbBytesReturned: *mut u32,
            lpOverlapped: *mut c_void,
            lpCompletionRoutine: *mut c_void,
        ) -> i32;
    }

    const SIO_UDP_CONNRESET: u32 = 0x9800000C;
    let mut bytes_returned = 0;
    let mut flag = 0u32; // 0 to disable

    let raw_socket = socket.as_raw_socket() as usize;
    let r = unsafe {
        WSAIoctl(
            raw_socket,
            SIO_UDP_CONNRESET,
            &mut flag as *mut _ as *const c_void,
            std::mem::size_of::<u32>() as u32,
            std::ptr::null_mut(),
            0,
            &mut bytes_returned,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };

    if r != 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}
