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
> "Your name is Alice. You're chatting with Bob via agent-relay. Say hello to Bob by typing: ->relay:Bob Hello Bob! I'm Alice."

### Terminal 3: Agent Bob

```bash
npx agent-relay wrap -n Bob "claude"
```

Once Claude starts, you can tell it:
> "Your name is Bob. You're chatting with Alice via agent-relay. Wait for her message, then respond."

## How It Works

1. Each agent is wrapped with `agent-relay wrap`, which:
   - Intercepts terminal output looking for `->relay:` patterns
   - Sends matched messages through the daemon to other agents
   - Injects received messages into the agent's terminal

2. Messages use the inline format:
   ```
   ->relay:RecipientName Your message here
   ```

3. Received messages appear as:
   ```
   [MSG] from SenderName: Their message
   ```

## Alternative: File-Based Chat

If you prefer file-based messaging (no PTY wrapper):

```bash
# Set up inboxes
mkdir -p /tmp/chat

# Alice sends to Bob
agent-relay inbox-write -t Bob -f Alice -m "Hello Bob!" -d /tmp/chat

# Bob reads his inbox
agent-relay inbox-read -n Bob -d /tmp/chat

# Bob replies
agent-relay inbox-write -t Alice -f Bob -m "Hi Alice!" -d /tmp/chat
```

## Tips

- Use `->relay:*` to broadcast to all connected agents
- Use `\->relay:` to output literal text without triggering the relay
- Check daemon status with `npx agent-relay status`
