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
use std::{net::SocketAddr, sync::Arc};

#[repr(C, packed)]
#[derive(Debug, Clone, Copy)]
pub struct UdpSessionHeader {
    pub session_id: u64,
    pub packet_type: u8,
    pub channel_id: u8,
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
    channel_id: u8,
    packet_type: u8,
    payload: &[u8],
) -> u32 {
    use sodiumoxide::crypto::generichash;
    let mut state = generichash::State::new(Some(32), Some(session_key.as_ref())).unwrap();
    let _ = state.update(&[channel_id, packet_type]);
    if channel_id == 1 {
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

pub struct KcpStream {
    _endpoint: KcpEndpoint,
    stop_sender: Option<oneshot::Sender<()>>,
}

impl KcpStream {
    fn create_framed(stream: stream::KcpStream, local_addr: Option<SocketAddr>) -> Stream {
        Stream::Tcp(FramedStream(
            tokio_util::codec::Framed::new(DynTcpStream(Box::new(stream)), BytesCodec::new()),
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
    ) -> ResultType<(Self, Stream)> {
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
        Self::kcp_io(udp_socket.clone(), input, output, stop_receiver, session_id, master_key, channel_id).await;

        let conn_id = tokio::time::timeout(timeout, endpoint.accept()).await??;
        if let Some(stream) = stream::KcpStream::new(&endpoint, conn_id) {
            Ok((
                Self {
                    _endpoint: endpoint,
                    stop_sender: Some(stop_sender),
                },
                Self::create_framed(stream, udp_socket.local_addr().ok()),
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
    ) -> ResultType<(Self, Stream)> {
        let mut endpoint = KcpEndpoint::new();
        endpoint.set_kcp_config_factory(Box::new(|conv| {
            KcpConfig {
                conv,
                mtu: Some(1400),
                sndwnd: Some(128),
                rcvwnd: Some(128),
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
        Self::kcp_io(udp_socket.clone(), input, output, stop_receiver, session_id, master_key, channel_id).await;

        let conn_id = endpoint.connect(timeout, 0, 0, Bytes::new()).await?;
        log::info!("KCP endpoint connected successfully, conn_id={:?}", conn_id);
        if let Some(stream) = stream::KcpStream::new(&endpoint, conn_id) {
            Ok((
                Self {
                    _endpoint: endpoint,
                    stop_sender: Some(stop_sender),
                },
                Self::create_framed(stream, udp_socket.local_addr().ok()),
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
    ) {
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
                            let mac = calculate_mac(&session_key, channel_id, 2, &payload); // packet_type = 2 (Data)
                            
                            let mut resp = vec![0u8; 14 + payload.len()];
                            let header = UdpSessionHeader {
                                session_id: sid.to_le(),
                                packet_type: 2,
                                channel_id,
                                mac,
                            };
                            unsafe {
                                std::ptr::write_unaligned(resp.as_mut_ptr() as *mut UdpSessionHeader, header);
                            }
                            resp[14..].copy_from_slice(&payload);
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
                                    if size < 14 {
                                        continue;
                                    }
                                    let header = unsafe { std::ptr::read_unaligned(buf.as_ptr() as *const UdpSessionHeader) };
                                    let recv_sid = u64::from_le(header.session_id);
                                    if recv_sid != sid {
                                        continue;
                                    }
                                    
                                    // Verify MAC
                                    let session_key = derive_session_key(&master_key.clone().unwrap_or_default(), sid);
                                    let kcp_payload = &buf[14..size];
                                    let expected_mac = calculate_mac(&session_key, header.channel_id, header.packet_type, kcp_payload);
                                    let header_mac = header.mac;
                                    if header_mac != expected_mac {
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
