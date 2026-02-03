# Storage Architecture

This describes the adapter stack, fallback behavior, and data policies.

## Components
- **createStorageAdapter**: Factory that selects an adapter based on config/env and handles fallbacks.
- **SQLite adapter**: Primary durable store (WAL-enabled, 7d retention default); tries `better-sqlite3` first, then `node:sqlite` (Node 22+).
- **Batched SQLite adapter**: Wraps SQLite for higher write throughput via buffered flushes.
- **JSONL adapter**: File-based append-only log (`.agent-relay/messages/YYYY-MM-DD.jsonl`, sessions in `.agent-relay/sessions.jsonl`) used when SQLite native modules fail or are blocked.
- **Memory adapter**: Volatile fallback to keep the daemon running when persistence fails.

## Fallback Chain
```
Config/env ──┐
             v
      createStorageAdapter
             |
             v
    SQLite (default)
      ├─ better-sqlite3
      └─ node:sqlite (Node 22+)
             |
     (failure to init)
             v
 SQLite (batched) [opt-in]
      ├─ better-sqlite3
      └─ node:sqlite
             |
     (failure to init)
             v
 JSONL (append-only)
             |
     (failure to init)
             v
       Memory (volatile)
```
Notes:
- Current behavior: SQLite (better-sqlite3 → node:sqlite) → JSONL → Memory if native modules or permissions break persistence.
- Each fallback logs the failure reason and a fix hint (upgrade Node or rebuild native deps).

## When to Use Each Adapter
- **SQLite**: Default for durability and low latency; use whenever native modules are available.
- **SQLite (batched)**: High-volume message bursts; tolerates small window of risk during batch flush.
- **JSONL**: Environments where native builds are blocked but disk is available; append-only per-day files.
- **Memory**: Tests, ephemeral runs, or emergency operation when persistence is broken.

## Performance Characteristics
- SQLite: Low latency reads/writes; WAL keeps contention low; periodic cleanup prunes old rows.
- Batched SQLite: Aggregates writes to reduce fsync cost; reads still hit SQLite directly.
- JSONL: Sequential write-friendly; random reads slower; cleanup removes old per-day files after retention.
- Memory: Fastest access; no disk contention; lost on process exit (keeps ~1k recent messages).

## Data Retention Policies
- SQLite adapters: Default 7-day retention with hourly cleanup; adjustable via adapter options (future CLI flag will surface this).
- Batched adapter inherits SQLite retention; pending batches live only in memory until flushed.
- JSONL: Default 7-day retention; cleanup removes old dated `.jsonl` files and persists deletions.
- Memory adapter: Keeps only recent messages (approx. last 1k) to avoid unbounded growth.
- JSONL rotation/compaction tooling will be documented alongside the migrator (placeholder).

## Health Checks
- Interface: `{ persistent: boolean; driver: 'sqlite' | 'jsonl' | 'memory'; canWrite: boolean; canRead: boolean; error?: string }`.
- JSONL health: reports `driver: 'jsonl'` and probes write/read capability inside `.agent-relay/`.
- SQLite health: reports driver name (better-sqlite3 or node:sqlite) and read/write probes; falls back if probes fail.
- Memory health: always `persistent: false` with reason in `error` when reached via fallback.

## Links
- Troubleshooting: `docs/troubleshooting/storage.md`
- README storage overview: `README.md#storage-requirements` (quick checks and fixes)
