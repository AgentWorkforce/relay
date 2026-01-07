# Local Docker Workflow

This guide covers how to work with the relay workspace Docker images locally.

## When to Rebuild

Understanding what code runs where is critical for knowing when rebuilds are needed:

| Code Location | Runs In | Rebuild Needed? |
|--------------|---------|-----------------|
| `src/cloud/*` | Cloud server (`npm run cloud`) | No - just restart |
| `src/dashboard/*` (Next.js) | Cloud server (`npm run cloud`) | No - just restart |
| `src/dashboard-server/*` | Workspace Docker container | **Yes** |
| `src/bridge/spawner.ts` | Workspace Docker container | **Yes** |
| `src/daemon/*` | Workspace Docker container | **Yes** |
| `src/wrapper/*` | Workspace Docker container | **Yes** |
| `src/protocol/*` | Both (shared) | **Yes** for workspace changes |

### Common Scenarios

**Changed cloud API or dashboard UI?**
```bash
# No rebuild needed - just restart
npm run cloud
```

**Changed spawner, dashboard-server, or daemon code?**
```bash
# Must rebuild workspace image
docker build -t ghcr.io/agentworkforce/relay-workspace:latest -f deploy/workspace/Dockerfile .
# Then restart your workspace container
```

**Changed CLI tool versions (Claude, Codex, etc.)?**
```bash
# Must rebuild base image first, then workspace
docker build -t ghcr.io/agentworkforce/relay-workspace-base:latest -f deploy/workspace/Dockerfile.base .
docker build -t ghcr.io/agentworkforce/relay-workspace:latest -f deploy/workspace/Dockerfile .
```

## Quick Start: Using Pre-built Images

The easiest way to run the workspace locally is to pull the pre-built image:

```bash
docker pull ghcr.io/agentworkforce/relay-workspace:latest
docker run -it ghcr.io/agentworkforce/relay-workspace:latest
```

Multi-architecture images (AMD64 and ARM64) are published automatically, so this works on both Intel and Apple Silicon Macs.

## Building Locally

When iterating on changes to the Dockerfile or application code, build locally:

```bash
docker build -t relay-workspace:local -f deploy/workspace/Dockerfile .
docker run -it relay-workspace:local
```

### Rebuilding the Base Image

The workspace image uses a base image (`relay-workspace-base`) that contains CLI tools (Claude, Codex, Gemini, etc.). This base image rarely changes and is cached remotely.

If you need to rebuild the base image locally (e.g., testing CLI version updates):

```bash
# Build base image for your platform
docker build -t ghcr.io/agentworkforce/relay-workspace-base:latest \
  -f deploy/workspace/Dockerfile.base .

# Then build the main image
docker build -t relay-workspace:local -f deploy/workspace/Dockerfile .
```

## CI/CD Workflow

Images are automatically built and pushed to GHCR on:
- Push to `main` branch
- Release publication
- Manual workflow dispatch

### Triggering a Base Image Rebuild

The base image only rebuilds when:
1. `deploy/workspace/Dockerfile.base` changes, OR
2. Manually triggered with `build_base: true`

To manually trigger a base image rebuild:

1. Go to Actions > Docker workflow
2. Click "Run workflow"
3. Check "Rebuild base image"
4. Click "Run workflow"

This is needed when updating CLI versions in `Dockerfile.base`.

## Image Architecture

| Image | Architectures | Registry |
|-------|---------------|----------|
| `relay-workspace-base` | AMD64, ARM64 | `ghcr.io/agentworkforce/relay-workspace-base:latest` |
| `relay-workspace` | AMD64, ARM64 | `ghcr.io/agentworkforce/relay-workspace:latest` |
| `agent-relay` | AMD64, ARM64 | `ghcr.io/agentworkforce/agent-relay:latest` |

## Troubleshooting

### Platform mismatch error

```
ERROR: no match for platform in manifest
```

This means the remote image doesn't have your architecture. Options:

1. **Force AMD64 emulation** (slower):
   ```bash
   docker build --platform linux/amd64 -t relay-workspace:local \
     -f deploy/workspace/Dockerfile .
   ```

2. **Build base image locally** (faster runtime):
   ```bash
   docker build -t ghcr.io/agentworkforce/relay-workspace-base:latest \
     -f deploy/workspace/Dockerfile.base .
   docker build -t relay-workspace:local -f deploy/workspace/Dockerfile .
   ```

3. **Trigger CI rebuild** with ARM64 support (see above)

### Slow builds

The base image contains large CLI tools. If builds are slow:

- Use the pre-built remote image when possible
- Use Docker's build cache (`--cache-from`)
- Only rebuild base image when CLI versions change

## Testing Cloud + Workspace Together

When developing features that span both cloud server and workspace container (like the xterm provider auth flow), follow this workflow:

### 1. Start Infrastructure

```bash
# Start PostgreSQL and Redis (required by cloud server)
npm run services:up

# Or manually:
docker compose -f docker-compose.dev.yml up -d postgres redis
```

### 2. Build Workspace Image (if needed)

```bash
# Only if you changed workspace code (spawner, dashboard-server, daemon, etc.)
docker build -t ghcr.io/agentworkforce/relay-workspace:latest -f deploy/workspace/Dockerfile .
```

### 3. Start Cloud Server

```bash
# In one terminal - runs cloud API + Next.js dashboard
npm run cloud
```

### 4. Create/Start a Workspace

Either through the dashboard UI at `http://localhost:3000`, or the workspace will be provisioned when you connect a provider.

### 5. Iterate

**For cloud-only changes:**
1. Make changes to `src/cloud/*` or `src/dashboard/*`
2. Restart `npm run cloud`
3. Test

**For workspace changes:**
1. Make changes to `src/bridge/*`, `src/dashboard-server/*`, etc.
2. Rebuild: `docker build -t ghcr.io/agentworkforce/relay-workspace:latest -f deploy/workspace/Dockerfile .`
3. Restart your workspace container (or delete and recreate via dashboard)
4. Test

### Example: Testing Provider Auth Flow

The xterm-based provider auth flow involves:
- Cloud server: `src/cloud/api/workspaces.ts` (agent spawn API)
- Cloud server: `src/cloud/server.ts` (WebSocket proxy)
- Next.js: `src/dashboard/app/providers/setup/[provider]/ProviderSetupClient.tsx`
- Workspace: `src/bridge/spawner.ts` (agent spawning)
- Workspace: `src/dashboard-server/server.ts` (WebSocket logs endpoint)

To test changes across this stack:

```bash
# 1. Start services
npm run services:up

# 2. Rebuild workspace (if spawner/dashboard-server changed)
docker build -t ghcr.io/agentworkforce/relay-workspace:latest -f deploy/workspace/Dockerfile .

# 3. Start cloud server
npm run cloud

# 4. Open browser to http://localhost:3000
# 5. Navigate to provider setup and test the flow
```
