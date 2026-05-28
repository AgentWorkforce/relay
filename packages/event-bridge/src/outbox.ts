import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readdir, readFile, rename } from 'node:fs/promises';
import path from 'node:path';

/**
 * Options for {@link startOutboxWatcher}.
 */
export interface OutboxWatcherOptions {
  /** Directory the agent writes reply files into. Created if missing. */
  dir: string;
  /**
   * Whether a `replyId` is currently awaiting a reply. Files whose basename is
   * not a pending id are left untouched (could be scratch files or stale).
   */
  isPending: (replyId: string) => boolean;
  /** Invoked with the agent's reply once a file for a pending id is stable. */
  onReply: (replyId: string, replyText: string) => Promise<void> | void;
  /** Quiet period after the last change before a file is read. Default 400ms. */
  debounceMs?: number;
  /** Safety-net rescan interval for events `fs.watch` may miss. Default 2000ms. */
  pollIntervalMs?: number;
  /** Invoked on non-fatal errors (read/move failures). */
  onError?: (err: Error) => void;
}

/**
 * Handle returned by {@link startOutboxWatcher}.
 */
export interface OutboxWatcherHandle {
  /** Stop watching and clear pending timers. */
  stop: () => Promise<void>;
}

/** Subdirectory processed files are moved into so they are not re-read. */
const SENT_DIR = '.sent';

/**
 * Watches an outbox directory for reply files. When the agent writes
 * `<replyId>.<ext>` (any extension) and the id is pending, the file's text is
 * delivered to `onReply` and the file is archived under `.sent/`.
 */
export async function startOutboxWatcher(options: OutboxWatcherOptions): Promise<OutboxWatcherHandle> {
  const dir = path.resolve(options.dir);
  const sentDir = path.join(dir, SENT_DIR);
  const debounceMs = options.debounceMs ?? 400;
  const pollIntervalMs = options.pollIntervalMs ?? 2000;

  await mkdir(sentDir, { recursive: true });

  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const inFlight = new Set<string>();
  let stopped = false;

  const replyIdOf = (file: string): string => path.basename(file, path.extname(file));

  const processFile = async (file: string): Promise<void> => {
    const replyId = replyIdOf(file);
    if (stopped || inFlight.has(file) || !options.isPending(replyId)) {
      return;
    }
    inFlight.add(file);
    try {
      const full = path.join(dir, file);
      const text = await readFile(full, 'utf-8');
      await options.onReply(replyId, text);
      // Archive so a later rescan does not re-deliver the same reply.
      await rename(full, path.join(sentDir, `${Date.now()}-${file}`)).catch(() => {});
    } catch (err) {
      options.onError?.(err instanceof Error ? err : new Error(String(err)));
    } finally {
      inFlight.delete(file);
    }
  };

  const schedule = (file: string): void => {
    if (file === SENT_DIR || file.startsWith('.')) {
      return;
    }
    const existing = timers.get(file);
    if (existing) {
      clearTimeout(existing);
    }
    timers.set(
      file,
      setTimeout(() => {
        timers.delete(file);
        void processFile(file);
      }, debounceMs)
    );
  };

  const rescan = async (): Promise<void> => {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile()) {
          schedule(entry.name);
        }
      }
    } catch (err) {
      options.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  };

  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(dir, (_event, filename) => {
      if (filename) {
        schedule(filename.toString());
      }
    });
  } catch {
    // fs.watch is unsupported on some platforms; the poll loop covers us.
  }

  const poll = setInterval(() => void rescan(), pollIntervalMs);
  await rescan();

  return {
    stop: async () => {
      stopped = true;
      clearInterval(poll);
      watcher?.close();
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
    },
  };
}
