use librustdesk::client::Client;
use hbb_common::{
    tokio,
    env_logger,
    ResultType,
    rendezvous_proto::ConnType,
};

#[tokio::main]
async fn main() -> ResultType<()> {
    env_logger::init();
    println!("============================================================");
    println!("🧪 [TEST-RUNNER] Starting Native QUIC Relay Connection Test...");
    println!("============================================================");

    let peer = "123456789";
    let uuid = uuid::Uuid::new_v4().to_string();
    let relay_server = "192.168.201.131:4433".to_string();
    let key = "";
    
    println!("🚀 [TEST-RUNNER] Target QUIC Relay Server: {}", relay_server);
    match Client::create_relay_quic(peer, uuid, relay_server, key, ConnType::DEFAULT_CONN, true).await {
        Ok(mut stream) => {
            println!("✅ [TEST-SUCCESS] Successfully established Native QUIC connection!");
            println!("📍 [TEST-SUCCESS] Local Socket Address: {}", stream.local_addr());
            println!("🎉 [TEST-SUCCESS] RequestRelay packet sent over Quinn QUIC stream.");
        }
        Err(e) => {
            println!("❌ [TEST-FAILED] Native QUIC Relay connection failed: {:?}", e);
        }
    }

    println!("============================================================");
    Ok(())
}
