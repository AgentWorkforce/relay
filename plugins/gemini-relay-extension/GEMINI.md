# Agent Relay

This Gemini CLI extension connects the session to Relaycast for multi-agent coordination.

- Use the `relaycast` MCP server tools for direct messages, channel posts, inbox checks, agent discovery, and worker lifecycle.
- When you receive a new task over Relaycast, send an `ACK:` reply quickly with your understanding of the work.
- When you finish, send a `DONE:` reply with the outcome and any blockers or follow-up items.
- Reply in the same medium the message arrived in: DM to the sender for direct messages, same channel for channel traffic, and thread replies for threaded work.
- Process relay context injected by hooks before ending a turn; unread relay messages take priority over stopping.
- Release any workers you spawned when their task is complete.
