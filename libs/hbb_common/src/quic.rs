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
    key: Option<sodiumoxide::crypto::secretbox::Key>,
    raw: bool,
    send_timeout_ms: u64,
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
        transport.keep_alive_interval(Some(Duration::from_secs(10)));
        if let Ok(idle) = IdleTimeout::try_from(Duration::from_secs(30)) {
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
        })
    }

    pub fn set_send_timeout(&mut self, ms: u64) {
        self.send_timeout_ms = ms;
    }

    pub fn set_raw(&mut self) {
        self.raw = true;
    }

    pub fn set_key(&mut self, key: sodiumoxide::crypto::secretbox::Key) {
        self.key = Some(key);
    }

    pub fn is_secured(&self) -> bool {
        self.key.is_some()
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.conn.local_ip().map(|ip| SocketAddr::new(ip, 0)).unwrap_or(self.addr)
    }

    pub async fn send_bytes(&mut self, bytes: Bytes) -> ResultType<()> {
        if self.raw {
            tokio::time::timeout(
                Duration::from_millis(self.send_timeout_ms),
                self.send.write_all(&bytes)
            ).await.map_err(|_| anyhow::anyhow!("QUIC send timeout"))??;
        } else {
            let mut frame = BytesMut::with_capacity(4 + bytes.len());
            frame.put_u32_le(bytes.len() as u32);
            frame.extend_from_slice(&bytes);
            
            tokio::time::timeout(
                Duration::from_millis(self.send_timeout_ms),
                self.send.write_all(&frame)
            ).await.map_err(|_| anyhow::anyhow!("QUIC send timeout"))??;
        }
        Ok(())
    }

    pub async fn send_raw(&mut self, bytes: Vec<u8>) -> ResultType<()> {
        tokio::time::timeout(
            Duration::from_millis(self.send_timeout_ms),
            self.send.write_all(&bytes)
        ).await.map_err(|_| anyhow::anyhow!("QUIC send raw timeout"))??;
        
        Ok(())
    }

    pub async fn next(&mut self) -> Option<Result<BytesMut, std::io::Error>> {
        if self.raw {
            let mut buf = vec![0u8; 65536];
            match self.recv.read(&mut buf).await {
                Ok(Some(n)) => Some(Ok(BytesMut::from(&buf[..n]))),
                Ok(None) => None,
                Err(e) => Some(Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, e))),
            }
        } else {
            let mut len_buf = [0u8; 4];
            match self.recv.read_exact(&mut len_buf).await {
                Ok(()) => {
                    let len = u32::from_le_bytes(len_buf) as usize;
                    let mut data_buf = vec![0u8; len];
                    match self.recv.read_exact(&mut data_buf).await {
                        Ok(()) => Some(Ok(BytesMut::from(&data_buf[..]))),
                        Err(e) => Some(Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, e))),
                    }
                }
                Err(e) => Some(Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, e))),
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
