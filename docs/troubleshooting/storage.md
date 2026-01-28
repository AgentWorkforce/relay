# Storage Troubleshooting

This guide covers stable storage behaviors and fixes based on the final storage chain (SQLite → JSONL → Memory). Future migrator tooling is noted as a placeholder where applicable.
See `docs/architecture/storage.md` for adapter structure and fallback diagrams.

- If the daemon prints `Running in non-persistent mode`, you are on an in-memory fallback.
- Always start with `agent-relay doctor` to gather environment and adapter status.
- Prefer Node.js 22+ for native SQLite without rebuilding.

## System Requirements
- Node.js: 22+ recommended (works on 20+ with native module rebuilds)
- SQLite: `better-sqlite3` prebuilt binary or the ability to compile (build-essential/Xcode CLT)
- Disk: write access to the configured data directory:
  - SQLite: `~/.agent-relay/relay.db`
  - JSONL fallback: `~/.agent-relay/messages/YYYY-MM-DD.jsonl` and `~/.agent-relay/sessions.jsonl`
- Env vars: `AGENT_RELAY_STORAGE_TYPE`, `AGENT_RELAY_STORAGE_PATH`, `AGENT_RELAY_STORAGE_URL` (future) control adapter selection

## Storage Modes
| Mode | Persistence | Best For | Notes |
| --- | --- | --- | --- |
| SQLite (default) | Durable | Most users; low-latency | WAL enabled; 7d retention by default |
| SQLite (batched) | Durable | High write throughput | Buffers writes; same retention as SQLite |
| JSONL | Durable | When SQLite native modules fail or are blocked | Append-only per-day files; sessions in `sessions.jsonl` |
| Memory | None (process lifetime) | Tests / emergency fallback | Keeps ~1k recent messages only |

## Quick Diagnostics
1) Run `agent-relay doctor` and check the Storage section (adapter, path, fallbacks, read/write tests).
2) Inspect daemon logs for `SQLite initialization failed`, `Falling back to JSONL storage`, or `Running in non-persistent mode`.
3) Confirm Node: `node -v` and ensure it matches the required major version.
4) Verify filesystem access to the configured path (`AGENT_RELAY_STORAGE_PATH` or default db).
5) Check disk space in `.agent-relay/` (doctor reports this under Disk Space).
6) Quick status: `agent-relay status` shows `Storage: ✓ Persistent (sqlite/jsonl)` or `⚠ Non-persistent (memory)` with fix hints.

## Common Installation Issues (and Fixes)
- **better-sqlite3 build fails (Node < 22 or missing toolchain)**
  - Result: Fallback to JSONL (persistent) or Memory (non-persistent) if JSONL also fails.
  - Fix: `npm rebuild better-sqlite3` (from repo root) then restart the daemon.
  - Fix: Upgrade to Node.js 22+ to use prebuilt binaries.
  - Fix: Install build tools (`xcode-select --install` on macOS, `build-essential` on Linux).
- **Permission denied writing the database**
  - Fix: Ensure the storage directory is writable (`chmod -R u+rw ~/.agent-relay`).
  - Fix: Move the DB via `AGENT_RELAY_STORAGE_PATH` to a writable location.
- **Stuck on memory mode (non-persistent)**
  - Fix: Ensure `AGENT_RELAY_STORAGE_TYPE` is not set to `memory`.
  - Fix: Rebuild SQLite, upgrade Node, then restart to regain persistence (or force JSONL via `AGENT_RELAY_STORAGE_TYPE=jsonl`).
- **Node version mismatch**
  - Fix: Install Node 22+ (recommended) or rebuild native deps after switching versions.
- **JSONL file writes failing**
  - Fix: Check disk space and permissions under `~/.agent-relay/messages/`.
  - Fix: Ensure filesystem is not mounted read-only; doctor will report `canWrite: false` with the error.

## Performance Implications
- SQLite: Lowest latency, WAL mode enabled; single writes are durable immediately.
- SQLite (batched): Higher throughput via buffered writes; small risk of losing in-flight batch if process crashes mid-flush.
- JSONL: Sequential append-only writes; easy to tail/debug; slower random reads and higher read amplification on large files.
- Memory: Fastest but volatile; intended only for tests or short-lived agents.

## Migration Between Storage Modes
1) Stop the daemon (`agent-relay down`).
2) Back up current data:
   - SQLite: `cp ~/.agent-relay/relay.db ~/.agent-relay/relay.db.bak`
   - JSONL: copy `~/.agent-relay/messages/*.jsonl` and `sessions.jsonl`
3) Set the target adapter:
   - `AGENT_RELAY_STORAGE_TYPE=sqlite` (default)
   - `AGENT_RELAY_STORAGE_TYPE=sqlite-batched`
   - `AGENT_RELAY_STORAGE_TYPE=jsonl`
   - `AGENT_RELAY_STORAGE_TYPE=memory` (ephemeral)
4) Optionally set `AGENT_RELAY_STORAGE_PATH` for SQLite/JSONL file location.
5) Start the daemon and run `agent-relay doctor` to verify adapter, path, and read/write tests.
6) Future migrator (Phase 2) will streamline SQLite ↔ JSONL conversions (placeholder).

## Recovery Procedures
- **SQLite**
  - Move aside a corrupted DB: `mv relay.db relay.db.corrupt && agent-relay doctor` (will recreate).
  - Clear WAL if locked: delete `relay.db-wal` and `relay.db-shm` after stopping the daemon.
  - Restore from backup: replace `relay.db` with your backup and restart.
- **JSONL**
  - Rotate log files by date: move offending `YYYY-MM-DD.jsonl` aside and restart (append-only).
  - If sessions are corrupt, move `sessions.jsonl` aside; new sessions file will be created.
  - Doctor will show `canRead`/`canWrite` and errors; fix permissions/space, then retry.
- **Memory fallback**
  - Switch back to SQLite or JSONL as above; keep the process alive until important messages are re-sent.

## Example Scenarios

### Scenario: SQLite Installation Failed

Symptoms:
- Warning during npm install
- "Running in non-persistent mode" on daemon start (if JSONL also failed)

Diagnosis:
- Run: `agent-relay doctor`

Fix:
- Option 1: `npm rebuild better-sqlite3`
- Option 2: Upgrade to Node 22+
- Option 3: Accept JSONL fallback (persistent append-only) or set `AGENT_RELAY_STORAGE_TYPE=jsonl`

### Scenario: JSONL Fallback Disk/Permission Error
Symptoms:
- Doctor shows `driver: jsonl`, `canWrite: false` or `canRead: false`
- Daemon logs mention `JSONL fallback failed`

Diagnosis:
- Check disk space under `~/.agent-relay/messages/`
- Confirm directory is writable and not on a read-only mount

Fix:
- Free disk space or change `AGENT_RELAY_STORAGE_PATH` to a writable location
- Retry `agent-relay doctor` until write/read tests pass

### Scenario: Unexpected Memory Mode After Upgrade
Symptoms:
- Daemon logs mention `Falling back to in-memory storage`
- Messages disappear after restart

Diagnosis:
- Check `AGENT_RELAY_STORAGE_TYPE` and `node -v`
- Confirm whether `better-sqlite3` rebuilt during the upgrade

Fix:
- Rebuild native deps, set `AGENT_RELAY_STORAGE_TYPE=sqlite`, restart
- Verify with `agent-relay doctor` that SQLite is active

### Scenario: SQLite Database Locked
Symptoms:
- Errors containing `SQLITE_BUSY` or `database is locked`
- Slow or stalled message writes

Diagnosis:
- Ensure only one daemon instance is using the DB path
- Check for leftover `relay.db-wal`/`relay.db-shm` after crashes

Fix:
- Stop the daemon, delete `.wal`/`.shm`, restart
- If lock persists, move the DB aside and allow the daemon to recreate a fresh file, then re-import from backup

## Doctor Output Cheatsheet
- Installation Status: timestamps, platform, detected driver, status/detail.
- SQLite Drivers: availability + versions for `better-sqlite3` and `node:sqlite`.
- Current Adapter: active adapter type (sqlite/sqlite-batched/jsonl/memory).
- Database/File Info: path, permissions, size (SQLite) or JSONL base dir and files.
- Disk Space: available space in `.agent-relay/`.
- Write/Read Tests: boolean results; errors surface in `error` when false.

### Doctor Output (Healthy Example)
```
Storage Diagnostics
═══════════════════
Installation Status
-------------------
- Last check: 2026-01-28T14:30:00.000Z (darwin-arm64)
- Driver detected: better-sqlite3 (status: ok)
- Detail: better-sqlite3 rebuilt successfully
- Node v22.1.0
✓ better-sqlite3: Available (v12.6.2)
✓ node:sqlite: Available (Node 22.1.0)
✓ Current adapter: SQLite (better-sqlite3)
✓ Database file: .agent-relay/relay.db (rw, 2.3 MB)
✓ Disk space: 45 GB available
✓ Write test: OK
✓ Read test: OK
Status: All checks passed ✓
```

### Doctor Output (Failure Example)
```
✗ better-sqlite3: Not available
  Fix: npm rebuild better-sqlite3
⚠ Current adapter: In-memory (no persistence)
  Fix: Upgrade to Node 22+ or run: npm rebuild better-sqlite3
```

## Storage Status Output (agent-relay status)
- Healthy SQLite: `Storage: ✓ Persistent (sqlite/better-sqlite3)`
- JSONL fallback: `Storage: ✓ Persistent (jsonl)          Using file-based fallback (SQLite unavailable)`
- Memory fallback: `Storage: ⚠ Non-persistent (memory)          To fix: npm rebuild better-sqlite3 or upgrade to Node 22+`

## Daemon Startup Messages
- Healthy: `[daemon] Storage: SQLite (better-sqlite3)`
- JSONL fallback: `[daemon] Storage: JSONL (file-based fallback)` and `SQLite unavailable - using persistent file storage`
- Memory fallback: `[daemon] ⚠️  Storage: In-memory (non-persistent)` and remediation hint

## File Locations
- Storage status: `.agent-relay/storage-status.txt`
- SQLite DB: `.agent-relay/relay.db`
- JSONL messages: `.agent-relay/messages/YYYY-MM-DD.jsonl`
- JSONL sessions: `.agent-relay/sessions.jsonl`
