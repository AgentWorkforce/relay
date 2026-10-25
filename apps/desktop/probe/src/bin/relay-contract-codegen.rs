//! Writes the Swift contract types generated from the Rust registry
//! (`relay::contract`). Run through `scripts/generate-contract.sh`.

use agent_relay_probe::relay::contract::codegen::{Contract, SWIFT_PATH};
use std::path::PathBuf;

fn main() -> std::io::Result<()> {
    let root = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".."));
    std::fs::write(root.join(SWIFT_PATH), Contract::collect().swift())?;
    println!("wrote {SWIFT_PATH}");
    Ok(())
}
