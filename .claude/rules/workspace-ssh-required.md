---
paths:
  - "deploy/workspace/entrypoint.sh"
  - "deploy/workspace/Dockerfile*"
  - "src/cloud/provisioner/**/*.ts"
---

# Workspace SSH - CRITICAL REQUIREMENT

**NEVER remove SSH support from workspace containers.** SSH tunneling is essential for Codex CLI OAuth callbacks in cloud workspaces.

## Architecture

```
User Browser                 Cloud                    Workspace Container
     |                         |                              |
     |  OAuth redirect to      |                              |
     |  localhost:PORT/callback|                              |
     |------------------------>| SSH tunnel forwards to       |
     |                         |----------------------------->|
     |                         |        Codex receives token  |
```

## Required Components

### 1. Provisioner (`src/cloud/provisioner/index.ts`)

Must pass these environment variables:

```typescript
ENABLE_SSH: 'true',
SSH_PASSWORD: deriveSshPassword(workspace.id),
SSH_PORT: String(WORKSPACE_SSH_PORT),
```

### 2. Entrypoint (`deploy/workspace/entrypoint.sh`)

Must include SSH server setup when `ENABLE_SSH=true`:

```bash
mkdir -p /etc/ssh/sshd_config.d  # REQUIRED - directory may not exist
cat > /etc/ssh/sshd_config.d/workspace.conf <<SSHEOF
# SSH config here
SSHEOF
/usr/sbin/sshd -e -p "${SSH_PORT}"
```

### 3. Dockerfile

Must install SSH server dependencies if SSH is enabled.

## Common Mistakes

1. **Removing SSH "because device flow exists"** - Device flow is a fallback, not a replacement.

2. **Missing directory creation** - Always use `mkdir -p /etc/ssh/sshd_config.d` before writing config.

3. **Merge conflicts reverting SSH code** - When resolving conflicts in `entrypoint.sh`, ensure SSH setup remains intact.

## Testing After Changes

1. Rebuild: `docker build -f deploy/workspace/Dockerfile.local -t relay-workspace:local .`
2. Create a new workspace
3. Verify container starts without errors
4. Test Codex authentication flow
