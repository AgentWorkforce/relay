# tmux Implementation: Technical Comparison & Analysis

## Head-to-Head: Ours vs Alternative Approach

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                    OUR APPROACH (agent-relay)                        │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│   User Terminal                                                      │
│       │                                                              │
│       ▼                                                              │
│   ┌─────────────────────────────────────────┐                       │
│   │  spawn('tmux', ['attach-session', '-t'])│ ◄── stdio: 'inherit'  │
│   │  User sees REAL tmux session            │                       │
│   └─────────────────────────────────────────┘                       │
│                                                                      │
│   Background Process (same Node.js process)                         │
│       │                                                              │
│       ├─► setInterval(200ms)                                        │
│       │       └─► execAsync('tmux capture-pane -p -J -S -')         │
│       │               └─► parser.parse(output)                      │
│       │                       └─► detect >>relay: patterns           │
│       │                               └─► send to daemon            │
│       │                                                              │
│       └─► onMessage from daemon                                     │
│               └─► wait for idle (1.5s no output)                    │
│                       └─► execAsync('tmux send-keys -l "msg"')      │
│                                                                      │
│   Dependencies: NONE (just tmux + node child_process)               │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                    ALTERNATIVE APPROACH (streaming)                  │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│   Browser (xterm.js)                                                 │
│       │                                                              │
│       │ WebSocket                                                    │
│       ▼                                                              │
│   ┌─────────────────────────────────────────┐                       │
│   │  WebSocket Server (server.mjs)          │                       │
│   │      │                                  │                       │
│   │      ▼                                  │                       │
│   │  node-pty.spawn('tmux', ['attach'])     │ ◄── PTY pseudo-tty    │
│   │      │                                  │                       │
│   │      ├─► pty.onData(data)              │                       │
│   │      │       └─► ws.send(data)          │  Real-time to browser │
│   │      │                                  │                       │
│   │      └─► ws.onMessage(input)           │                       │
│   │              └─► pty.write(input)       │  Real-time from user  │
│   └─────────────────────────────────────────┘                       │
│                                                                      │
│   Messages: Separate system (filesystem + HTTP API)                  │
│       └─► ~/.relay/messages/inbox/{agent}/                          │
│       └─► Agent polls for new files or gets tmux notification       │
│                                                                      │
│   Dependencies: node-pty (native), ws, xterm.js                      │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Technical Deep Dive

### 1. Terminal I/O Method

#### Ours: Polling with `capture-pane`

```typescript
// Every 200ms, capture terminal buffer
private async pollForRelayCommands(): Promise<void> {
  const { stdout } = await execAsync(
    `tmux capture-pane -t ${this.sessionName} -p -J -S - 2>/dev/null`
  );
  //    -p = print to stdout (not to buffer)
  //    -J = join wrapped lines
  //    -S - = start from beginning of scrollback

  const cleanContent = this.stripAnsi(stdout);
  const { commands } = this.parser.parse(cleanContent);
  // ...
}
```

#### Alternative: Streaming with node-pty

```javascript
// Real-time event-driven
const pty = spawn('tmux', ['attach-session', '-t', session]);

pty.onData((data) => {
  // Fires immediately on ANY output
  ws.send(data);  // Forward to browser
  filterAndLog(data);
});
```

#### Comparison

| Aspect | Polling (Ours) | Streaming (Theirs) |
|--------|----------------|-------------------|
| **Latency** | 0-200ms (poll interval) | <10ms (event-driven) |
| **CPU idle** | Constant ~1-2% (polling) | Near 0% (event-driven) |
| **CPU active** | Same | Same |
| **Missed output** | Possible if buffer wraps | Never (stream-based) |
| **Complexity** | ~20 lines | ~50 lines + native dep |
| **Build issues** | None | node-pty compilation |

**Robustness verdict:** Streaming is technically more robust (no missed output), but polling is simpler and "good enough" for text-based agents that don't produce massive output bursts.

---

### 2. User Terminal Experience

#### Ours: Native tmux attach

```typescript
// User's terminal is directly attached to tmux
this.attachProcess = spawn('tmux', ['attach-session', '-t', this.sessionName], {
  stdio: 'inherit',  // <-- KEY: User's stdin/stdout/stderr ARE the tmux session
});
```

**What this means:**
- User's terminal emulator renders tmux directly
- All keybindings work natively (Ctrl+B, mouse, etc.)
- Scrollback, copy/paste work as expected
- No intermediate rendering layer

#### Alternative: Browser-based xterm.js

```javascript
// Terminal rendered in browser via WebGL
const term = new Terminal({
  rendererType: 'webgl',
  convertEol: false,  // PTY handles line endings
});
term.loadAddon(new FitAddon());
term.loadAddon(new WebglAddon());
```

**What this means:**
- Terminal is *emulated* in browser
- Some keybindings may differ
- Scrollback limited by xterm.js buffer
- Copy/paste goes through browser

#### Comparison

| Aspect | Native tmux (Ours) | xterm.js (Theirs) |
|--------|-------------------|-------------------|
| **Keybindings** | 100% native | ~95% (some edge cases) |
| **Scrollback** | tmux buffer (configurable) | xterm.js buffer |
| **Performance** | Native | WebGL (good, but more overhead) |
| **Accessibility** | Terminal emulator's | Browser-based |
| **Remote access** | SSH | Browser (Tailscale) |

**Robustness verdict:** Native is more robust for power users. Browser is more accessible for teams/remote.

---

### 3. Message Injection

#### Ours: Idle detection + send-keys

```typescript
private async injectNextMessage(): Promise<void> {
  // Wait for output to settle
  const timeSinceOutput = Date.now() - this.lastOutputTime;
  if (timeSinceOutput < 1500) {  // 1.5 seconds
    setTimeout(() => this.checkForInjectionOpportunity(), 500);
    return;
  }

  // Clear any partial input
  await this.sendKeys('Escape');
  await this.sleep(30);
  await this.sendKeys('C-u');  // Clear line
  await this.sleep(30);

  // Type the message
  await this.sendKeysLiteral(message);
  await this.sleep(50);
  await this.sendKeys('Enter');
}

private async sendKeysLiteral(text: string): Promise<void> {
  const escaped = text
    .replace(/[\r\n]+/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`')
    .replace(/!/g, '\\!');
  await execAsync(`tmux send-keys -t ${this.sessionName} -l "${escaped}"`);
}
```

#### Alternative: Multiple injection methods

```bash
# Method 1: display-message (non-intrusive popup)
tmux display-message -t $SESSION "Message from $FROM: $MSG"

# Method 2: send-keys with echo (injects shell command)
tmux send-keys -t $SESSION "echo '📬 MESSAGE: $MSG'" Enter

# Method 3: send-keys literal (injects text)
tmux send-keys -t $SESSION -l "Message: $MSG"
```

#### Comparison

| Aspect | Our Approach | Their Approach |
|--------|--------------|----------------|
| **Idle detection** | Time-based (1.5s) | None (fire and forget) |
| **Input clearing** | Yes (Esc + Ctrl-U) | No |
| **Race conditions** | Reduced | Possible |
| **CLI-specific** | Yes (Gemini printf) | Partial |
| **Intrusive** | Yes (types into prompt) | display-message is not |

**Robustness verdict:** Our approach is more robust because of idle detection and input clearing. Their `display-message` is less intrusive but also less reliable for LLM consumption.

---

### 4. Message Detection/Parsing

#### Ours: Pattern matching on terminal output

```typescript
// Parser handles real-world terminal mess
const INLINE_RELAY = /^(?:\s*(?:[>$%#→➜›»●•◦‣⁃\-*⏺◆◇○□■]\s*)*)?>>relay:(\S+)\s+(.+)$/;

// Strip ANSI codes
const ANSI_PATTERN = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\].*?(?:\x07|\x1b\\)|\r/g;

// Handle continuation lines (TUI wrapping)
private joinContinuationLines(content: string): string {
  // Claude Code and TUIs insert real newlines...
}

// Track what we've already processed
private sentMessageHashes: Set<string> = new Set();
```

#### Alternative: No parsing needed

```javascript
// Messages are sent via API/CLI, not terminal output
send-relay-message.sh Bob "Subject" "Body"

// Creates file in ~/.relay/messages/inbox/Bob/
// Agent's "subconscious" polls filesystem for new files
```

#### Comparison

| Aspect | Pattern Parsing (Ours) | API-based (Theirs) |
|--------|------------------------|-------------------|
| **Agent effort** | Just output text | Call external script |
| **Natural** | Yes (`>>relay:Bob hi`) | No (shell command) |
| **Reliable** | ~95% (edge cases) | 100% (structured) |
| **Multi-line** | Complex (continuation) | Easy (JSON body) |
| **ANSI codes** | Must strip | N/A |

**Robustness verdict:** API-based is technically more robust (no parsing edge cases). But pattern-based is more natural for agents - they just "speak" instead of calling tools.

---

### 5. Session Management

#### Ours: One wrapper = one session

```typescript
// Generate unique session name
this.sessionName = `relay-${config.name}-${process.pid}`;

// Create session
execSync(`tmux new-session -d -s ${this.sessionName} -x ${cols} -y ${rows}`);

// Set environment
execSync(`tmux setenv -t ${this.sessionName} AGENT_RELAY_NAME ${name}`);

// When wrapper exits, session is killed
stop(): void {
  execSync(`tmux kill-session -t ${this.sessionName} 2>/dev/null`);
}
```

#### Alternative: Discovery-based

```typescript
// Discover existing sessions
async function discoverLocalSessions(): Promise<Session[]> {
  const { stdout } = await execAsync('tmux list-sessions -F "#{session_name}"');
  return stdout.trim().split('\n').map(name => ({
    name,
    // Fetch metadata
    cwd: await execAsync(`tmux display-message -t ${name} -p '#{pane_current_path}'`)
  }));
}

// Sessions can exist without agents
// Agents can exist without sessions
// Linking is optional
```

#### Comparison

| Aspect | Wrapper-owns-session (Ours) | Discovery-based (Theirs) |
|--------|----------------------------|-------------------------|
| **Lifecycle** | Coupled (wrapper=session) | Decoupled |
| **Pre-existing** | No | Yes |
| **Orphan sessions** | No (killed on exit) | Possible |
| **Flexibility** | Lower | Higher |

**Robustness verdict:** Their approach is more flexible (can attach to existing sessions). Our approach is simpler and prevents orphan sessions.

---

## Which is More Robust?

### Our Strengths

| Area | Why We're Stronger |
|------|-------------------|
| **Native experience** | Direct tmux attach, no emulation layer |
| **Simplicity** | No native dependencies, no WebSocket complexity |
| **Injection** | Idle detection prevents race conditions |
| **CLI support** | Special handling for Gemini, etc. |
| **Deduplication** | Won't send same message twice |

### Their Strengths

| Area | Why They're Stronger |
|------|---------------------|
| **Real-time** | Event-driven, no polling latency |
| **Visibility** | Browser dashboard shows all agents |
| **Message reliability** | Filesystem-based, never lost |
| **Remote access** | Browser-based, works via Tailscale |
| **Agent decoupling** | Agents exist independent of sessions |

---

## Recommended Improvements for Robustness

### 1. Add Activity State Tracking (from their approach)

```typescript
// Track active/idle/disconnected state
private activityState: 'active' | 'idle' | 'disconnected' = 'active';
private lastActivityTime = Date.now();

private updateActivityState(): void {
  const elapsed = Date.now() - this.lastActivityTime;

  if (elapsed > 30_000) {
    this.activityState = 'idle';
    // Idle is the BEST time to inject
    this.flushMessageQueue();
  } else if (elapsed > 5_000) {
    this.activityState = 'idle';
  } else {
    this.activityState = 'active';
  }
}
```

### 2. Add Exponential Backoff for Reconnection

```typescript
private readonly RECONNECT_DELAYS = [100, 500, 1000, 2000, 5000];
private reconnectAttempt = 0;

private reconnect(): void {
  if (this.reconnectAttempt >= this.RECONNECT_DELAYS.length) {
    this.logStderr('Max reconnection attempts, operating offline');
    return;
  }

  const delay = this.RECONNECT_DELAYS[this.reconnectAttempt++];
  setTimeout(() => this.client.connect(), delay);
}
```

### 3. Consider Hybrid: Streaming + Pattern Parsing

```typescript
// Best of both worlds (optional mode)
import { spawn } from 'node-pty';

// Read-only PTY attach for real-time output
const pty = spawn('tmux', ['attach-session', '-t', session, '-r']);

pty.onData((data) => {
  // Real-time pattern detection
  const { commands } = this.parser.parse(data);
  for (const cmd of commands) {
    this.sendRelayCommand(cmd);
  }
});

// Still use send-keys for injection (works on attached session)
```

### 4. Add Bracketed Paste for Safer Injection

```typescript
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

async function injectSafe(text: string): Promise<void> {
  // Bracketed paste prevents shell interpretation
  await sendKeysLiteral(PASTE_START + text + PASTE_END);
  await sendKeys('Enter');
}
```

---

## Known Issue: `@` Symbol Conflicts with Gemini

### The Problem

Gemini CLI uses `@` for file references:
```bash
gemini> @src/main.ts    # References a file
gemini> >>relay:Bob Hi   # Gemini might try to open file "relay:Bob"!
```

This could explain why Gemini agents have trouble sending relay messages - the CLI intercepts `@` before it reaches the terminal output.

### Proposed Alternative Prefixes

| Prefix | Example | Pros | Cons |
|--------|---------|------|------|
| `>>` | `>>Bob: Hello` | Simple, intuitive | Could conflict with shell redirect |
| `->` | `->Bob: Hello` | Clear direction | Might look like code |
| `#relay:` | `#relay:Bob Hello` | Hashtag is common | Could conflict with comments |
| `!relay:` | `!relay:Bob Hello` | Bang is distinct | Could trigger shell history |
| `/relay` | `/relay Bob Hello` | Slash command style | Familiar pattern |
| `[[relay]]` | `[[relay:Bob]] Hello` | Very distinct | Verbose |
| `@>` | `@>Bob: Hello` | Keeps @ but distinct | Still has @ |
| `relay::` | `relay::Bob Hello` | No special prefix char | Plain text |

### Recommended: Configurable Prefix

Support multiple prefixes with a default that works everywhere:

```typescript
// In config
{
  "relayPrefix": ">>relay:",     // Default (works for Claude, Codex)
  // Alternatives:
  // "relayPrefix": ">>",        // For Gemini
  // "relayPrefix": "/relay",    // Slash command style
  // "relayPrefix": "relay::",   // Plain text
}

// In parser.ts
const prefix = config.relayPrefix || '>>relay:';
const pattern = new RegExp(`^(?:\\s*)?${escapeRegex(prefix)}(\\S+)\\s+(.+)$`);
```

### Testing Gemini with Alternative Prefix

```bash
# Start with alternative prefix
agent-relay -n GeminiAgent --prefix=">>" gemini

# Agent outputs:
>>Bob: Can you review this code?

# Instead of:
>>relay:Bob Can you review this code?
```

### Implementation: CLI Flag

```typescript
// In cli/index.ts
.option('--prefix <pattern>', 'Relay pattern prefix (default: >>relay:)')

// In wrapper config
const wrapperConfig: TmuxWrapperConfig = {
  name: options.name,
  command: mainCommand,
  args: commandArgs,
  relayPrefix: options.prefix || '>>relay:',
  // ...
};
```

### Parser Update

```typescript
// In parser.ts
export class OutputParser {
  private prefix: string;
  private inlinePattern: RegExp;

  constructor(options: ParserOptions = {}) {
    this.prefix = options.prefix || '>>relay:';

    // Build pattern dynamically
    const escaped = this.escapeRegex(this.prefix);
    this.inlinePattern = new RegExp(
      `^(?:\\s*(?:[>$%#→➜›»●•◦‣⁃\\-*⏺◆◇○□■]\\s*)*)?${escaped}(\\S+)\\s+(.+)$`
    );
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
```

### Recommendation

1. **Short term:** Add `--prefix` flag to test with Gemini
2. **Default for Gemini:** Auto-detect and use `>>` or `/relay`
3. **Long term:** Document which prefix works best per CLI

```typescript
// Auto-detect best prefix for CLI type
function getDefaultPrefix(cliType: string): string {
  switch (cliType) {
    case 'gemini':
      return '>>';        // Avoid @ conflict
    case 'claude':
    case 'codex':
    default:
      return '>>relay:';   // Original, works fine
  }
}
```

---

## Verdict: Overall Robustness

| Category | Winner | Reason |
|----------|--------|--------|
| **Message detection** | Tie | Ours is natural, theirs is reliable |
| **Message delivery** | Ours | Idle detection prevents corruption |
| **Terminal fidelity** | Ours | Native > emulated |
| **Real-time** | Theirs | Streaming > polling |
| **Simplicity** | Ours | No native deps, no browser |
| **Visibility** | Theirs | Dashboard > logs |
| **Multi-agent** | Theirs | Built for teams |

**Overall:** For 2-3 agents, **ours is more robust** (simpler, fewer failure modes). For 5-10 agents, **theirs scales better** (visibility, discovery). The recommended improvements above would close the gap.

---

## Current Implementation Summary

Our tmux wrapper uses an **attach-based polling architecture**:

```
┌─────────────────────────────────────────────────────────────┐
│  User Terminal                                               │
│    └─ tmux attach-session (stdio: 'inherit')                │
│         └─ User sees real tmux session                      │
│                                                              │
│  Background (every 200ms)                                    │
│    └─ tmux capture-pane -p -J -S -                          │
│         └─ Parse for >>relay: patterns                       │
│         └─ Send detected commands to daemon                 │
│                                                              │
│  Message Injection                                           │
│    └─ Wait for 1.5s idle                                    │
│    └─ tmux send-keys (Escape, C-u, message, Enter)         │
└─────────────────────────────────────────────────────────────┘
```

---

## Alternative Approach: WebSocket + node-pty

A different approach uses **real-time PTY streaming** instead of polling:

```
┌─────────────────────────────────────────────────────────────┐
│  Browser/Client                                              │
│    └─ xterm.js terminal                                     │
│         └─ WebSocket connection                             │
│                                                              │
│  Server                                                      │
│    └─ node-pty spawns: tmux attach -t session               │
│         └─ pty.onData → ws.send (real-time streaming)       │
│         └─ ws.onMessage → pty.write (real-time input)       │
│                                                              │
│  No polling needed - events are instant                      │
└─────────────────────────────────────────────────────────────┘
```

---

## Key Differences

| Aspect | Our Approach (Polling) | Alternative (Streaming) |
|--------|------------------------|-------------------------|
| **Terminal location** | User's actual terminal | Browser (xterm.js) |
| **Data flow** | Periodic capture-pane | Real-time PTY events |
| **Latency** | 0-200ms | ~1-10ms |
| **CPU usage** | Constant (polling) | Event-driven (lower) |
| **Complexity** | Simple shell commands | node-pty + WebSocket |
| **Dependencies** | None (just tmux) | node-pty, ws, xterm.js |
| **User experience** | Native terminal feel | Browser-based |

---

## What We Do Better

### 1. Native Terminal Experience

Users stay in their actual terminal. No browser, no xterm.js emulation quirks.

```bash
# Our approach - user is IN the tmux
agent-relay -n Alice claude
# User types directly, sees real output

# Alternative - user is in browser
# Terminal is rendered in xterm.js WebGL
# Subtle differences in keybindings, scrolling, copy/paste
```

**Keep this.** The native feel is valuable.

### 2. Simpler Dependencies

We only need tmux and Node.js. No native compilation (node-pty), no browser components.

```json
// Our package.json - no native deps
{
  "dependencies": {
    "commander": "^12.0.0",
    "better-sqlite3": "^9.0.0"
    // That's it for core functionality
  }
}

// Alternative needs
{
  "dependencies": {
    "node-pty": "^1.0.0",      // Native compilation required
    "xterm": "^5.0.0",          // Browser terminal
    "xterm-addon-fit": "...",
    "xterm-addon-webgl": "...",
    "ws": "^8.0.0"
  }
}
```

**Keep this.** Simpler install, fewer build issues.

### 3. Pattern-Based Communication

Agents just output `>>relay:Name message`. No API calls, no special handling.

```
# Our approach - agent outputs text naturally
Claude: I'll ask Bob for help.
>>relay:Bob Can you review the auth module?

# Alternative - agent calls external script
Claude: I'll ask Bob for help.
!send-message Bob "Can you review the auth module?"
```

**Keep this.** It's our killer feature.

---

## What We Can Improve

### 1. Activity Tracking

The alternative tracks session activity state (active/idle/disconnected) with timestamps:

```typescript
// Their approach
const sessionActivity: Map<string, number> = new Map();

// On any output
sessionActivity.set(sessionName, Date.now());

// Idle detection
const IDLE_THRESHOLD = 30_000; // 30 seconds
function getSessionStatus(name: string): 'active' | 'idle' | 'disconnected' {
  const lastActivity = sessionActivity.get(name);
  if (!lastActivity) return 'disconnected';
  return Date.now() - lastActivity > IDLE_THRESHOLD ? 'idle' : 'active';
}
```

**Improvement:** Add activity tracking for better injection timing:

```typescript
// In tmux-wrapper.ts
private lastActivityTime = Date.now();
private activityState: 'active' | 'idle' = 'active';

private updateActivityState(): void {
  const now = Date.now();
  const wasActive = this.activityState === 'active';

  if (now - this.lastActivityTime > 30_000) {
    this.activityState = 'idle';
    if (wasActive) {
      this.logStderr('Session went idle');
      // Good time to check for messages
      this.checkForInjectionOpportunity();
    }
  }
}
```

### 2. Graceful Reconnection

The alternative implements exponential backoff for WebSocket reconnection:

```typescript
// Their approach
const RECONNECT_DELAYS = [100, 500, 1000, 2000, 5000];
let reconnectAttempt = 0;

function reconnect() {
  if (reconnectAttempt >= RECONNECT_DELAYS.length) {
    console.error('Max reconnection attempts reached');
    return;
  }

  setTimeout(() => {
    connect();
    reconnectAttempt++;
  }, RECONNECT_DELAYS[reconnectAttempt]);
}
```

**Improvement:** Add to our RelayClient:

```typescript
// In client.ts
private reconnectAttempts = 0;
private readonly MAX_RECONNECT_ATTEMPTS = 5;
private readonly RECONNECT_DELAYS = [100, 500, 1000, 2000, 5000];

private scheduleReconnect(): void {
  if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
    this.logStderr('Relay connection failed, operating offline');
    return;
  }

  const delay = this.RECONNECT_DELAYS[this.reconnectAttempts];
  this.reconnectAttempts++;

  setTimeout(() => {
    this.connect().catch(() => this.scheduleReconnect());
  }, delay);
}
```

### 3. Agent Registry Persistence

The alternative stores agent metadata in a persistent registry:

```typescript
// Alternative approach - ~/.relay/agents/registry.json
{
  "agents": {
    "agent-abc123": {
      "id": "agent-abc123",
      "name": "Alice",
      "aliases": ["alice", "dev-alice"],
      "workingDirectory": "/home/user/project",
      "cli": "claude",
      "createdAt": "2025-12-20T10:00:00Z",
      "lastSeen": "2025-12-20T14:30:00Z"
    }
  }
}
```

**Improvement:** Add agent registry:

```typescript
// New file: src/daemon/registry.ts
interface AgentRecord {
  id: string;
  name: string;
  cli: string;
  workingDirectory: string;
  firstSeen: string;
  lastSeen: string;
  messagesSent: number;
  messagesReceived: number;
}

class AgentRegistry {
  private registryPath: string;
  private agents: Map<string, AgentRecord> = new Map();

  constructor(dataDir: string) {
    this.registryPath = path.join(dataDir, 'agents.json');
    this.load();
  }

  register(name: string, cli: string, cwd: string): AgentRecord {
    const existing = this.agents.get(name);
    if (existing) {
      existing.lastSeen = new Date().toISOString();
      this.save();
      return existing;
    }

    const record: AgentRecord = {
      id: `agent-${randomId()}`,
      name,
      cli,
      workingDirectory: cwd,
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      messagesSent: 0,
      messagesReceived: 0,
    };

    this.agents.set(name, record);
    this.save();
    return record;
  }
}
```

### 4. Session Discovery

The alternative auto-discovers tmux sessions:

```typescript
// Their approach
async function discoverLocalSessions(): Promise<Session[]> {
  const { stdout } = await execAsync('tmux list-sessions -F "#{session_name}"');
  const sessionNames = stdout.trim().split('\n').filter(Boolean);

  return Promise.all(sessionNames.map(async (name) => {
    const { stdout: cwd } = await execAsync(
      `tmux display-message -t ${name} -p '#{pane_current_path}'`
    );
    return { name, workingDirectory: cwd.trim() };
  }));
}
```

**Improvement:** Add discovery for better `agent-relay status`:

```typescript
// In cli/index.ts - enhance status command
async function discoverRelaySessions(): Promise<SessionInfo[]> {
  try {
    const { stdout } = await execAsync('tmux list-sessions -F "#{session_name}"');
    const sessions = stdout.trim().split('\n').filter(Boolean);

    // Filter to relay sessions only
    return sessions
      .filter(name => name.startsWith('relay-'))
      .map(name => {
        const match = name.match(/^relay-(.+)-\d+$/);
        return match ? { sessionName: name, agentName: match[1] } : null;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}
```

### 5. Output Filtering

The alternative filters noisy patterns from logs:

```typescript
// Their approach - filter thinking indicators, escape sequences
const NOISE_PATTERNS = [
  /\[\d+\/\d+\]/,           // [1/418] thinking steps
  /\x1b\[[0-9;]*[mK]/,      // ANSI escape sequences
  /^Thinking\.{1,3}$/,       // "Thinking..." lines
];

function filterNoise(output: string): string {
  return output.split('\n')
    .filter(line => !NOISE_PATTERNS.some(p => p.test(line)))
    .join('\n');
}
```

**Improvement:** Add optional output filtering for cleaner logs:

```typescript
// In tmux-wrapper.ts
private filterForLogging(output: string): string {
  if (!this.config.filterLogs) return output;

  return output
    .split('\n')
    .filter(line => {
      // Skip thinking indicators
      if (/^\[[\d/]+\]/.test(line)) return false;
      // Skip empty ANSI-only lines
      if (this.stripAnsi(line).trim() === '') return false;
      return true;
    })
    .join('\n');
}
```

---

## Rejected Ideas

### 1. Browser-Based Terminal

Moving to xterm.js would lose the native terminal feel. Users expect to use their own terminal with their own keybindings, themes, and muscle memory.

**Decision:** Keep native tmux attach.

### 2. Full node-pty Integration

Using node-pty for output streaming would add native dependencies and build complexity. The polling approach works well enough.

**Decision:** Keep capture-pane polling. Consider optional streaming as future enhancement.

### 3. Complex Agent Lifecycle

The alternative supports agents without sessions, complex metadata, and persistent memory. This adds significant complexity.

**Decision:** Keep it simple. Agent = wrapper process. When wrapper exits, agent is gone.

---

## Implementation Priority

| Improvement | Effort | Impact | Priority |
|-------------|--------|--------|----------|
| Activity tracking | Low | Medium | P1 |
| Reconnection backoff | Low | Medium | P1 |
| Session discovery | Low | Low | P2 |
| Agent registry | Medium | Medium | P2 |
| Output filtering | Low | Low | P3 |

---

## Summary

Our tmux implementation is **simpler and more native** than alternatives. The key improvements to adopt:

1. **Activity state tracking** - Better injection timing
2. **Exponential backoff** - Graceful daemon reconnection
3. **Session discovery** - Better status output
4. **Agent registry** - Persistence across restarts

These add minimal complexity while improving reliability. The core architecture (polling + pattern parsing + injection) remains unchanged.
