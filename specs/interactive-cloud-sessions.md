# Interactive Cloud Sessions

**Status**: Draft
**Date**: 2026-04-07
**Author**: Design session (human + Claude)

---

## 1. Overview & Motivation

agent-relay currently has two modes for running agents, each with a significant limitation:

| Mode           | Command                               | Isolation                          | Interactive |
| -------------- | ------------------------------------- | ---------------------------------- | ----------- |
| Local          | `agent-relay on claude`               | None -- agent can escape mount dir | Yes         |
| Cloud workflow | `agent-relay cloud run workflow.yaml` | Full container isolation (Daytona) | No          |

**The gap:** There is no way to get an interactive agent session running inside a fully isolated cloud container. Users who want true isolation for interactive work -- exploring a codebase, debugging, iterating on changes -- have no option today.

Interactive cloud sessions close this gap by combining the interactivity of `agent-relay on` with the isolation guarantees of `agent-relay cloud run`.

### Why this matters

- **True isolation**: Container filesystem/process/network boundaries mean the agent cannot touch anything outside the project. No accidental `rm -rf /` on the host.
- **Zero setup**: No local Docker, no VM configuration. The cloud provisions an ephemeral Daytona container with the agent CLI pre-installed.
- **Secret exclusion**: `.env`, credentials, and SSH keys never enter the container -- only project source code does.
- **Ephemeral by default**: The container is destroyed on exit. No lingering state, no cleanup burden.
- **Consistent environment**: Every session gets the same base image regardless of the developer's local OS or toolchain.

---

## 2. User-Facing API

### Command

Reuse the existing `--cloud` flag on the `on` command, but change its behavior from "use remote relayfile with local process" to "run the entire agent session in a cloud container":

```bash
agent-relay on claude --cloud
```

This is the primary interface. The `--cloud` flag already exists on the `on` command (registered in `src/cli/commands/on.ts` line 39) and currently only switches file storage to remote relayfile while still spawning the agent locally. The new behavior replaces the local spawn entirely.

### End-to-End User Experience

```
$ agent-relay on claude --cloud
Authenticating with Agent Relay Cloud...
Creating tarball of project files...
  Tarball: 342KB (187 files)
Uploading project to cloud...
  Uploaded in 1.2s
Provisioning cloud sandbox...
  Sandbox ready (us-east-1, daytona-abc123)
Connecting via SSH...

On the relay as claude (cloud)
  Workspace: rw_x7k2m9p1
  Sandbox: daytona-abc123
  Region: us-east-1
  Files: 187 synced to /home/user/project
  Isolation: container (filesystem, process, network)

╭────────────────────────────────────────╮
│ You are now in an interactive cloud    │
│ agent session. The agent CLI is        │
│ running inside an isolated container.  │
│                                        │
│ Press Ctrl+C to end the session.       │
│ Modified files will be synced back.    │
╰────────────────────────────────────────╯

> claude --dangerously-skip-permissions
[Claude session starts inside container, stdio piped through SSH]
...
[User exits Claude with /exit or Ctrl+C]

Ending cloud session...
Generating patch of modified files...
  12 files changed, 3 files added, 1 file deleted
Downloading patch (4.2KB)...
Applying changes to local project...
  Applied 16 file changes
Destroying sandbox...
Off the relay.
```

### Options

| Flag                        | Description                                 | Default        |
| --------------------------- | ------------------------------------------- | -------------- |
| `--cloud`                   | Run in cloud container instead of locally   | `false`        |
| `--cloud-timeout <minutes>` | Max session duration before auto-cleanup    | `120`          |
| `--cloud-region <region>`   | Preferred cloud region                      | auto (nearest) |
| `--no-sync-back`            | Skip downloading changes after session ends | `false`        |
| `--dry-run-sync`            | Show patch diff without applying            | `false`        |

### How Project Files Get Into the Container

The same tarball mechanism used by `agent-relay cloud run` (see `packages/cloud/src/workflows.ts` lines 468-515):

1. If in a git repo: `git ls-files` determines the file list (respects `.gitignore`)
2. Otherwise: walk the directory tree, excluding patterns from `CODE_SYNC_EXCLUDES` (`.git`, `node_modules`, `.env`, `*.pem`, etc.)
3. Create a gzipped tarball
4. Upload to S3 via scoped temporary credentials from the cloud API

### How Files Get Synced Back

After the session ends (agent exits or user presses Ctrl+C):

1. The cloud API generates a `git diff`-style patch of all changes made inside the container relative to the uploaded tarball
2. The CLI downloads the patch via the existing `/api/v1/workflows/runs/:runId/patch` endpoint (or a new session-specific equivalent)
3. The patch is applied to the local working directory via `git apply`
4. The user sees a summary of changed files

This reuses the same sync mechanism as `agent-relay cloud sync` (see `src/cli/commands/cloud.ts` lines 459-515).

---

## 3. Architecture & Data Flow

### Component Diagram

```
Local Machine                          Agent Relay Cloud
┌──────────────────────┐               ┌─────────────────────────────────────┐
│                      │               │                                     │
│  agent-relay CLI     │               │  Cloud API                          │
│  ┌────────────────┐  │               │  ┌───────────────────────────────┐  │
│  │ on --cloud     │──┼──── HTTPS ────┼─▶│ POST /api/v1/sessions        │  │
│  │                │  │               │  │  - validate auth              │  │
│  │ 1. auth        │  │               │  │  - provision Daytona sandbox  │  │
│  │ 2. tarball     │──┼──── S3 ──────▶│  │  - unpack tarball            │  │
│  │ 3. SSH tunnel  │◀─┼──── SSH ──────┼──│  - return SSH credentials    │  │
│  │ 4. stdio pass  │  │               │  └───────────────────────────────┘  │
│  │ 5. sync back   │◀─┼──── HTTPS ────┼──│                                 │
│  └────────────────┘  │               │  Daytona Sandbox (ephemeral)       │
│                      │               │  ┌───────────────────────────────┐  │
│  User's terminal     │               │  │ /home/user/project/           │  │
│  (stdin/stdout)      │               │  │   [uploaded project files]    │  │
│                      │               │  │                               │  │
│                      │               │  │ $ claude --dangerously-skip-  │  │
│                      │               │  │   permissions                 │  │
│                      │               │  │   [interactive agent session] │  │
│                      │               │  └───────────────────────────────┘  │
└──────────────────────┘               └─────────────────────────────────────┘
```

### Step-by-Step Flow

**Phase A: Setup (CLI-side)**

1. User runs `agent-relay on claude --cloud`
2. CLI verifies TTY is available (interactive terminal required)
3. CLI authenticates with cloud API via `ensureAuthenticated()` (reuse from `@agent-relay/cloud`)
4. CLI creates tarball of project files (reuse `createTarball()` from `packages/cloud/src/workflows.ts`)

**Phase B: Provisioning (Cloud-side)**

5. CLI calls `POST /api/v1/sessions/create` with:
   - `agentCli`: `"claude"` (which agent to launch)
   - `s3CodeKey`: location of uploaded tarball
   - `timeout`: max session duration
6. Cloud API provisions a Daytona container:
   - Base image includes agent CLIs (claude, codex, gemini, etc.)
   - Downloads and unpacks tarball into `/home/user/project`
   - Injects provider credentials from the user's stored cloud auth
   - Starts SSH server
7. Cloud API returns SSH connection details (`host`, `port`, `user`, `password`) and a `sessionId`

**Phase C: Interactive Session (SSH tunnel)**

8. CLI establishes SSH connection using existing `ssh2` library (reuse from `src/cli/lib/ssh-interactive.ts`)
9. CLI opens a shell session in the container
10. CLI sends the agent launch command through the shell: `cd /home/user/project && claude --dangerously-skip-permissions`
11. stdin/stdout/stderr are piped bidirectionally between the local terminal and the remote shell
12. Terminal resize events are forwarded (`stream.setWindow()`)
13. User interacts with the agent normally -- the experience is identical to local usage

**Phase D: Teardown & Sync**

14. Agent exits (user types `/exit`, presses Ctrl+C, or timeout fires)
15. SSH session closes
16. CLI calls `POST /api/v1/sessions/:sessionId/complete`
17. Cloud generates a patch of all file changes
18. CLI downloads the patch via `GET /api/v1/sessions/:sessionId/patch`
19. CLI applies patch to local working directory via `git apply`
20. CLI displays summary of changes
21. Cloud destroys the Daytona container

---

## 4. Implementation Plan

### Phase 1 -- MVP

**Goal:** Interactive cloud session that works end-to-end with basic file sync.

#### 4.1.1 New function: `goOnTheRelayCloud()`

Create a new code path in `src/cli/commands/on/start.ts` (or a new file `src/cli/commands/on/cloud.ts`) that handles the `--cloud` flag. This function replaces the local `spawn()` call with an SSH-tunneled remote session.

```
goOnTheRelayCloud(cli, options, extraArgs, deps):
  1. ensureAuthenticated(apiUrl)
  2. createTarball(process.cwd())        // reuse from packages/cloud
  3. upload tarball to S3                 // reuse from packages/cloud
  4. POST /api/v1/sessions/create         // new endpoint
  5. runInteractiveCloudSession(ssh, remoteCommand)  // adapted from ssh-interactive.ts
  6. POST /api/v1/sessions/:id/complete
  7. download and apply patch
```

#### 4.1.2 Adapt SSH interactive session

The existing `runInteractiveSession()` in `src/cli/lib/ssh-interactive.ts` is designed for auth flows -- it watches for `successPatterns` and `errorPatterns` and auto-closes on match. For interactive cloud sessions, we need a variant that:

- Does **not** scan for auth patterns
- Stays open indefinitely (until the remote process exits or the user sends Ctrl+C)
- Supports terminal resize forwarding (already implemented)
- Returns the exit code from the remote agent process

Options:

- **Option A**: Add a `mode: 'auth' | 'interactive'` parameter to `runInteractiveSession()` that disables pattern matching when set to `'interactive'`
- **Option B**: Create a new `runCloudShellSession()` function that is simpler (no pattern scanning, no timeout by default)

**Recommendation:** Option B. The auth-flow SSH session has enough specialized logic (pattern matching, auto-close on success, tunnel port for OAuth callbacks) that combining them would add unnecessary complexity. A dedicated function keeps both paths clean.

#### 4.1.3 Routing in `goOnTheRelay()`

At the entry point of `goOnTheRelay()` (line 1204 in `start.ts`), add an early return when `--cloud` is set that routes to the new cloud path:

```typescript
if (options.cloud) {
  return goOnTheRelayCloud(cli, options, extraArgs, deps);
}
```

This replaces the current behavior where `--cloud` only changes the auth base URL (line 1225) and file storage mode (line 1228), while still spawning the agent locally.

#### 4.1.4 Cloud API: `POST /api/v1/sessions/create`

**Request:**

```json
{
  "agentCli": "claude",
  "s3CodeKey": "code/abc123.tar.gz",
  "runId": "run_xyz",
  "timeout": 7200,
  "language": "typescript"
}
```

**Response:**

```json
{
  "sessionId": "sess_abc123",
  "sandboxId": "daytona-xyz",
  "ssh": {
    "host": "sandbox-xyz.daytona.example.com",
    "port": 22,
    "user": "daytona",
    "password": "generated-password"
  },
  "remoteCommand": "cd /home/user/project && claude --dangerously-skip-permissions",
  "expiresAt": "2026-04-07T14:00:00Z",
  "region": "us-east-1"
}
```

This is structurally identical to the existing `POST /api/v1/cli/auth` endpoint (see `src/cli/commands/cloud.ts` lines 261-269) but provisions a larger sandbox with project files instead of a minimal auth sandbox.

#### 4.1.5 Cloud API: `POST /api/v1/sessions/:sessionId/complete`

**Request:**

```json
{
  "sessionId": "sess_abc123"
}
```

Triggers the cloud to:

1. Generate a patch (`git diff` of changes vs original tarball)
2. Make the patch available for download
3. Schedule sandbox destruction (with a grace period for the patch download)

#### 4.1.6 Cloud API: `GET /api/v1/sessions/:sessionId/patch`

Returns the same `SyncPatchResponse` structure as the existing workflow sync endpoint:

```json
{
  "hasChanges": true,
  "patch": "diff --git a/src/foo.ts b/src/foo.ts\n..."
}
```

### Phase 2 -- File Sync Polish

#### 4.2.1 Respect `.agentignore` / `.agentreadonly` in the container

When unpacking the tarball in the container, the cloud should:

- Exclude files matching `.agentignore` patterns from being writable
- Mark files matching `.agentreadonly` patterns as read-only in the container filesystem
- Generate and place `_PERMISSIONS.md` in the project root (same as local mode)

#### 4.2.2 Diff summary before applying

Before applying the patch, show the user a summary:

```
Files modified by agent:
  M src/auth/login.ts       (+12, -3)
  M src/auth/middleware.ts   (+5, -1)
  A src/auth/refresh.ts      (+48)
  D src/auth/legacy.ts       (-22)

Apply these changes? [Y/n]
```

Add `--yes` flag to auto-confirm (useful for scripts/CI).

#### 4.2.3 Selective sync

Allow `--sync-include` and `--sync-exclude` patterns to control which changed files are brought back:

```bash
agent-relay on claude --cloud --sync-exclude "*.test.ts"
```

### Phase 3 -- Polish & Advanced Features

#### 4.3.1 Session resume

If the SSH connection drops (network issue, laptop sleep), allow reconnecting:

```bash
agent-relay cloud resume sess_abc123
```

Implementation: the cloud keeps the sandbox alive for a configurable grace period (default 5 minutes) after SSH disconnect. The CLI stores the `sessionId` locally in `.relay/cloud-session.json` for easy reconnection.

#### 4.3.2 Timeout and auto-cleanup

- Default session timeout: 2 hours
- Warning at 5 minutes before timeout (sent through the SSH channel)
- `--cloud-timeout <minutes>` flag to customize
- Cloud-side cleanup: destroy sandbox, clean up S3 artifacts
- Client-side cleanup on `SIGINT`/`SIGTERM`: call complete endpoint, download patch, then allow sandbox destruction

#### 4.3.3 Multiple agents in the same cloud workspace

Allow a second agent to join the same cloud sandbox:

```bash
# Terminal 1
agent-relay on claude --cloud
# Shows: Workspace: rw_x7k2m9p1, Sandbox: daytona-abc123

# Terminal 2
agent-relay on codex --cloud --workspace rw_x7k2m9p1
# Joins the same container, same project files, different agent
```

This requires the cloud API to accept `--workspace` as a parameter and return SSH credentials to the existing sandbox rather than creating a new one.

#### 4.3.4 Session list and management

```bash
agent-relay cloud sessions          # list active sessions
agent-relay cloud sessions:kill <id>  # force-destroy a session
```

---

## 5. Cloud API Changes Needed

### New Endpoints

| Method   | Path                             | Description                                      |
| -------- | -------------------------------- | ------------------------------------------------ |
| `POST`   | `/api/v1/sessions/create`        | Provision interactive sandbox with project files |
| `POST`   | `/api/v1/sessions/:id/complete`  | Signal session end, trigger patch generation     |
| `GET`    | `/api/v1/sessions/:id/patch`     | Download file changes as unified diff            |
| `GET`    | `/api/v1/sessions`               | List active sessions for the user                |
| `DELETE` | `/api/v1/sessions/:id`           | Force-destroy a session                          |
| `POST`   | `/api/v1/sessions/:id/reconnect` | Get fresh SSH credentials for existing session   |

### Reusable Infrastructure

The following existing cloud infrastructure can be reused without modification:

- **S3 code upload**: The `POST /api/v1/workflows/prepare` endpoint already returns scoped S3 credentials and a code key. The same mechanism works for interactive sessions.
- **Daytona sandbox provisioning**: The `POST /api/v1/cli/auth` endpoint already provisions Daytona containers with SSH access. The interactive session endpoint follows the same pattern but with a different base image and longer TTL.
- **Authentication**: All new endpoints use the same `authorizedApiFetch()` mechanism as existing cloud endpoints.

### Differences from Workflow Run

| Aspect           | Workflow Run              | Interactive Session                   |
| ---------------- | ------------------------- | ------------------------------------- |
| Sandbox lifetime | Until workflow completes  | Until user disconnects + grace period |
| Agent invocation | Cloud runs the agent      | User runs the agent via SSH           |
| Output           | Logs streamed via polling | stdio piped through SSH               |
| Interaction      | None (fire and forget)    | Full bidirectional terminal           |
| Patch generation | Automatic on completion   | Triggered by complete endpoint        |

---

## 6. Isolation Guarantees

When a user runs `agent-relay on claude --cloud`, they get the following isolation properties:

### Container Filesystem Isolation

- The agent can only access `/home/user/project` (the uploaded project files)
- No access to the host filesystem, other users' files, or system directories beyond the base image
- The container filesystem is ephemeral -- destroyed when the session ends

### Process Isolation

- The agent process runs inside a Daytona container with its own PID namespace
- No visibility into processes on the host or other containers
- Resource limits (CPU, memory) enforced at the container level

### Network Policies

- Outbound internet access is available (needed for package installs, API calls)
- No access to other containers or internal cloud infrastructure
- SSH is the only inbound access path, authenticated with session-specific credentials

### Automatic Secret Exclusion

The tarball upload mechanism excludes sensitive files by default (from `CODE_SYNC_EXCLUDES` in `packages/cloud/src/workflows.ts`):

- `.env`, `.env.*`, `.env.local`, `.env.production`
- `*.pem`, `*.key`
- `credentials.json`
- `.aws/`, `.ssh/`

Provider credentials (Anthropic API key, etc.) are injected by the cloud from the user's stored encrypted credentials -- never from the local machine.

### Ephemeral by Default

- The sandbox is destroyed when the session ends
- No persistent storage between sessions
- Patch must be explicitly synced back; nothing is auto-written to the host

---

## 7. Files to Modify

### CLI (TypeScript)

| File                                 | Change                                                                                                                                                    |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/cli/commands/on/start.ts`       | Add early return in `goOnTheRelay()` when `options.cloud` is true, routing to new `goOnTheRelayCloud()` function                                          |
| `src/cli/commands/on/cloud.ts` (new) | New module implementing `goOnTheRelayCloud()` -- handles tarball upload, SSH session, and sync-back                                                       |
| `src/cli/commands/on.ts`             | Add `--cloud-timeout`, `--cloud-region`, `--no-sync-back`, `--dry-run-sync` options                                                                       |
| `src/cli/lib/ssh-interactive.ts`     | No changes needed for Phase 1 -- new `runCloudShellSession()` will be a separate function. Potentially extract shared SSH connection setup into a helper. |
| `src/cli/lib/cloud-shell.ts` (new)   | New module: `runCloudShellSession()` -- simplified SSH session without auth pattern matching, designed for long-running interactive use                   |
| `src/cli/commands/cloud.ts`          | Add `cloud sessions`, `cloud sessions:kill`, `cloud resume` subcommands (Phase 3)                                                                         |

### Cloud Package

| File                                   | Change                                                                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/cloud/src/workflows.ts`      | Export `createTarball()` and S3 upload helpers so they can be reused by interactive sessions                                         |
| `packages/cloud/src/sessions.ts` (new) | New module: `createInteractiveSession()`, `completeSession()`, `getSessionPatch()` -- client functions for the new session endpoints |
| `packages/cloud/src/types.ts`          | Add `InteractiveSessionResponse`, `SessionPatchResponse`, `CreateSessionOptions` types                                               |
| `packages/cloud/src/index.ts`          | Re-export new session functions and types                                                                                            |

### Config

| File                                     | Change                                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `packages/config/src/cli-auth-config.ts` | Possibly add cloud session agent configs if the sandbox base image needs different CLIs than the auth sandbox |

---

## 8. Comparison: Local vs Cloud `on`

| Dimension                    | `agent-relay on claude`            | `agent-relay on claude --cloud`                   |
| ---------------------------- | ---------------------------------- | ------------------------------------------------- |
| **Where agent runs**         | Local machine (child process)      | Cloud container (Daytona) via SSH                 |
| **Filesystem isolation**     | Symlink mount (can be escaped)     | Container boundary (cannot escape)                |
| **Process isolation**        | None (shares host PID namespace)   | Container PID namespace                           |
| **Network isolation**        | None (full host network access)    | Container network (outbound only)                 |
| **Secret exposure**          | Local env vars visible to agent    | Secrets injected by cloud, never from host        |
| **Setup required**           | Agent CLI installed locally        | Agent CLI pre-installed in container image        |
| **Latency**                  | None (local process)               | SSH round-trip (~10-50ms typically)               |
| **Startup time**             | < 1 second                         | 5-15 seconds (upload + provision)                 |
| **File sync (in)**           | Symlink mount (instant)            | Tarball upload (seconds, depends on project size) |
| **File sync (out)**          | Symlink sync-back on exit          | Patch download + git apply on exit                |
| **Session persistence**      | Tied to local process              | Survives SSH disconnect (with grace period)       |
| **Cost**                     | Free (local resources)             | Cloud compute charges                             |
| **Offline capable**          | Yes                                | No (requires internet)                            |
| **Multi-agent**              | Via `--shared` flag with relayfile | Via `--workspace` flag (shared container)         |
| **`.agentignore` support**   | Yes (enforced via mount)           | Yes (enforced in container)                       |
| **`.agentreadonly` support** | Yes (enforced via mount)           | Yes (enforced via file permissions)               |

---

## 9. Testing Strategy

### Unit Tests

| Test                        | Location                           | Description                                                                    |
| --------------------------- | ---------------------------------- | ------------------------------------------------------------------------------ |
| `goOnTheRelayCloud` routing | `tests/cli/on-cloud.test.ts`       | Verify `goOnTheRelay()` routes to cloud path when `options.cloud` is true      |
| Tarball creation            | Existing tests in `packages/cloud` | Verify tarball excludes secrets, respects `.gitignore`                         |
| SSH session lifecycle       | `tests/cli/cloud-shell.test.ts`    | Mock SSH connection, verify stdin/stdout piping, exit code propagation         |
| Patch application           | `tests/cli/cloud-sync.test.ts`     | Verify `git apply` is called correctly, handles empty patches, reports changes |
| Session cleanup on SIGINT   | `tests/cli/on-cloud.test.ts`       | Verify complete endpoint is called and patch is downloaded on interrupt        |

### Integration Tests

| Test                   | Description                                                                    |
| ---------------------- | ------------------------------------------------------------------------------ |
| Full cloud session E2E | Start session with real cloud API, run a simple command, verify file sync back |
| TTY requirement        | Verify command fails gracefully when stdin is not a TTY                        |
| Auth failure           | Verify clear error when cloud credentials are expired/missing                  |
| Timeout handling       | Verify session ends cleanly when timeout fires                                 |
| Large project upload   | Verify tarball creation and upload works for projects > 100MB                  |
| Patch conflict         | Verify graceful handling when local files changed during session               |

### Manual Test Matrix

| Scenario                                    | Expected Behavior                                            |
| ------------------------------------------- | ------------------------------------------------------------ |
| Happy path: `agent-relay on claude --cloud` | Session starts, agent runs, files sync back                  |
| Ctrl+C during session                       | Session ends gracefully, patch downloaded                    |
| Network drop during session                 | SSH disconnects, CLI retries or shows reconnect instructions |
| No cloud auth                               | CLI prompts for `cloud login`                                |
| Empty project                               | Session starts with empty workspace                          |
| Binary files in project                     | Tarball includes them, patch handles them                    |
| Agent exits with error                      | Exit code propagated, patch still offered                    |
| `--no-sync-back`                            | Session ends without downloading changes                     |
| `--dry-run-sync`                            | Patch displayed but not applied                              |

### Dependency Injection for Testability

Following the established DI pattern (see `GoOnRelayDeps` interface at line 1054 of `start.ts`), the new cloud function accepts injectable dependencies:

```typescript
interface GoOnRelayCloudDeps {
  log?: LogFn;
  error?: LogFn;
  exit?: (code: number) => never | void;
  fetch?: FetchFn;
  createTarball?: (rootDir: string) => Promise<Buffer>;
  runCloudShell?: (options: CloudShellOptions) => Promise<CloudShellResult>;
  applyPatch?: (patch: string, targetDir: string) => void;
}
```

This allows tests to mock the SSH connection, S3 upload, and patch application without hitting real infrastructure.

---

## 10. Open Questions

1. **Sandbox image versioning**: How do we ensure the container has the correct version of each agent CLI? Pin to specific versions in the image, or install on-the-fly?

2. **MCP server support**: Should the cloud session support relay's MCP tools (relaycast)? This would require the broker to be running inside the container or accessible via network.

3. **Cost model**: How is cloud compute time billed? Per-minute? Per-session? This affects default timeout and UX around session management.

4. **Maximum project size**: What is the upper bound for tarball upload? The current S3 upload has no explicit limit, but very large projects (monorepos) may hit practical limits.

5. **Container spec**: What CPU/memory should the default sandbox get? Agent workloads (especially LLM-powered ones) are mostly I/O-bound (waiting for API responses), so modest compute should suffice.

6. **Workspace reuse**: Should `--workspace` for cloud sessions reuse an existing container (same sandbox, multiple SSH sessions) or create a new container with the same workspace identity? The former is more efficient but harder to implement; the latter is simpler but duplicates state.
