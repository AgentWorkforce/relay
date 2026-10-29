//! Writes the Swift contract types generated from the Rust registry
//! (`relay::contract`). Run through `crates/probe/scripts/generate-contract.sh`.
//!
//! - no arguments: writes this crate's checked-in `contract/CoreContract.swift`,
//!   which CI checks for drift;
//! - `--out FILE`: writes FILE;
//! - `--app-root DIR` (or a bare `DIR`, the old form): writes the macOS app's
//!   copy, `DIR/macos/Sources/RelayDesktopCore/CoreContract.swift`.

use agent_relay_probe::relay::contract::codegen::{Contract, CONTRACT_PATH, SWIFT_PATH};
use std::path::PathBuf;

fn target() -> Result<PathBuf, String> {
    let mut args = std::env::args_os().skip(1);
    let Some(first) = args.next() else {
        return Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(CONTRACT_PATH));
    };
    let target = match first.to_str() {
        Some("--out") => PathBuf::from(args.next().ok_or("--out needs a file")?),
        Some("--app-root") => PathBuf::from(args.next().ok_or("--app-root needs a directory")?)
            .join(SWIFT_PATH),
        Some(flag) if flag.starts_with('-') => return Err(format!("unknown option {flag}")),
        _ => PathBuf::from(first).join(SWIFT_PATH),
    };
    match args.next() {
        Some(extra) => Err(format!("unexpected argument {}", extra.to_string_lossy())),
        None => Ok(target),
    }
}

fn main() -> std::io::Result<()> {
    let path = target().unwrap_or_else(|error| {
        eprintln!("relay-contract-codegen: {error}");
        std::process::exit(2);
    });
    std::fs::write(&path, Contract::collect().swift())?;
    println!("wrote {}", path.display());
    Ok(())
}
