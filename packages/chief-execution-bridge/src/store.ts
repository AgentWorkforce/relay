import { chmodSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { canonical, hash, type Assignment, type ReportState, type WorkerReport } from './protocol.js';

export type TaskState = 'queued' | 'invoking' | 'launched' | 'running' | 'completed' | 'failed';
export type ClaimedResult = 'completed' | 'failed';

export interface TaskRow {
  taskId: string;
  digest: string;
  assignment: Assignment;
  repository: string;
  agentName: string;
  invocationKey: string;
  state: TaskState;
  invocationId?: string;
  boundAgentId?: string;
  pendingResult?: ClaimedResult;
  reason?: string;
  createdAt: number;
  invokingAt?: number;
  runningAt?: number;
  stopPending: boolean;
}

export interface PendingReport {
  report: WorkerReport;
  attempts: number;
}

export type ClaimOutcome = 'claimed' | 'over_budget' | 'duplicate' | 'conflict';

const REPORT_RETRY_BASE_MS = 5000;
const REPORT_RETRY_MAX_MS = 300_000;
/** Rows kept in `quarantine`, newest first. Any peer can DM the worker, so it must be bounded. */
const QUARANTINE_MAX_ROWS = 10_000;

/**
 * The bridge's durable record. A task row and its first report are written in one
 * transaction before any native call, so a replayed DM can never start a second run.
 */
export class BridgeStore {
  private readonly db: DatabaseSync;
  private readonly maxQuarantineRows: number;

  constructor(path: string, options: { maxQuarantineRows?: number } = {}) {
    this.maxQuarantineRows = options.maxQuarantineRows ?? QUARANTINE_MAX_ROWS;
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS binding(id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(
        task_id TEXT PRIMARY KEY,
        digest TEXT NOT NULL,
        assignment TEXT NOT NULL,
        repository TEXT NOT NULL,
        reservation_micros INTEGER NOT NULL,
        agent_name TEXT NOT NULL UNIQUE,
        invocation_key TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('queued','invoking','launched','running','completed','failed')),
        next_sequence INTEGER NOT NULL,
        invocation_id TEXT,
        bound_agent_id TEXT,
        pending_result TEXT CHECK(pending_result IN ('completed','failed')),
        reason TEXT,
        created_at INTEGER NOT NULL,
        invoking_at INTEGER,
        running_at INTEGER,
        finished_at INTEGER,
        stop_pending INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS reports(
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        sequence INTEGER NOT NULL,
        payload TEXT NOT NULL,
        sent INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        PRIMARY KEY(task_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS cursors(conversation_id TEXT PRIMARY KEY, message_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chief_conversation(id INTEGER PRIMARY KEY CHECK(id=1), conversation_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS quarantine(
        message_id TEXT PRIMARY KEY,
        code TEXT NOT NULL,
        payload_digest TEXT NOT NULL,
        sender_agent_id TEXT NOT NULL,
        at INTEGER NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Pins the ledger to one worker, workspace and chief. A different binding is refused. */
  pinBinding(binding: object): void {
    const value = canonical(binding);
    this.transaction(() => {
      const row = this.db.prepare('SELECT value FROM binding WHERE id=1').get() as
        { value: string } | undefined;
      if (row && row.value !== value) throw new Error('bridge_binding_mismatch');
      if (!row) this.db.prepare('INSERT INTO binding(id, value) VALUES (1, ?)').run(value);
    });
  }

  claim(input: {
    assignment: Assignment;
    digest: string;
    agentName: string;
    invocationKey: string;
    budgetMicros: number;
    now: number;
  }): ClaimOutcome {
    const { assignment, digest, now } = input;
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT digest FROM tasks WHERE task_id=?').get(assignment.taskId) as
        { digest: string } | undefined;
      if (existing) return existing.digest === digest ? 'duplicate' : 'conflict';
      const { total } = this.db
        .prepare('SELECT COALESCE(SUM(reservation_micros), 0) AS total FROM tasks')
        .get() as { total: number };
      const overBudget = total + assignment.reservationMicros > input.budgetMicros;
      // An unfunded task reserves nothing against later work but is still recorded.
      this.db
        .prepare(
          `INSERT INTO tasks(task_id, digest, assignment, repository, reservation_micros, agent_name,
             invocation_key, state, next_sequence, reason, created_at, finished_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 2, ?, ?, ?)`
        )
        .run(
          assignment.taskId,
          digest,
          canonical(assignment),
          assignment.repository,
          overBudget ? 0 : assignment.reservationMicros,
          input.agentName,
          input.invocationKey,
          overBudget ? 'failed' : 'queued',
          overBudget ? 'budget_exceeded' : null,
          now,
          overBudget ? now : null
        );
      this.enqueue(assignment.taskId, digest, 1, overBudget ? 'failed' : 'accepted', now);
      return overBudget ? 'over_budget' : 'claimed';
    });
  }

  private enqueue(taskId: string, digest: string, sequence: number, state: ReportState, now: number): void {
    const report: WorkerReport = {
      protocol: 'relay-chief.report.v1',
      taskId,
      assignmentDigest: digest,
      sequence,
      state,
      artifactRefs: [],
    };
    this.db
      .prepare('INSERT INTO reports(task_id, sequence, payload, next_attempt_at) VALUES (?, ?, ?, ?)')
      .run(taskId, sequence, canonical(report), now);
  }

  private row(raw: Record<string, unknown>): TaskRow {
    return {
      taskId: raw.task_id as string,
      digest: raw.digest as string,
      assignment: JSON.parse(raw.assignment as string) as Assignment,
      repository: raw.repository as string,
      agentName: raw.agent_name as string,
      invocationKey: raw.invocation_key as string,
      state: raw.state as TaskState,
      invocationId: (raw.invocation_id as string | null) ?? undefined,
      boundAgentId: (raw.bound_agent_id as string | null) ?? undefined,
      pendingResult: (raw.pending_result as ClaimedResult | null) ?? undefined,
      reason: (raw.reason as string | null) ?? undefined,
      createdAt: raw.created_at as number,
      invokingAt: (raw.invoking_at as number | null) ?? undefined,
      runningAt: (raw.running_at as number | null) ?? undefined,
      stopPending: raw.stop_pending === 1,
    };
  }

  task(taskId: string): TaskRow | undefined {
    const raw = this.db.prepare('SELECT * FROM tasks WHERE task_id=?').get(taskId);
    return raw ? this.row(raw as Record<string, unknown>) : undefined;
  }

  activeTasks(): TaskRow[] {
    return this.db
      .prepare(`SELECT * FROM tasks WHERE state NOT IN ('completed','failed') ORDER BY created_at, task_id`)
      .all()
      .map((raw) => this.row(raw as Record<string, unknown>));
  }

  /** An unfinished task whose spawned agent carries this unique name. */
  taskForAgent(agentName: string): TaskRow | undefined {
    const raw = this.db
      .prepare(`SELECT * FROM tasks WHERE agent_name=? AND state IN ('invoking','launched','running')`)
      .get(agentName);
    return raw ? this.row(raw as Record<string, unknown>) : undefined;
  }

  /** Records intent before the network call. False if another pass already took it. */
  markInvoking(taskId: string, now: number): boolean {
    return (
      this.db
        .prepare(`UPDATE tasks SET state='invoking', invoking_at=? WHERE task_id=? AND state='queued'`)
        .run(now, taskId).changes === 1
    );
  }

  markLaunched(taskId: string, invocationId: string): void {
    this.db
      .prepare(`UPDATE tasks SET state='launched', invocation_id=? WHERE task_id=? AND state='invoking'`)
      .run(invocationId, taskId);
  }

  markRunning(taskId: string, now: number): void {
    this.transaction(() => {
      const row = this.db
        .prepare(`SELECT digest, next_sequence FROM tasks WHERE task_id=? AND state='launched'`)
        .get(taskId) as { digest: string; next_sequence: number } | undefined;
      if (!row) return;
      this.enqueue(taskId, row.digest, row.next_sequence, 'running', now);
      this.db
        .prepare(
          `UPDATE tasks SET state='running', running_at=?, next_sequence=next_sequence+1 WHERE task_id=?`
        )
        .run(now, taskId);
    });
  }

  /** Pins the first sender of the spawned name. Later messages must match it. */
  bindAgent(taskId: string, agentId: string): void {
    this.db
      .prepare('UPDATE tasks SET bound_agent_id=? WHERE task_id=? AND bound_agent_id IS NULL')
      .run(agentId, taskId);
  }

  /** The first claimed outcome wins; an agent cannot revise it. */
  setPendingResult(taskId: string, result: ClaimedResult): void {
    this.db
      .prepare('UPDATE tasks SET pending_result=? WHERE task_id=? AND pending_result IS NULL')
      .run(result, taskId);
  }

  /** Ends a task and queues its report atomically. A second call changes nothing. */
  finish(taskId: string, state: 'completed' | 'failed', reason: string | undefined, now: number): boolean {
    return this.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT digest, next_sequence, invoking_at FROM tasks
           WHERE task_id=? AND state NOT IN ('completed','failed')`
        )
        .get(taskId) as { digest: string; next_sequence: number; invoking_at: number | null } | undefined;
      if (!row) return false;
      this.enqueue(taskId, row.digest, row.next_sequence, state, now);
      this.db
        .prepare(
          `UPDATE tasks SET state=?, reason=?, finished_at=?, next_sequence=next_sequence+1, stop_pending=?
           WHERE task_id=?`
        )
        .run(state, reason ?? null, now, row.invoking_at === null ? 0 : 1, taskId);
      return true;
    });
  }

  stopPending(): TaskRow[] {
    return this.db
      .prepare('SELECT * FROM tasks WHERE stop_pending=1 ORDER BY finished_at, task_id')
      .all()
      .map((raw) => this.row(raw as Record<string, unknown>));
  }

  clearStop(taskId: string): void {
    this.db.prepare('UPDATE tasks SET stop_pending=0 WHERE task_id=?').run(taskId);
  }

  /** Per task, only the lowest unsent report and only once its retry time has come. */
  dueReports(now: number): PendingReport[] {
    return (
      this.db
        .prepare(
          `SELECT payload, attempts FROM reports r
           WHERE sent=0 AND next_attempt_at<=?
             AND sequence=(SELECT MIN(sequence) FROM reports o WHERE o.task_id=r.task_id AND o.sent=0)
           ORDER BY task_id`
        )
        .all(now) as Array<{ payload: string; attempts: number }>
    ).map((row) => ({ report: JSON.parse(row.payload) as WorkerReport, attempts: row.attempts }));
  }

  markReportSent(taskId: string, sequence: number): void {
    this.db.prepare('UPDATE reports SET sent=1 WHERE task_id=? AND sequence=?').run(taskId, sequence);
  }

  markReportRetry(taskId: string, sequence: number, attempts: number, now: number): void {
    const delay = Math.min(REPORT_RETRY_MAX_MS, REPORT_RETRY_BASE_MS * 2 ** Math.min(attempts, 16));
    this.db
      .prepare('UPDATE reports SET attempts=?, next_attempt_at=? WHERE task_id=? AND sequence=?')
      .run(attempts + 1, now + delay, taskId, sequence);
  }

  unsentReports(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM reports WHERE sent=0').get() as { n: number }).n;
  }

  cursor(conversationId: string): string | undefined {
    const row = this.db
      .prepare('SELECT message_id FROM cursors WHERE conversation_id=?')
      .get(conversationId) as { message_id: string } | undefined;
    return row?.message_id;
  }

  advanceCursor(conversationId: string, messageId: string): void {
    this.db
      .prepare(
        `INSERT INTO cursors(conversation_id, message_id) VALUES (?, ?)
         ON CONFLICT(conversation_id) DO UPDATE SET message_id=excluded.message_id`
      )
      .run(conversationId, messageId);
  }

  pinChiefConversation(conversationId: string): void {
    this.db
      .prepare(
        `INSERT INTO chief_conversation(id, conversation_id) VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET conversation_id=excluded.conversation_id`
      )
      .run(conversationId);
  }

  chiefConversation(): string | undefined {
    const row = this.db.prepare('SELECT conversation_id FROM chief_conversation WHERE id=1').get() as
      { conversation_id: string } | undefined;
    return row?.conversation_id;
  }

  /** Stores a digest of a refused payload, never its contents, keeping only the newest rows. */
  quarantine(messageId: string, code: string, payload: unknown, senderAgentId: string, now: number): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO quarantine(message_id, code, payload_digest, sender_agent_id, at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(messageId, code, hash(payload), senderAgentId, now);
    this.db
      .prepare(
        `DELETE FROM quarantine WHERE message_id IN
           (SELECT message_id FROM quarantine ORDER BY at DESC, message_id DESC LIMIT -1 OFFSET ?)`
      )
      .run(this.maxQuarantineRows);
  }

  quarantined(): Array<{ messageId: string; code: string }> {
    return (
      this.db.prepare('SELECT message_id, code FROM quarantine ORDER BY message_id').all() as Array<{
        message_id: string;
        code: string;
      }>
    ).map((row) => ({ messageId: row.message_id, code: row.code }));
  }
}
