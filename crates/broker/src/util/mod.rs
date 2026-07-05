pub(crate) mod version;

// ANSI stripping, per-CLI prompt detection, and streaming UTF-8 decoding
// come from the harness-agnostic `relay-pty` crate, alongside the broker's
// own utilities above.
pub(crate) use relay_pty::{ansi, terminal, utf8_stream};
