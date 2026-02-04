# Storage Architecture

This describes the adapter stack, fallback behavior, and data policies.

## Components
- **createStorageAdapter**: Factory that selects an adapter based on config/env and handles fallbacks.
- **JSONL adapter**: Default durable store; file-based append-only log (`.agent-relay/messages/YYYY-MM-DD.jsonl`, sessions in `.agent-relay/sessions.jsonl`). Zero native dependencies.
- **SQLite adapter**: Optional durable store (WAL-enabled, 7d retention default); tries `better-sqlite3` first, then `node:sqlite` (Node 22+).
- **Batched SQLite adapter**: Wraps SQLite for higher write throughput via buffered flushes.
- **Memory adapter**: Volatile fallback to keep the daemon running when persistence fails.

## Fallback Chain
```
Config/env ──┐
             v
      createStorageAdapter
             |
             v
    JSONL (default)
      └─ .agent-relay/messages/*.jsonl
             |
     (failure to init)
             v
 SQLite [opt-in via AGENT_RELAY_STORAGE_TYPE=sqlite]
      ├─ better-sqlite3
      └─ node:sqlite (Node 22+)
             |
     (failure to init)
             v
       Memory (volatile)
```
Notes:
- Current behavior: JSONL (default) → Memory if filesystem write fails.
- SQLite available via `AGENT_RELAY_STORAGE_TYPE=sqlite` for low-latency query needs.
- Each fallback logs the failure reason and a fix hint.

## When to Use Each Adapter
- **JSONL**: Default for durability with zero native dependencies; append-only per-day files.
- **SQLite**: Low-latency queries; use when you need faster reads or complex queries.
- **SQLite (batched)**: High-volume message bursts; tolerates small window of risk during batch flush.
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
