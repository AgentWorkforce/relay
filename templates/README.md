# Agent Relay Templates

Starter templates for building on Agent Relay.

## Available Templates

| Template | Description | Use Case |
|----------|-------------|----------|
| [slack-bridge](./slack-bridge/) | Connect Slack to AR | Team chat integration |
| [discord-bridge](./discord-bridge/) | Connect Discord to AR | Community/gaming integration |
| [webhook-bridge](./webhook-bridge/) | HTTP webhooks to AR | CI/CD, external services |
| [storage-adapter](./storage-adapter/) | Custom persistence | Postgres, Redis, S3 |
| [memory-adapter](./memory-adapter/) | Vector memory | RAG, knowledge graphs |
| [custom-dashboard](./custom-dashboard/) | Custom web UI | Monitoring, control panels |

## Quick Start

```bash
# Copy a template
cp -r templates/slack-bridge my-slack-bot
cd my-slack-bot

# Install dependencies
npm install

# Configure
cp .env.example .env
# Edit .env with your credentials

# Run
npm start
```

## Template Structure

Each template follows a consistent structure:

```
template-name/
├── README.md           # Template-specific docs
├── package.json        # Dependencies
├── .env.example        # Environment template
├── src/
│   ├── index.ts        # Entry point
│   ├── bridge.ts       # Main logic (for bridges)
│   └── types.ts        # TypeScript types
└── tsconfig.json       # TypeScript config
```

## Creating Your Own Template

1. Pick the closest template to your use case
2. Copy and modify
3. Submit a PR to share with the community!

See [BUILDING_ON_AR.md](../docs/BUILDING_ON_AR.md) for detailed documentation.
