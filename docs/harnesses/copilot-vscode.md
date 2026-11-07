# Copilot in VS Code

The `copilot` session route serves the **Copilot** harness in VS Code on macOS.
The older **Local** harness and standalone Copilot CLI are not live delivery
routes. Hosted MCP configuration and native Copilot history remain available
on other platforms; verified messaging and wake support are unavailable there.

Provider setup installs one owned `~/.copilot/hooks/agent-relay.json` file
(`$COPILOT_HOME` replaces `~/.copilot`). Other hook files remain unchanged.
If this exact file contains unrecognized content, setup refuses to overwrite or
remove it. Back it up and reconcile or move it before repairing Relay setup.
Desktop's provider installer owns this setup path; the public core exposes the
adapter for that installer rather than a separate `settings.set` toggle.
Start a new Copilot chat to load the hooks and MCP connection. Hooks do not
alter model approval or tool permission settings. History is acquired by
RelayHistory's existing `copilot` provider from the runtime's native journal.
Sharing and uploads retain the person's normal consent and scheduling.

The hook forwards `agentrelay-<tool>` and legacy `agent-relay-<tool>` calls to
Desktop. Tool names are retained up to 256 characters; longer names are
truncated. Desktop remains the authority for per-call attestation; forwarding
a name does not make it eligible for signing.

The native [sessionStart output](https://docs.github.com/en/copilot/reference/hooks-reference)
uses top-level `additionalContext`, as does post-tool context; the older Local
harness wrapper is not used. The SessionStart and post-tool hooks identify the chat by its native
`sessionId`. The stop hook waits up to 59 minutes after a completed turn,
without model calls, and returns `decision: block` with the next message as its
`reason`. This resumes the same chat. Post-tool delivery uses top-level
`additionalContext`. Closing the chat, cancelling its hook, closing VS Code,
sleeping the computer or exceeding the wait ends that wake opportunity.
Delivery waits for the next active hook; it does not create a chat or launch a
new model executor. Copilot may impose its own consecutive stop-hook limits.

## Identity and delivery proof

Verified against VS Code 1.144.0, bundled Copilot Chat 0.72.0 and Copilot
runtime 1.0.103-unstable.r40031404408.gba6c003. The runtime holds real
`session-state/<native-id>/inuse.<pid>.hold` descriptors, including several
sessions in one process. A filename alone is not evidence.

Before discovering a chat or returning message data the core verifies the peer
UID and immediate runtime parent, the installed Microsoft-signed runtime, its VS Code utility host and
main executable and live code objects, strict validation of its sealed app bundle, process start times, the native session ID and the open
inode's birth against the current hold path. A copied path, replaced hold,
recycled PID, ordinary tool child or multiplexed MCP process cannot name a
chat. A hook-observed record gates discovery and is rechecked before delivery.
Idle stop polls with no offer return only `{}` after checking the observed parent
runtime incarnation; they exit when it is gone and do not perform the expensive
descriptor scan or create a discovery record. The helper path comes from the
Desktop host and its live code must satisfy the core program’s designated
signature requirement. Code deliberately running as this
user is outside this proof's threat model,
as it is for the other local hook routes.

Ordinary VS Code terminal tools do not carry a Copilot chat ID, and the runtime
holds several chats. They therefore cannot identify a chat on the session
socket. Relay's SessionStart context, retried on tool hooks until native acceptance,
tells the chat its registered desktop
address for `join_relay` through the hosted MCP. It never chooses another held
chat or supplies a misleading socket reply command. The private Desktop plugin
uses the verified `preToolUse` callback to sign the native chat, installation,
workspace, user, tool, exact arguments and a fresh nonce. `modifiedArgs` carries
that short-lived proof to hosted MCP without changing tool approval policy.
Cloud verifies and spends the nonce before dispatch; a connection ID or
model-provided desktop address alone grants no identity. Until the service
advertises Copilot proof support, setup reports messaging unavailable.

Automatic final replies use the completed native final-answer turn after the
specific delivery receipt; intermediate tool turns and unrelated human turns
cannot answer it. MCP tools can also send explicit replies. This control-path
receipt reader does not replace RelayHistory’s transcript ingestion.

Delivery uses a chat-scoped durable claim in the core's running-turn journal.
The hook claims before the response is sent. Claimed submission tombstones are
retained across long sleeps; no message text is kept in those tombstones. They
are intentionally not discarded merely after native receipt: the bounded
receipt tail can later roll past a buffered delivery. Safe compaction needs a
durable signal that its outer delivery can no longer replay.
Offers and identity context require the active registration workspace, with
workspace/account-generation checks around asynchronous verification. A native queued user message
confirms a stop follow-up; a successful
`postToolUse` output confirms added context. Both must contain the exact Relay
message reference. A stop decision alone is insufficient because Copilot can
limit consecutive stop blocks. A lost response remains
in doubt until native acceptance is observed and is never blindly retried.
Receipt inspection is bounded to the final 8 MiB; lack of proof remains
an in-doubt terminal failure rather than permission to resubmit; Relay reports
that the message was not resent. Restarting the core preserves
claimed tombstones; fresh, unclaimed offers are reconstructed by the delivery loop.

## Verification

The live disposable editor proof read a synthetic README and returned
`RELAY_COPILOT_VSCODE_PROOF_OK`; the same native journal passes RelayHistory's
public discover/hydrate/read/reopen/export/full-sync conformance. A queued
stop-hook message then resumed the same editor chat and returned
`RELAY_INBOUND_HOOK_OK`. The production adapter additionally tests held-inode
and signature refusals, exact-chat delivery, persisted claims, native acceptance
and non-destructive hook installation. End-to-end release verification must
also prove the hosted MCP identity and Relay round trip with the built adapter.
