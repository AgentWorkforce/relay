#[tokio::main]
async fn main() -> anyhow::Result<()> {
    agent_relay_probe::run().await
}
