import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { InboxItem, RelayMessaging } from '@agent-relay/sdk';

import type { DeliveryInjector, InjectionOutcome } from './coding-session-injector.js';

const SAFETY_POLL_INTERVAL_MS = 30_000;
const LEDGER_LOCK_TIMEOUT_MS = 5_000;
const LEDGER_LOCK_RETRY_MS = 100;
const LEDGER_LOCK_STALE_MS = 4_000;
const INJECTED_REASONS = new Set(['dm', 'mention', 'thread_reply', 'thread-reply']);

export type DeliveryItem = InboxItem;
export type DeliveryQueue = {
  inbox: Pick<RelayMessaging['inbox'], 'list' | 'ack' | 'fail' | 'defer'>;
};
export type DeliveryRelay = Pick<RelayMessaging, 'capabilities' | 'inbox'>;

interface LedgerEntry {
  state: 'injecting' | 'injected' | 'in-doubt' | 'rejected';
  updatedAt: string;
  reason?: string;
}

interface LedgerFile {
  version: 1;
  deliveries: Record<string, LedgerEntry>;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') return 'request aborted';
  return error instanceof Error ? error.message : 'unknown error';
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

type DeliveryLedgerLock = <T>(action: () => Promise<T>) => Promise<T>;

export class LedgerLockBusyError extends Error {
  constructor(lockDirectory: string) {
    super(`Timed out waiting for another on-relay listener using ${lockDirectory}.`);
    this.name = 'LedgerLockBusyError';
  }
}

interface LedgerLockOwner {
  version: 1;
  pid: number;
  token: string;
}

async function assertLedgerLockDirectory(lockDirectory: string) {
  const info = await lstat(lockDirectory);
  if (!info.isDirectory()) {
    throw new Error(`The on-relay ledger lock is not a directory: ${lockDirectory}.`);
  }
  return info;
}

async function inspectLedgerLock(lockDirectory: string): Promise<{
  entries: string[];
  ownerIsAlive: boolean;
}> {
  await assertLedgerLockDirectory(lockDirectory);
  const entries = await readdir(lockDirectory);
  let ownerIsAlive = false;
  for (const entry of entries) {
    let owner: Partial<LedgerLockOwner>;
    try {
      owner = JSON.parse(await readFile(path.join(lockDirectory, entry), 'utf8')) as Partial<LedgerLockOwner>;
    } catch {
      continue;
    }
    if (
      owner.version === 1 &&
      typeof owner.pid === 'number' &&
      Number.isInteger(owner.pid) &&
      owner.pid > 0 &&
      typeof owner.token === 'string' &&
      owner.token === entry &&
      processAlive(owner.pid)
    ) {
      ownerIsAlive = true;
    }
  }
  return { entries, ownerIsAlive };
}

/** Serialize the complete injection transition for listeners sharing a ledger. */
async function withPortableLedgerLock<T>(ledgerFile: string, action: () => Promise<T>): Promise<T> {
  await mkdir(path.dirname(ledgerFile), { recursive: true, mode: 0o700 });
  const lockDirectory = `${ledgerFile}.lock`;
  const token = randomUUID();
  const ownerPath = path.join(lockDirectory, token);
  const startedAt = Date.now();

  while (true) {
    try {
      await mkdir(lockDirectory, { mode: 0o700 });
      try {
        await writeFile(
          ownerPath,
          JSON.stringify({ version: 1, pid: process.pid, token } satisfies LedgerLockOwner),
          { encoding: 'utf8', mode: 0o600, flag: 'wx' }
        );
      } catch (error) {
        await rm(ownerPath, { force: true });
        await rmdir(lockDirectory).catch(() => {});
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          if (Date.now() - startedAt >= LEDGER_LOCK_TIMEOUT_MS) {
            throw new LedgerLockBusyError(lockDirectory);
          }
          await new Promise((resolve) => setTimeout(resolve, LEDGER_LOCK_RETRY_MS));
          continue;
        }
        throw error;
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }

    try {
      if (Date.now() - (await assertLedgerLockDirectory(lockDirectory)).mtimeMs >= LEDGER_LOCK_STALE_MS) {
        const observed = await inspectLedgerLock(lockDirectory);
        if (!observed.ownerIsAlive) {
          for (const entry of observed.entries) {
            await assertLedgerLockDirectory(lockDirectory);
            await rm(path.join(lockDirectory, entry), { force: true });
          }
          await rmdir(lockDirectory).catch((error) => {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== 'ENOENT' && code !== 'ENOTEMPTY') throw error;
          });
          continue;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (Date.now() - startedAt >= LEDGER_LOCK_TIMEOUT_MS) {
      throw new LedgerLockBusyError(lockDirectory);
    }
    await new Promise((resolve) => setTimeout(resolve, LEDGER_LOCK_RETRY_MS));
  }

  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await action() };
  } catch (error) {
    outcome = { ok: false, error };
  }
  let releaseError: unknown;
  try {
    await rm(ownerPath, { force: true });
  } catch (error) {
    releaseError = error;
  }
  try {
    await rmdir(lockDirectory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && releaseError === undefined) releaseError = error;
  }
  if (!outcome.ok) throw outcome.error;
  if (releaseError !== undefined) throw releaseError;
  return outcome.value;
}

/** Durable local barrier around an external coding-session side effect. */
export class DeliveryLedger {
  private entries = new Map<string, LedgerEntry>();

  constructor(
    readonly filePath: string,
    private readonly lock: DeliveryLedgerLock = (action) => withPortableLedgerLock(filePath, action)
  ) {}

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.entries = new Map();
        return;
      }
      throw error;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      throw new Error(`The on-relay delivery ledger is corrupt: ${this.filePath}`);
    }
    const record = asRecord(decoded);
    if (record.version !== 1) {
      throw new Error(`The on-relay delivery ledger has an unsupported version: ${this.filePath}`);
    }
    const entries = new Map<string, LedgerEntry>();
    for (const [id, value] of Object.entries(asRecord(record.deliveries))) {
      const entry = asRecord(value);
      const state = entry.state;
      const updatedAt = entry.updatedAt;
      if (
        (state === 'injecting' || state === 'injected' || state === 'in-doubt' || state === 'rejected') &&
        typeof updatedAt === 'string'
      ) {
        entries.set(id, {
          state,
          updatedAt,
          ...(typeof entry.reason === 'string' ? { reason: entry.reason } : {}),
        });
      }
    }
    this.entries = entries;
  }

  async exclusive<T>(action: () => Promise<T>): Promise<T> {
    return this.lock(async () => {
      await this.load();
      return action();
    });
  }

  get(id: string): LedgerEntry['state'] | undefined {
    return this.entries.get(id)?.state;
  }

  reason(id: string): string | undefined {
    return this.entries.get(id)?.reason;
  }

  async record(id: string, state: LedgerEntry['state'], reason?: string): Promise<void> {
    const next = new Map(this.entries);
    next.set(id, {
      state,
      updatedAt: new Date().toISOString(),
      ...(reason ? { reason: reason.slice(0, 500) } : {}),
    });
    await this.save(next);
    this.entries = next;
  }

  async forget(id: string): Promise<void> {
    if (!this.entries.has(id)) return;
    const next = new Map(this.entries);
    next.delete(id);
    await this.save(next);
    this.entries = next;
  }

  private async save(entries: Map<string, LedgerEntry>): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const deliveries = Object.fromEntries(entries);
    await writeFile(
      temporary,
      `${JSON.stringify({ version: 1, deliveries } satisfies LedgerFile, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600, flag: 'wx' }
    );
    await rename(temporary, this.filePath);
  }
}

export function defaultDeliveryStateFile(name: string, agentId: string, env = process.env): string {
  const root =
    nonEmpty(env.XDG_STATE_HOME) ?? path.join(nonEmpty(env.HOME) ?? os.homedir(), '.agentworkforce');
  const suffix = createHash('sha256').update(agentId).digest('hex').slice(0, 12);
  return path.join(root, 'relay', 'on-relay', `${name}-${suffix}.json`);
}

export function messageReference(messageId: string): string {
  return createHash('sha256').update(messageId).digest('hex').slice(0, 12);
}

function safeLabel(value: string): string {
  return [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return character === '[' || character === ']' || codePoint < 0x20 || codePoint === 0x7f
        ? '?'
        : character;
    })
    .join('');
}

export function labeledDeliveryText(item: DeliveryItem, agentName: string): string {
  const sender = item.message.from.name ? `@${safeLabel(item.message.from.name)}` : 'a teammate';
  const messageId = item.message.id || item.id;
  return `[via Agent Relay — from ${sender} to @${agentName} · ref ${messageReference(
    messageId
  )}]\n\n${item.message.text}`;
}

function deliveryReason(item: DeliveryItem): string | undefined {
  return typeof item.metadata?.reason === 'string' ? item.metadata.reason : undefined;
}

export interface DeliveryDrainerOptions {
  relay: DeliveryQueue;
  ledger: DeliveryLedger;
  injector: DeliveryInjector;
  agentName: string;
  sessionId: string;
  signal?: AbortSignal;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

/** Serial durable queue consumer. A delivery is never injected twice concurrently. */
export class DeliveryDrainer {
  private running?: Promise<void>;
  private requested = false;
  private readonly retryAfter = new Map<string, number>();
  private readonly attempts = new Map<string, number>();

  constructor(private readonly options: DeliveryDrainerOptions) {}

  request(): Promise<void> {
    this.requested = true;
    this.running ??= this.run().finally(() => {
      this.running = undefined;
      if (this.requested && !this.options.signal?.aborted) void this.request();
    });
    return this.running;
  }

  private async run(): Promise<void> {
    while (this.requested && !this.options.signal?.aborted) {
      this.requested = false;
      await this.drainOnce();
    }
  }

  async drainOnce(): Promise<void> {
    await this.options.ledger.exclusive(async () => {
      const result = await this.options.relay.inbox.list({
        agentName: this.options.agentName,
        limit: 50,
      });
      for (const item of result.items) {
        if (this.options.signal?.aborted) return;
        const availableAt = item.availableAt === undefined ? undefined : Date.parse(item.availableAt);
        if (
          (item.state === 'deferred' && availableAt === undefined) ||
          (availableAt !== undefined && (!Number.isFinite(availableAt) || availableAt > Date.now()))
        ) {
          continue;
        }
        if (item.state !== 'queued' && item.state !== 'delivered' && item.state !== 'deferred') continue;
        try {
          await this.handle(item);
        } catch (error) {
          this.options.warn?.(`Delivery ${item.id} could not be handled: ${safeErrorMessage(error)}`);
        }
      }
    });
  }

  private async handle(item: DeliveryItem): Promise<void> {
    const remembered = this.options.ledger.get(item.id);
    if (remembered === 'injected') {
      if (await this.ack(item.id)) await this.options.ledger.forget(item.id);
      return;
    }
    if (remembered === 'injecting' || remembered === 'in-doubt') {
      await this.failInDoubt(item.id);
      return;
    }
    if (remembered === 'rejected') {
      await this.failRejected(item.id, this.options.ledger.reason(item.id) ?? 'delivery rejected');
      return;
    }
    if ((this.retryAfter.get(item.id) ?? 0) > Date.now()) return;
    const reason = deliveryReason(item);
    if (!INJECTED_REASONS.has(reason ?? '') || !item.message.text.trim()) {
      await this.ack(item.id);
      return;
    }
    if (item.message.from.name?.trim().replace(/^@/, '').toLowerCase() === this.options.agentName) {
      await this.ack(item.id);
      return;
    }

    await this.options.ledger.record(item.id, 'injecting');
    let outcome: InjectionOutcome;
    try {
      outcome = await this.options.injector({
        text: labeledDeliveryText(item, this.options.agentName),
        messageId: item.message.id || item.id,
        sessionId: this.options.sessionId,
      });
    } catch {
      outcome = { kind: 'in-doubt', reason: 'the harness injection route failed ambiguously' };
    }
    if (outcome.kind === 'injected') {
      this.attempts.delete(item.id);
      this.retryAfter.delete(item.id);
      await this.options.ledger.record(item.id, 'injected');
      if (!(await this.ack(item.id))) {
        this.options.warn?.(`Injected delivery ${item.id}; acknowledgement will retry.`);
        return;
      }
      await this.options.ledger.forget(item.id);
      this.options.log?.(`Injected delivery ${item.id} from @${item.message.from.name ?? 'unknown'}.`);
      return;
    }
    if (outcome.kind === 'in-doubt') {
      this.attempts.delete(item.id);
      this.retryAfter.delete(item.id);
      await this.options.ledger.record(item.id, 'in-doubt');
      await this.failInDoubt(item.id, outcome.reason);
      this.options.warn?.(`Delivery ${item.id} may have arrived and will not be resent.`);
      return;
    }
    if (outcome.kind === 'rejected') {
      this.attempts.delete(item.id);
      this.retryAfter.delete(item.id);
      await this.options.ledger.record(item.id, 'rejected', outcome.reason);
      await this.failRejected(item.id, outcome.reason);
      this.options.warn?.(`Delivery ${item.id} was rejected (${outcome.reason}).`);
      return;
    }
    await this.options.ledger.forget(item.id);
    const attempt = (this.attempts.get(item.id) ?? 0) + 1;
    this.attempts.set(item.id, attempt);
    const availableAt = Date.now() + Math.min(30_000, 3_000 * 2 ** (attempt - 1));
    this.retryAfter.set(item.id, availableAt);
    try {
      await this.options.relay.inbox.defer({
        inboxItemId: item.id,
        availableAt: new Date(availableAt).toISOString(),
        reason: outcome.reason.slice(0, 500),
      });
    } catch {
      // The local timer still throttles this item. A later SDK queue poll retries it.
    }
    this.options.warn?.(`Could not inject delivery ${item.id}; retrying (${outcome.reason}).`);
  }

  private async ack(id: string): Promise<boolean> {
    try {
      await this.options.relay.inbox.ack({ inboxItemId: id, state: 'read' });
      return true;
    } catch {
      return false;
    }
  }

  private async failInDoubt(id: string, reason = 'in doubt, not resent'): Promise<void> {
    try {
      await this.options.relay.inbox.fail({ inboxItemId: id, error: reason.slice(0, 500), retry: false });
      await this.options.ledger.forget(id);
    } catch {
      // The durable ledger is the duplicate guard; a later SDK queue pass
      // retries this terminal transition without repeating the injection.
    }
  }

  private async failRejected(id: string, reason: string): Promise<void> {
    try {
      await this.options.relay.inbox.fail({ inboxItemId: id, error: reason.slice(0, 500), retry: false });
      await this.options.ledger.forget(id);
    } catch {
      // Keep the terminal record until Relaycast confirms the failure.
    }
  }
}

export interface RunDurableSessionDeliveryOptions {
  relay: DeliveryRelay;
  stateFile: string;
  injector: DeliveryInjector;
  agentName: string;
  sessionId: string;
  signal: AbortSignal;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  pollIntervalMs?: number;
}

/**
 * Consume the SDK's direct-node delivery stream while retaining a local
 * pre-injection barrier for ambiguous external side effects.
 */
export async function runDurableSessionDelivery(options: RunDurableSessionDeliveryOptions): Promise<void> {
  if (!options.relay.capabilities.serverDeliveryState) {
    throw new Error('The Relay SDK client does not support durable delivery state.');
  }
  const ledger = new DeliveryLedger(options.stateFile);
  try {
    await ledger.exclusive(async () => {});
  } catch (error) {
    if (!(error instanceof LedgerLockBusyError)) throw error;
  }
  const drainer = new DeliveryDrainer({ ...options, ledger });
  const requestDrain = () => {
    void drainer.request().catch((error) => {
      if (error instanceof LedgerLockBusyError) return;
      options.warn?.(`Delivery queue unavailable: ${safeErrorMessage(error)}`);
    });
  };

  requestDrain();
  const polling = setInterval(requestDrain, options.pollIntervalMs ?? SAFETY_POLL_INTERVAL_MS);
  try {
    for await (const _item of options.relay.inbox.subscribe({
      agentName: options.agentName,
      signal: options.signal,
      disconnectOnClose: true,
      onConnectionState: (state) => {
        if (state === 'connected') {
          options.log?.('Realtime delivery listener connected.');
          requestDrain();
        }
        if (state === 'error' || state === 'permanentlyDisconnected') {
          options.warn?.(`Realtime delivery listener ${state}.`);
        }
      },
    })) {
      requestDrain();
    }
  } finally {
    clearInterval(polling);
    await drainer.request().catch(() => {});
  }
}
