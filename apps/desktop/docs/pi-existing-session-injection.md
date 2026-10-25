# Existing Pi sessions

The macOS and Linux cores discover and deliver into an already-running Pi
session through the bundled extension in `probe/src/relay/pi/agent-relay.mjs`.
Pi itself needs no upgrade, patch, restart, or special launch flags. Installing
an extension does require **one `/reload` in an existing session**. The extension
uses Pi's existing `session_start`, `session_shutdown`, `sendUserMessage`,
`isIdle`, and session-manager APIs; it imports no Pi package, supporting both
the `@mariozechner` and `@earendil-works` package names.

## Connect

1. Run Agent Relay built with this adapter. Its shared core installs the
   extension at `~/.pi/agent/extensions/agent-relay.js` when Pi's agent directory
   exists. `PI_CODING_AGENT_DIR` selects a different absolute agent directory.
   To install from this checkout now, run `node scripts/install-pi-extension.mjs`.
2. In the existing Pi session, run `/reload`. This reloads extensions in the
   same process and conversation; it does not update Pi.
3. Enable **Receives messages** for that Pi session in Agent Relay's session
   table. Messages arrive as attributed user turns once Pi is idle. Automatic
   replies use the completed final assistant message from that turn.

Only persistent UI sessions are listed. Print sessions and sessions using
`--no-session` are excluded. This adapter does not launch or resume a second Pi
process against the same transcript, type terminal input, or attach to RPC
stdin. A bare TUI without the loaded extension cannot receive messages.
`AGENT_RELAY_ENABLE_PI=0` disables discovery, installation, and delivery in the
core. Another person's extension at `agent-relay.js` is preserved, never replaced.

## Identity and delivery

Each loaded runtime creates a random private directory below
`~/.agentworkforce/desktop/pi/` and keeps `session.json` open. The core admits a
session only while the kernel reports that its same-user process holds that
file. Registry files and delivery records are 0600; directories are 0700;
symlinks and non-private records are refused. Duplicate live holders of a Pi
session ID are excluded. Registration pins the process PID, kernel start time,
and random runtime identity. Every send repeats discovery and checks that pin.

The core atomically writes and syncs a pending inbox record keyed by the full
SHA-256 of the Relaycast message ID. Repeated requests read that same record;
different text under the same ID fails closed. New records carry a durable
arrival sequence allocated under the runtime's delivery lock; retries keep their
original place. The extension submits pending messages in that sequence, rather
than SHA-256 filename order. Pre-upgrade records precede sequenced records and
use their file times as a best-effort ordering fallback; their exact historical
arrival order was not recorded. An unreadable counter fails closed. The extension polls every 250 ms
and waits until Pi is idle. It syncs a claim before calling `sendUserMessage`.
Only an exact matching user message in Pi's own session history and saved JSONL
promotes the record to `recorded`; the extension syncs that transcript before
syncing its receipt. Older Pi versions defer saving the first user entry until
the first assistant message, so that first delivery stays accepted until then.
Only a saved entry is acknowledged. Readback checks the last 8 MiB of the
transcript; a message outside that bound stays unacknowledged, never resubmitted.
The prompt includes a full delivery digest for exact transcript correlation.
An uncertain claim is never submitted again. A complete final assistant
message is saved separately; tool progress, errors, and aborted turns are not
automatic replies.

Reloading or switching sessions closes the registry descriptor. A new runtime
gets a new identity, so an existing registration must be turned off and added
again. Pending messages in the old runtime are not transferred. Receipts remain
private on disk so completed answers can still be read after Pi exits; there is
currently no automatic cleanup of these runtime directories. Lost claims need
manual reconciliation rather than blind retry.

An already-recorded receipt is reconciled before requiring a live binding.
It can settle the exact message ID and text after Pi exits, reloads or switches
sessions; this never submits a new prompt to a replacement runtime.

This bridge trusts code running as the signed-in operating-system user, as Pi's
extension API does. Private files exclude other users; they do not sandbox
malicious code with the same UID, which can already read the relay's tokens,
inboxes and Pi transcripts. The held-file and PID/start/runtime checks prove
the registered local holder and prevent accidental retargeting; they are not
code attestation of the Pi process.

The route supports receiving messages and automatic final answers, including
subscribed channel batches: their final answer replies once to the batch's last
post, whose message ID is used for answer lookup. Direct messages are unchanged.
The journal retains that original post's routing metadata, so a queue member
leaving before retry never changes the inbox key or answer destination. Pins
created before this fix retain Pi's original batch key and previous lack of an
automatic channel reply; changing their key on upgrade could run the prompt
again. Newly queued batches use the persisted original last post.

If the extension cannot be installed, both desktop apps retain the reason in
status details and Settings → Relay, even when connecting after core startup.
A conflicting extension is preserved. Resolve the conflict or file permissions,
restart Agent Relay to retry installation, then run `/reload` in Pi. Successful
setup clears the diagnostic on the next core start.

The route does not yet identify Pi tool subprocesses for the relay-send socket, so it supplies no
shell reply hints or session self-registration command.

## Verification

Run `bash scripts/test-pi-live.sh` for the extension unit tests and a real Pi
TUI against a deterministic loopback model. It installs pinned Pi 0.68.0
(`@mariozechner`) and Pi 1.3.0 (`@earendil-works`) into temporary directories,
with fresh agent homes and transcripts; it uses no model credentials and does
not update the person's Pi installation. Both packages are tested on Linux and
macOS in CI.

The live test starts Pi before installing the extension, loads it with
`/reload`, discovers it through `LocalSessions`, pins its registration, sends
through `LocalInjector`, confirms the user entries in Pi's actual JSONL
transcript, and reads its final replies. It checks idle delivery, a message
waiting unclaimed while another response runs, duplicate suppression, binding
replacement on reload, switching sessions with `/new`, and receipts after exit.
Only the model HTTP endpoint is a fixture; Pi's TUI, extension loader,
session manager, agent loop, and Relay's discovery and injector are real.

For a paid live-model test, set `OPENAI_API_KEY` in the environment and run
`bash scripts/test-pi-live-model.sh`. It tests both pinned versions with OpenAI
`gpt-4.1-mini` and Pi's real `read`, `bash`, and `write` tools. Each isolated
session starts before extension installation and loads it using `/reload`.
The model must read a fresh challenge, execute a shell command, write a checked
result, and process two follow-ups injected while the shell tool is running. The
test verifies the saved tool results, all three final Relay answers and their saved arrival order, duplicate
suppression, and receipt settlement after exit. The API key is passed only
through the child environment; it is not written into Pi's temporary home.
This test is opt-in and does not run in CI. `RELAY_PI_MODEL` overrides the model;
`RELAY_PI_PROVIDER` overrides the provider. For a signed-in provider, set
`RELAY_PI_AUTH_FILE` to a Pi-format `auth.json`; the harness copies it with 0600
permissions into its disposable home and never modifies the source credentials.
For example, a Pi Codex sign-in can use `RELAY_PI_PROVIDER=openai-codex` and
an exact available model ID in `RELAY_PI_MODEL`. `RELAY_PI_MODELS_FILE` optionally
copies a Pi-format `models.json` into the test home, allowing an older Pi to
call a current model without updating Pi or changing its installed catalog.
`RELAY_PI_EVIDENCE_ROOT` optionally retains each version's test transcript and
summary in private directories. The test never uses existing conversations or
updates the person's Pi installation.

Upstream contracts: [extension API](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/extensions/types.ts),
[reload](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/slash-commands.md),
[RPC mode](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc.md).
