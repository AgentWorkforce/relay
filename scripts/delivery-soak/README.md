# PTY delivery soak

This script starts a fresh **local-only** Relay broker, spawns a real Claude or
Codex PTY worker, sends messages through the broker's `/api/send` endpoint, and
asks the worker to save the bytes it saw. It compares each saved payload with
the generated payload and writes `result.json`. A nonzero exit means a message
was rejected, lost, changed, duplicated, or observed out of order. The broker
and agent are stopped after the run; the output directory retains evidence.

Build the broker from the revision under test, then run from any directory:

```sh
cargo build -p agent-relay-broker --bin agent-relay-broker
python3 scripts/delivery-soak/soak.py \
  --broker-bin target/debug/agent-relay-broker \
  --harness codex --count 2 --output /tmp/relay-soak-codex-1
```

Repeat with `--harness claude`, and pass a broker binary built from each branch
to compare revisions. Use a new output directory for each run. The default is
one message at each of 50, 150, 1,024, 4,096 and 16,384 bytes; increase
`--count` for a stress run. Python 3.9+ is sufficient on macOS and
Linux. The chosen agent CLI must be installed and authenticated.

The `records/` files contain exactly what the agent chose to write. A missing
file can mean a parked turn or a model/tool failure as well as failed delivery;
inspect `broker.log`, `broker-status.json`, and the terminal snapshot before
attributing it to the transport. Latency includes agent reasoning and file
writing. `reordered` describes file-write order, which can differ from wire
order if the agent handles queued messages differently. The 16 KiB payload has
an additional message envelope, so broker revisions with a 16 KiB
formatted-body limit should reject that case after queue acceptance.
