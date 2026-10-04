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

Verification recognizes exact echoes, whitespace-normalized head/tail anchors,
and paste summaries. A tail without its head fails with `echo_head_missing`; the
body is never automatically replayed. If the observation buffer has discarded the
head, that is not treated as proof of truncation. No echo retains the existing
`timeout_fallback` behavior, with a warning and process-local fallback counter.
This compatibility verdict **does not prove byte-for-byte receipt**.

Verified fleet PTY spawns with a task wait for its delivery verdict after proven
startup readiness. A failed task fails the spawn action; timeout fallback still
counts as success for compatibility. Wrap uses the same echo evidence but keeps
its existing failed-throttle policy on absent echoes.
