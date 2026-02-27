# Agent Relay — Electron Demo

Minimal Electron app that demonstrates the `@agent-relay/sdk` integration pattern from the docs.

## Run it

```bash
cd examples/electron-demo
npm install   # first time only
npm start
```

## What it does

- Starts the Agent Relay broker automatically on launch
- **Spawn Agent** — enter a name, pick a CLI (claude / codex / gemini), click Spawn
- **Messages tab** — shows all messages routed through the broker
- **PTY Output tab** — streams raw terminal output from spawned agents
- Click an agent in the sidebar to DM it; click again to go back to broadcast mode
- Type a message and hit Enter or Send

## Requirements

The broker binary must be built (`cargo build --release` from the repo root).
To actually spawn agents you need the relevant CLI installed (`claude`, `codex`, etc.).
