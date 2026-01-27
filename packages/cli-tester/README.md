# @agent-relay/cli-tester

Manual interactive testing environment for CLI authentication flows.

## Purpose

This package provides a Docker-based environment for testing CLI authentication with real OAuth providers. It's designed for:

- **Debugging auth issues** - Isolate problems with specific CLIs (e.g., "Cursor doesn't work")
- **Testing auth flows** - Verify OAuth flows work end-to-end
- **Message injection** - Test relay-pty message delivery
- **Credential verification** - Check that credentials are saved correctly

## Quick Start

From the relay repo root:

```bash
# Start the test environment (drops into container shell)
npm run cli-tester:start

# Start with clean credentials (removes any cached auth)
npm run cli-tester:start:clean

# Start with daemon for full integration testing
npm run cli-tester:start:daemon
```

## Inside the Container

### Test a CLI

```bash
# Test Claude CLI with relay-pty
./scripts/test-cli.sh claude

# Test Codex with device auth
./scripts/test-cli.sh codex --device-auth

# Test with debug output
DEBUG=1 ./scripts/test-cli.sh cursor
```

### Verify Credentials

```bash
# Check if credentials exist (after authenticating)
./scripts/verify-auth.sh claude
./scripts/verify-auth.sh codex
./scripts/verify-auth.sh gemini
```

### Inject Messages

In a second terminal (while CLI is running):

```bash
# Send a message via relay-pty socket
./scripts/inject-message.sh test-claude "What is 2+2?"
```

### Clear Credentials

```bash
# Clear credentials for fresh testing
./scripts/clear-auth.sh claude
./scripts/clear-auth.sh all  # Clear all CLIs
```

## Advanced: Testing Spawn Flow

The simple `test-cli.sh` tests the CLI in isolation. For debugging issues where the CLI works in isolation but fails when spawned via the application (e.g., registration timeout), use these advanced tests:

### Test Spawn Behavior

Simulates what `AgentSpawner.spawn()` does, including CLI-specific flags:

```bash
# Test with same flags as spawner (--force for cursor, --dangerously-skip-permissions for claude)
./scripts/test-spawn.sh cursor

# Test in interactive mode (without auto-accept flags)
./scripts/test-spawn.sh cursor --interactive

# With verbose debug output
DEBUG_SPAWN=1 ./scripts/test-spawn.sh cursor
```

### Test Registration Flow

Monitors the registration files that the spawner polls. This is the step that times out:

```bash
# Watch registration with 60 second timeout
./scripts/test-registration.sh cursor 60

# With debug output
DEBUG_SPAWN=1 ./scripts/test-registration.sh cursor
```

### Full Daemon Integration Test

Starts a real daemon and tests the complete flow:

```bash
# Full end-to-end test with daemon
./scripts/test-with-daemon.sh cursor

# With debug output
DEBUG=1 ./scripts/test-with-daemon.sh cursor
```

**Note:** Requires the daemon to be built: `cd packages/daemon && npm run build`

## Debugging a Broken CLI

When a CLI isn't working, use this workflow:

```bash
# 1. Start fresh
npm run cli-tester:start:clean

# 2. Test the problematic CLI
./scripts/test-cli.sh cursor

# 3. Observe the output for:
#    - Auth URLs being printed
#    - Error messages
#    - Prompt patterns

# 4. Check credentials
./scripts/verify-auth.sh cursor
ls -la ~/.cursor/

# 5. Compare with a working CLI
./scripts/test-cli.sh claude
```

## Debugging Registration Timeout

If a CLI works in isolation but times out when spawned ("Agent registration timeout"), the issue is in the daemon registration flow.

### Quick Test (Run This First)

```bash
# Test the EXACT setup flow - this is what TerminalProviderSetup.tsx does
DEBUG=1 ./scripts/test-full-spawn.sh cursor true
```

This simulates:
- `interactive: true` (no --force flag, like setup terminal)
- 30 second registration timeout
- Verbose logging of what's happening

### Understanding the Flow

**Normal spawn (non-interactive):**
```bash
./scripts/test-full-spawn.sh cursor       # Has --force flag
```

**Setup terminal (interactive):**
```bash
./scripts/test-full-spawn.sh cursor true  # NO --force flag
```

The key difference is `interactive: true` **skips auto-accept flags**. Setup terminals expect the user to respond to prompts in the browser terminal.

### What the Tests Show

1. **test-full-spawn.sh** - Simulates spawner's 30s registration timeout
   - Shows poll count (like spawner logs)
   - Shows socket status
   - Captures CLI output to log file
   - Tells you exactly where things fail

2. **test-setup-flow.sh** - Identical to what TerminalProviderSetup.tsx does
   - Uses `__setup__cursor-xxx` naming
   - No CLI flags (interactive mode)

### Debugging Steps

```bash
# 1. Test in isolation (verify CLI starts)
./scripts/test-cli.sh cursor

# 2. Test NON-INTERACTIVE spawn (with --force)
DEBUG=1 ./scripts/test-full-spawn.sh cursor

# 3. Test INTERACTIVE spawn (setup terminal flow)
DEBUG=1 ./scripts/test-full-spawn.sh cursor true

# 4. Watch the log file in another terminal
tail -f /tmp/relay-spawn-*.log
```

### Common Causes

| Symptom | Cause | Fix |
|---------|-------|-----|
| CLI exits immediately | Not installed or crash | Check `which agent` |
| Socket never created | CLI stuck on early prompt | Check log for prompts |
| 30s timeout | CLI waiting for user input | Respond to prompts (trust, etc.) |
| 30s timeout | No daemon to register with | Run with daemon profile |

### The Registration Flow

The spawner waits for TWO conditions:
1. Agent in `connected-agents.json` (daemon updates this when CLI connects)
2. Agent in `agents.json` (relay-pty hook updates this)

Without a running daemon, both files are empty → timeout.

## Available CLIs

The container includes these pre-installed CLIs:

| CLI | Command | Auth Command | Credential Path |
|-----|---------|--------------|-----------------|
| Claude | `claude` | (auto) | `~/.claude/.credentials.json` |
| Codex | `codex` | `login` | `~/.codex/auth.json` |
| Gemini | `gemini` | (auto) | `~/.gemini/credentials.json` |
| Cursor | `agent` | (auto) | `~/.cursor/auth.json` |
| OpenCode | `opencode` | `auth login` | `~/.local/share/opencode/auth.json` |
| Droid | `droid` | `--login` | `~/.droid/auth.json` |
| Copilot | `copilot` | `auth login` | `~/.config/gh/hosts.yml` |

**Note:** Cursor CLI installs as `agent`, not `cursor`. The test scripts handle this mapping automatically.

## How It Works

1. **relay-pty** wraps the CLI and provides:
   - Unix socket for message injection
   - Output parsing for relay commands
   - Idle detection for message timing

2. **Docker volumes** persist credentials between runs so you don't have to re-authenticate each time.

3. **Shell scripts** provide simple commands for common operations.

## TypeScript API

For programmatic use:

```typescript
import { RelayPtyClient, checkCredentials } from '@agent-relay/cli-tester';

// Check credentials
const result = checkCredentials('claude');
console.log(result.exists, result.valid, result.hasAccessToken);

// Inject messages via socket
const client = new RelayPtyClient('/tmp/relay-pty-test-claude.sock');
await client.connect();
await client.inject({ from: 'Test', body: 'Hello' });
```

## File Structure

```
packages/cli-tester/
├── docker/
│   ├── Dockerfile           # Test environment image
│   └── docker-compose.yml   # Container configuration
├── scripts/
│   ├── start.sh             # Start container
│   ├── test-cli.sh          # Test a CLI with relay-pty
│   ├── verify-auth.sh       # Check credentials
│   ├── inject-message.sh    # Send message via socket
│   └── clear-auth.sh        # Clear credentials
├── src/
│   └── utils/
│       ├── socket-client.ts     # relay-pty socket communication
│       └── credential-check.ts  # Credential file utilities
└── tests/
    └── credential-check.test.ts
```
