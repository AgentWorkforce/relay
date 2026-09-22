/**
 * A **codex** session that relay did not launch.
 *
 * Phase 1 of `docs/native-delivery-migration.md` is the `codex queue` route,
 * and the doc's "gate that does not exist yet" asks for a scenario that starts
 * a bare `codex` OUTSIDE the broker and proves a relay message reaches it. The
 * phase-0 host (`session-host.ts`) deliberately used `opencode serve` and said
 * so: codex had no delivery route yet, and launching codex carelessly writes
 * the operator's config. Phase 1 is the phase that owns codex, so this file is
 * the codex half of the same idea.
 *
 * ## Why `codex app-server`, and not a TUI
 *
 * The scenario's constraint is "no wrap, no PTY" — relay must not own the
 * session's terminal. `codex app-server` is a bare `codex` process speaking
 * JSON-RPC over its own stdio: started by the test, parented to the test, with
 * a real thread in codex's own store (a UUIDv7 `thread.id`, a rollout JSONL at
 * `thread.path`, a row in `state_5.sqlite`) — exactly the thread handle
 * `codex queue --thread <uuid>` addresses and `crates/broker/src/codex_thread.rs`
 * settles from. No pseudo-terminal is allocated anywhere in this file.
 *
 * ## The config hazard, closed by construction
 *
 * The doc's testing-hazard section: launching codex in an untrusted directory,
 * or answering its first-run prompts, writes the operator's config. Neither can
 * happen here. `CODEX_HOME` points at a fresh temp directory, so every file
 * codex touches — `config.toml`, `state_5.sqlite`, `sessions/`, `auth.json` —
 * is inside that directory and is removed on `stop()`. `app-server` is
 * non-interactive, so there is no first-run prompt to answer. Verified on
 * codex-cli 0.144.5: after a full start/thread/stop cycle the operator's
 * `~/.codex/config.toml` hash is unchanged.
 *
 * ## How the session registers itself
 *
 * The scenario requires the session to `set_workspace_key` + `register_agent`.
 * Those are relay MCP tools, and in a real unlaunched setup codex is the MCP
 * *client*: the operator configures `mcp_servers.agent-relay` and the session
 * calls the tools. That is reproduced exactly — the relay MCP server is
 * configured in the isolated `config.toml` and spawned by codex, not by this
 * test — with one deliberate difference: the tool call is driven through the
 * app-server's own `mcpServer/tool/call` method rather than by prompting a
 * model to please call it. The call still originates from the codex process's
 * MCP client; what is removed is the model's discretion, which is not the
 * thing under test and which would make the gate nondeterministic and paid.
 */
import { spawn, execFileSync, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Queue-capable Codex builds can ship with the desktop app before PATH updates. */
const CODEX_FALLBACKS = [
  '/Applications/ChatGPT.app/Contents/Resources/codex',
  '/opt/homebrew/bin/codex',
  '/usr/local/bin/codex',
];

/** Enough for a cold `codex app-server` to complete `initialize`. */
const STARTUP_TIMEOUT_MS = 60_000;
/** Any single JSON-RPC round trip. Thread creation is local and fast. */
const RPC_TIMEOUT_MS = 60_000;

type HostChild = ChildProcessByStdio<Writable, Readable, Readable>;

export interface RelayMcpServer {
  /** Executable codex spawns for the relay MCP server (usually `node`). */
  command: string;
  /** Arguments, e.g. `['packages/cli/dist/cli/index.js', 'mcp']`. */
  args: string[];
  /** Extra environment for that server process. Never logged. */
  env?: Record<string, string>;
}

export interface UnlaunchedCodexSession {
  /** Codex's own thread id (UUIDv7) — the `--thread` argument. */
  threadId: string;
  /** Rollout JSONL codex writes this thread to, or null if unreported. */
  rolloutPath: string | null;
  /** PID of the `codex app-server` process. Its parent is this test. */
  pid: number;
  /** Isolated `CODEX_HOME`; removed on stop. */
  codexHome: string;
  /** Isolated working directory the thread was created in. */
  workdir: string;
  /** Call a relay MCP tool through the codex session's own MCP client. */
  callRelayTool(tool: string, args: Record<string, unknown>): Promise<RelayToolResult>;
  /** Every text fragment codex has recorded for this thread. */
  readThreadText(): Promise<string[]>;
  stop(): Promise<void>;
}

export interface RelayToolResult {
  isError: boolean;
  /** Flattened text content of the tool result. */
  text: string;
  structuredContent: unknown;
}

export interface CodexQueueCapability {
  available: boolean;
  /** Human-readable reason, safe to put in an assertion message. */
  reason: string;
}

export function resolveCodexBinary(): string | null {
  const configured = process.env.RELAY_UNLAUNCHED_CODEX_BIN?.trim();
  if (configured) return existsSync(configured) ? configured : null;
  const candidates: string[] = [];
  try {
    const resolved = execFileSync('/bin/sh', ['-c', 'command -v codex'], {
      encoding: 'utf8',
    }).trim();
    if (resolved.length > 0) candidates.push(resolved);
  } catch {
    // A bundled app binary can still satisfy the gate.
  }
  candidates.push(...CODEX_FALLBACKS);
  const existing = [...new Set(candidates)].filter((candidate) => existsSync(candidate));
  return existing.find((candidate) => probeCodexQueueCapability(candidate).available) ?? existing[0] ?? null;
}

/**
 * The same capability decision `CodexQueueTarget::ensure_queue_capability`
 * makes in `crates/broker/src/delivery/codex_queue.rs`, reproduced here so the
 * gate reports the route's own precondition rather than a downstream symptom.
 *
 * The flag check is not belt-and-braces. On codex-cli 0.144.5 an unknown
 * subcommand is not an error: `codex queue --help` prints the top-level help
 * and **exits 0**. A probe that trusted the exit status alone would report the
 * route available on a codex that has no `queue` command at all, and the
 * backend would then classify the real invocation's failure as committed —
 * post-write, never retried, never falling back. Requiring `--thread` and
 * `--message` in the help text is what keeps that failure pre-write.
 */
export function probeCodexQueueCapability(binary: string): CodexQueueCapability {
  const codexHome = mkdtempSync(path.join(tmpdir(), 'relay-codex-probe-'));
  try {
    let stdout = '';
    let status = 0;
    try {
      stdout = execFileSync(binary, ['queue', '--help'], {
        encoding: 'utf8',
        env: { ...process.env, CODEX_HOME: codexHome },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      status = failure.status ?? 1;
      stdout = `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
    }
    if (status !== 0) {
      return { available: false, reason: `\`codex queue --help\` exited ${status}` };
    }
    const hasThread = stdout.includes('--thread');
    const hasMessage = stdout.includes('--message');
    if (!hasThread || !hasMessage) {
      return {
        available: false,
        reason:
          '`codex queue --help` exited 0 but the help text does not document ' +
          `${[!hasThread ? '--thread' : null, !hasMessage ? '--message' : null]
            .filter(Boolean)
            .join(' or ')}` +
          ' — this codex has no `queue` subcommand and printed top-level help instead',
      };
    }
    return { available: true, reason: '`codex queue` documents --thread and --message' };
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
}

/** TOML string literal. Codex config values are parsed as TOML. */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

function relayMcpToml(server: RelayMcpServer): string {
  const lines = [
    '[mcp_servers.agent-relay]',
    `command = ${tomlString(server.command)}`,
    `args = [${server.args.map(tomlString).join(', ')}]`,
  ];
  const env = server.env ?? {};
  const entries = Object.entries(env);
  if (entries.length > 0) {
    lines.push('[mcp_servers.agent-relay.env]');
    for (const [key, value] of entries) lines.push(`${key} = ${tomlString(value)}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Start a bare codex and create one thread in it.
 *
 * Nothing about this is relay-owned: the process is a child of the test, its
 * stdio is a pipe rather than a pty, and the thread is created through codex's
 * own API before relay is told anything.
 */
export async function startUnlaunchedCodexSession(options: {
  binary: string;
  relayMcp: RelayMcpServer;
  startupTimeoutMs?: number;
}): Promise<UnlaunchedCodexSession> {
  const codexHome = mkdtempSync(path.join(tmpdir(), 'relay-unlaunched-codex-'));
  const workdir = path.join(codexHome, 'work');
  const relayHome = path.join(codexHome, 'relay-home');
  mkdirSync(workdir, { recursive: true });
  mkdirSync(relayHome, { recursive: true });
  const isolatedRelayMcp: RelayMcpServer = {
    ...options.relayMcp,
    env: {
      ...options.relayMcp.env,
      // `optionsFromEnv()` also resumes the machine-global active workspace.
      // An empty environment is therefore not enough to make this MCP session
      // unconfigured; isolate both the workspace store and telemetry state.
      AGENT_RELAY_HOME: relayHome,
      AGENT_RELAY_DATA_DIR: relayHome,
      AGENT_RELAY_PROJECT: workdir,
      // Codex normally uses ~/.codex, which both the MCP process and broker can
      // resolve independently. This gate intentionally relocates that store;
      // carry the same location into the MCP child so native attach names the
      // isolated thread store rather than the operator's default one.
      CODEX_HOME: codexHome,
    },
  };

  // `approval_policy`/`sandbox_mode` are set so the session never blocks on an
  // approval request; nothing in this gate runs a command in the session.
  writeFileSync(
    path.join(codexHome, 'config.toml'),
    ['approval_policy = "never"', 'sandbox_mode = "read-only"', '', relayMcpToml(isolatedRelayMcp)].join(
      '\n'
    ),
    'utf8'
  );

  // This is deliberately an *unconfigured* Relay session. The parent test has
  // a workspace key so it can create the hosted workspace and drive the
  // control broker, but passing that key through Codex would make the MCP
  // subprocess auto-register the default `orchestrator` before this session
  // calls set_workspace_key/register_agent itself. Besides violating the
  // scenario, a reused workspace can then make MCP startup exit on an existing
  // orchestrator identity and close the initialize handshake.
  const codexEnv: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: codexHome };
  for (const key of Object.keys(codexEnv)) {
    if (key.startsWith('RELAY_') || key.startsWith('AGENT_RELAY_')) delete codexEnv[key];
  }
  // The one interrupted priming turn below exists only to materialize Codex's
  // rollout file. Never let it inherit a provider credential and accidentally
  // become a paid model request.
  delete codexEnv.OPENAI_API_KEY;
  delete codexEnv.CODEX_API_KEY;

  const child = spawn(options.binary, ['app-server'], {
    cwd: workdir,
    env: codexEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as HostChild;

  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  const stderrTail: string[] = [];
  let buffered = '';
  let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  let nextId = 1;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffered += chunk;
    for (;;) {
      const newline = buffered.indexOf('\n');
      if (newline < 0) break;
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (line.length === 0) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const id = message.id;
      if (typeof id === 'number' && pending.has(id)) {
        pending.get(id)?.(message);
        pending.delete(id);
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderrTail.push(chunk);
    if (stderrTail.length > 40) stderrTail.shift();
  });
  child.on('exit', (code, signal) => {
    exited = { code, signal };
    for (const [id, resolve] of pending) {
      resolve({ id, error: { message: `codex app-server exited (code=${code} signal=${signal})` } });
    }
    pending.clear();
  });

  const request = (method: string, params: unknown, timeoutMs = RPC_TIMEOUT_MS): Promise<unknown> => {
    if (exited) {
      return Promise.reject(
        new Error(`codex app-server is not running: ${JSON.stringify(exited)} ${stderrTail.join('')}`)
      );
    }
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`codex app-server did not answer ${method} within ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, (message) => {
        clearTimeout(timer);
        const error = message.error as { message?: string } | undefined;
        if (error) {
          reject(new Error(`codex app-server refused ${method}: ${error.message ?? JSON.stringify(error)}`));
          return;
        }
        resolve(message.result);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  };

  const cleanup = async (): Promise<void> => {
    if (!child.killed) child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(codexHome, { recursive: true, force: true });
  };

  let threadId: string;
  let rolloutPath: string | null;
  try {
    await request(
      'initialize',
      {
        clientInfo: { name: 'relay-unlaunched-gate', version: '1.0.0' },
        capabilities: { experimentalApi: true },
      },
      options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS
    );
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`);
    const started = (await request('thread/start', { cwd: workdir })) as {
      thread?: { id?: unknown; path?: unknown };
    };
    threadId = String(started.thread?.id ?? '');
    if (!threadId) throw new Error(`codex did not return a thread id: ${JSON.stringify(started)}`);
    rolloutPath = typeof started.thread?.path === 'string' ? started.thread.path : null;

    // `thread/start` reserves the path but Codex does not create the rollout
    // until the first turn begins. `codex queue` resolves its target through
    // that rollout and otherwise returns "no rollout found". Real app/terminal
    // threads have already crossed this boundary; reproduce it without a
    // model call by starting and immediately interrupting a credential-less
    // local turn.
    const primed = (await request('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'Initialize this local delivery test session.' }],
    })) as { turn?: { id?: unknown } };
    const primingTurnId = String(primed.turn?.id ?? '');
    if (primingTurnId) {
      try {
        await request('turn/interrupt', { threadId, turnId: primingTurnId }, 10_000);
      } catch {
        // A missing credential can end the turn before the interrupt arrives;
        // beginning it is sufficient to materialize the rollout.
      }
    }
    if (rolloutPath) {
      const deadline = Date.now() + 10_000;
      while (!existsSync(rolloutPath) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (!existsSync(rolloutPath)) {
        throw new Error(`codex did not materialize the thread rollout at ${rolloutPath}`);
      }
    }
  } catch (error) {
    await cleanup();
    throw error;
  }

  const callRelayTool = async (tool: string, args: Record<string, unknown>): Promise<RelayToolResult> => {
    const result = (await request('mcpServer/tool/call', {
      server: 'agent-relay',
      threadId,
      tool,
      arguments: args,
    })) as {
      content?: Array<{ type?: unknown; text?: unknown }>;
      isError?: unknown;
      structuredContent?: unknown;
    };
    const text = (result.content ?? [])
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .join('\n');
    return {
      isError: result.isError === true,
      text,
      structuredContent: result.structuredContent,
    };
  };

  /**
   * Read the thread back from codex's own records.
   *
   * `thread/items/list` is the supported view and is the only view returned
   * when available. The rollout repeats one logical user item as both a raw
   * response item and an `item_completed` event; combining the two projections
   * would make one injection look like three. The rollout is therefore only a
   * fallback when the supported item view is unavailable.
   */
  const readThreadText = async (): Promise<string[]> => {
    const fragments: string[] = [];
    try {
      const listed = (await request('thread/items/list', { threadId })) as { data?: unknown[] };
      for (const item of listed.data ?? []) fragments.push(JSON.stringify(item));
      return fragments;
    } catch {
      // An app-server that has gone away can still leave an authoritative
      // rollout for the gate to inspect.
    }
    if (rolloutPath && existsSync(rolloutPath)) {
      for (const line of readFileSync(rolloutPath, 'utf8').split('\n')) {
        if (line.trim().length > 0) fragments.push(line);
      }
    }
    return fragments;
  };

  return {
    threadId,
    rolloutPath,
    pid: child.pid as number,
    codexHome,
    workdir,
    callRelayTool,
    readThreadText,
    stop: cleanup,
  };
}

/** Read a process's parent pid. Used to prove relay did not launch the host. */
export function parentPidOf(pid: number): number | null {
  try {
    const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' });
    const parsed = Number.parseInt(out.trim(), 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** How many of `fragments` contain `needle`. */
export function countOccurrences(fragments: string[], needle: string): number {
  return fragments.reduce((total, fragment) => {
    let count = 0;
    let index = fragment.indexOf(needle);
    while (index >= 0) {
      count += 1;
      index = fragment.indexOf(needle, index + needle.length);
    }
    return total + count;
  }, 0);
}
