use std::{
    net::SocketAddr,
    sync::Arc,
    time::Duration,
    convert::TryFrom,
};
use bytes::{Bytes, BytesMut, BufMut};
use log::info;
use quinn::{ClientConfig, Endpoint, Connection, SendStream, RecvStream, IdleTimeout};
use rustls::client::{ServerCertVerifier, ServerCertVerified};
use rustls::Certificate;
use tokio::io::AsyncWriteExt;
use crate::ResultType;

struct SkipServerVerification;

impl ServerCertVerifier for SkipServerVerification {
    fn verify_server_cert(
        &self,
        _end_entity: &Certificate,
        _intermediates: &[Certificate],
        _server_name: &rustls::ServerName,
        _scts: &mut dyn Iterator<Item = &[u8]>,
        _ocsp_response: &[u8],
        _now: std::time::SystemTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }
}

#[inline(always)]
pub fn normalize_tls_sni(server_name: &str) -> &str {
    let clean_name = server_name.split(':').next().unwrap_or(server_name);
    let clean_name = clean_name.trim_start_matches("https://").trim_start_matches("http://");

    if clean_name.parse::<std::net::IpAddr>().is_ok() || clean_name.is_empty() {
        "localhost"
    } else {
        clean_name
    }
}

pub struct QuicFramedStream {
    conn: Connection,
    send: SendStream,
    recv: RecvStream,
    addr: SocketAddr,
    key: Option<crate::tcp::Encrypt>,
    raw: bool,
    send_timeout_ms: u64,
    read_buf: BytesMut,
}

impl QuicFramedStream {
    pub async fn connect(
        target: SocketAddr,
        server_name: &str,
        ms_timeout: u64,
    ) -> ResultType<Self> {
        let mut crypto = rustls::ClientConfig::builder()
            .with_safe_defaults()
            .with_custom_certificate_verifier(Arc::new(SkipServerVerification))
            .with_no_client_auth();
        crypto.alpn_protocols = vec![b"rustdesk-quic-v1".to_vec()];

        let mut client_config = ClientConfig::new(Arc::new(crypto));
        let mut transport = quinn::TransportConfig::default();
        transport.keep_alive_interval(Some(Duration::from_secs(1)));
        transport.initial_mtu(1200);
        transport.min_mtu(1200);
        transport.mtu_discovery_config(None);
        if let Ok(idle) = IdleTimeout::try_from(Duration::from_secs(60)) {
            transport.max_idle_timeout(Some(idle));
        }
        client_config.transport_config(Arc::new(transport));

        let bind_addr: SocketAddr = if target.is_ipv6() {
            "[::]:0".parse().unwrap()
        } else {
            "0.0.0.0:0".parse().unwrap()
        };

        let mut endpoint = Endpoint::client(bind_addr)?;
        endpoint.set_default_client_config(client_config);

        let tls_sni = normalize_tls_sni(server_name);
        info!("🚀 [NATIVE-QUIC] Connecting Native QUIC Endpoint to {} (server_name: {}, tls_sni: {})", target, server_name, tls_sni);
        let connecting = endpoint.connect(target, tls_sni)?;
        
        let conn = tokio::time::timeout(
            Duration::from_millis(ms_timeout),
            connecting
        ).await.map_err(|_| anyhow::anyhow!("QUIC connection timeout"))??;

        info!("🎉 [NATIVE-QUIC] QUIC Connection established with {}!", target);
        let (send, recv) = conn.open_bi().await?;

        Ok(Self {
            conn,
            send,
            recv,
            addr: target,
            key: None,
            raw: true,
            send_timeout_ms: 10000,
            read_buf: BytesMut::new(),
        })
    }

    pub fn set_send_timeout(&mut self, ms: u64) {
        self.send_timeout_ms = ms;
    }

    pub fn set_raw(&mut self) {
        self.raw = true;
    }

    pub fn set_key(&mut self, key: sodiumoxide::crypto::secretbox::Key) {
        info!("🔐 [NATIVE-QUIC] Symmetric encryption key registered successfully on QUIC stream! Switching to framed stream mode.");
        self.key = Some(crate::tcp::Encrypt::new(key));
        self.raw = false;
    }

    pub fn is_secured(&self) -> bool {
        self.key.is_some()
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.conn.local_ip().map(|ip| SocketAddr::new(ip, 0)).unwrap_or(self.addr)
    }

    pub async fn send_bytes(&mut self, bytes: Bytes) -> ResultType<()> {
        let is_encrypted = self.key.is_some();
        let bytes_to_send = if let Some(encrypt) = self.key.as_mut() {
            Bytes::from(encrypt.enc(&bytes))
        } else {
            bytes
        };

        if self.raw {
            log::debug!("📤 [NATIVE-QUIC-SEND] Sending raw un-framed packet: len={} B", bytes_to_send.len());
            tokio::time::timeout(
                Duration::from_millis(self.send_timeout_ms),
                self.send.write_all(&bytes_to_send)
            ).await.map_err(|_| anyhow::anyhow!("QUIC send timeout"))??;
            let _ = self.send.flush().await;
        } else {
            let mut codec = crate::bytes_codec::BytesCodec::new();
            let mut frame = BytesMut::new();
            if let Err(e) = codec.encode(bytes_to_send.clone(), &mut frame) {
                return Err(anyhow::anyhow!("QUIC BytesCodec encode error: {:?}", e));
            }
            
            log::debug!(
                "📤 [NATIVE-QUIC-SEND] Sent framed packet: payload_len={} B, total_frame_len={} B, encrypted={}",
                bytes_to_send.len(),
                frame.len(),
                is_encrypted
            );

            tokio::time::timeout(
                Duration::from_millis(self.send_timeout_ms),
                self.send.write_all(&frame)
            ).await.map_err(|_| anyhow::anyhow!("QUIC send timeout"))??;
            let _ = self.send.flush().await;
        }
        Ok(())
    }

    pub async fn send_raw(&mut self, bytes: Vec<u8>) -> ResultType<()> {
        log::debug!("📤 [NATIVE-QUIC-SEND] Sending raw bytes: len={} B", bytes.len());
        tokio::time::timeout(
            Duration::from_millis(self.send_timeout_ms),
            self.send.write_all(&bytes)
        ).await.map_err(|_| anyhow::anyhow!("QUIC send raw timeout"))??;
        let _ = self.send.flush().await;
        
        Ok(())
    }

    pub async fn next(&mut self) -> Option<Result<BytesMut, std::io::Error>> {
        if self.raw {
            if !self.read_buf.is_empty() {
                let mut data = self.read_buf.split_to(self.read_buf.len());
                if let Some(encrypt) = self.key.as_mut() {
                    if let Err(e) = encrypt.dec(&mut data) {
                        log::error!("❌ [NATIVE-QUIC-RECV] QUIC raw decryption failed on {} B! Error: {:?}", data.len(), e);
                        return Some(Err(e));
                    }
                }
                return Some(Ok(data));
            }
            let mut buf = vec![0u8; 65536];
            match self.recv.read(&mut buf).await {
                Ok(Some(n)) => {
                    let mut data = BytesMut::from(&buf[..n]);
                    if let Some(encrypt) = self.key.as_mut() {
                        if let Err(e) = encrypt.dec(&mut data) {
                            log::error!("❌ [NATIVE-QUIC-RECV] QUIC raw decryption failed on {} B! Error: {:?}", n, e);
                            return Some(Err(e));
                        }
                        log::debug!("✅ [NATIVE-QUIC-RECV] QUIC raw payload decrypted: len={} B", data.len());
                    } else {
                        log::debug!("🔍 [NATIVE-QUIC-RECV] Read {} raw unencrypted bytes from QUIC endpoint", data.len());
                    }
                    Some(Ok(data))
                }
                Ok(None) => {
                    log::info!("🔌 [NATIVE-QUIC-RECV] QUIC stream returned EOF");
                    None
                }
                Err(e) => {
                    log::warn!("⚠️ [NATIVE-QUIC-RECV] QUIC stream raw read error: {:?}", e);
                    Some(Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, e)))
                }
            }
        } else {
            let mut codec = crate::bytes_codec::BytesCodec::new();
            loop {
                match codec.decode(&mut self.read_buf) {
                    Ok(Some(mut data)) => {
                        let len = data.len();
                        if let Some(encrypt) = self.key.as_mut() {
                            if let Err(e) = encrypt.dec(&mut data) {
                                log::error!(
                                    "❌ [NATIVE-QUIC-RECV] QUIC framed decryption failed! cipher_len={} B, error: {:?}",
                                    len,
                                    e
                                );
                                return Some(Err(e));
                            }
                            log::debug!(
                                "✅ [NATIVE-QUIC-RECV] QUIC frame decrypted successfully: cipher_len={} B -> plain_len={} B",
                                len,
                                data.len()
                            );
                        } else {
                            log::debug!("🔍 [NATIVE-QUIC-RECV] Read {} framed unencrypted bytes from QUIC endpoint", data.len());
                        }
                        return Some(Ok(data));
                    }
                    Ok(None) => {}
                    Err(e) => {
                        log::error!("❌ [NATIVE-QUIC-RECV] BytesCodec decode error: {:?}", e);
                        return Some(Err(e));
                    }
                }

                let mut tmp = [0u8; 65536];
                match self.recv.read(&mut tmp).await {
                    Ok(Some(n)) => {
                        self.read_buf.extend_from_slice(&tmp[..n]);
                    }
                    Ok(None) => {
                        if self.read_buf.is_empty() {
                            log::info!("🔌 [NATIVE-QUIC-RECV] QUIC stream closed by peer (EOF)");
                            return None;
                        } else {
                            log::warn!(
                                "⚠️ [NATIVE-QUIC-RECV] QUIC stream closed with incomplete frame ({} B remaining in buffer)",
                                self.read_buf.len()
                            );
                            return Some(Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "incomplete frame on EOF")));
                        }
                    }
                    Err(e) => {
                        log::warn!("⚠️ [NATIVE-QUIC-RECV] QUIC stream read error: {:?}", e);
                        return Some(Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, e)));
                    }
                }
            }
        }
    }

    pub async fn next_timeout(&mut self, timeout_ms: u64) -> Option<Result<BytesMut, std::io::Error>> {
        tokio::time::timeout(
            Duration::from_millis(timeout_ms),
            self.next()
        ).await.ok().flatten()
    }
}
