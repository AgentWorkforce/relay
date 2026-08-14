# relay-proof lane — terminal transport fix verification

Branch: `proof/terminal-attach-verify` @ 01f1a9eca (branched from
`rescue/1521-terminal-wip`, which carries the WIP fix from `relay-terminal`).
Machine: sf-mini (separate from the finn-mini lane that authored the fix).

## What is being proved / disproved

Claim: `agent-relay node agent attach --node <node> <agent>` intermittently
fails with `Node <node> has no terminal transport` on long-lived nodes because
`crates/broker/src/terminal_control.rs` never pinged the peer and never
tracked read-idle time, and — even after the earlier `d8fc48958` fix added
ping/read-idle — a write inside the select loop could starve the ping.

Fix under test (`01f1a9eca`): dedicated `run_terminal_writer` task owning the
sink, a two-channel biased select so pings/close jump ahead of bulk output,
and a `WRITE_TIMEOUT` bounding every send so a wedged write marks the
connection dead rather than blocking the watchdog.

## Evidence structure

Primary (mechanistic, at fake tokio clock speed):

- `terminal_control_reconnects_when_peer_goes_silent` — must fire
- `terminal_control_stays_connected_when_peer_is_idle_but_polling` — must not
- `terminal_control_watchdog_survives_a_wedged_writer` — must fire (P1)
- `terminal_control_large_output_does_not_disconnect_a_draining_peer` — must not

All four live in `crates/broker/src/terminal_control.rs` under one
`read_idle_timeout` clock (400–500ms), each paired with its own must-not-fire
control arm.

Secondary (end-to-end, on real cross-node plumbing):

- Positive: fixed broker + `agent-relay node agent attach ... --json`
- Control: shipped 11.6.3 broker at the same command
- Time dimension: reproduce the intermittent failure on a long-lived or
  deliberately blackholed node

## Binaries

- Fixed:   `target/debug/agent-relay-broker` (crate 3.0.0, sha256 e4d64e7b...)
- Shipped: `~/.local/bin/agent-relay-broker` (11.6.3, sha256 f2c8b6d3...)

## Constraints observed

- Do not restart sf-mini, finn-mini, or chief-broker fleet nodes.
- Do not touch sibling worktrees; no `git stash`.
- Any harness or script is committed to `proof/terminal-attach-verify` as it
  is written; do not push to `fix/terminal-transport-*` or `main`.
