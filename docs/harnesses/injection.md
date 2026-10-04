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

The broker-wide ceiling is **16,384 UTF-8 bytes**. The formatted envelope must fit
this ceiling as well, so leave room for attribution and broker reminders. Paced
fallback input has an effective limit of **1,536 bytes including the envelope** at
the default 5 ms pace. A slower `RELAY_INJECT_RATE_MS` lowers that limit to keep
writing within 7.68 seconds. Unpaced fallback uses the global ceiling. Codex uses
the smaller of the global ceiling and its deadline-derived limit. Rejections name
the harness and effective limit; oversized bodies are never partially written.
For longer briefs, create a file on the node and send a short instruction to read it.

The input wire normalizes CRLF to LF and strips bare carriage returns and ESC
characters. These bytes cannot submit the composer early or close a paste from
inside its body. Other UTF-8 content is preserved.

```sh
agent-relay fleet spawn claude --node my-node --name reviewer --task-file ./brief.md
agent-relay node agent spawn claude --name reviewer --task-file ./brief.md
```

`--task-file` reads a UTF-8 file on the **requester's machine**, then sends the
contents through the usual task transport. It does not create a file on the node
or bypass size limits. Fleet requires exactly one of `--task` and `--task-file`;
local `agent spawn` and `node agent spawn` allow neither. The integration command's
existing task option remains unchanged.

Only a whole-payload echo confirms receipt: `echo` (verbatim) or
`echo_normalized` (verbatim once the TUI's wrapping whitespace is removed from
both sides). A tail without its head fails with `echo_head_missing`; the body is
never automatically replayed. If the observation buffer has discarded the head,
that is not treated as proof of truncation.

Every other verdict is an ack that **does not prove byte-for-byte receipt**, and
each says what was actually observed: `echo_incomplete` (head and tail without
the payload between them — matching endpoints say nothing about the bytes
between them), `paste_summary` (the harness collapsed the paste, so no content
was echoed at all) and `timeout_fallback` (no echo), the last with a warning and
a process-local fallback counter.

Verified fleet PTY spawns with a task wait for its delivery verdict after proven
startup readiness. A failed task fails the spawn action. A task acked without
confirmed receipt resolves the action as `spawn_task_unconfirmed`, naming the
live agent: the spawn must not be retried (that duplicates the agent), so resend
the task or point the agent at a brief file. Wrap uses the same echo evidence and
keeps its failed-throttle policy on absent echoes and on evidence of loss; a
collapsed paste is recorded as unverified instead, since it indicates nothing
about loss.
