# @agent-relay/harnesses

Pre-built harness definitions for local coding agents. Requires Node.js 22 or newer.

Use this package with `@agent-relay/harness-driver` when Agent Relay should create or supervise managed sessions.

## Runtime selection

Claude Code, Codex, and OpenCode offer both an official AI SDK native harness runtime and the existing PTY runtime. Their adapters begin as experimental, so `auto` continues to select PTY until each adapter passes its promotion gates.

```ts
import { claude } from '@agent-relay/harnesses';

await claude.create({ relay }); // auto: PTY while the adapter is experimental
await claude.create({ relay, backend: 'ai-sdk' }); // explicit native harness runtime
await claude.create({ relay, backend: 'pty' }); // explicit terminal runtime
```

Runtime selection is final before the session starts. Relay does not switch a running session between PTY and AI SDK.

| Harness         | AI SDK adapter                       | PTY | Initial selection                        |
| --------------- | ------------------------------------ | --- | ---------------------------------------- |
| Claude Code     | `@ai-sdk/harness-claude-code@1.0.35` | yes | PTY; AI SDK is explicit and experimental |
| Codex           | `@ai-sdk/harness-codex@1.0.36`       | yes | PTY; AI SDK is explicit and experimental |
| OpenCode        | `@ai-sdk/harness-opencode@1.0.35`    | yes | PTY; AI SDK is explicit and experimental |
| Pi              | `@ai-sdk/harness-pi@1.0.34`          | no  | explicit experimental AI SDK             |
| Deep Agents     | `@ai-sdk/harness-deepagents@1.0.33`  | no  | explicit experimental AI SDK             |
| Other built-ins | none                                 | yes | PTY                                      |

Pi and Deep Agents require `backend: 'ai-sdk'` while experimental. Deep Agents does not advertise manual compaction, and stopping its current adapter does not preserve in-memory conversation.

Harness execution is `pty` or `native`. The broker may internally wrap native harnesses and attached app servers as `headless` processes, but `headless` is not an observability mode. Both execution paths publish the same normalized `AgentEvent` contract.

## Native harness attach

AI SDK sessions expose agent-event history and live events instead of terminal bytes:

```bash
agent-relay node agent attach my-agent --mode view
agent-relay node agent attach my-agent --mode drive
agent-relay node agent attach my-agent --mode view --json
agent-relay node agent attach my-agent --mode view --reasoning --diagnostics
```

`view` is read-only. `drive` sends each input line after broker acknowledgement; `/interrupt`, `/approve <id>`, `/reject <id>`, and `/detach` are local controls. `passthrough` is unavailable because a native harness session has no terminal byte stream. `--json` writes normalized NDJSON to stdout. Reasoning and diagnostics stay hidden unless requested.

## Observability

The AI SDK stream is Relay's reference observability profile. Relay publishes portable agent events and the activities `starting`, `thinking`, `typing`, `using_tool`, `waiting`, `idle`, and `error`. Every event carries its source and either `exact` or `inferred` fidelity.

PTY sessions use the same capability matrix. Today the broker provides exact startup and runtime failure plus inferred busy and idle boundaries. Signals that terminal bytes cannot prove, including reasoning, text blocks, tools, approvals, files, and compaction, are reported as unavailable rather than guessed.

Another Relay application can inspect events successfully accepted into Relaycast's durable agent log through the messaging surface:

```ts
const activity = await relay.messaging.sessionEvents?.list('my-agent', {
  type: 'activity.changed',
  limit: 100,
});
```

The broker owns PTY publication for every spawn surface. A managed `create({ relay })` call additionally mirrors those broker events into listeners on that local `AgentRelay` instance.

Hosted publication is operational observability, not a lossless audit ledger. The broker preserves order through a bounded publisher queue and logs queue, timeout, and Relaycast failures locally; events can be absent during a sustained outage or broker crash.

## Local-host security and troubleshooting

The AI SDK local-host provider is a process and filesystem lifecycle boundary, not an operating-system sandbox. It rejects lexical traversal and static symlink escapes on a best-effort basis for adapter file operations, holds bridge ports on loopback until handing them to the adapter process, and terminates only child processes it started. Concurrent filesystem mutation by another process is outside this boundary, so the path guard is not TOCTOU-safe and must not be used as isolation for untrusted code.

The local-host AI SDK runtime currently supports macOS and Linux. On Windows, use the PTY backend; an explicit AI SDK selection fails with a typed platform error instead of attempting POSIX adapter bootstrap commands. Preflight checks the platform, Node.js 22, `pnpm`, workspace access, cache access, and loopback port allocation. If startup fails, verify those commands and permissions first. Bootstrap work is cached by stable adapter identity under the runtime cache; deleting unrelated workspace files is never part of cleanup.

Adapter upgrades must keep the `@ai-sdk/harness@1.0.34` family coherent and pass the registry, lifecycle, agent-event replay, observability, real-CLI, and 100-cycle soak contracts before changing an adapter's rollout state.
