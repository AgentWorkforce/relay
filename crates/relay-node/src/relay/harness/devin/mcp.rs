//! Devin's ACP permission correlation over the shared pinned send transport.
use super::super::relay_mcp;
use serde_json::Value;
use std::path::Path;
// Only the Unix ACP host (`host`) correlates permissions.
#[cfg_attr(windows, allow(dead_code))]
mod permissions;
#[cfg_attr(windows, allow(unused_imports))]
pub(super) use permissions::Gate;
#[cfg_attr(windows, allow(unused_imports))]
use relay_mcp::{valid_arguments, TOOL};

#[cfg_attr(windows, allow(dead_code))] // Only the Unix ACP host asks for it.
pub(super) fn definition(helper: &Path, alias: &str, development: bool) -> Value {
    relay_mcp::definition(helper, alias, development, relay_mcp::Harness::Devin)
}
pub fn run(development: bool) -> anyhow::Result<()> {
    relay_mcp::run(development)
}
