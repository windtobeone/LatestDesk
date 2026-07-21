use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use hbb_common::tokio::net::UdpSocket;
use hbb_common::tokio::time::{self, Instant};
use hbb_common::{log, ResultType, anyhow};
use hbb_common::protobuf::Message as _;
use hbb_common::rendezvous_proto::{RendezvousMessage, TestNatRequest, rendezvous_message::Union};
use crate::ui_interface::UI_STATUS;

pub async fn start_prober(rendezvous_server: &str) -> ResultType<()> {
    // 1. Resolve host address
    let rendezvous_addr: SocketAddr = if let Ok(addr) = rendezvous_server.parse() {
        addr
    } else {
        hbb_common::tokio::net::lookup_host(rendezvous_server)
            .await?
            .next()
            .ok_or_else(|| anyhow::anyhow!("Failed to resolve rendezvous host"))?
    };

    // 2. Bind local socket
    let socket = Arc::new(UdpSocket::bind("0.0.0.0:0").await?);
    let mut interval = time::interval(Duration::from_secs(10));
    let mut buf = [0u8; 1024];
    let mut last_recv = Instant::now();
    let mut is_online = false;

    log::info!("[Prober] Outgoing-only UDP prober started, target: '{}'", rendezvous_addr);

    loop {
        hbb_common::tokio::select! {
            _ = interval.tick() => {
                let mut msg = RendezvousMessage::new();
                msg.set_test_nat_request(TestNatRequest {
                    ..Default::default()
                });

                if let Ok(bytes) = msg.write_to_bytes() {
                    let _ = socket.send_to(&bytes, rendezvous_addr).await;
                }

                // If no response is received in 15 seconds, turn the status light red (-1)
                if last_recv.elapsed() > Duration::from_secs(15) && is_online {
                    is_online = false;
                    UI_STATUS.lock().unwrap().status_num = -1;
                    log::warn!("[Prober] Connection lost for target: '{}'", rendezvous_addr);
                }
            }

            res = socket.recv_from(&mut buf) => {
                if let Ok((len, from_addr)) = res {
                    if from_addr == rendezvous_addr {
                        if let Ok(reply) = RendezvousMessage::parse_from_bytes(&buf[..len]) {
                            if let Some(Union::TestNatResponse(_)) = reply.union {
                                last_recv = Instant::now();
                                if !is_online {
                                    is_online = true;
                                    UI_STATUS.lock().unwrap().status_num = 1; // Green status
                                    log::info!("[Prober] Rendezvous server '{}' is ONLINE", rendezvous_addr);
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
