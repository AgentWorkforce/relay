# tmux Implementation Notes

## Previous Failure Analysis

### What Failed: "Game never even started"

The previous tmux implementation had these issues:

1. **Nested PTY Attachment**: Created tmux session, then attached via node-pty
   ```typescript
   // Created tmux session
   execSync(`tmux new-session -d -s ${session} '${command}'`);
   // Then attached via PTY
   this.ptyProcess = pty.spawn('tmux', ['attach-session', '-t', session]);
   ```
   This creates: Agent CLI → tmux → tmux attach → node-pty
   Double terminal layer causes escape sequence issues.

2. **Command Quoting Problem**: Single quotes break complex commands
   ```bash
   tmux new-session -d -s session 'claude -p "You're playing..."'
   # The apostrophe in "You're" breaks the quoting
   ```

3. **Environment Variables Not Passed**: ENV vars set on attach, not on session
   - The agent process inside tmux doesn't see AGENT_RELAY_NAME

4. **No Session Ready Wait**: Attached immediately after creating session
   - Session might not be ready, causing race conditions

## New Architecture: No Attachment

```
┌──────────────────────────────────┐
│  tmux session "relay-AgentX"     │
│  (detached, running in background)│
│  ┌────────────────────────────┐  │
│  │  agent CLI process         │  │
│  │  (claude, codex, etc)      │  │
│  └────────────────────────────┘  │
└──────────────────────────────────┘
         ↑                    ↓
    send-keys            capture-pane
    (inject input)       (read output)
         │                    │
┌──────────────────────────────────┐
│  TmuxWrapper (this process)      │
│  - Polls capture-pane @ 100ms    │
│  - Detects new output (diff)     │
│  - Parses @relay: commands       │
│  - Writes to stdout for user     │
│  - Injects messages via send-keys│
│  - Forwards user stdin to tmux   │
└──────────────────────────────────┘
```

## Key Differences from Previous Implementation

1. **No PTY attachment** - Eliminates double-terminal problem
2. **capture-pane polling** - Direct access to terminal content
3. **Proper command escaping** - Use shell escaping, not simple quotes
4. **Environment via tmux** - Set ENV in tmux session directly
5. **Session ready wait** - Wait for session to be active before proceeding

## Implementation Details

### Starting a Session

```bash
# Set environment variables IN the tmux session
tmux new-session -d -s relay-AgentX \
  -x 120 -y 40 \
  "export AGENT_RELAY_NAME=AgentX; exec claude"
```

### Capturing Output

```bash
# Capture entire scrollback (not just visible pane)
tmux capture-pane -t relay-AgentX -p -S -
```

### Sending Input

```bash
# Use -l for literal string (no escaping needed)
tmux send-keys -t relay-AgentX -l "Your message here"
tmux send-keys -t relay-AgentX Enter
```

### Handling User Input

Forward process stdin to tmux session:
```typescript
process.stdin.on('data', (data) => {
  execSync(`tmux send-keys -t ${session} -l "${escape(data)}"`);
});
```

## Edge Cases to Handle

1. **Fast output**: capture-pane might miss fast scrolling
   - Solution: Use -S - to get full scrollback, diff against last capture

2. **Binary/escape sequences**: Output might contain control characters
   - Solution: Strip ANSI codes before parsing @relay:

3. **Session death**: tmux session might exit
   - Solution: Monitor with `tmux has-session -t session`

4. **Multiple messages**: Several @relay: in one capture
   - Solution: Track last processed line/position

5. **Stdin race conditions**: User types while we inject
   - Solution: Queue injections, use mutex/lock

## Testing Plan

1. **Basic session start**: Does claude actually launch in tmux?
2. **Output capture**: Can we see claude's output?
3. **Input injection**: Can we send text and get response?
4. **@relay detection**: Does parser find @relay: commands?
5. **Full game**: Two agents playing tic-tac-toe

## Rollback Plan

If this doesn't work, fall back to:
1. File-based inbox (already implemented)
2. Hook-based polling (Claude only)
3. Spawn-per-message (loses context)

---

## Implementation Complete - Testing Instructions

### Build Status: SUCCESS

The new TmuxWrapper has been implemented at:
- `src/wrapper/tmux-wrapper.ts`

CLI updated to support `--tmux2` flag.

### Quick Test: Basic Session Start

```bash
# Test 1: Does bash work in tmux?
node dist/cli/index.js wrap --tmux2 -n TestAgent -- bash

# You should see:
# - "Mode: tmux2 (new simplified tmux wrapper)"
# - Bash prompt in your terminal
# - Type commands, they should work
# - Ctrl+C to exit
```

### Test 2: Simple Echo Command

```bash
# Start with echo (should immediately show output and exit)
node dist/cli/index.js wrap --tmux2 -n TestAgent -- echo "Hello World"
```

### Test 3: Claude CLI (No Relay)

```bash
# Test Claude starts correctly
node dist/cli/index.js wrap --tmux2 -n PlayerX -- claude

# Expected: Claude CLI starts, you can interact with it
```

### Test 4: With Relay Daemon

```bash
# Terminal 1: Start daemon
node dist/cli/index.js start -f

# Terminal 2: Start PlayerX
node dist/cli/index.js wrap --tmux2 -n PlayerX -- claude

# Terminal 3: Start PlayerO
node dist/cli/index.js wrap --tmux2 -n PlayerO -- claude

# Terminal 4: Send a test message
node dist/cli/index.js send -f Coordinator -t PlayerX -m "Hello from Coordinator"

# Expected: PlayerX terminal should show the message and inject it
```

### Test 5: Tic-Tac-Toe

```bash
# Terminal 1: Daemon
node dist/cli/index.js start -f

# Terminal 2: PlayerX
node dist/cli/index.js wrap --tmux2 -n PlayerX -- claude -p "You are PlayerX playing tic-tac-toe. Use @relay:PlayerO to send moves. Start with your first move."

# Terminal 3: PlayerO
node dist/cli/index.js wrap --tmux2 -n PlayerO -- claude -p "You are PlayerO playing tic-tac-toe. Use @relay:PlayerX to send moves. Wait for PlayerX to start."
```

### Debugging

```bash
# Check if tmux session exists
tmux list-sessions

# Attach to session manually to see what's happening
tmux attach -t relay-PlayerX-<pid>

# Kill stuck sessions
tmux kill-server
```

### Key Differences from Old tmux Implementation

1. **No PTY attachment** - We don't `tmux attach` via node-pty
2. **capture-pane polling** - Read output by polling, not events
3. **send-keys -l** - Use literal mode for text injection
4. **Environment via tmux setenv** - Set ENV vars in tmux session directly
5. **Simpler architecture** - Less layers = fewer failure points

---

## Test Results - December 19, 2025

### Basic Test: PASSED

Message injection into bash session works:

```
[daemon] Agent registered: TestAgent
[router] Coordinator -> TestAgent: Hello TestAgent!...
[router] Delivered to TestAgent: success
[tmux:TestAgent] ← Coordinator: Hello TestAgent!...
[tmux:TestAgent] Injecting message from Coordinator
[tmux:TestAgent] Message injected successfully
bash-3.2$ Relay message from Coordinator: Hello TestAgent!
```

The message was successfully typed into the bash terminal via tmux send-keys.

### What Works

1. **Session creation** - tmux session starts correctly
2. **Output capture** - capture-pane polling detects new output
3. **Relay connection** - Agent connects to daemon
4. **Message routing** - Messages route between agents
5. **Message injection** - Text is typed into the terminal via send-keys

### Next Steps

1. Test with Claude CLI (replace bash with claude)
2. Test full tic-tac-toe game between two agents
3. Verify @relay: command parsing works in both directions
4. Check if multi-round injection remains stable (previous implementations failed after 2-3 rounds)

### Critical Question

Does this implementation avoid the "fails after a few rounds" problem? The key difference:

- **Old approach**: PTY stdin write (`ptyProcess.write()`) - corrupts over time
- **New approach**: tmux send-keys (`tmux send-keys -l "..."`) - should be more stable

---

## December 19, 2025 - Attach-Based Implementation: SUCCESS

### Problem with First tmux Attempt

The first tmux wrapper tried to:
1. Poll `capture-pane` for output
2. Write output to stdout
3. This caused display corruption after message injection

### Solution: Direct Attach

New architecture:
1. Start agent in detached tmux session
2. **Attach user directly** via `spawn('tmux', ['attach'], { stdio: 'inherit' })`
3. Background polling is **completely silent** (no stdout writes)
4. Injection via `send-keys` works on attached session
5. Logs only to stderr

### Test Result: PASSED

Message injection works without display corruption:
```bash
# Terminal 1: Daemon
node dist/cli/index.js start -f

# Terminal 2: Agent
node dist/cli/index.js wrap --tmux2 -n PlayerX -- claude

# Terminal 3: Send message
node dist/cli/index.js send -f Test -t PlayerX -m "Hello!"
# → Message injected successfully, display intact
```

### Next: Multi-Round Tic-Tac-Toe Test

The critical test is whether injection remains stable over multiple rounds:
```bash
# Terminal 1: Daemon
node dist/cli/index.js start -f

# Terminal 2: PlayerX
node dist/cli/index.js wrap --tmux2 -n PlayerX -- claude -p "Play tic-tac-toe. Use @relay:PlayerO to send moves."

# Terminal 3: PlayerO
node dist/cli/index.js wrap --tmux2 -n PlayerO -- claude -p "Play tic-tac-toe. Use @relay:PlayerX to send moves."
```

If this works for a full game (5-9 moves), we've solved the problem.

---

## December 19, 2025 - Command Quoting Fix

### Problem

Running with `-p` flag failed:
```bash
node dist/cli/index.js wrap --tmux2 -n PlayerX -- claude -p "You are PlayerX..."
# Result: Claude terminal didn't open
```

### Root Cause

The CLI was joining all command parts into a single string at line 229:
```typescript
const command = commandParts.join(' ');
```

And passing only this joined string to TmuxWrapper. But by the time args reach Node.js,
the shell has already stripped the outer quotes, so `commandParts` = `['claude', '-p', 'You are PlayerX...']`.

When joined back together without re-quoting: `claude -p You are PlayerX...` - the prompt is split.

### Fix

1. **CLI (index.ts)**: Split command and args separately:
   ```typescript
   const [mainCommand, ...commandArgs] = commandParts;
   // Pass to TmuxWrapper as:
   // command: mainCommand ('claude')
   // args: commandArgs (['-p', 'You are PlayerX...'])
   ```

2. **TmuxWrapper**: `buildCommand()` re-quotes args containing spaces:
   ```typescript
   private buildCommand(): string {
     const quotedArgs = this.config.args.map(arg => {
       if (arg.includes(' ') || arg.includes('"') || arg.includes("'")) {
         return `"${arg.replace(/"/g, '\\"')}"`;
       }
       return arg;
     });
     return `${this.config.command} ${quotedArgs.join(' ')}`;
   }
   ```

Result: `claude -p "You are PlayerX..."` is correctly sent to tmux.
