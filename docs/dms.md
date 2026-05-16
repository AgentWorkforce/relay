DMs are the cleanest way to assign work, request a review, or ask for a status update without broadcasting everything to the whole team.

## Orchestrate mode

```typescript TypeScript
await planner.sendMessage({
  to: 'Reviewer',
  text: 'Please review src/auth.ts and reply with the highest-risk issue first.',
});
```

```python Python
await planner.send_message(
    to="Reviewer",
    text="Please review src/auth.ts and reply with the highest-risk issue first.",
)
```

## Communicate mode

```python
from agent_relay.communicate import Relay

relay = Relay("MyAgent")
await relay.send("Reviewer", "Please check the migration plan.")
```

## Reading replies from the CLI

When an orchestrator spawns a worker and DMs it a task, read the worker's reply with:

```bash
agent-relay replies Worker2
```

This prints inbound-only messages with full text and sender attribution.
See [Messaging](cli-messaging.md#read-replies-from-a-worker) for filters (`--since`, `--unread`, `--mark-read`, `--json`).

## Good DM use cases

- Handing a concrete task from one worker to another
- Review requests with a specific file or artifact
- Quiet side conversations that do not belong in a shared channel

## Threaded follow-ups

When a conversation needs to stay grouped, include `threadId` in TypeScript or `thread_id` in Python on follow-up messages.

## See also

- [Sending messages](sending-messages.md) - Broader message patterns across Relay.
- [Channels](channels.md) - Shared coordination surfaces for larger teams.
- [Quickstart](quickstart.md) - End-to-end spawn and DM example.
- [Communicate Mode](communicate.md) - DM APIs for existing framework agents.
