//! Devin Cloud sessions: the remote counterpart of `devin`'s local
//! sessions, which a build's remote session source
//! (`session_sources::RemoteSessions`) lists and delivers into.

/// The `host` a remote catalog row carries in the discovery listing — the
/// app holding the session is Devin's own cloud service, not anything on
/// this machine. It marks the rows the connector's sign-in, not a local
/// process, activates and delivers into.
pub const CLOUD_HOST: &str = "Devin Cloud";

/// Whether `session_id` names a Devin Cloud session: the bare 32-hex id the
/// v3 API reports, or the `devin-`-prefixed form. Local CLI sessions carry
/// names like `real-gallium` — never hex — so this is also the guard that
/// keeps a stopped *local* session off the cloud route.
pub fn is_cloud_session_id(session_id: &str) -> bool {
    let hex = session_id.strip_prefix("devin-").unwrap_or(session_id);
    hex.len() == 32 && hex.bytes().all(|b| b.is_ascii_hexdigit())
}
