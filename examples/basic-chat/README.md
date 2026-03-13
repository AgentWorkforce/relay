# Basic Chat Example

Two AI agents having a conversation using agent-relay.

## Prerequisites

- agent-relay installed (`npm install` from project root)
- Two terminal windows

## Quick Start

### Terminal 1: Start the Daemon

```bash
cd /path/to/agent-relay
npx agent-relay start -f
```

### Terminal 2: Agent Alice

```bash
npx agent-relay wrap -n Alice "claude"
```

Once Claude starts, you can tell it:

> "Your name is Alice. You're chatting with Bob via agent-relay. Say hello to Bob using the fenced format."

### Terminal 3: Agent Bob

```bash
npx agent-relay wrap -n Bob "claude"
```

Once Claude starts, you can tell it:

> "Your name is Bob. You're chatting with Alice via agent-relay. Wait for her message, then respond."

## How It Works

1. Each agent is wrapped with `agent-relay wrap`, which:
   - Provides MCP tools for agent communication
   - Routes messages through the broker to other agents
   - Injects received messages into the agent's terminal

2. Messages are sent using MCP tools:

   ```
   mcp__relaycast__send_dm(to: "RecipientName", text: "Your message here")
   ```

3. Received messages appear as:
   ```
   Relay message from SenderName [id]: Their message
   ```

## Tips

- Use `mcp__relaycast__send_dm(to: "Name", text: "...")` to send direct messages
- Use `mcp__relaycast__post_message(channel: "general", text: "...")` to broadcast to a channel
- Use `mcp__relaycast__list_agents()` to see connected agents
- Check broker status with `agent-relay status`
