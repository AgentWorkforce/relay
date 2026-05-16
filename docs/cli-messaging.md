Once the broker is up, the CLI can act as a lightweight operator console for human-to-agent messages and recent conversation history.

## Send a message

```bash
agent-relay send reviewer "Please summarize the riskiest changes first."
```

The target argument accepts:

- an agent name such as `reviewer`
- a channel such as `#general`
- `*` for broadcast

Optional flags:

- `--from <name>` sets the sender identity. Defaults to `$AGENT_RELAY_ORCHESTRATOR_NAME` or `orchestrator`.
  Workers' replies are addressed to this name, so use a stable value you can read with `agent-relay replies <worker>`.
- `--thread <id>` keeps follow-ups grouped under an existing thread.

## Read recent history

```bash
agent-relay history --to '#general' --since 30m
```

Useful filters:

- `--from <agent>` keeps only one sender.
- `--to <agent-or-channel>` narrows to a target. When `<agent>` is not a channel, the command prints messages in chronological order with no preview truncation; pair with `--from <sender>` to filter by sender.
  For example, `agent-relay history --to Worker2 --from Worker2` is equivalent to `agent-relay replies Worker2` for the non-`--unread` case.
- `--since <time>` accepts values like `30m`, `1h`, or an ISO date.
- `--json` emits structured output for scripts. Each DM record carries a `direction` field (`inbound` or `outbound`) relative to the reader identity.

## Read replies from a worker

```bash
agent-relay replies Worker2
```

Shows messages received from `<agent>` in chronological order (oldest first, newest at the bottom), full text, with sender attribution. Inbound-only: it never echoes the orchestrator's own outbound DMs.

Useful filters:

- `-n, --limit <count>` caps the number of messages (default `50`).
- `--since <time>` accepts values like `30s`, `5m`, `1h`, or an ISO date.
- `--unread` shows only unread messages and does not mark them read.
- `--mark-read` marks the printed messages as read after printing.
- `--as <name>` reads as a specific orchestrator identity (default `$AGENT_RELAY_ORCHESTRATOR_NAME` or `orchestrator`).
- `--full` disables truncation; text is already printed in full, so this is currently a forward-compatible no-op.
- `--json` emits structured output; each record carries a `direction` field (`inbound` or `outbound`) relative to the reader identity.

Exit code is `0` whether messages were printed or none were found; only connection or auth failures return non-zero.

## Check the inbox

```bash
agent-relay inbox
```

`inbox` summarizes unread channels, mentions, and DMs. For DMs, the text renderer prints up to three most recent unread messages per conversation with full text and a `<sender> → <reader>` header.
If a conversation has more than three unread messages, a footer line points at `agent-relay replies <agent> --unread` for the full list. Add `--json` if another tool will parse the result; the JSON shape is unchanged for existing callers and additionally carries a `direction` field on each unread DM `last_message`.

## Practical pattern

```bash
agent-relay send planner "Create the plan, then hand implementation to coder."
agent-relay replies planner --since 15m
agent-relay inbox
```

## See also

- [Agent management](cli-agent-management.md) - Spawn agents before trying to message them.
- [Sending messages](sending-messages.md) - SDK patterns for the same message flow.
- [Channels](channels.md) - Design shared communication spaces.
- [DMs](dms.md) - One-to-one coordination patterns.
