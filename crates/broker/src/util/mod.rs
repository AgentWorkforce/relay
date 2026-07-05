pub(crate) mod version;

// Extracted into the harness-agnostic `relay-pty` crate; re-exported so
// existing `crate::util::ansi` / `crate::util::terminal` /
// `crate::util::utf8_stream` paths keep working unchanged.
pub(crate) use relay_pty::{ansi, terminal, utf8_stream};
