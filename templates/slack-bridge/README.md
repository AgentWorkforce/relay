# Slack Bridge for Agent Relay

Connect Slack to your Agent Relay network. Messages flow both ways:
- Slack mentions → broadcast to agents
- Agent messages → post to Slack channels

## Setup

### 1. Create Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Click "Create New App" → "From scratch"
3. Name it (e.g., "Agent Relay") and select workspace

### 2. Configure Permissions

**OAuth & Permissions** → Add Bot Token Scopes:
- `app_mentions:read` - Read mentions
- `chat:write` - Post messages
- `channels:history` - Read channel history
- `channels:read` - List channels

### 3. Enable Socket Mode

**Socket Mode** → Enable Socket Mode
- Generate an App-Level Token with `connections:write` scope
- Save the token (starts with `xapp-`)

### 4. Install to Workspace

**Install App** → Install to Workspace
- Save the Bot Token (starts with `xoxb-`)

### 5. Configure Environment

```bash
cp .env.example .env
# Edit .env with your tokens
```

### 6. Run

```bash
npm install
npm run dev
```

## Usage

### Slack → Agents

Mention the bot in Slack:
```
@AgentRelay What's the build status?
```

This broadcasts to all connected agents.

### Agents → Slack

Agents can send to Slack by including `slackChannel` in message data:
```
->relay:SlackBridge <<<
Build completed successfully!
{"slackChannel": "#deployments"}>>>
```

### Targeting Specific Channels

Configure `DEFAULT_CHANNEL` for untagged messages, or include channel in message data.

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│    Slack    │◄───►│ SlackBridge  │◄───►│ AR Daemon   │
│  Workspace  │     │  (this app)  │     │  + Agents   │
└─────────────┘     └──────────────┘     └─────────────┘
```

## Customization

### Filter Messages

Edit `src/bridge.ts` to filter which messages go to Slack:

```typescript
// Only forward messages tagged for Slack
if (!msg.data?.forSlack) return;
```

### Transform Messages

Customize formatting in `formatForSlack()`:

```typescript
formatForSlack(from: string, body: string): string {
  return `*[${from}]*\n${body}`;
}
```

### Thread Mapping

The bridge maintains thread context. Replies in Slack threads stay in threads.
