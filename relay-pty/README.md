# relay-pty

A Rust PTY wrapper for reliable agent message injection. Replaces brittle `tmux send-keys` injection with a clean Unix socket interface.

## Why?

The current tmux-based injection is problematic:
- Shell escaping is complex and error-prone
- Timing heuristics for idle detection are unreliable
- Race conditions between injection and verification
- No flow control (backpressure)

`relay-pty` solves this by:
- Direct PTY write (no shell escaping)
- Unix socket for reliable message delivery
- Built-in queue with priority and backpressure
- Instant verification through output monitoring

## User Experience

**Users see the exact same Claude TUI they're used to.** The PTY is transparent:

```
┌──────────────┐           ┌─────────────┐           ┌───────────────┐
│   User's     │  stdin    │             │   pty     │               │
│  Terminal    │──────────►│  relay-pty  │──────────►│    Claude     │
│  (same TUI)  │◄──────────│             │◄──────────│   (or codex)  │
│              │  stdout   │             │           │               │
└──────────────┘           └─────────────┘           └───────────────┘
                                  ▲
                                  │ Unix socket (injection)
                           ┌──────┴──────┐
                           │   Daemon    │
                           └─────────────┘
```

## Installation

### From Source

```bash
cd relay-pty
cargo build --release
# Binary at target/release/relay-pty
```

### Pre-built Binaries

Coming soon - will be distributed via GitHub releases.

## Usage

### Basic Usage

```bash
# Wrap Claude with relay-pty
relay-pty --name myagent -- claude

# With options
relay-pty \
  --name myagent \
  --socket /tmp/relay-pty-myagent.sock \
  --idle-timeout 500 \
  -- claude --model opus
```

### Options

| Flag | Description | Default |
|------|-------------|---------|
| `--name` | Agent identifier (required) | - |
| `--socket` | Unix socket path | `/tmp/relay-pty-{name}.sock` |
| `--prompt-pattern` | Regex for prompt detection | `^[>$%#] $` |
| `--idle-timeout` | Ms of silence before idle | 500 |
| `--queue-max` | Max queued messages | 50 |
| `--json-output` | Output parsed commands as JSON | false |
| `--max-retries` | Injection retry attempts | 3 |
| `--retry-delay` | Ms between retries | 300 |
| `--log-level` | Log level | info |

## Socket Protocol

The Unix socket accepts JSON-line messages:

### Inject a Message

```json
{"type": "inject", "id": "msg-123", "from": "Alice", "body": "Hello!", "priority": 0}
```

Response:
```json
{"type": "inject_result", "id": "msg-123", "status": "queued", "timestamp": 1705350000000}
```

Status values: `queued`, `injecting`, `delivered`, `failed`

### Query Status

```json
{"type": "status"}
```

Response:
```json
{"type": "status", "agent_idle": true, "queue_length": 2, "last_output_ms": 1500}
```

### Shutdown

```json
{"type": "shutdown"}
```

## Integration with Daemon

The agent-relay daemon should:

1. **Start agents with relay-pty:**
   ```bash
   relay-pty --name worker1 -- claude
   ```

2. **Connect to socket for injection:**
   ```javascript
   const socket = net.connect('/tmp/relay-pty-worker1.sock');
   socket.write(JSON.stringify({
     type: 'inject',
     id: 'msg-abc',
     from: 'Lead',
     body: 'Please implement the auth module'
   }) + '\n');
   ```

3. **Handle responses:**
   ```javascript
   socket.on('data', (data) => {
     const response = JSON.parse(data);
     if (response.status === 'delivered') {
       console.log('Message delivered!');
     }
   });
   ```

## Architecture

```
src/
├── main.rs       # CLI entry point and event loop
├── pty.rs        # PTY creation and management
├── socket.rs     # Unix socket server
├── queue.rs      # Message queue with priority
├── parser.rs     # Output parsing for relay commands
├── inject.rs     # Injection logic and verification
└── protocol.rs   # JSON message types
```

## How Injection Works

1. **Message arrives** via socket
2. **Queued** with priority ordering
3. **Wait for window** (agent idle via prompt detection or silence)
4. **Write to PTY** directly (no shell escaping needed)
5. **Verify** by watching for echo in output
6. **Report result** back to daemon

## Compared to tmux send-keys

| Aspect | tmux send-keys | relay-pty |
|--------|---------------|-----------|
| **Escaping** | Complex shell escaping | Direct PTY write |
| **Latency** | ~200ms (poll interval) | <10ms |
| **Verification** | Poll capture-pane | Real-time output monitor |
| **Flow control** | None | Backpressure protocol |
| **Memory** | Unbounded dedup set | Bounded queue |
| **User experience** | tmux attach | Native terminal |

## Development

```bash
# Build
cargo build

# Run tests
cargo test

# Build release
cargo build --release

# Format
cargo fmt

# Lint
cargo clippy
```

## License

Apache-2.0
