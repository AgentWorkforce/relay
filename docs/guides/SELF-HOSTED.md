# Self-Hosted Deployment

Run Agent Relay on your own infrastructure while using Agent Relay Cloud for authentication and dashboard.

## Overview

Self-hosted mode gives you:
- **Your servers, your data** - Agents run on your infrastructure
- **Cloud authentication** - OAuth flows handled by Agent Relay Cloud
- **Cloud dashboard** - Logs sync to your cloud dashboard
- **Full control** - Custom security, networking, GPU access

```
┌────────────────────────────────────────────────────────────────┐
│                    AGENT RELAY CLOUD                            │
│   ┌────────────┐  ┌────────────┐  ┌────────────┐              │
│   │  Provider  │  │ Dashboard  │  │   Team     │              │
│   │ Auth/Vault │  │  & Logs    │  │ Management │              │
│   └─────┬──────┘  └─────▲──────┘  └────────────┘              │
└─────────┼───────────────┼──────────────────────────────────────┘
          │ Credentials   │ Sync
          ▼               │
┌─────────────────────────┴──────────────────────────────────────┐
│                 YOUR INFRASTRUCTURE                             │
│   ┌────────────┐  ┌────────────┐  ┌────────────┐              │
│   │agent-relay │  │   Agents   │  │   Repos    │              │
│   │  daemon    │  │  (claude,  │  │  (local)   │              │
│   │            │  │   codex)   │  │            │              │
│   └────────────┘  └────────────┘  └────────────┘              │
└────────────────────────────────────────────────────────────────┘
```

## When to Use Self-Hosted

Choose self-hosted if you need:

- Compute in specific regions/clouds
- Custom security requirements (VPC, firewall rules)
- GPU workloads on specialized hardware
- Cost optimization for high-volume usage
- Data locality compliance

## Requirements

- **Node.js** 20+
- **tmux** installed
- **Rust toolchain** (for relay-pty compilation, or use prebuilt binary)
- Network access to `agent-relay.com` for auth

### Linux/Ubuntu

```bash
sudo apt-get update
sudo apt-get install -y build-essential tmux
```

### macOS

```bash
brew install tmux
xcode-select --install  # For build tools
```

## Installation

### 1. Install Agent Relay

```bash
npm install -g agent-relay
```

### 2. Connect to Cloud

This authenticates you with Agent Relay Cloud and syncs credentials:

```bash
agent-relay cloud login
```

This will:
1. Display a URL to open in your browser
2. You authenticate with GitHub
3. Credentials sync to your server

```
$ agent-relay cloud login

  To authenticate, open this URL in your browser:

  ┌────────────────────────────────────────────────────────────┐
  │  https://agent-relay.com/auth/remote?session=xK9mPq2R     │
  └────────────────────────────────────────────────────────────┘

  ⏳ Waiting for authentication...
     Session expires in 9:45

  ✅ Authenticated as user@example.com
```

### 3. Connect AI Providers

Connect each provider you want to use:

```bash
# Connect Claude
agent-relay cloud connect anthropic

# Connect Codex
agent-relay cloud connect openai

# Connect Gemini
agent-relay cloud connect google
```

Each command opens a browser for OAuth login. Credentials are encrypted and synced to your server.

### 4. Clone Your Repositories

Clone the repos you'll work with:

```bash
git clone https://github.com/your-org/your-repo.git
cd your-repo
```

### 5. Start the Daemon

```bash
agent-relay up
```

Your local dashboard is now available at `http://localhost:3888`.

## Running Agents

Once set up, use Agent Relay normally:

```bash
# Start an agent
agent-relay -n Alice claude

# Start another agent
agent-relay -n Bob codex

# Check status
agent-relay status
```

Agents communicate via the local daemon, and logs sync to your cloud dashboard.

## Docker Deployment

### Using the Official Image

```bash
docker run -d \
  --name agent-relay \
  -p 3888:3888 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v ~/.agent-relay:/root/.agent-relay \
  -v ~/repos:/workspace \
  ghcr.io/agentworkforce/agent-relay:latest
```

### Docker Compose

```yaml
version: '3.8'

services:
  agent-relay:
    image: ghcr.io/agentworkforce/agent-relay:latest
    ports:
      - "3888:3888"
    volumes:
      - ./repos:/workspace
      - agent-relay-data:/root/.agent-relay
    environment:
      - CLOUD_API_URL=https://api.agent-relay.com
    restart: unless-stopped

volumes:
  agent-relay-data:
```

### Building Your Own Image

```dockerfile
FROM node:20-slim

# Install dependencies
RUN apt-get update && apt-get install -y \
    build-essential \
    tmux \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install agent-relay
RUN npm install -g agent-relay

# Install AI CLIs
RUN npm install -g @anthropic/claude-code

WORKDIR /workspace

# Start daemon
CMD ["agent-relay", "up", "--host", "0.0.0.0"]
```

## Kubernetes Deployment

### Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: agent-relay
spec:
  replicas: 1
  selector:
    matchLabels:
      app: agent-relay
  template:
    metadata:
      labels:
        app: agent-relay
    spec:
      containers:
      - name: agent-relay
        image: ghcr.io/agentworkforce/agent-relay:latest
        ports:
        - containerPort: 3888
        volumeMounts:
        - name: workspace
          mountPath: /workspace
        - name: credentials
          mountPath: /root/.agent-relay
          readOnly: true
        env:
        - name: CLOUD_API_URL
          value: "https://api.agent-relay.com"
      volumes:
      - name: workspace
        persistentVolumeClaim:
          claimName: agent-relay-workspace
      - name: credentials
        secret:
          secretName: agent-relay-credentials
```

### Service

```yaml
apiVersion: v1
kind: Service
metadata:
  name: agent-relay
spec:
  selector:
    app: agent-relay
  ports:
  - port: 3888
    targetPort: 3888
  type: ClusterIP
```

### Storing Credentials

Create a secret with your synced credentials:

```bash
# After running `agent-relay cloud login` locally
kubectl create secret generic agent-relay-credentials \
  --from-file=credentials.json=$HOME/.agent-relay/credentials.json
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `CLOUD_API_URL` | Agent Relay Cloud API | `https://api.agent-relay.com` |
| `DASHBOARD_PORT` | Local dashboard port | `3888` |
| `LOG_LEVEL` | Logging verbosity | `info` |
| `SYNC_INTERVAL` | Cloud sync interval (ms) | `30000` |

### Config File

Create `~/.agent-relay/config.json`:

```json
{
  "cloud": {
    "apiUrl": "https://api.agent-relay.com",
    "syncInterval": 30000
  },
  "dashboard": {
    "port": 3888,
    "host": "0.0.0.0"
  },
  "logging": {
    "level": "info",
    "file": "/var/log/agent-relay.log"
  }
}
```

## Credential Management

### How Credentials Work

1. You authenticate via `agent-relay cloud connect <provider>`
2. OAuth tokens are stored encrypted in Agent Relay Cloud
3. Encrypted credentials sync to your server
4. Local cache auto-refreshes via cloud

### Manual Credential Sync

```bash
# Force sync credentials from cloud
agent-relay cloud sync

# Check credential status
agent-relay cloud credentials
```

### Credential Storage Location

Credentials are stored in `~/.agent-relay/`:

```
~/.agent-relay/
├── config.json        # Configuration
├── credentials.json   # Encrypted provider tokens
└── cache/             # Local message cache
```

## Log Syncing

Logs from your self-hosted instance sync to your cloud dashboard.

### What Syncs

- Agent spawn/stop events
- Messages between agents
- Errors and warnings
- Compute usage metrics

### What Doesn't Sync

- File contents
- Full conversation history
- Repository data

### Disable Syncing

If you need fully offline operation:

```bash
agent-relay up --no-sync
```

Note: Without sync, you won't see activity in the cloud dashboard.

## Networking

### Firewall Rules

Agent Relay needs outbound access to:

| Destination | Port | Purpose |
|-------------|------|---------|
| `api.agent-relay.com` | 443 | Cloud API |
| `api.anthropic.com` | 443 | Claude API |
| `api.openai.com` | 443 | OpenAI API |
| `github.com` | 443 | Git operations |

### Behind a Proxy

```bash
export HTTP_PROXY=http://proxy.example.com:8080
export HTTPS_PROXY=http://proxy.example.com:8080
agent-relay up
```

### Air-Gapped Environments

For fully air-gapped environments, use local AI models:

```bash
# Start with Ollama
agent-relay -n Alice ollama

# Or LM Studio
agent-relay -n Bob lmstudio
```

No cloud connection required for local models.

## Monitoring

### Health Check

```bash
# Check daemon health
agent-relay status

# Detailed health info
agent-relay status --verbose
```

### Prometheus Metrics

Enable metrics endpoint:

```bash
agent-relay up --metrics-port 9090
```

Available metrics:
- `agent_relay_agents_active` - Currently running agents
- `agent_relay_messages_total` - Total messages processed
- `agent_relay_spawn_duration_seconds` - Agent spawn latency

### Logging

```bash
# View daemon logs
agent-relay logs

# Follow logs
agent-relay logs -f

# Export to file
agent-relay logs > /var/log/agent-relay.log
```

## Upgrading

### NPM

```bash
npm update -g agent-relay
agent-relay down && agent-relay up
```

### Docker

```bash
docker pull ghcr.io/agentworkforce/agent-relay:latest
docker-compose down && docker-compose up -d
```

## Troubleshooting

### "Cloud connection failed"

1. Check network access to `api.agent-relay.com`
2. Verify credentials: `agent-relay cloud credentials`
3. Re-authenticate: `agent-relay cloud login`

### "Provider not connected"

```bash
# Check provider status
agent-relay cloud credentials

# Reconnect provider
agent-relay cloud connect anthropic
```

### Credential Sync Issues

```bash
# Force credential refresh
agent-relay cloud sync --force

# Check sync status
agent-relay cloud status
```

### Performance Issues

- Ensure adequate RAM (4GB+ recommended)
- Check disk space for repo clones
- Monitor with `agent-relay status --verbose`

## Support

- **Documentation**: [docs.agent-relay.com](https://docs.agent-relay.com)
- **GitHub Issues**: [github.com/khaliqgant/agent-relay/issues](https://github.com/khaliqgant/agent-relay/issues)
- **Email**: support@agent-relay.com (Pro+ plans)
