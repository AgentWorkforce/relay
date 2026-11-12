import { createHash } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CODEX_HOOK_COMMAND,
  configPath,
  HOOK_COMMAND,
  runCli,
  skillText,
  TEMP_WORKSPACE_SECONDS,
  type CliIo,
} from './cli.js';
import { handleEventsShimRequest } from './http.js';
import { MemoryEventsShimStore } from './memory-store.js';

const BASE = 'https://shim.test/api/v1/events-shim';

/** A real inbox served in-process, and a CLI environment pointed at a temp HOME. */
async function setupWorld(
  options: {
    claude?: boolean;
    socket?: boolean;
    stdin?: string;
    addFails?: boolean;
    core?: boolean;
    badChecksum?: boolean;
  } = {}
) {
  const store = new MemoryEventsShimStore();
  const shimFetch: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const path = new URL(request.url).pathname.replace('/api/v1/events-shim', '');
    return (
      (await handleEventsShimRequest(request, path, {
        deps: {
          store,
          sleep: async () => {},
          fetchImpl: async () => Response.json({ ok: true }, { status: 202 }),
        },
        urls: {
          mcpUrl: (token) => `${BASE}/t/${token}/mcp`,
          hookUrl: (token, mode) => `${BASE}/h/${token}${mode === 'open' ? '' : `/${mode}`}`,
        },
        pollIntervalMs: 5,
      })) ?? new Response('missing', { status: 404 })
    );
  };
  const created = (await (await shimFetch(`${BASE}/shims`, { method: 'POST' })).json()) as {
    mcp_url: string;
    webhook_url: string;
    manage_token: string;
  };
  const home = mkdtempSync(join(tmpdir(), 'events-shim-cli-'));
  const out: string[] = [];
  const err: string[] = [];
  const runs: string[][] = [];
  const killed: number[] = [];
  const spawned: string[][] = [];
  const appServerCalls: [string, unknown][] = [];
  const listeners = new Set<number>([777]);
  /** A fake Agent Relay core: its bridge calls, whether it runs, the agents it lists. */
  const core = {
    running: options.core ?? false,
    calls: [] as [string, unknown][],
    agents: [] as { name: string; target: { kind: string; id: string } }[],
    hooks: 0,
  };
  const logs: string[] = [];
  const mints: unknown[] = [];
  const downloads: string[] = [];
  const io: CliIo = {
    env: { HOME: home },
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    fetchImpl: async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === 'https://cast.agentrelay.com/v1/workspaces') {
        mints.push(JSON.parse(String(init?.body)));
        return Response.json({
          ok: true,
          data: {
            workspace_id: 'ws1',
            api_key: `rk_live_temp${mints.length}`,
            expires_at: '2026-11-19T14:00:00.000Z',
          },
        });
      }
      if (url.startsWith('https://github.com/AgentWorkforce/relay/releases/download/')) {
        const binary = new Uint8Array([0x7f, 0x45, 0x4c, 0x46]);
        if (!url.endsWith('.sha256')) {
          downloads.push(url);
          return new Response(binary);
        }
        const sum = options.badChecksum ? '0'.repeat(64) : createHash('sha256').update(binary).digest('hex');
        return new Response(`${sum}  agent-relay-node\n`);
      }
      return shimFetch(input, init);
    },
    run: (file, args) => {
      runs.push([file, ...args]);
      if (options.claude === false) return false;
      if (options.addFails && args[0] === 'mcp') return false;
      return true;
    },
    exists: (path) => Boolean(options.socket) && path === '/tmp/agent-relay-test/relay.sock',
    readText: (path) =>
      options.socket && path.endsWith(join('.agentworkforce', 'desktop', 'relay-socket'))
        ? '/tmp/agent-relay-test/relay.sock\n'
        : null,
    readStdin: async () => options.stdin ?? '',
    pid: 4242,
    pidAlive: (pid) => pid === 4242 || pid === 777,
    ancestor: () => 777,
    spawnDetached: (file, args) => {
      spawned.push([file, ...args]);
      if (args[0] === 'serve') core.running = true;
    },
    coreBinaries: () => ['/core/agent-relay-node'],
    runCapture: (_file, args) => {
      if (!core.running) return null;
      const params = JSON.parse(args[3] ?? '{}') as { name?: string };
      core.calls.push([args[1], params]);
      const result =
        args[1] === 'agents.list'
          ? { agents: core.agents }
          : args[1] === 'agents.webhook.create'
            ? (core.hooks += 1) === 1
              ? { id: 'wh1', url: 'https://cast.agentrelay.com/v1/hooks/wh1', secret: null, created: false }
              : {
                  id: `wh${core.hooks}`,
                  url: `https://cast.agentrelay.com/v1/hooks/wh${core.hooks}`,
                  secret: 'wh_live_0123456789abcdef',
                  created: true,
                }
            : {};
      return JSON.stringify({ result });
    },
    appendLog: (line) => {
      logs.push(line);
    },
    codexAppServer: async (work) =>
      work(async (method, params) => {
        appServerCalls.push([method, params]);
        if (method === 'hooks/list') {
          return {
            data: [
              {
                hooks: [
                  {
                    command: 'npx -y @agent-relay/events-shim@latest link --codex-hook',
                    key: '/h/hooks.json:session_start:0:0',
                    currentHash: 'sha256:abc',
                    trustStatus: 'untrusted',
                  },
                ],
              },
            ],
          };
        }
        return {};
      }),
    listDir: (path) => {
      try {
        return readdirSync(path);
      } catch {
        return [];
      }
    },
    kill: (pid) => {
      killed.push(pid);
    },
    processArgs: (pid) =>
      listeners.has(pid)
        ? 'node /x/node_modules/@agent-relay/events-shim/dist/bin.js listen --hook'
        : pid === 555
          ? 'grep listen --hook notes.txt'
          : null,
    createExclusive: (path, contents) => {
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, contents, { flag: 'wx' });
        return true;
      } catch {
        return false;
      }
    },
    sleep: async () => {},
  };
  const post = (body: unknown) =>
    shimFetch(created.webhook_url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return {
    store,
    io,
    out,
    err,
    runs,
    killed,
    listeners,
    spawned,
    appServerCalls,
    home,
    created,
    post,
    shimFetch,
    core,
    logs,
    mints,
    downloads,
  };
}

describe('events-shim CLI', () => {
  it('setup saves the inbox privately, installs the skill and adds the MCP server to Claude Code', async () => {
    const w = await setupWorld();
    expect(await runCli(['setup', w.created.mcp_url, '--claude'], w.io)).toBe(0);

    const config = JSON.parse(readFileSync(configPath(w.io), 'utf8'));
    expect(config).toMatchObject({ mcpUrl: w.created.mcp_url, webhookUrl: w.created.webhook_url });
    expect(modeOf(configPath(w.io))).toBe(0o600);
    const skill = readFileSync(join(w.home, '.claude', 'skills', 'agent-relay-webhooks', 'SKILL.md'), 'utf8');
    expect(skill).toBe(skillText());
    expect(skill).toContain('npx -y @agent-relay/events-shim@latest listen');
    expect(w.runs).toContainEqual([
      'claude',
      'mcp',
      'add',
      '--scope',
      'user',
      '--transport',
      'http',
      'webhooks',
      w.created.mcp_url,
    ]);
    expect(w.out.join('\n')).toContain('Each post wakes it by itself; there is nothing to tell it.');
  });

  it('setup says when Agent Relay is running, and when no agent CLI is installed', async () => {
    const w = await setupWorld({ claude: false, socket: true });
    expect(await runCli(['setup', w.created.mcp_url], w.io)).toBe(0);
    const printed = w.out.join('\n');
    expect(printed).toContain('No supported agent CLI found here');
    w.out.length = 0;
    expect(await runCli(['setup', w.created.mcp_url, '--cursor'], w.io)).toBe(0);
    expect(w.out.join('\n')).toContain('Agent Relay (running here) injects each post');
  });

  it('setup installs the MCP server the right way for each CLI it is asked for', async () => {
    const w = await setupWorld();
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(w.home, '.cursor'), { recursive: true });
    writeFileSync(
      join(w.home, '.cursor', 'mcp.json'),
      JSON.stringify({ mcpServers: { other: { url: 'https://o' } } })
    );
    w.io.readText = (path) => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    };
    const flags = ['--codex', '--cursor', '--opencode', '--muse', '--gemini', '--grok', '--devin'];
    expect(await runCli(['setup', w.created.mcp_url, ...flags], w.io)).toBe(0);
    const url = w.created.mcp_url;
    expect(w.runs).toContainEqual(['codex', 'mcp', 'add', 'webhooks', '--url', url]);
    expect(w.runs).toContainEqual([
      'gemini',
      'mcp',
      'add',
      '--scope',
      'user',
      '--transport',
      'http',
      'webhooks',
      url,
    ]);
    expect(w.runs).toContainEqual([
      'grok',
      'mcp',
      'add',
      '--scope',
      'user',
      '--transport',
      'http',
      'webhooks',
      url,
    ]);
    expect(w.runs).toContainEqual(['devin', 'mcp', 'add', '--scope', 'user', 'webhooks', '--url', url]);
    expect(w.runs.some((run) => run[0] === 'claude' && run[1] === 'mcp')).toBe(false);
    const json = (path: string[]) => JSON.parse(readFileSync(join(w.home, ...path), 'utf8'));
    expect(json(['.cursor', 'mcp.json']).mcpServers).toEqual({
      other: { url: 'https://o' },
      webhooks: { url },
    });
    expect(json(['.config', 'opencode', 'opencode.json']).mcp.webhooks).toEqual({
      type: 'remote',
      url,
      enabled: true,
    });
    expect(json(['.config', 'muse', 'settings.json']).mcpServers.webhooks).toEqual({ url });
    expect(readFileSync(join(w.home, '.codex', 'skills', 'agent-relay-webhooks', 'SKILL.md'), 'utf8')).toBe(
      skillText()
    );
    expect(await runCli(['setup', url, '--cli', 'claude,nope'], w.io)).toBe(2);
    expect(w.err.join('\n')).toContain('Unknown CLI: nope');
  });

  it('setup refuses anything that is not an inbox MCP URL', async () => {
    const w = await setupWorld();
    expect(await runCli(['setup', 'https://evil.example/mcp'], w.io)).toBe(2);
    expect(await runCli(['setup'], w.io)).toBe(2);
    expect(w.err.join('\n')).toContain('MCP URL');
  });

  it('listen waits for the next post, prints it wrapped as data, marks it read and exits', async () => {
    const w = await setupWorld();
    await runCli(['setup', w.created.mcp_url], w.io);
    w.out.length = 0;
    const listening = runCli(['listen'], w.io);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await w.post({ deploy: 'green' });
    expect(await listening).toBe(0);
    const printed = w.out.join('\n');
    expect(printed).toContain('Webhook post #1');
    expect(printed).toContain('untrusted data');
    expect(printed).toContain('{"deploy":"green"}');
    expect(printed).toContain('start the listener again');
    // Handed over once: a second listen with a short timeout finds nothing.
    w.out.length = 0;
    expect(await runCli(['listen', '--timeout', '1'], w.io)).toBe(0);
    expect(w.out.join('\n')).toContain('No webhook post yet');
  });

  it('listen without setup explains what to run', async () => {
    const w = await setupWorld();
    expect(await runCli(['listen'], w.io)).toBe(2);
    expect(w.err.join('\n')).toContain('setup');
  });

  it('forward posts a relayfile event notice into the inbox, once per revision', async () => {
    const w = await setupWorld();
    await runCli(['setup', w.created.mcp_url], w.io);
    const args = [
      'forward',
      '--provider',
      'github',
      '--type',
      'file.updated',
      '--path',
      '/github/repos/a/b/pulls/1/meta.json',
      '--revision',
      'r7',
    ];
    expect(await runCli(args, w.io)).toBe(0);
    expect(await runCli(args, w.io)).toBe(0); // relayfile retried: deduplicated
    w.out.length = 0;
    expect(await runCli(['listen', '--timeout', '1'], w.io)).toBe(0);
    const printed = w.out.join('\n');
    expect(printed).toContain('github.file.updated');
    expect(printed).toContain('/github/repos/a/b/pulls/1/meta.json');
    expect(printed.match(/Webhook post #/g)).toHaveLength(1);
  });

  it("forward --stdin reads relayfile's event, and a hostile file name stays data", async () => {
    const path = "/github/repos/a/b/pulls/1/$(touch /tmp/pwned)'; rm -rf ~;.json";
    const w = await setupWorld({
      stdin: JSON.stringify({ provider: 'github', type: 'file.created', path, revision: 'r1' }),
    });
    await runCli(['setup', w.created.mcp_url], w.io);
    expect(skillText()).toContain("--run 'npx -y @agent-relay/events-shim@latest forward --stdin'");
    expect(skillText()).not.toContain('{{path}}');
    expect(await runCli(['forward', '--stdin'], w.io)).toBe(0);
    w.out.length = 0;
    expect(await runCli(['listen', '--timeout', '1'], w.io)).toBe(0);
    expect(w.out.join('\n')).toContain('github.file.created');
    expect(w.out.join('\n')).toContain('rm -rf ~');
  });

  it('forward takes the provider from the path when relayfile leaves it out', async () => {
    const w = await setupWorld({
      stdin: JSON.stringify({
        type: 'file.updated',
        path: '/github/repos/a/b/commits/c1/metadata.json',
        revision: 'rev_1',
      }),
    });
    await runCli(['setup', w.created.mcp_url], w.io);
    expect(skillText()).toContain("listen --path '/github/**'");
    expect(skillText()).not.toContain('listen --provider');
    expect(await runCli(['forward', '--stdin'], w.io)).toBe(0);
    w.out.length = 0;
    expect(await runCli(['listen', '--timeout', '1'], w.io)).toBe(0);
    expect(w.out.join('\n')).toContain('github.file.updated');
  });

  it('forward keeps every revision of a long path distinct', async () => {
    const w = await setupWorld();
    await runCli(['setup', w.created.mcp_url], w.io);
    const path = `/github/repos/${'x'.repeat(250)}/meta.json`;
    for (const revision of ['r1', 'r2']) {
      expect(
        await runCli(
          [
            'forward',
            '--provider',
            'github',
            '--type',
            'file.updated',
            '--path',
            path,
            '--revision',
            revision,
          ],
          w.io
        )
      ).toBe(0);
    }
    w.out.length = 0;
    expect(await runCli(['listen', '--timeout', '1'], w.io)).toBe(0);
    expect(w.out.join('\n').match(/Webhook post #/g)).toHaveLength(2);
  });

  it('forward handles non-ASCII paths, once per revision', async () => {
    const w = await setupWorld();
    await runCli(['setup', w.created.mcp_url], w.io);
    const args = (revision: string) => [
      'forward',
      '--provider',
      'notion',
      '--type',
      'file.updated',
      '--path',
      '/notion/pages/资料__ünïcode.json',
      '--revision',
      revision,
    ];
    expect(await runCli(args('r1'), w.io)).toBe(0);
    expect(await runCli(args('r1'), w.io)).toBe(0); // retried: deduplicated
    expect(await runCli(args('r2'), w.io)).toBe(0);
    w.out.length = 0;
    expect(await runCli(['listen', '--timeout', '1'], w.io)).toBe(0);
    expect(w.out.join('\n').match(/Webhook post #/g)).toHaveLength(2);
    expect(w.out.join('\n')).toContain('资料__ünïcode');
  });

  it('setup keeps a JSON config private and never replaces one it cannot read', async () => {
    const w = await setupWorld();
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const cursor = join(w.home, '.cursor', 'mcp.json');
    mkdirSync(join(w.home, '.cursor'), { recursive: true });
    writeFileSync(cursor, JSON.stringify({ mcpServers: {} }), { mode: 0o644 }); // shared: setup must make it private
    w.io.readText = (path) => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    };
    w.io.exists = (path) => path === cursor; // only the Cursor config already exists
    expect(await runCli(['setup', w.created.mcp_url, '--cursor'], w.io)).toBe(0);
    expect(modeOf(cursor)).toBe(0o600);
    const fresh = join(w.home, '.config', 'muse', 'settings.json');
    expect(await runCli(['setup', w.created.mcp_url, '--muse'], w.io)).toBe(0);
    expect(modeOf(fresh)).toBe(0o600);

    // Exists but unreadable: left alone, with the manual step.
    w.io.readText = () => null;
    const before = readFileSync(cursor, 'utf8');
    expect(await runCli(['setup', w.created.mcp_url, '--cursor'], w.io)).toBe(1);
    expect(readFileSync(cursor, 'utf8')).toBe(before);
    expect(w.out.join('\n')).toContain('Cursor: could not add the MCP server');
  });

  it("setup --claude installs wake hooks once, keeping the person's own hooks; uninstall takes them out", async () => {
    const w = await setupWorld();
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const settings = join(w.home, '.claude', 'settings.json');
    mkdirSync(join(w.home, '.claude'), { recursive: true });
    writeFileSync(
      settings,
      JSON.stringify({
        model: 'opus',
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine.sh' }] }] },
      })
    );
    w.io.readText = (path) => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    };
    expect(await runCli(['setup', w.created.mcp_url, '--claude'], w.io)).toBe(0);
    expect(await runCli(['setup', w.created.mcp_url, '--claude'], w.io)).toBe(0); // again: still one of ours
    const saved = JSON.parse(readFileSync(settings, 'utf8'));
    expect(saved.model).toBe('opus');
    const ours = { type: 'command', command: HOOK_COMMAND, async: true, asyncRewake: true, timeout: 604800 };
    expect(saved.hooks.SessionStart).toEqual([{ hooks: [ours] }]);
    expect(saved.hooks.Stop).toEqual([
      { hooks: [{ type: 'command', command: 'mine.sh' }] },
      { hooks: [ours] },
    ]);
    expect(saved.permissions.allow).toEqual(['Bash(npx -y @agent-relay/events-shim@latest listen:*)']);

    expect(await runCli(['uninstall', '--claude'], w.io)).toBe(0);
    const after = JSON.parse(readFileSync(settings, 'utf8'));
    expect(after.hooks).toEqual({ Stop: [{ hooks: [{ type: 'command', command: 'mine.sh' }] }] });
    expect(after.permissions.allow).toEqual([]);
    expect(w.runs).toContainEqual(['claude', 'mcp', 'remove', '--scope', 'user', 'webhooks']);
  });

  it("setup and uninstall keep the person's own command in a hook group they share with ours, and uninstall stops listeners", async () => {
    const w = await setupWorld();
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const settings = join(w.home, '.claude', 'settings.json');
    mkdirSync(join(w.home, '.claude'), { recursive: true });
    const shared = {
      matcher: 'startup',
      hooks: [
        { type: 'command', command: 'mine.sh' },
        { type: 'command', command: HOOK_COMMAND },
      ],
    };
    writeFileSync(settings, JSON.stringify({ hooks: { SessionStart: [shared] } }));
    w.io.readText = (path) => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    };
    expect(await runCli(['setup', w.created.mcp_url, '--claude'], w.io)).toBe(0);
    const mine = { matcher: 'startup', hooks: [{ type: 'command', command: 'mine.sh' }] };
    expect(JSON.parse(readFileSync(settings, 'utf8')).hooks.SessionStart[0]).toEqual(mine);
    writeFileSync(join(w.home, '.config', 'agent-relay', 'listen-0123456789abcdef.pid'), '777\n');
    writeFileSync(join(w.home, '.config', 'agent-relay', 'listen-fedcba9876543210.pid'), '555\n'); // a reused pid, not a listener
    expect(await runCli(['uninstall', '--codex'], w.io)).toBe(0);
    expect(w.killed).toEqual([]); // removing Codex leaves Claude's listener running
    expect(await runCli(['uninstall', '--claude'], w.io)).toBe(0);
    expect(JSON.parse(readFileSync(settings, 'utf8')).hooks.SessionStart).toEqual([mine]);
    expect(w.killed).toEqual([777]);
  });

  it('listen --hook runs one hook process per session; uninstall also stops a waiting hook', async () => {
    const w = await setupWorld({ stdin: JSON.stringify({ session_id: 'sess-1' }) });
    w.io.readText = (path) => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    };
    await runCli(['setup', w.created.mcp_url], w.io);
    const dir = join(w.home, '.config', 'agent-relay');
    const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);
    // An earlier turn's hook of this same session (pid 777) is still waiting: this one leaves at once.
    writeFileSync(join(dir, `wait-${digest(`${w.created.mcp_url}\nsess-1`)}.pid`), '777\n');
    expect(await runCli(['listen', '--hook'], w.io)).toBe(0);
    // Uninstalling Claude Code stops waiting hooks too, not only the inbox owner.
    expect(await runCli(['uninstall', '--claude'], w.io)).toBe(0);
    expect(w.killed).toEqual([777]);
    expect(readdirSync(dir).filter((file) => file.endsWith('.pid'))).toEqual([]);
  });

  it('setup --codex installs and trusts the SessionStart hook, starts its own core on a temporary workspace; uninstall untrusts it', async () => {
    const w = await setupWorld();
    w.io.readText = (path) => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    };
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(w.home, '.codex'), { recursive: true });
    writeFileSync(
      join(w.home, '.codex', 'hooks.json'),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine' }] }] } })
    );
    w.io.exists = (path) => {
      try {
        readFileSync(path);
        return true;
      } catch {
        return false;
      }
    };
    expect(await runCli(['setup', w.created.mcp_url, '--codex'], w.io)).toBe(0);
    const hooks = JSON.parse(readFileSync(join(w.home, '.codex', 'hooks.json'), 'utf8')).hooks;
    expect(hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: 'mine' }] }]);
    expect(hooks.SessionStart).toEqual([
      { hooks: [{ type: 'command', command: CODEX_HOOK_COMMAND, timeout: 30 }] },
    ]);
    expect(w.appServerCalls).toContainEqual([
      'config/value/write',
      {
        keyPath: 'hooks.state',
        mergeStrategy: 'upsert',
        value: { '/h/hooks.json:session_start:0:0': { trusted_hash: 'sha256:abc' } },
      },
    ]);
    // No core was running: a 7-day workspace was made and a core started on it.
    expect(w.mints).toEqual([expect.objectContaining({ expires_in_seconds: TEMP_WORKSPACE_SECONDS })]);
    const config = JSON.parse(readFileSync(configPath(w.io), 'utf8'));
    expect(config.workspaceKey).toBe('rk_live_temp1');
    expect(config.workspaceExpiresAt).toBe('2026-11-19T14:00:00.000Z');
    expect(w.downloads).toHaveLength(1);
    expect(w.spawned.find((run) => run[1] === 'serve')).toEqual([
      join(w.home, '.agentworkforce', 'events-shim', 'bin', 'agent-relay-node'),
      'serve',
      '--headless',
    ]);
    const said = w.out.join('\n');
    expect(said).toContain(
      'Start a new Codex session. From its first message on, each post wakes it by itself.'
    );
    expect(said).toContain('temporary Agent Relay workspace, deleted 2026-11-19');

    // Setup again: the same workspace, no new download.
    expect(await runCli(['setup', w.created.mcp_url, '--codex'], w.io)).toBe(0);
    expect(w.mints).toHaveLength(1);
    expect(w.downloads).toHaveLength(1);

    // The core adds its own Codex hooks; uninstall removes them and stops the core it started.
    const core = join(w.home, '.agentworkforce', 'events-shim', 'bin', 'agent-relay-node');
    const withCore = JSON.parse(readFileSync(join(w.home, '.codex', 'hooks.json'), 'utf8'));
    withCore.hooks.Stop.push({ hooks: [{ type: 'command', command: `${core} codex-stop-hook` }] });
    writeFileSync(join(w.home, '.codex', 'hooks.json'), JSON.stringify(withCore));
    const runCapture = w.io.runCapture;
    w.io.runCapture = (file, args) =>
      args[1] === 'status.get'
        ? JSON.stringify({ result: { daemon: { pid: 991 } } })
        : runCapture(file, args);
    w.io.processArgs = (pid) => (pid === 991 ? `${core} serve --headless` : null);
    expect(await runCli(['uninstall', '--codex'], w.io)).toBe(0);
    expect(w.killed).toEqual([991]);
    const left = JSON.parse(readFileSync(join(w.home, '.codex', 'hooks.json'), 'utf8')).hooks;
    expect(left.SessionStart).toBeUndefined();
    expect(left.Stop).toEqual([{ hooks: [{ type: 'command', command: 'mine' }] }]);
    expect(w.appServerCalls).toContainEqual([
      'config/value/write',
      { keyPath: 'hooks.state."/h/hooks.json:session_start:0:0"', mergeStrategy: 'replace', value: null },
    ]);
  });

  it('setup --codex refuses a core download that does not match its checksum', async () => {
    const w = await setupWorld({ badChecksum: true });
    expect(await runCli(['setup', w.created.mcp_url, '--codex'], w.io)).toBe(1);
    expect(w.out.join('\n')).toContain('did not match its checksum');
    expect(w.spawned).toEqual([]);
  });

  it('setup --codex uses a core that is already running (Desktop) and makes no workspace', async () => {
    const w = await setupWorld({ core: true });
    expect(await runCli(['setup', w.created.mcp_url, '--codex'], w.io)).toBe(0);
    expect(w.mints).toEqual([]);
    expect(w.spawned).toEqual([]);
    expect(JSON.parse(readFileSync(configPath(w.io), 'utf8')).workspaceKey).toBeUndefined();
    expect(w.out.join('\n')).not.toContain('temporary');
    // Desktop's core is never stopped by uninstall.
    w.io.runCapture = () => JSON.stringify({ result: { daemon: { pid: 992 } } });
    w.io.processArgs = (pid) => (pid === 992 ? '/usr/lib/agent-relay/agent-relay-desktop' : null);
    expect(await runCli(['uninstall', '--codex'], w.io)).toBe(0);
    expect(w.killed).toEqual([]);
  });

  it('the Codex hook starts a detached link; link makes the session webhook through the core and links the inbox', async () => {
    const thread = '01a1d1a0-39f8-7491-8408-45def74d5a7c';
    const w = await setupWorld({
      core: true,
      stdin: JSON.stringify({ session_id: thread, hook_event_name: 'SessionStart' }),
    });
    w.io.readText = (path) => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    };
    await runCli(['setup', w.created.mcp_url, '--claude'], w.io);
    expect(await runCli(['link', '--codex-hook'], w.io)).toBe(0);
    expect(w.spawned).toHaveLength(1);
    expect(w.spawned[0]!.slice(2)).toEqual(['link', '--kind', 'codex', '--session', thread]);

    // The session shows up on the relay after a while; it already had a webhook, so a new one is made.
    let polls = 0;
    w.io.sleep = async () => {
      polls += 1;
      if (polls === 2) w.core.agents.push({ name: 'codex-01a1', target: { kind: 'codex', id: thread } });
    };
    let linked: unknown = null;
    const fetchBefore = w.io.fetchImpl;
    w.io.fetchImpl = async (input, init) => {
      const text = typeof init?.body === 'string' ? init.body : '';
      if (text.includes('link_relay_wake')) linked = JSON.parse(text).params.arguments;
      return fetchBefore(input, init);
    };
    expect(await runCli(['link', '--kind', 'codex', '--session', thread], w.io)).toBe(0);
    const methods = w.core.calls.map(([method]) => method);
    expect(methods).toContain('agents.webhook.revoke');
    expect(w.core.calls.filter(([method]) => method === 'agents.webhook.create')).toEqual([
      ['agents.webhook.create', { name: 'codex-01a1' }],
      ['agents.webhook.create', { name: 'codex-01a1' }],
    ]);
    expect(linked).toEqual({
      url: 'https://cast.agentrelay.com/v1/hooks/wh2',
      secret: 'wh_live_0123456789abcdef',
    });
    expect(w.logs.at(-1)).toContain('linked codex-01a1');
  });

  it('link gives up quietly when no core can run and the session never appears', async () => {
    const w = await setupWorld();
    await runCli(['setup', w.created.mcp_url, '--claude'], w.io);
    expect(await runCli(['link', '--kind', 'codex', '--session', 'sess-123456'], w.io)).toBe(1);
    expect(w.logs.at(-1)).toContain('no Agent Relay workspace');
    expect(await runCli(['link', '--kind', 'Codex!', '--session', 'x'], w.io)).toBe(2);
  });

  it('a duplicate signed delivery says so without suggesting a new key', async () => {
    const w = await setupWorld();
    await runCli(['setup', w.created.mcp_url], w.io);
    const github = JSON.parse(readFileSync(configPath(w.io), 'utf8')).verifiedUrls.github as string;
    const manage = w.created.manage_token;
    await w.shimFetch(`${BASE}/shims/current/secrets/github`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${manage}`, 'content-type': 'application/json' },
      body: JSON.stringify({ secret: 'gh-secret-1' }),
    });
    const { hmacSha256Hex } = await import('./crypto.js');
    const body = '{"action":"opened"}';
    const send = async () =>
      (await (
        await w.shimFetch(github, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-hub-signature-256': `sha256=${await hmacSha256Hex('gh-secret-1', body)}`,
          },
          body,
        })
      ).json()) as { duplicate?: boolean; message?: string };
    await send();
    const again = await send();
    expect(again.duplicate).toBe(true);
    expect(again.message).toBe('This exact delivery was already received, so it was not delivered again.');
  });

  it('listen --hook wakes the session: exits 2 with the post on stderr', async () => {
    const w = await setupWorld({ stdin: JSON.stringify({ session_id: 'abc-123', hook_event_name: 'Stop' }) });
    w.io.readText = (path) => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    };
    await runCli(['setup', w.created.mcp_url], w.io);
    const listening = runCli(['listen', '--hook'], w.io);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await w.post({ deploy: 'green' });
    expect(await listening).toBe(2);
    const woke = w.err.join('\n');
    expect(woke).toContain('Webhook inbox (agent-relay-webhooks): a post arrived');
    expect(woke).toContain('{"deploy":"green"}');
    expect(woke).toContain('untrusted data');
  });

  it('listen --hook: one listener per inbox; a waiting session takes over when the owner is gone; a closed one claims nothing', async () => {
    const w = await setupWorld({ stdin: JSON.stringify({ session_id: 'abc-123' }) });
    w.io.readText = (path) => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    };
    await runCli(['setup', w.created.mcp_url], w.io);
    const lockFile = join(
      w.home,
      '.config',
      'agent-relay',
      `listen-${createHash('sha256').update(w.created.mcp_url).digest('hex').slice(0, 16)}.pid`
    );
    writeFileSync(lockFile, '777\n'); // another session's live listener owns this inbox
    await w.post({ waiting: true });

    // This session's Claude closes while it waits for ownership: exits, claims nothing.
    let sleeps = 0;
    w.io.sleep = async () => {
      sleeps += 1;
      if (sleeps === 2) w.io.pidAlive = (pid) => pid === 4242; // this session's Claude (777) exits
    };
    expect(await runCli(['listen', '--hook'], w.io)).toBe(0);
    expect(readFileSync(lockFile, 'utf8')).toBe('777\n');

    // A waiting session takes over once the owner is gone, then receives the post.
    w.io.pidAlive = (pid) => pid === 4242 || pid === 777;
    sleeps = 0;
    w.io.sleep = async () => {
      sleeps += 1;
      if (sleeps === 1) w.listeners.delete(777); // the owner's listener exits
    };
    expect(await runCli(['listen', '--hook'], w.io)).toBe(2);
    expect(w.err.join('\n')).toContain('{"waiting":true}');
    expect(() => readFileSync(lockFile, 'utf8')).toThrow(); // released on exit
  });

  it('a duplicate post says it was not delivered again', async () => {
    const w = await setupWorld();
    const send = () =>
      w.shimFetch(w.created.webhook_url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'demo-1' },
        body: '{}',
      });
    await send();
    const again = (await (await send()).json()) as { duplicate: boolean; message: string };
    expect(again.duplicate).toBe(true);
    expect(again.message).toContain('not delivered again');
  });

  it('a JSON-RPC error from the inbox fails setup instead of saving an empty inbox', async () => {
    const w = await setupWorld();
    w.io.fetchImpl = async () =>
      Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'boom' } });
    expect(await runCli(['setup', w.created.mcp_url], w.io)).toBe(1);
    expect(w.err.join('\n')).toContain('boom');
    expect(() => readFileSync(configPath(w.io))).toThrow();
  });

  it('setup reports a failed MCP add instead of claiming success', async () => {
    const w = await setupWorld({ addFails: true });
    expect(await runCli(['setup', w.created.mcp_url, '--claude'], w.io)).toBe(1);
    expect(w.err.join('\n')).toContain('Claude Code did not accept the MCP server');
    // It only removed the old server after the add was refused, and tried again.
    const mcp = w.runs.filter((run) => run[1] === 'mcp').map((run) => run[2]);
    expect(mcp).toEqual(['add', 'remove']);
  });

  it('listen cuts long bodies and names the event id', async () => {
    const w = await setupWorld();
    await runCli(['setup', w.created.mcp_url], w.io);
    await w.post({ big: 'y'.repeat(9_000) });
    w.out.length = 0;
    expect(await runCli(['listen', '--timeout', '1'], w.io)).toBe(0);
    const printed = w.out.join('\n');
    expect(printed).toContain('truncated; call get_webhook_events with event_id');
    expect(printed.length).toBeLessThan(7_000);
  });
});

/** A file's permission bits, read through one open descriptor. */
function modeOf(path: string): number {
  const fd = openSync(path, 'r');
  try {
    return fstatSync(fd).mode & 0o777;
  } finally {
    closeSync(fd);
  }
}
