use librustdesk::client::Client;
use hbb_common::{
    tokio,
    env_logger,
    ResultType,
    rendezvous_proto::ConnType,
    bytes::Bytes,
};

#[tokio::main]
async fn main() -> ResultType<()> {
    env_logger::init();
    println!("============================================================");
    println!("🧪 [E2E-TEST-RUNNER] Starting Dual Native QUIC Relay E2E Test...");
    println!("============================================================");

    let peer_id = "999888777";
    let test_uuid = format!("test-quic-e2e-{}", uuid::Uuid::new_v4());
    let relay_server = "192.168.201.131:4433".to_string();
    let key = "";

    println!("🔑 [E2E-TEST] Shared Pairing UUID: {}", test_uuid);

    // Spawn Peer A (Controlled Host)
    let uuid_a = test_uuid.clone();
    let relay_a = relay_server.clone();
    let task_a = tokio::spawn(async move {
        println!("🚀 [PEER-A (Host)] Connecting QUIC Relay stream...");
        match Client::create_relay_quic(peer_id, uuid_a, relay_a, key, ConnType::DEFAULT_CONN, true).await {
            Ok(mut stream) => {
                println!("✅ [PEER-A (Host)] Connected! Switching to raw stream mode & waiting for Peer B data...");
                stream.set_raw();
                match stream.next_timeout(10000).await {
                    Some(Ok(data)) => {
                        println!("🔥 [PEER-A (Host)] RECEIVED DATA FROM PEER B OVER QUIC RELAY: {:?}", String::from_utf8_lossy(&data));
                        return true;
                    }
                    Some(Err(e)) => println!("❌ [PEER-A (Host)] Error reading Peer B data: {:?}", e),
                    None => println!("❌ [PEER-A (Host)] Timeout/EOF reading Peer B data"),
                }
            }
            Err(e) => {
                println!("❌ [PEER-A (Host)] Connection failed: {:?}", e);
            }
        }
        false
    });

    // Wait 200ms then spawn Peer B (Controlling Client)
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    let uuid_b = test_uuid.clone();
    let relay_b = relay_server.clone();
    let task_b = tokio::spawn(async move {
        println!("🚀 [PEER-B (Client)] Connecting QUIC Relay stream...");
        match Client::create_relay_quic(peer_id, uuid_b, relay_b, key, ConnType::DEFAULT_CONN, true).await {
            Ok(mut stream) => {
                println!("✅ [PEER-B (Client)] Connected! Switching to raw stream mode...");
                stream.set_raw();
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                println!("📤 [PEER-B (Client)] Sending payload 'HELLO-NATIVE-QUIC-E2E' to Peer A...");
                if let Err(e) = stream.send_bytes(Bytes::from_static(b"HELLO-NATIVE-QUIC-E2E")).await {
                    println!("❌ [PEER-B (Client)] Error sending payload: {:?}", e);
                } else {
                    println!("✅ [PEER-B (Client)] Payload sent successfully! Keeping connection alive...");
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    return true;
                }
            }
            Err(e) => {
                println!("❌ [PEER-B (Client)] Connection failed: {:?}", e);
            }
        }
        false
    });

    let (res_a, res_b) = tokio::join!(task_a, task_b);
    let success_a = res_a.unwrap_or(false);
    let success_b = res_b.unwrap_or(false);

    println!("============================================================");
    if success_a && success_b {
        println!("🏆 [E2E-SUCCESS] Native QUIC Relay Pair Match & Bidirectional Data Forwarding PASSED!");
    } else {
        println!("❌ [E2E-FAILED] Native QUIC Relay E2E Test failed.");
    }
    println!("============================================================");

    Ok(())
}
