import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';

// Read-only access to Codex's SQLite files (queue_1.sqlite, state_5.sqlite)
// without an npm dependency: `node:sqlite` when this Node has it (22.13+,
// 23.4+ without a flag), else the `sqlite3` command line when it is on PATH,
// else nothing, and callers degrade (docs/connect-node-local-relay.md,
// "SQLite").

const BUSY_TIMEOUT_MS = 2_000;

let backend;

async function loadNodeSqlite() {
  // node:sqlite prints an ExperimentalWarning when it loads; it is noise for
  // a guest's terminal, so only that warning is held back, only here.
  const original = process.emitWarning;
  process.emitWarning = function emitWarning(warning, ...rest) {
    const text = typeof warning === 'string' ? warning : (warning?.message ?? '');
    if (/sqlite/i.test(text)) return undefined;
    return original.call(this, warning, ...rest);
  };
  try {
    const module = await import('node:sqlite');
    return typeof module.DatabaseSync === 'function' ? module.DatabaseSync : null;
  } catch {
    return null;
  } finally {
    process.emitWarning = original;
  }
}

function run(file, args, timeout = 10_000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) =>
      resolve(error ? null : String(stdout))
    );
  });
}

/**
 * Which reader this process uses: `{kind: 'node:sqlite', DatabaseSync}`,
 * `{kind: 'sqlite3'}` or `{kind: null}`. Decided once.
 */
export async function sqliteBackend() {
  if (backend) return backend;
  const forced = process.env.AGENT_RELAY_CONNECT_SQLITE;
  const DatabaseSync = forced === 'sqlite3' || forced === 'none' ? null : await loadNodeSqlite();
  if (DatabaseSync) {
    backend = { kind: 'node:sqlite', DatabaseSync };
  } else if (forced !== 'none' && (await run('sqlite3', ['-version'])) !== null) {
    backend = { kind: 'sqlite3' };
  } else {
    backend = { kind: null };
  }
  return backend;
}

/** Forgets the chosen backend (tests). */
export function resetSqliteBackend() {
  backend = undefined;
}

function literal(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** `sql` with each `?` replaced by a quoted literal, for the sqlite3 CLI. */
function inline(sql, params) {
  let index = 0;
  return sql.replace(/\?/g, () => literal(params[index++]));
}

/**
 * Runs one read-only query against `file`:
 * - `{status: 'missing'}` when there is no such file;
 * - `{status: 'unavailable'}` when no SQLite reader exists on this computer;
 * - `{status: 'unreadable'}` when it exists but cannot be read now;
 * - `{status: 'ok', rows}` with each row as a plain object by column name.
 *
 * Statements come from this package only; `params` are bound (node:sqlite)
 * or quoted (sqlite3 CLI).
 */
export async function queryReadOnly(file, sql, params = []) {
  try {
    await stat(file);
  } catch (error) {
    return error?.code === 'ENOENT' ? { status: 'missing' } : { status: 'unreadable' };
  }
  const reader = await sqliteBackend();
  if (reader.kind === 'node:sqlite') {
    let database;
    try {
      database = new reader.DatabaseSync(file, { readOnly: true });
      database.exec(`pragma busy_timeout = ${BUSY_TIMEOUT_MS}`);
      const rows = database.prepare(sql).all(...params);
      return { status: 'ok', rows: rows.map((row) => ({ ...row })) };
    } catch {
      return { status: 'unreadable' };
    } finally {
      try {
        database?.close();
      } catch {
        // Already closed or never opened.
      }
    }
  }
  if (reader.kind === 'sqlite3') {
    const output = await run('sqlite3', [
      '-readonly',
      '-json',
      '-cmd',
      `.timeout ${BUSY_TIMEOUT_MS}`,
      file,
      inline(sql, params),
    ]);
    if (output === null) return { status: 'unreadable' };
    if (output.trim() === '') return { status: 'ok', rows: [] };
    try {
      const rows = JSON.parse(output);
      return Array.isArray(rows) ? { status: 'ok', rows } : { status: 'unreadable' };
    } catch {
      return { status: 'unreadable' };
    }
  }
  return { status: 'unavailable' };
}
