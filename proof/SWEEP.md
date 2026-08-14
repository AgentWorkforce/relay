# Chunk-count sweep — draining-peer regression evidence

The fix under test (`01f1a9eca`) fails its own control-arm test
`terminal_control_large_output_does_not_disconnect_a_draining_peer` at
`crates/broker/src/terminal_control.rs:978`. The test sends 128 chunks of
100 bytes to a peer that IS actively draining and expects the client not to
disconnect. Observed: server receives 0 of 12,800 bytes and
"Connection reset without closing handshake".

## Sweep

Reproduced by varying `WEDGE_CHUNK_COUNT` at
`crates/broker/src/terminal_control.rs:885` (the constant shared with the
wedged-writer test) and running only the draining test with
`--test-threads=1 --nocapture`. Each row is a fresh cargo test invocation on
`proof/terminal-attach-verify @ 01f1a9eca`, no source changes other than the
constant swap.

| WEDGE_CHUNK_COUNT | draining test outcome | exit | server received |
| ----------------- | ---------------------- | ---- | ---------------- |
| 32                | pass                   | 0    | full payload     |
| 65                | FAIL                   | 101  | 0 / 6500 bytes   |
| 128 (as-is)       | FAIL                   | 101  | 0 / 12800 bytes  |

Threshold is exactly `WRITER_QUEUE_CAPACITY = 64` at `terminal_control.rs:56`.

## Root cause

At `terminal_control.rs:323` the select loop routes bulk outbound data:

```rust
if writer_tx.try_send(Message::Text(encoded)).is_err() {
    connected = false;
}
```

`tokio::sync::mpsc::error::TrySendError` has two variants:

- `Full` — the bounded channel is at capacity right now; this is normal
  backpressure when the writer/sink is momentarily slower than the producer.
- `Closed` — the receiver has been dropped; the writer task has exited.

The current code treats both identically and disconnects. That is only correct
for `Closed`. A `Full` under active drain is the writer doing its job — the
sink is servicing sends but not instantly, so the queue transiently fills.

The writer task's own `WRITE_TIMEOUT = 10s` at `terminal_control.rs:427`
guarantees a truly wedged writer exits within 10 seconds, at which point
`writer_rx` is dropped and every future `writer_tx.try_send` returns
`Err(Closed)`. So `Closed` is the correct, sufficient discriminator for
"writer wedged, treat connection as dead" — and `Full` is not.

The same pattern appears at `terminal_control.rs:361` on the priority (ping)
queue. A full priority queue after a ping is a stronger signal because the
priority queue is drained biased-ahead of data and only ever holds a ping
or a close frame, so its capacity of 8 should never fill under a healthy
writer. That path is more defensible; the data-path conflation is not.

## Production impact

Any terminal output burst above ~6.4 KB across ≤64 frames on a healthy peer
disconnects the client. In practice a shell command that prints a large log
line, a `cat` of a modest file, or a build's status spam over a slow-drain
socket will trip this repeatedly. The fix therefore trades one intermittent
attach failure for a deterministic disconnect on ordinary output volume.

## What I did NOT do

I did not attempt to fix the bug. The lane brief was explicit: "you must not
become invested in it working." The above pinpoints the two lines and names
the intended discriminator so an owning lane can implement the correction.
