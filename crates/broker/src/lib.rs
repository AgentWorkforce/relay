// `agent-relay-broker` is a binary-with-thin-lib crate: `main.rs` only calls
// `run_cli`, so every code path the binary exercises is reachable through this
// library. The `#[allow(dead_code)]` annotations below mark modules that
// currently carry unused items (constants, helpers, even whole types) — a
// follow-up cleanup will trim them. They are not a side effect of the
// binary/library split; each annotated module has at least one genuinely
// unused public-facing item that the compiler would otherwise warn about.

pub mod fleet_wire;
pub mod ids;
pub mod protocol;
pub mod snippets;

pub(crate) mod broker;
pub(crate) mod cli;
pub(crate) mod cli_mcp_args;
#[allow(dead_code)]
pub(crate) mod config;
pub(crate) mod control;
#[allow(dead_code)]
pub(crate) mod conversation_log;
#[allow(dead_code)]
pub(crate) mod dedup;
#[allow(dead_code)]
pub(crate) mod events;
pub(crate) mod listen_api;
#[allow(dead_code)]
pub(crate) mod metrics;
pub(crate) mod node_control;
pub(crate) mod obligation;
pub(crate) mod priorities;
pub(crate) mod pty_worker;
#[allow(dead_code)]
pub(crate) mod redact;
#[allow(dead_code)]
pub(crate) mod relaycast;
pub(crate) mod replay_buffer;
// Local-target routing helpers, kept for their unit tests but no longer
// called from production code: the HTTP/sidecar send path (runtime/api.rs)
// no longer resolves local targets and injects directly — it always
// publishes through Relaycast and lets node delivery (runtime/fleet.rs)
// redeliver, even to workers attached to this same broker.
#[allow(dead_code)]
pub(crate) mod routing;
pub(crate) mod runtime;
#[allow(dead_code)]
pub(crate) mod scheduler;
pub(crate) mod spawner;
#[allow(dead_code)]
pub(crate) mod supervisor;
pub(crate) mod swarm;
pub(crate) mod swarm_tui;
#[allow(dead_code)]
pub(crate) mod telemetry;
pub(crate) mod terminal_control;
#[allow(dead_code)]
pub(crate) mod types;
pub(crate) mod util;
pub(crate) mod worker;
pub(crate) mod worker_request;
pub(crate) mod wrap;

// The PTY layer — session management, terminal grid snapshots, and CLI
// readiness detection — lives in the `relay-pty` crate, along with the
// runtime-agnostic session primitives the broker parameterizes with its
// own types (priority queue, injection retry loop, restart supervisor,
// crash classification, Codex session pre-creation). That crate is
// harness-agnostic by design: it understands terminals and agent-CLI
// behavior (prompts, readiness, activity), never relay messaging,
// channels, or delivery semantics. The broker layers its delivery and
// injection logic on top of these primitives, addressed as `crate::pty`,
// `crate::queue`, and so on. (`relay_pty::wait` is used internally by
// `readiness` and has no direct broker callers, so it is not re-exported;
// `relay_pty::supervisor` is adapted through `crate::supervisor`, which
// pins its payload type.)
pub(crate) use relay_pty::{
    codex_session, crash_insights, inject, pty, queue, readiness, snapshot,
};

pub async fn run_cli() -> anyhow::Result<()> {
    cli::run().await
}
