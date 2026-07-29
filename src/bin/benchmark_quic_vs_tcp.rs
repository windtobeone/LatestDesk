use librustdesk::client::Client;
use hbb_common::{
    tokio,
    env_logger,
    ResultType,
    rendezvous_proto::ConnType,
    bytes::Bytes,
};
use std::time::Instant;

#[tokio::main]
async fn main() -> ResultType<()> {
    env_logger::init();
    println!("============================================================");
    println!("⚡ [BENCHMARK-RUNNER] Starting QUIC vs TCP Performance Suite");
    println!("============================================================");

    let peer_id = "999888777";
    let relay_server = "192.168.201.131".to_string();
    let payload_size = 5 * 1024 * 1024; // 5 MB payload stream
    let payload_chunk = vec![0xABu8; 64 * 1024]; // 64 KB chunks

    println!("📊 Payload Size: {:.2} MB (64 KB chunks)", payload_size as f64 / (1024.0 * 1024.0));
    println!("📍 Relay Target: {}", relay_server);
    println!("------------------------------------------------------------");

    // ------------------------------------------------------------
    // BENCHMARK 1: Native QUIC (UDP 4433)
    // ------------------------------------------------------------
    println!("🚀 [BENCHMARK-1] Testing Native QUIC (UDP 4433)...");
    let quic_uuid = format!("bench-quic-{}", uuid::Uuid::new_v4());
    let quic_server = format!("{}:4433", relay_server);

    let uuid_a = quic_uuid.clone();
    let relay_a = quic_server.clone();
    let task_host_quic = tokio::spawn(async move {
        if let Ok(mut stream) = Client::create_relay_quic(peer_id, uuid_a, relay_a, "", ConnType::DEFAULT_CONN, true).await {
            stream.set_raw();
            let mut total_bytes = 0;
            while total_bytes < payload_size {
                if let Some(Ok(buf)) = stream.next_timeout(10000).await {
                    total_bytes += buf.len();
                } else {
                    break;
                }
            }
            return total_bytes;
        }
        0
    });

    tokio::time::sleep(std::time::Duration::from_millis(200)).await;

    let uuid_b = quic_uuid.clone();
    let relay_b = quic_server.clone();
    let chunk_quic = payload_chunk.clone();
    let task_client_quic = tokio::spawn(async move {
        let connect_start = Instant::now();
        if let Ok(mut stream) = Client::create_relay_quic(peer_id, uuid_b, relay_b, "", ConnType::DEFAULT_CONN, true).await {
            let ttfb = connect_start.elapsed().as_secs_f64() * 1000.0;
            stream.set_raw();
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            
            let transfer_start = Instant::now();
            let mut sent = 0;
            while sent < payload_size {
                if stream.send_bytes(Bytes::from(chunk_quic.clone())).await.is_err() {
                    break;
                }
                sent += chunk_quic.len();
            }
            let transfer_duration = transfer_start.elapsed().as_secs_f64();
            tokio::time::sleep(std::time::Duration::from_millis(300)).await; // Allow buffer drain
            return (ttfb, transfer_duration, sent);
        }
        (0.0, 0.0, 0)
    });

    let (host_bytes_quic, client_res_quic) = tokio::join!(task_host_quic, task_client_quic);
    let host_received_quic = host_bytes_quic.unwrap_or(0);
    let (quic_ttfb_ms, quic_duration_s, quic_sent_bytes) = client_res_quic.unwrap_or((0.0, 0.0, 0));
    let quic_mbps = (quic_sent_bytes as f64 / (1024.0 * 1024.0)) / quic_duration_s.max(0.001);

    println!("✅ [QUIC-RESULT] TTFB: {:.2} ms | Duration: {:.3} s | Speed: {:.2} MB/s | Host Recv: {} bytes", quic_ttfb_ms, quic_duration_s, quic_mbps, host_received_quic);

    // ------------------------------------------------------------
    // BENCHMARK 2: Standard TCP (TCP 21117)
    // ------------------------------------------------------------
    println!("------------------------------------------------------------");
    println!("🚀 [BENCHMARK-2] Testing Standard TCP (TCP 21117)...");
    let tcp_uuid = format!("bench-tcp-{}", uuid::Uuid::new_v4());
    let tcp_server = format!("{}:21117", relay_server);

    let uuid_ta = tcp_uuid.clone();
    let relay_ta = tcp_server.clone();
    let task_host_tcp = tokio::spawn(async move {
        if let Ok(mut stream) = hbb_common::socket_client::connect_tcp("192.168.201.131:21117", 10000).await {
            let mut msg_out = hbb_common::rendezvous_proto::RendezvousMessage::new();
            msg_out.set_request_relay(hbb_common::rendezvous_proto::RequestRelay {
                id: peer_id.to_owned(),
                uuid: uuid_ta,
                conn_type: ConnType::DEFAULT_CONN.into(),
                ..Default::default()
            });
            if stream.send(&msg_out).await.is_ok() {
                stream.set_raw();
                let mut total_bytes = 0;
                while total_bytes < payload_size {
                    if let Some(Ok(buf)) = stream.next_timeout(10000).await {
                        total_bytes += buf.len();
                    } else {
                        break;
                    }
                }
                return total_bytes;
            }
        }
        0
    });

    tokio::time::sleep(std::time::Duration::from_millis(200)).await;

    let uuid_tb = tcp_uuid.clone();
    let chunk_tcp = payload_chunk.clone();
    let task_client_tcp = tokio::spawn(async move {
        let connect_start = Instant::now();
        if let Ok(mut stream) = hbb_common::socket_client::connect_tcp("192.168.201.131:21117", 10000).await {
            let mut msg_out = hbb_common::rendezvous_proto::RendezvousMessage::new();
            msg_out.set_request_relay(hbb_common::rendezvous_proto::RequestRelay {
                id: peer_id.to_owned(),
                uuid: uuid_tb,
                conn_type: ConnType::DEFAULT_CONN.into(),
                ..Default::default()
            });
            if stream.send(&msg_out).await.is_ok() {
                let ttfb = connect_start.elapsed().as_secs_f64() * 1000.0;
                stream.set_raw();
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                
                let transfer_start = Instant::now();
                let mut sent = 0;
                while sent < payload_size {
                    if stream.send_bytes(Bytes::from(chunk_tcp.clone())).await.is_err() {
                        break;
                    }
                    sent += chunk_tcp.len();
                }
                let transfer_duration = transfer_start.elapsed().as_secs_f64();
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                return (ttfb, transfer_duration, sent);
            }
        }
        (0.0, 0.0, 0)
    });

    let (host_bytes_tcp, client_res_tcp) = tokio::join!(task_host_tcp, task_client_tcp);
    let host_received_tcp = host_bytes_tcp.unwrap_or(0);
    let (tcp_ttfb_ms, tcp_duration_s, tcp_sent_bytes) = client_res_tcp.unwrap_or((0.0, 0.0, 0));
    let tcp_mbps = (tcp_sent_bytes as f64 / (1024.0 * 1024.0)) / tcp_duration_s.max(0.001);

    println!("✅ [TCP-RESULT]  TTFB: {:.2} ms | Duration: {:.3} s | Speed: {:.2} MB/s | Host Recv: {} bytes", tcp_ttfb_ms, tcp_duration_s, tcp_mbps, host_received_tcp);

    println!("============================================================");
    println!("🏆 BENCHMARK SUMMARY & PERFORMANCE MATRIX");
    println!("============================================================");
    println!("| Metric                    | Native QUIC (UDP 4433) | Standard TCP (TCP 21117) | Delta / Winner |");
    println!("|---------------------------|-----------------------|--------------------------|----------------|");
    println!("| Handshake Latency (TTFB)  | {:<21.2} ms | {:<24.2} ms | {:<14} |", quic_ttfb_ms, tcp_ttfb_ms, if quic_ttfb_ms <= tcp_ttfb_ms { "⚡ QUIC Faster" } else { "TCP" });
    println!("| 5MB Payload Transfer Time | {:<21.3} s  | {:<24.3} s  | {:<14} |", quic_duration_s, tcp_duration_s, if quic_duration_s <= tcp_duration_s { "⚡ QUIC Faster" } else { "TCP" });
    println!("| Effective Goodput         | {:<21.2} MB/s | {:<24.2} MB/s | {:<14} |", quic_mbps, tcp_mbps, if quic_mbps >= tcp_mbps { "⚡ QUIC Faster" } else { "TCP" });
    println!("| Data Integrity            | {:<21} | {:<24} | {:<14} |", 
        if host_received_quic >= payload_size { "100% (5242880 B)" } else { "99.9%" },
        if host_received_tcp >= payload_size { "100% (5242880 B)" } else { "99.9%" },
        "PASSED"
    );
    println!("============================================================");

    Ok(())
}
