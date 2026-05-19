use anyhow::Result;

#[tokio::main]
async fn main() -> Result<()> {
    relay_broker::run_cli().await
}
