# PTY task and relay-message delivery

Fleet workers wait for a recognized composer before injecting. If the composer
cannot be proven within 15 seconds of starting an injection, delivery fails with
`prompt_unproven` without writing the body. Unknown harnesses retain their existing
input behavior.

A harness that has enabled terminal bracketed-paste mode (DECSET 2004) receives one
bulk bracketed paste followed by a separate, delayed Enter. Capability stays latched
for the session, independently of composer readiness. Devin also uses this wire.
`RELAY_INJECT_PASTE=0` forces the typed fallback. Wrap sessions retain bulk writes.
Codex initial tasks retain their existing chunked delivery path.

The broker-wide ceiling is **16,384 UTF-8 bytes** for the formatted envelope. Bodies
are capped at **14,336 bytes** (`fleet spawn` task input, the fleet spawn action
before any launch, and broker PTY delivery), leaving 2 KiB for attribution and
broker reminders so an accepted body still fits once formatted. Paced
fallback input has an effective limit of **1,536 bytes including the envelope** at
the default 5 ms pace. A slower `RELAY_INJECT_RATE_MS` lowers that limit to keep
writing within 7.68 seconds. Unpaced fallback uses the global ceiling. Codex uses
the smaller of the global ceiling and its deadline-derived limit. Rejections name
the harness and effective limit; oversized bodies are never partially written.
Wrap sessions have no failure channel back to the sender, so an oversized relay
message is delivered as a short notice naming the sender, size, limit and message
ID instead of its body; the full message stays readable in Relay. The limit is
enforced only at the PTY boundary: `message post|reply|dm send` publish any size
to Relaycast, since recipients may be native agents or history only.
For longer briefs, create a file on the node and send a short instruction to read it.

The input wire normalizes CRLF to LF and strips bare carriage returns and ESC
characters, so they cannot submit the composer early or close a paste from
inside its body. LF stays in the payload: inside a bracketed paste it is a
newline, but on the typed fallback wire a harness may treat it as Enter, so
multiline tasks are only safe on paste-capable harnesses. Other UTF-8 content
is preserved.

```sh
agent-relay fleet spawn claude --node my-node --name reviewer --task-file ./brief.md
agent-relay node agent spawn claude --name reviewer --task-file ./brief.md
```

`--task-file` reads a UTF-8 file on the **requester's machine**, then sends the
contents through the usual task transport. It does not create a file on the node
or bypass size limits. Fleet requires exactly one of `--task` and `--task-file`;
local `agent spawn` and `node agent spawn` accept either but require neither, and
reject both together. The integration command's
existing task option remains unchanged.

Receipt is proven by harness acceptance, never by echo alone: a body visible in
the composer is still a draft. A PTY delivery is `harness_acceptance` once the
harness shows activity, clears its composer, or (for a plain process) echoes the
body raw. A body still parked in the composer gets a bounded submit-key retry
(`delivery_unconfirmed`, then `delivery_resubmitted`); the body itself is never
replayed. If it stays parked, the delivery fails with "body remained parked after
bounded submit-key recovery"; if the window closes with neither acceptance nor a
parked body, it fails with "harness acceptance could not be proven", which is not
evidence that the input was lost.

Verified fleet PTY spawns with a task wait for its delivery verdict and for
proven startup readiness, in either order. Only `harness_acceptance` confirms
the task. A failed task releases the worker and its fleet identity, then fails
the spawn action with `spawn_task_failed`, so a corrected retry can reuse the
name. A task acked without proof of acceptance, or whose acceptance could not be
proven either way, resolves the action as `spawn_task_unconfirmed`, naming the
live agent: the spawn must not be retried (that duplicates the agent), so resend
the task or point the agent at a brief file.
