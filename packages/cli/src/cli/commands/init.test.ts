import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CANCELLED, type InitPrompter } from '../lib/init-prompts.js';
import { boundOrigin } from '../lib/relaycast-origin-binding.js';
import { resolveWorkspaceTransport, type SdkClientOptions } from '../lib/sdk-client.js';
import { readWorkspaceStore, writeWorkspaceStore } from '../lib/workspace-store.js';
import { readProjectWorkspaceKey } from '../lib/project-workspace-key.js';
import { registerAgentCommands } from './agent.js';
import { DownloadHttpError, engineAssetName } from '../lib/relaycast-engine-install.js';
import { LOCAL_ENGINE_VERSION, registerInitCommand, type InitCommandDependencies } from './init.js';
import { PROBE_VERSION, type CoreClient } from '../lib/probe-core.js';
import { getProjectPaths } from '@agent-relay/config';

let home: string;
let project: string;
let toolHome: string;

class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`exit:${code}`);
  }
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-init-home-'));
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-init-project-'));
  toolHome = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-init-toolhome-'));
  vi.stubEnv('AGENT_RELAY_HOME', home);
  vi.stubEnv('AGENT_RELAY_INSTALL_DIR', '');
  vi.stubEnv('RELAYCAST_ENGINE_PATH', '');
  vi.stubEnv('AGENT_RELAY_PROJECT', project);
  vi.stubEnv('RELAY_BASE_URL', '');
  vi.stubEnv('RELAY_WORKSPACE_KEY', '');
  vi.stubEnv('AGENT_RELAY_PROBE_PATH', '');
  // Never reach a real Agent Relay core on the machine running the tests.
  vi.stubEnv('AGENT_RELAY_CORE_SOCKET', path.join(home, 'no-core.sock'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
  fs.rmSync(toolHome, { recursive: true, force: true });
});

function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function setup(overrides: Partial<InitCommandDependencies> = {}) {
  const logs: string[] = [];
  const errors: string[] = [];
  let serverUp = false;
  const createWorkspace = vi.fn(async (name: string, baseUrl?: string) => ({
    workspaceKey: `rk_live_${name}_${baseUrl?.includes('127.0.0.1') ? 'local' : 'remote'}`,
  }));
  const deps: Partial<InitCommandDependencies> = {
    log: (...args) => logs.push(args.join(' ')),
    error: (...args) => errors.push(args.join(' ')),
    exit: vi.fn((code: number) => {
      throw new ExitSignal(code);
    }) as unknown as InitCommandDependencies['exit'],
    createWorkspace: createWorkspace as never,
    startEngine: vi.fn(() => {
      serverUp = true;
      return 4242;
    }),
    isAlive: vi.fn(() => serverUp),
    stop: vi.fn(() => {
      serverUp = false;
    }),
    sleep: async () => undefined,
    fetch: vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/health') return serverUp ? jsonResponse(200, { ok: true }) : jsonResponse(503);
      if (url.pathname === '/v1/workspace') return jsonResponse(200, { ok: true, data: {} });
      return jsonResponse(404);
    }) as never,
    isInteractive: () => false,
    // No tool CLI on PATH and a private home: configs are written as files, here.
    toolContext: () => ({ projectRoot: project, home: toolHome, env: { PATH: '' } }),
    runTool: vi.fn(() => ({ status: 1, output: 'not used' })),
    resolveLaunch: () => ({
      command: '/opt/relay/bin/agent-relay',
      args: ['mcp'],
      reason: 'the test launcher',
    }),
    warmLaunch: vi.fn(),
    // Offline by default: no test reaches GitHub, and the npm path is the fallback.
    downloadEngine: vi.fn(async () => {
      throw new Error('offline');
    }),
    engineVersion: vi.fn(() => undefined),
    enginePlatform: () => ({ platform: 'linux', arch: 'x64', musl: false }),
    // No core runs and none can be downloaded unless a test says so: the MCP route.
    coreSocket: () => path.join(home, 'no-core.sock'),
    connectCore: vi.fn(async () => undefined),
    startCore: vi.fn(() => {
      throw new Error('no core in this test');
    }),
    downloadProbe: vi.fn(async () => {
      throw new Error('offline');
    }),
    probeVersion: vi.fn(() => undefined),
    ...overrides,
  };
  const program = new Command().exitOverride();
  registerInitCommand(program, deps);
  const run = (...args: string[]) => program.parseAsync(['init', ...args], { from: 'user' });
  return { run, logs, errors, createWorkspace, deps };
}

describe('relay init', () => {
  it('starts a local server, creates a workspace bound to it, and reuses both on re-run', async () => {
    const { run, logs, createWorkspace, deps } = setup();
    await run();
    expect(deps.startEngine).toHaveBeenCalledTimes(1);
    expect(createWorkspace).toHaveBeenCalledWith('local', 'http://127.0.0.1:8787');
    const key = readWorkspaceStore().workspaces.local?.key;
    expect(key).toBeDefined();
    expect(boundOrigin(key as string)).toBe('http://127.0.0.1:8787');
    expect(logs.join('\n')).toContain('No account needed');

    await run();
    expect(deps.startEngine).toHaveBeenCalledTimes(1);
    expect(createWorkspace).toHaveBeenCalledTimes(1);
  });

  it('explains a local server that will not start, with the log tail', async () => {
    const { run, errors } = setup({ startEngine: vi.fn(() => 1), isAlive: vi.fn(() => false) });
    await expect(run()).rejects.toEqual(new ExitSignal(1));
    expect(errors.join('\n')).toMatch(/did not start.*Node\.js 22 or 24/s);
  });

  it('connects to your own server only after checking the key, and binds the key to it', async () => {
    const { run, logs, createWorkspace } = setup();
    await run('--url', 'https://relay.corp.test:8443', '--key', 'rk_live_corp', '--name', 'corp');
    expect(createWorkspace).not.toHaveBeenCalled();
    expect(readWorkspaceStore().workspaces.corp?.key).toBe('rk_live_corp');
    expect(boundOrigin('rk_live_corp')).toBe('https://relay.corp.test:8443');
    expect(logs.join('\n')).toContain('only ever sent to this server');
  });

  it('refuses a self-hosted key the server rejects, and saves nothing', async () => {
    const { run, errors } = setup({ fetch: vi.fn(async () => jsonResponse(401)) as never });
    await expect(run('--url', 'https://relay.corp.test', '--key', 'rk_live_bad')).rejects.toEqual(
      new ExitSignal(1)
    );
    expect(errors.join('\n')).toContain('rejected the workspace key');
    expect(readWorkspaceStore().workspaces['relay.corp.test']).toBeUndefined();
    expect(boundOrigin('rk_live_bad')).toBeUndefined();
  });

  it('requires --key with --url', async () => {
    const { run, errors } = setup();
    await expect(run('--url', 'https://relay.corp.test')).rejects.toEqual(new ExitSignal(1));
    expect(errors.join('\n')).toContain('Pass --key with --url');
  });

  it('creates a hosted workspace and prints the one command another machine runs to join', async () => {
    const { run, logs, createWorkspace } = setup({ cliVersion: '15.0.0-next.6' });
    await run('--hosted', '--name', 'team');
    expect(createWorkspace).toHaveBeenCalledWith('team', 'https://cast.agentrelay.com');
    const output = logs.join('\n');
    // The teammate's command is init itself, through npx so Relay need not
    // be installed there: it joins and sets up injection in one step.
    expect(output).toContain('treat this key like a password');
    expect(output).toContain("  npx -y agent-relay@next init --key 'rk_live_team_remote'");
    expect(output).not.toContain('relay workspace join');
    expect(output).not.toContain('--name');
    expect(boundOrigin('rk_live_team_remote')).toBeUndefined();
  });

  it.each([
    ['15.0.0-next.6', 'agent-relay@next'],
    ['15.1.0', 'agent-relay@15.1.0'],
    [undefined, 'agent-relay@next'],
  ])('names the npx package for CLI version %s', async (cliVersion, spec) => {
    const { run, logs } = setup({ cliVersion });
    await run('--hosted', '--name', 'team');
    expect(logs.join('\n')).toContain(`npx -y ${spec} init --key 'rk_live_team_remote'`);
  });

  it('names a hosted workspace after the person and the folder, without asking', async () => {
    const { run, logs, createWorkspace } = setup();
    await run('--hosted');
    let username = '';
    try {
      username = os.userInfo().username;
    } catch {
      // No passwd entry: init names it after the folder alone.
    }
    const user = username
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    const folder = path
      .basename(project)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    const name = [user, folder].filter(Boolean).join('-').slice(0, 40);
    expect(createWorkspace).toHaveBeenCalledWith(name, 'https://cast.agentrelay.com');
    const output = logs.join('\n');
    expect(output).toContain(`Created hosted workspace "${name}".`);
    expect(output).toContain('pass --name to choose another');
    // A second one here gets a name of its own instead of replacing it.
    await run('--hosted');
    expect(createWorkspace).toHaveBeenLastCalledWith(`${name}-2`, 'https://cast.agentrelay.com');
  });

  it('joins a hosted workspace with --key alone, named as the server names it', async () => {
    const { run, logs, createWorkspace, deps } = setup({
      fetch: vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        if (url.pathname === '/v1/workspace') {
          return jsonResponse(200, { ok: true, data: { id: 'ws_team', name: 'team' } });
        }
        return jsonResponse(404);
      }) as never,
    });
    await run('--key', 'rk_live_team_remote');
    expect(createWorkspace).not.toHaveBeenCalled();
    expect(vi.mocked(deps.fetch!).mock.calls[0]?.[0]?.toString()).toBe(
      'https://cast.agentrelay.com/v1/workspace'
    );
    expect(readWorkspaceStore().workspaces.team?.key).toBe('rk_live_team_remote');
    const output = logs.join('\n');
    expect(output).toContain('Joined hosted workspace "team" (https://cast.agentrelay.com).');
    expect(output).toContain('only ever sent to the hosted service');
    expect(output).not.toContain('your server');
    // A teammate does not get told to invite others with a create-only hint.
    expect(output).not.toContain('On another machine');
  });

  it('keeps an explicit --name, and the --url form, when joining the hosted service', async () => {
    const { run, logs } = setup();
    await run('--url', 'https://cast.agentrelay.com', '--key', 'rk_live_team_remote', '--name', 'mine');
    expect(readWorkspaceStore().workspaces.mine?.key).toBe('rk_live_team_remote');
    expect(logs.join('\n')).toContain('Joined hosted workspace "mine" (https://cast.agentrelay.com).');
  });

  it('never sends a key bound to a self-hosted server to the hosted service', async () => {
    const first = setup();
    await first.run('--url', 'https://relay.corp.test:8443', '--key', 'rk_live_corp', '--name', 'corp');
    const fetch = vi.fn(async () => jsonResponse(200, { ok: true, data: {} }));
    const { run, errors } = setup({ fetch: fetch as never });
    await expect(run('--key', 'rk_live_corp')).rejects.toEqual(new ExitSignal(1));
    expect(errors.join('\n')).toContain('belongs to https://relay.corp.test:8443');
    expect(fetch).not.toHaveBeenCalled();
    expect(boundOrigin('rk_live_corp')).toBe('https://relay.corp.test:8443');
  });

  it('keeps the saved local workspace when checking it fails for a reason other than a rejected key', async () => {
    const first = setup();
    await first.run();
    const key = readWorkspaceStore().workspaces.local?.key;

    const { run, errors, createWorkspace } = setup({
      startEngine: vi.fn(() => 4242),
      isAlive: vi.fn(() => true),
      fetch: vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        if (url.pathname === '/health') return jsonResponse(200, { ok: true });
        return jsonResponse(503);
      }) as never,
    });
    await expect(run()).rejects.toEqual(new ExitSignal(1));
    expect(errors.join('\n')).toContain('answered 503');
    expect(createWorkspace).not.toHaveBeenCalled();
    expect(readWorkspaceStore().workspaces.local?.key).toBe(key);
  });

  it('replaces the saved local workspace only when the server rejects its key', async () => {
    const first = setup();
    await first.run();

    const createWorkspace = vi.fn(async () => ({ workspaceKey: 'rk_live_local_replacement' }));
    const { run } = setup({
      startEngine: vi.fn(() => 4242),
      isAlive: vi.fn(() => true),
      createWorkspace: createWorkspace as never,
      fetch: vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        if (url.pathname === '/health') return jsonResponse(200, { ok: true });
        return jsonResponse(401);
      }) as never,
    });
    await run();
    expect(createWorkspace).toHaveBeenCalledTimes(1);
    expect(readWorkspaceStore().workspaces.local?.key).toBe('rk_live_local_replacement');
    expect(boundOrigin('rk_live_local_replacement')).toBe('http://127.0.0.1:8787');
  });

  it('does not create a workspace whose key it could not bind', async () => {
    fs.writeFileSync(path.join(home, 'relaycast-origins.json'), '{not json');
    const { run, errors, createWorkspace } = setup();
    await expect(run()).rejects.toEqual(new ExitSignal(1));
    expect(createWorkspace).not.toHaveBeenCalled();
    expect(errors.join('\n')).toContain('not a valid Relaycast origin file');
  });

  it.each([0, 1, -5, 1.5, '42'])('never signals a process for a saved pid of %s', async (pid) => {
    fs.mkdirSync(path.join(home, 'local'), { recursive: true });
    fs.writeFileSync(
      path.join(home, 'local', 'server.json'),
      JSON.stringify({ pid, port: 8787, origin: 'http://127.0.0.1:8787', engine: 'x' })
    );
    const { run, logs, deps } = setup({ isAlive: vi.fn(() => true) });
    await run('--stop');
    expect(deps.stop).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('No local Relay server is running');
  });

  it('stops the local server it started', async () => {
    const { run, logs, deps } = setup();
    await run();
    await run('--stop');
    expect(deps.stop).toHaveBeenCalledWith(4242);
    expect(logs.join('\n')).toContain('Stopped the local Relay server');
  });
});

describe('relay init and the machine-wide active workspace', () => {
  const HOSTED = { active: 'ghsub-live', workspaces: { 'ghsub-live': { key: 'rk_live_fleet' } } };
  const projectKey = () => readProjectWorkspaceKey(getProjectPaths().dataDir);
  const keptLine =
    /This project now uses workspace "local"; "ghsub-live" stays active machine-wide\. To make "local" the default everywhere, run: relay workspace switch local/;

  it('makes the new workspace active on a machine with none', async () => {
    const { run, logs } = setup();
    await run('--tools', 'none');
    const store = readWorkspaceStore();
    expect(store.active).toBe('local');
    expect(projectKey()).toBe(store.workspaces.local?.key);
    expect(logs.join('\n')).not.toContain('stays active');
  });

  it('keeps a different active workspace, binds this project to the new one, and says so', async () => {
    writeWorkspaceStore(HOSTED);
    const { run, logs } = setup();
    await run('--tools', 'none');
    const store = readWorkspaceStore();
    expect(store.active).toBe('ghsub-live');
    expect(store.workspaces['ghsub-live']?.key).toBe('rk_live_fleet');
    expect(store.workspaces.local?.key).toBe('rk_live_local_local');
    expect(projectKey()).toBe('rk_live_local_local');
    expect(logs.join('\n')).toMatch(keptLine);
  });

  it('stays the same on re-run', async () => {
    writeWorkspaceStore(HOSTED);
    const { run, logs, createWorkspace } = setup();
    await run('--tools', 'none');
    const before = readWorkspaceStore();
    logs.length = 0;
    await run('--tools', 'none');
    expect(createWorkspace).toHaveBeenCalledTimes(1);
    expect(readWorkspaceStore()).toEqual(before);
    expect(projectKey()).toBe('rk_live_local_local');
    expect(logs.join('\n')).toMatch(keptLine);
  });

  it('re-selecting the active workspace keeps it active without a note', async () => {
    const { run, logs } = setup();
    await run('--tools', 'none');
    await run('--tools', 'none');
    expect(readWorkspaceStore().active).toBe('local');
    expect(logs.join('\n')).not.toContain('stays active');
  });

  it('keeps it for --hosted', async () => {
    writeWorkspaceStore(HOSTED);
    const { run, logs } = setup();
    await run('--hosted', '--name', 'team', '--tools', 'none');
    expect(readWorkspaceStore().active).toBe('ghsub-live');
    expect(readWorkspaceStore().workspaces.team?.key).toBe('rk_live_team_remote');
    expect(projectKey()).toBe('rk_live_team_remote');
    expect(logs.join('\n')).toContain('"ghsub-live" stays active machine-wide');
    expect(logs.join('\n')).toContain('relay workspace switch team');
  });

  it('keeps it for --url/--key', async () => {
    writeWorkspaceStore(HOSTED);
    const { run, logs } = setup();
    await run(
      '--url',
      'https://relay.corp.test',
      '--key',
      'rk_live_corp',
      '--name',
      'corp',
      '--tools',
      'none'
    );
    expect(readWorkspaceStore().active).toBe('ghsub-live');
    expect(projectKey()).toBe('rk_live_corp');
    expect(logs.join('\n')).toContain('relay workspace switch corp');
  });

  it('quotes a workspace name the shell would split in the switch command', async () => {
    writeWorkspaceStore(HOSTED);
    const { run, logs } = setup();
    await run('--hosted', '--name', "my team's", '--tools', 'none');
    expect(readWorkspaceStore().workspaces["my team's"]?.key).toBeDefined();
    expect(logs.join('\n')).toContain(`run: relay workspace switch 'my team'\\''s'`);
  });

  it('says which workspace globally set up agent tools use outside this project', async () => {
    writeWorkspaceStore(HOSTED);
    const { run, logs } = setup();
    await run('--tools', 'claude', '--scope', 'global');
    expect(logs.join('\n')).toContain(
      'In projects without their own workspace, globally set up agent tools use the active workspace "ghsub-live". ' +
        'To make "local" the machine-wide fallback, run: relay workspace switch local'
    );
  });

  it('adds no global-scope note at project scope or when the new workspace is active', async () => {
    const fresh = setup();
    await fresh.run('--tools', 'claude', '--scope', 'global');
    expect(fresh.logs.join('\n')).not.toContain('globally set up agent tools');

    writeWorkspaceStore({
      ...HOSTED,
      workspaces: { ...HOSTED.workspaces, ...readWorkspaceStore().workspaces },
    });
    const project = setup();
    await project.run('--tools', 'claude', '--scope', 'project');
    expect(project.logs.join('\n')).not.toContain('globally set up agent tools');
  });

  it('keeps it in the guided flow', async () => {
    writeWorkspaceStore(HOSTED);
    const script = scriptedPrompter(['local', []]);
    const { run } = setup({ isInteractive: () => true, prompter: () => script.prompter });
    await run('--interactive');
    expect(readWorkspaceStore().active).toBe('ghsub-live');
    expect(projectKey()).toBe('rk_live_local_local');
    expect(script.shown.join('\n')).toMatch(keptLine);
  });

  it('then `relay agent register` in this project uses the new local workspace', async () => {
    writeWorkspaceStore(HOSTED);
    const { run } = setup();
    await run('--tools', 'none');

    const transports: ReturnType<typeof resolveWorkspaceTransport>[] = [];
    const register = vi.fn(async ({ name }: { name: string }) => ({
      id: 'a_1',
      name,
      token: 'at_live_alice',
    }));
    const program = new Command().exitOverride();
    registerAgentCommands(program, {
      createWorkspaceRelay: ((options: SdkClientOptions) => {
        transports.push(resolveWorkspaceTransport(options));
        return { workspace: { register } };
      }) as never,
      log: () => undefined,
      error: () => undefined,
      exit: ((code: number) => {
        throw new ExitSignal(code);
      }) as never,
    });
    await program.parseAsync(['agent', 'register', 'alice'], { from: 'user' });

    expect(register).toHaveBeenCalledTimes(1);
    expect(transports).toEqual([
      { workspaceKey: 'rk_live_local_local', baseUrl: 'http://127.0.0.1:8787', source: 'project' },
    ]);
    expect(readWorkspaceStore().active).toBe('ghsub-live');
  });
});

/** A prompter that answers from a script and records what was shown. */
function scriptedPrompter(answers: unknown[]) {
  const shown: string[] = [];
  const asked: string[] = [];
  const next = async (message: string) => {
    asked.push(message);
    if (answers.length === 0) throw new Error(`Unexpected prompt: ${message}`);
    return answers.shift() as never;
  };
  const prompter: InitPrompter = {
    intro: (title) => shown.push(`intro ${title}`),
    outro: (message) => shown.push(`outro ${message}`),
    cancel: (message) => shown.push(`cancel ${message}`),
    note: (message, title) => shown.push(`note ${title ?? ''}\n${message}`),
    info: (message) => shown.push(`info ${message}`),
    warn: (message) => shown.push(`warn ${message}`),
    success: (message) => shown.push(`success ${message}`),
    select: (input) => next(input.message),
    multiselect: (input) => {
      shown.push(
        `options ${input.options.map((o) => `${o.label}${input.initialValues?.includes(o.value) ? '*' : ''}`).join(',')}`
      );
      return next(input.message);
    },
    text: (input) => next(input.message),
    password: (input) => next(input.message),
    confirm: (input) => next(input.message),
    spinner: () => ({
      start: (m) => shown.push(`spin ${m}`),
      message: () => undefined,
      stop: (m) => shown.push(`done ${m}`),
      error: (m) => shown.push(`error ${m}`),
    }),
  };
  return { prompter, shown, asked };
}

const mcpJson = () => JSON.parse(fs.readFileSync(path.join(project, '.mcp.json'), 'utf8'));

describe('relay init agent tools (non-interactive)', () => {
  // The default asks nothing, even in a terminal: this machine, every
  // installed tool, global scope, then what it chose and how to change it.
  it('asks nothing by default, even in a terminal, and says what it chose', async () => {
    fs.mkdirSync(path.join(toolHome, '.claude'));
    const prompter = vi.fn();
    const { run, logs } = setup({
      isInteractive: () => true,
      prompter: prompter as never,
      resolveLaunch: (_ctx: unknown, scope: string) => ({
        command: '/opt/relay/bin/agent-relay',
        args: ['mcp'],
        reason: scope,
      }),
    } as never);
    await run();
    expect(prompter).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(project, '.mcp.json'))).toBe(false);
    const output = logs.join('\n');
    expect(output).toContain('Chosen without asking:');
    expect(output).toMatch(/Server:\s+this machine \(--hosted for agents on other machines/);
    expect(output).toMatch(/Tools:\s+claude \(the ones installed here; --tools to choose\)/);
    expect(output).toMatch(/Scope:\s+global \(--scope project for this project only\)/);
    expect(output).toContain('relay init --interactive');
  });

  it('asks only with --interactive, and only in a terminal', async () => {
    const { run, errors } = setup();
    await expect(run('--interactive')).rejects.toEqual(new ExitSignal(1));
    expect(errors.join('\n')).toContain('--interactive needs a terminal');
  });

  it('connects the detected tools at --scope project', async () => {
    fs.mkdirSync(path.join(toolHome, '.claude'));
    fs.mkdirSync(path.join(toolHome, '.codex'));
    const { run, logs } = setup();
    await run('--scope', 'project');
    expect(mcpJson().mcpServers['agent-relay']).toMatchObject({
      command: '/opt/relay/bin/agent-relay',
      args: ['mcp'],
      env: { AGENT_RELAY_MANAGED_BY: 'relay-init', AGENT_RELAY_CLIENT: 'claude' },
    });
    expect(fs.readFileSync(path.join(project, '.codex', 'config.toml'), 'utf8')).toContain(
      '[mcp_servers.agent-relay]'
    );
    const output = logs.join('\n');
    const folder = path.basename(project).toLowerCase();
    expect(output).toContain(`"Send a message to codex-${folder} saying hello"`);
    expect(output).toContain('relay message dm send bob "hello" --as alice');
    // Codex reads the project file only once the project itself is trusted;
    // --yes never trusts it on the person's behalf.
    expect(output).toContain('Codex reads .codex/config.toml only in projects it trusts');
    expect(output).toContain(
      `[projects.${JSON.stringify(fs.realpathSync(project))}]\n    trust_level = "trusted"`
    );
    expect(fs.existsSync(path.join(toolHome, '.codex', 'config.toml'))).toBe(false);
  });

  it('says nothing about Codex trust when Codex already trusts the project', async () => {
    fs.mkdirSync(path.join(toolHome, '.codex'));
    fs.writeFileSync(
      path.join(toolHome, '.codex', 'config.toml'),
      `[projects.${JSON.stringify(fs.realpathSync(project))}]\ntrust_level = "trusted"\n`
    );
    const { run, logs } = setup();
    await run('--tools', 'codex');
    expect(logs.join('\n')).not.toContain('only in projects it trusts');
  });

  it('resolves the launch for the chosen scope and warms an npx launch before writing it', async () => {
    const resolveLaunch = vi.fn((_ctx: unknown, scope: string) => ({
      command: 'npx',
      args: ['-y', `agent-relay@15.0.0`, 'mcp'],
      reason: scope,
    }));
    const warmLaunch = vi.fn();
    const { run } = setup({ resolveLaunch, warmLaunch });
    await run('--tools', 'claude', '--scope', 'project');
    expect(resolveLaunch).toHaveBeenCalledWith(expect.anything(), 'project');
    expect(warmLaunch).toHaveBeenCalledWith(expect.objectContaining({ command: 'npx' }));
    expect(mcpJson().mcpServers['agent-relay']).toMatchObject({
      command: 'npx',
      args: ['-y', 'agent-relay@15.0.0', 'mcp'],
    });
  });

  it('replaces an entry it wrote with an npx cache path on re-run', async () => {
    const npxCache = '/home/me/.npm/_npx/88f578dfe12e5edc/node_modules/.bin/agent-relay';
    const first = setup({ resolveLaunch: () => ({ command: npxCache, args: ['mcp'], reason: 'old' }) });
    await first.run('--tools', 'claude,codex', '--scope', 'project');
    const { run, logs } = setup({
      resolveLaunch: () => ({ command: 'agent-relay', args: ['mcp'], reason: 'portable' }),
    });
    await run('--tools', 'claude,codex', '--scope', 'project');
    expect(logs.join('\n')).toMatch(/Claude Code\s+updated/);
    expect(mcpJson().mcpServers['agent-relay'].command).toBe('agent-relay');
    const codex = fs.readFileSync(path.join(project, '.codex', 'config.toml'), 'utf8');
    expect(codex).toContain('command = "agent-relay"');
    expect(codex).not.toContain('_npx');
  });

  it('keeps the workspace key out of git status in a git project', async () => {
    // A git hook or shell may point git elsewhere; aim it at the test project only.
    const gitEnv = { ...process.env };
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete gitEnv[key];
    try {
      execFileSync('git', ['init', '-q', project], { env: gitEnv });
    } catch {
      return; // git is not installed here.
    }
    const { run } = setup();
    await run('--tools', 'claude', '--scope', 'project');
    expect(fs.existsSync(path.join(project, '.agentworkforce', 'relay', 'workspace-key.json'))).toBe(true);
    expect(fs.readFileSync(path.join(project, '.git', 'info', 'exclude'), 'utf8')).toContain(
      '/.agentworkforce/relay/'
    );
    const status = execFileSync('git', ['-C', project, 'status', '--porcelain', '--untracked-files=all'], {
      env: gitEnv,
      encoding: 'utf8',
    });
    expect(status).not.toContain('.agentworkforce');
    expect(status).toContain('.mcp.json');
    // The project's own .gitignore is never touched.
    expect(fs.existsSync(path.join(project, '.gitignore'))).toBe(false);
  });

  it('says so when no tool is installed, and still prints the CLI fallback', async () => {
    const { run, logs } = setup();
    await run();
    expect(logs.join('\n')).toContain('No agent tools found');
    expect(logs.join('\n')).toContain('relay agent register alice');
    expect(fs.existsSync(path.join(project, '.mcp.json'))).toBe(false);
  });

  it('installs the tools named by --tools at --scope global', async () => {
    const { run } = setup();
    await run('--tools', 'claude,pi,devin', '--scope', 'global', '--yes');
    expect(
      JSON.parse(fs.readFileSync(path.join(toolHome, '.claude.json'), 'utf8')).mcpServers
    ).toHaveProperty('agent-relay');
    expect(fs.existsSync(path.join(toolHome, '.pi', 'agent', 'mcp.json'))).toBe(true);
    expect(fs.existsSync(path.join(toolHome, '.config', 'devin', 'mcp_config.json'))).toBe(true);
    expect(fs.existsSync(path.join(project, '.mcp.json'))).toBe(false);
  });

  it('--tools none sets up the server only', async () => {
    fs.mkdirSync(path.join(toolHome, '.claude'));
    const { run } = setup();
    await run('--tools', 'none');
    expect(readWorkspaceStore().workspaces.local?.key).toBeDefined();
    expect(fs.existsSync(path.join(project, '.mcp.json'))).toBe(false);
  });

  it('re-running updates its entry instead of duplicating it', async () => {
    const first = setup();
    await first.run('--tools', 'claude', '--scope', 'project');
    const before = fs.readFileSync(path.join(project, '.mcp.json'), 'utf8');
    const { run, logs } = setup();
    await run('--tools', 'claude', '--scope', 'project');
    expect(fs.readFileSync(path.join(project, '.mcp.json'), 'utf8')).toBe(before);
    expect(logs.join('\n')).toContain('already set up');
  });

  it.each([
    [['--tools', 'cursor'], /Unknown tool for --tools: cursor/],
    [['--tools', 'gemini,vscode,windsurf'], /Unknown tools/],
    [['--scope', 'everywhere'], /Expected project or global/],
  ])('rejects %j before changing anything', async (args, message) => {
    const { run, deps } = setup();
    await expect(run(...args)).rejects.toThrow(message);
    expect(deps.startEngine).not.toHaveBeenCalled();
  });

  it('never prompts with --yes, even in a terminal', async () => {
    const prompter = vi.fn();
    const { run } = setup({ isInteractive: () => true, prompter: prompter as never });
    await run('--yes', '--tools', 'claude', '--scope', 'project');
    expect(prompter).not.toHaveBeenCalled();
    expect(mcpJson().mcpServers).toHaveProperty('agent-relay');
  });
});

describe('relay init --uninstall', () => {
  it('removes exactly the entries relay init added, in both scopes by default', async () => {
    fs.writeFileSync(
      path.join(project, '.mcp.json'),
      JSON.stringify({ mcpServers: { github: { command: 'gh-mcp' } } }, null, 2)
    );
    const devinUser = path.join(toolHome, '.config', 'devin', 'mcp_config.json');
    fs.mkdirSync(path.dirname(devinUser), { recursive: true });
    const ownDevin = JSON.stringify({ mcpServers: { 'agent-relay': { command: 'my-own' } } });
    fs.writeFileSync(devinUser, ownDevin);
    const install = setup();
    await install.run('--tools', 'claude,codex', '--scope', 'project');
    await install.run('--tools', 'opencode', '--scope', 'global');

    const { run, logs } = setup();
    await run('--uninstall');
    expect(mcpJson()).toEqual({ mcpServers: { github: { command: 'gh-mcp' } } });
    expect(fs.existsSync(path.join(project, '.codex', 'config.toml'))).toBe(false);
    expect(fs.existsSync(path.join(toolHome, '.config', 'opencode', 'opencode.json'))).toBe(false);
    expect(fs.readFileSync(devinUser, 'utf8')).toBe(ownDevin);
    const output = logs.join('\n');
    expect(output).toMatch(/Claude Code\s+removed/);
    expect(output).toMatch(/Devin \(local CLI\)\s+left as is/);
    // The server and workspace are untouched.
    expect(readWorkspaceStore().workspaces.local?.key).toBeDefined();
  });

  it('limits removal to --scope', async () => {
    const install = setup();
    await install.run('--tools', 'claude', '--scope', 'project');
    await install.run('--tools', 'claude', '--scope', 'global');
    const { run } = setup();
    await run('--uninstall', '--scope', 'global');
    expect(mcpJson().mcpServers).toHaveProperty('agent-relay');
    expect(fs.existsSync(path.join(toolHome, '.claude.json'))).toBe(false);
  });

  it('says when there is nothing to remove', async () => {
    const { run, logs } = setup();
    await run('--uninstall');
    expect(logs.join('\n')).toContain('nothing to remove');
  });
});

describe('relay init guided flow', () => {
  it('asks where agents talk, which tools, and the scope, then installs and names the next step', async () => {
    fs.mkdirSync(path.join(toolHome, '.claude'));
    fs.mkdirSync(path.join(toolHome, '.pi', 'agent'), { recursive: true });
    const script = scriptedPrompter([
      'own',
      'https://relay.corp.test',
      'rk_live_corp',
      ['claude', 'codex'],
      'project',
      true,
      true,
    ]);
    const { run, createWorkspace } = setup({ isInteractive: () => true, prompter: () => script.prompter });
    await run('--interactive', '--delivery', 'mcp');

    expect(script.asked).toEqual([
      'Where should your agents talk?',
      'Server URL',
      'Workspace key',
      'Which agents should get Relay?',
      'Installation scope',
      'Proceed with installation?',
      expect.stringMatching(
        /^Codex reads \.codex\/config\.toml only in projects it trusts\. Trust .* in Codex now\?/
      ),
    ]);
    // Codex now trusts exactly this project, so it loads .codex/config.toml.
    expect(fs.readFileSync(path.join(toolHome, '.codex', 'config.toml'), 'utf8')).toBe(
      `[projects.${JSON.stringify(fs.realpathSync(project))}]\ntrust_level = "trusted"\n`
    );
    expect(script.shown.join('\n')).not.toContain('not trusted yet');
    // Detected tools are pre-checked; every supported tool is offered.
    expect(script.shown).toContain('options Claude Code*,Codex,OpenCode,Grok CLI,Pi*,Devin (local CLI)');
    expect(createWorkspace).not.toHaveBeenCalled();
    expect(boundOrigin('rk_live_corp')).toBe('https://relay.corp.test');
    expect(mcpJson().mcpServers).toHaveProperty('agent-relay');
    const shown = script.shown.join('\n');
    expect(shown).toContain('Installation Summary');
    expect(shown).toContain('Runs: /opt/relay/bin/agent-relay mcp');
    expect(shown).toContain(`Send a message to codex-${path.basename(project).toLowerCase()} saying hello`);
    expect(shown).toContain('outro Relay is ready.');
  });

  it('leaves Codex trust alone when the person declines, and says what is left to do', async () => {
    const script = scriptedPrompter([true, false]);
    const { run } = setup({ isInteractive: () => true, prompter: () => script.prompter });
    await run('--interactive', '--hosted', '--tools', 'codex', '--scope', 'project');
    expect(script.asked).toHaveLength(2);
    expect(fs.existsSync(path.join(toolHome, '.codex', 'config.toml'))).toBe(false);
    expect(script.shown.join('\n')).toContain('not trusted yet');
  });

  it('does not ask about Codex trust at global scope', async () => {
    const script = scriptedPrompter([true]);
    const { run } = setup({ isInteractive: () => true, prompter: () => script.prompter });
    await run('--interactive', '--hosted', '--tools', 'codex', '--scope', 'global');
    expect(script.asked).toEqual(['Proceed with installation?']);
  });

  it('only asks what the flags did not answer', async () => {
    const script = scriptedPrompter([true]);
    const { run } = setup({ isInteractive: () => true, prompter: () => script.prompter });
    await run('--interactive', '--hosted', '--tools', 'grok', '--scope', 'global');
    expect(script.asked).toEqual(['Proceed with installation?']);
    expect(fs.readFileSync(path.join(toolHome, '.grok', 'config.toml'), 'utf8')).toContain('enabled = true');
  });

  it('stops without installing when the person cancels', async () => {
    const script = scriptedPrompter(['local', ['claude'], 'project', CANCELLED]);
    const { run } = setup({ isInteractive: () => true, prompter: () => script.prompter });
    await run('--interactive', '--delivery', 'mcp');
    expect(script.shown.join('\n')).toContain('cancel Setup cancelled');
    expect(fs.existsSync(path.join(project, '.mcp.json'))).toBe(false);
  });

  it('shows the CLI fallback when no agent is chosen', async () => {
    const script = scriptedPrompter(['local', []]);
    const { run } = setup({ isInteractive: () => true, prompter: () => script.prompter });
    await run('--interactive');
    expect(script.shown.join('\n')).toContain('relay agent register alice');
    expect(script.asked).not.toContain('Installation scope');
  });
});

describe('relay init standalone server download', () => {
  const asset = `relaycast-engine-${LOCAL_ENGINE_VERSION}-linux-x64`;
  const base = `https://github.com/AgentWorkforce/relaycast/releases/download/v${LOCAL_ENGINE_VERSION}/${asset}`;
  const body = new TextEncoder().encode('#!/bin/sh\necho relaycast-engine\n');
  const digest = createHash('sha256').update(body).digest('hex');
  const target = () => path.join(home, 'bin', 'relaycast-engine');

  function release(files: Record<string, Uint8Array | number>) {
    return vi.fn(async (url: string) => {
      const file = files[url];
      if (file === undefined || typeof file === 'number') throw new DownloadHttpError(url, file ?? 404);
      return file;
    });
  }

  it('downloads, verifies and installs the pinned binary before starting the server', async () => {
    const downloadEngine = release({
      [base]: body,
      [`${base}.sha256`]: new TextEncoder().encode(`${digest}  ${asset}\n`),
    });
    let installedWhenStarted = false;
    // Only the freshly downloaded temp file runs; nothing is installed yet.
    const engineVersion = vi.fn((binary: string) =>
      binary.endsWith('.tmp') ? LOCAL_ENGINE_VERSION : undefined
    );
    const { run, logs, deps } = setup({ downloadEngine, engineVersion });
    const start = deps.startEngine as ReturnType<typeof vi.fn>;
    const original = start.getMockImplementation() as InitCommandDependencies['startEngine'];
    start.mockImplementation((input) => {
      installedWhenStarted = fs.existsSync(target());
      return original(input);
    });
    await run('--tools', 'none');
    expect(downloadEngine).toHaveBeenCalledWith(
      base,
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    );
    expect(fs.readFileSync(target())).toEqual(Buffer.from(body));
    expect(fs.statSync(target()).mode & 0o777).toBe(0o755);
    expect(installedWhenStarted).toBe(true);
    expect(fs.readdirSync(path.join(home, 'bin'))).toEqual(['relaycast-engine']);
    expect(logs.filter((line) => line.startsWith('Downloading the local Relaycast server'))).toHaveLength(1);
    expect(logs.join('\n')).not.toContain('falling back');
  });

  it('never installs a binary whose checksum does not match, and falls back to npm', async () => {
    const downloadEngine = release({
      [base]: body,
      [`${base}.sha256`]: new TextEncoder().encode(`${'0'.repeat(64)}  ${asset}\n`),
    });
    const { run, logs, deps } = setup({ downloadEngine });
    await run('--tools', 'none');
    expect(fs.existsSync(target())).toBe(false);
    expect(fs.existsSync(path.join(home, 'bin')) ? fs.readdirSync(path.join(home, 'bin')) : []).toEqual([]);
    expect(logs.join('\n')).toMatch(/SHA-256 mismatch.*falling back to the npm package @relaycast\/engine@/s);
    expect(deps.startEngine).toHaveBeenCalledTimes(1);
  });

  it('does not install a verified download that will not run here', async () => {
    const downloadEngine = release({
      [base]: body,
      [`${base}.sha256`]: new TextEncoder().encode(`${digest}  ${asset}\n`),
    });
    const { run, logs } = setup({ downloadEngine, engineVersion: vi.fn(() => undefined) });
    await run('--tools', 'none');
    expect(fs.existsSync(target())).toBe(false);
    expect(fs.readdirSync(path.join(home, 'bin'))).toEqual([]);
    expect(logs.join('\n')).toMatch(/does not run on this machine.*falling back to the npm package/s);
  });

  it('reuses a server another relay init started while this one was downloading', async () => {
    let otherUp = false;
    const downloadEngine = vi.fn(async () => {
      // A concurrent `relay init` starts and records its server during our download.
      fs.mkdirSync(path.join(home, 'local'), { recursive: true });
      fs.writeFileSync(
        path.join(home, 'local', 'server.json'),
        JSON.stringify({ pid: 777, port: 8787, origin: 'http://127.0.0.1:8787', engine: 'x' })
      );
      otherUp = true;
      throw new DownloadHttpError('https://example.test/x', 404);
    });
    const { run, deps } = setup({
      downloadEngine,
      isAlive: vi.fn((pid: number) => pid === 777 && otherUp),
      fetch: vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        if (url.pathname === '/health') return jsonResponse(otherUp ? 200 : 503);
        return jsonResponse(200, { ok: true, data: {} });
      }) as never,
    });
    await run('--tools', 'none');
    expect(deps.startEngine).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(path.join(home, 'local', 'server.json'), 'utf8')).pid).toBe(777);
  });

  it('refuses an occupied port before downloading anything', async () => {
    const downloadEngine = vi.fn(async () => new Uint8Array());
    const { run, errors } = setup({
      downloadEngine,
      fetch: vi.fn(async () => jsonResponse(200, { ok: true })) as never,
    });
    await expect(run('--tools', 'none')).rejects.toEqual(new ExitSignal(1));
    expect(errors.join('\n')).toContain('Something else is already serving on port 8787');
    expect(downloadEngine).not.toHaveBeenCalled();
  });

  it('falls back to npm when the release has no asset for this platform', async () => {
    const downloadEngine = release({});
    const { run, logs, deps } = setup({ downloadEngine });
    await run('--tools', 'none');
    expect(downloadEngine).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(target())).toBe(false);
    expect(logs.join('\n')).toContain(`no release asset ${asset}.sha256`);
    expect(logs.join('\n')).toContain('falling back to the npm package');
    expect(deps.startEngine).toHaveBeenCalledTimes(1);
  });

  it('does not download when the installed binary reports the pinned version', async () => {
    fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
    fs.writeFileSync(target(), 'existing', { mode: 0o755 });
    const downloadEngine = release({});
    const engineVersion = vi.fn(() => LOCAL_ENGINE_VERSION);
    const { run, logs } = setup({ downloadEngine, engineVersion });
    await run('--tools', 'none');
    expect(engineVersion).toHaveBeenCalledWith(target());
    expect(downloadEngine).not.toHaveBeenCalled();
    expect(fs.readFileSync(target(), 'utf8')).toBe('existing');
    expect(logs.join('\n')).not.toContain('Downloading');
  });

  it('replaces an older installed binary, keeping it if the download fails', async () => {
    fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
    fs.writeFileSync(target(), 'old', { mode: 0o755 });
    const { run, logs } = setup({ engineVersion: vi.fn(() => '11.0.0') });
    await run('--tools', 'none');
    expect(fs.readFileSync(target(), 'utf8')).toBe('old');
    expect(logs.join('\n')).toContain(`using the one already at ${target()}`);
  });
});

describe('engineAssetName', () => {
  it.each([
    [{ platform: 'darwin', arch: 'arm64', musl: false }, 'darwin-arm64'],
    [{ platform: 'darwin', arch: 'x64', musl: false }, 'darwin-x64'],
    [{ platform: 'linux', arch: 'x64', musl: false }, 'linux-x64'],
    [{ platform: 'linux', arch: 'arm64', musl: false }, 'linux-arm64'],
    [{ platform: 'linux', arch: 'x64', musl: true }, 'linux-musl-x64'],
    [{ platform: 'linux', arch: 'arm64', musl: true }, 'linux-musl-arm64'],
    [{ platform: 'win32', arch: 'x64', musl: false }, 'windows-x64.exe'],
  ] as const)('maps %o to %s', (target, suffix) => {
    expect(engineAssetName('11.1.0', target)).toBe(`relaycast-engine-11.1.0-${suffix}`);
  });

  it.each([
    { platform: 'win32', arch: 'arm64', musl: false },
    { platform: 'linux', arch: 'ia32', musl: false },
    { platform: 'freebsd', arch: 'x64', musl: false },
  ] as const)('publishes nothing for %o', (target) => {
    expect(engineAssetName('11.1.0', target)).toBeUndefined();
  });
});

interface FakeAgent {
  name: string;
  alias?: string;
  address?: string;
  target: { kind: string; id: string };
  reply_with_final_answer?: boolean | null;
  webhook?: { id: string; url: string };
  integrations?: unknown[];
}

/**
 * An in-memory Agent Relay core: its settings, its workspace, and whether it
 * runs. `owner` is who started it: relay init (through `startCore`) or
 * someone else (the desktop app).
 */
function fakeCore(
  options: {
    running?: boolean;
    settings?: Record<string, unknown>;
    workspaceName?: string;
    workspaceId?: string;
    /** The Relaycast server the core's workspace is on. */
    baseUrl?: string;
    /** Settings the core refuses to turn on. */
    refuse?: string[];
    /** Claude settings files the core's direct delivery writes, as `set_direct_delivery` does. */
    claudeFiles?: string[];
    /** The OpenCode plugin file `opencode_plugin` writes, and whose off marker it leaves. */
    openCodePlugin?: string;
    /** Pi's agent folder, where `pi_extension` writes the extension; off leaves the core's marker. */
    piAgentDir?: string;
    /** Agents on the relay, as `agents.list` names them. */
    agents?: FakeAgent[];
    /** Serve the store's active workspace on `workspace.refresh`, as the real core does. */
    followStore?: boolean;
    /** Names whose sessions have ended. */
    ended?: string[];
    /** Names `agents.register` refuses. */
    refuseRegister?: string[];
  } = {}
) {
  const settings: Record<string, unknown> = {
    auto_activate: false,
    direct_delivery: false,
    claude_session_hook: false,
    codex_stop_hook: false,
    opencode_plugin: false,
    opencode_auto_activate: false,
    grok_leader: false,
    devin_direct_delivery: false,
    pi_extension: false,
    pi_auto_activate: false,
    ...options.settings,
  };
  /** The person's own crossSessionInbound, which the default never overrides. */
  let userChoseInbound = 'direct_delivery' in (options.settings ?? {});
  let up = options.running ?? false;
  let pid = up ? 777 : 0;
  const calls: Array<[string, unknown]> = [];
  let agents = [...(options.agents ?? [])];
  const workspace = {
    state: 'found',
    base_url: options.baseUrl ?? 'http://127.0.0.1:8787',
    workspace_name: options.workspaceName ?? 'local',
    workspace_id: options.workspaceId ?? 'ws_1',
    verification: 'verified',
  };
  const writeInbound = (value: string, only: string | undefined) => {
    for (const file of options.claudeFiles ?? []) {
      let current: Record<string, unknown> = {};
      try {
        current = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
      }
      if (only !== undefined && current.crossSessionInbound !== only) continue;
      if (value === 'accept' && current.crossSessionInbound !== undefined) continue;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ ...current, crossSessionInbound: value }));
    }
  };
  /** As `OpenCodeSettings::set_plugin`: on writes the plugin, off leaves the marker. */
  const writePlugin = (key: string, value: unknown) => {
    const plugin = key === 'opencode_plugin' ? options.openCodePlugin : undefined;
    const on = value === true;
    if (!plugin) return;
    fs.mkdirSync(path.dirname(plugin), { recursive: true });
    fs.rmSync(on ? `${plugin}.off` : plugin, { force: true });
    if (on) fs.writeFileSync(plugin, '// AGENT_RELAY_OPENCODE_PLUGIN=7\n');
    else
      fs.writeFileSync(
        `${plugin}.off`,
        "Agent Relay's OpenCode plugin was turned off in Agent Relay's settings.\n"
      );
  };
  /** As `PiSetup::set_extension`: on writes the extension, off removes it and leaves the marker. */
  const writePiExtension = (key: string, value: unknown) => {
    if (key !== 'pi_extension' || !options.piAgentDir) return;
    const file = path.join(options.piAgentDir, 'extensions', 'agent-relay.js');
    const marker = path.join(toolHome, '.agentworkforce', 'desktop', 'pi-extension.off');
    if (value === true) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '// AGENT_RELAY_PI_EXTENSION=2\n');
      fs.rmSync(marker, { force: true });
      return;
    }
    fs.rmSync(file, { force: true });
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, "Agent Relay's Pi extension was turned off (pi_extension).\n");
  };
  const client: CoreClient = {
    async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      calls.push([method, params]);
      switch (method) {
        case 'status.get':
          return { daemon: { pid, version: PROBE_VERSION, socket: '/core.sock' }, workspace } as T;
        case 'settings.get':
          return { ...settings } as T;
        case 'settings.set':
          for (const [key, value] of Object.entries(params)) {
            if (value === true && options.refuse?.includes(key)) throw new Error(`${key} is not available.`);
            if (key === 'direct_delivery_default') {
              if (!userChoseInbound) {
                settings.direct_delivery = true;
                writeInbound('accept', undefined);
              }
            } else {
              settings[key] = value;
              writePlugin(key, value);
              writePiExtension(key, value);
              if (key === 'direct_delivery') {
                userChoseInbound = false;
                if (value === false) writeInbound('hold', 'accept');
              }
            }
          }
          return { ...settings } as T;
        case 'workspace.refresh':
          if (options.followStore) {
            const store = readWorkspaceStore();
            const key = store.active ? store.workspaces[store.active]?.key : undefined;
            workspace.workspace_name = store.active ?? '';
            workspace.base_url = (key && boundOrigin(key)) ?? 'https://cast.agentrelay.com';
            workspace.workspace_id = `id-${store.active}`;
          }
          return workspace as T;
        case 'agents.list':
          return { agents } as T;
        case 'sessions.list':
          return {
            sessions: agents.map((agent) => ({
              target: agent.target,
              live: !options.ended?.includes(agent.name),
            })),
          } as T;
        case 'agents.unregister':
          agents = agents.filter((agent) => agent.name !== params.name);
          return {} as T;
        case 'agents.register': {
          if (options.refuseRegister?.includes(String(params.name))) throw new Error('taken');
          // Without a name the core suggests one.
          const added = {
            name: String(params.name ?? 'codex-suggested'),
            target: params.target as FakeAgent['target'],
          };
          agents = [...agents, added];
          return { name: added.name } as T;
        }
        case 'daemon.shutdown':
          up = false;
          return { stopping: true } as T;
        default:
          throw new Error(`unexpected ${method}`);
      }
    },
    close: () => undefined,
  };
  return {
    settings,
    calls,
    agents: () => agents,
    isUp: () => up,
    sets: () => calls.filter(([method]) => method === 'settings.set').map(([, params]) => params),
    deps: {
      connectCore: vi.fn(async () => (up ? client : undefined)),
      startCore: vi.fn(() => {
        up = true;
        pid = 5151;
        return pid;
      }),
      // Only the core's pid is alive; the fake local server's is separate.
      probeVersion: vi.fn(() => PROBE_VERSION),
    } satisfies Partial<InitCommandDependencies>,
  };
}

/** A probe binary already in the bin slot, so no download is needed. */
function installedProbe(): string {
  const binary = path.join(home, 'bin', 'agent-relay-probe');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, '#!/bin/sh\necho agent-relay-probe\n', { mode: 0o755 });
  return binary;
}

describe('relay init joining a team after solo relay init', () => {
  const SESSION: FakeAgent = {
    name: 'codex-api',
    address: 'codex-api@mac-a1',
    target: { kind: 'codex', id: 'thread-1' },
  };
  const moves = (calls: Array<[string, unknown]>) =>
    calls.filter(([method]) => method === 'agents.unregister' || method === 'agents.register');

  /** The servers: `local` holds `onLocal`; every workspace's id is the core's for its name. */
  function servers(onLocal: string[] = [SESSION.name], teamName = 'team') {
    let localUp = false;
    return {
      startEngine: vi.fn(() => {
        localUp = true;
        return 4242;
      }),
      isAlive: vi.fn(() => localUp),
      fetch: vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        const local = url.hostname === '127.0.0.1';
        if (url.pathname === '/health') return localUp ? jsonResponse(200, { ok: true }) : jsonResponse(503);
        if (url.pathname === '/v1/workspace') {
          const name = local ? 'local' : teamName;
          return jsonResponse(200, { ok: true, data: { id: `id-${name}`, name } });
        }
        const agent = /^\/v1\/agents\/(.+)$/.exec(url.pathname)?.[1];
        if (agent && onLocal.includes(agent)) {
          return jsonResponse(200, { ok: true, data: { id: 'a1', name: agent } });
        }
        return jsonResponse(404);
      }) as never,
    };
  }

  /** Solo `relay init` with a running session on `local`. */
  async function solo(agents: FakeAgent[] = [SESSION], onLocal?: string[]) {
    installedProbe();
    const core = fakeCore({ agents, followStore: true });
    const net = servers(onLocal);
    await setup({ ...core.deps, ...net }).run('--tools', 'codex');
    expect(readWorkspaceStore().active).toBe('local');
    return { core, net };
  }

  it('solo then --hosted: the machine, the core and running sessions move to the team', async () => {
    const { core, net } = await solo();
    const { run, logs } = setup({ ...core.deps, ...net });
    await run('--hosted', '--name', 'team', '--tools', 'codex');

    expect(readWorkspaceStore().active).toBe('team');
    expect(readWorkspaceStore().workspaces.local).toBeDefined();
    const output = logs.join('\n');
    expect(logs).toContain('Switched this machine to workspace "team"');
    expect(output).toContain('Moved running sessions to "team": codex-api.');
    expect(output).not.toContain('stays active');
    expect(output).not.toContain('agents here join that workspace');
    expect(core.calls.map(([method]) => method)).toContain('workspace.refresh');
    expect(moves(core.calls)).toEqual([
      ['agents.unregister', { name: 'codex-api' }],
      ['agents.register', { target: SESSION.target, name: 'codex-api' }],
    ]);
    expect(core.deps.startCore).toHaveBeenCalledTimes(1);
    expect(core.isUp()).toBe(true);
  });

  it('solo then --key: the same, for a teammate joining', async () => {
    const { core, net } = await solo();
    const { run, logs } = setup({ ...core.deps, ...net });
    await run('--key', 'rk_live_team', '--tools', 'codex');

    expect(readWorkspaceStore().active).toBe('team');
    expect(readProjectWorkspaceKey(getProjectPaths().dataDir)).toBe('rk_live_team');
    expect(logs).toContain('Switched this machine to workspace "team"');
    expect(logs.join('\n')).toContain('Moved running sessions to "team": codex-api.');
    expect(logs.join('\n')).not.toContain('rk_live_');
    expect(moves(core.calls)).toHaveLength(2);
  });

  it('solo then --url/--key: the same, for your own server', async () => {
    const { core, net } = await solo();
    const { run, logs } = setup({ ...core.deps, ...net });
    await run('--url', 'https://relay.corp.test', '--key', 'rk_live_team', '--tools', 'codex');
    expect(readWorkspaceStore().active).toBe('team');
    expect(logs).toContain('Switched this machine to workspace "team"');
  });

  it('a real active workspace stays, and nothing in the core moves', async () => {
    writeWorkspaceStore({ active: 'ghsub-live', workspaces: { 'ghsub-live': { key: 'rk_live_fleet' } } });
    installedProbe();
    const core = fakeCore({ agents: [SESSION] });
    const { run, logs } = setup(core.deps);
    await run('--hosted', '--name', 'team', '--tools', 'codex');

    expect(readWorkspaceStore().active).toBe('ghsub-live');
    expect(logs.join('\n')).toContain('"ghsub-live" stays active machine-wide');
    expect(logs.join('\n')).toContain('relay workspace switch team');
    expect(logs.join('\n')).not.toContain('Switched this machine');
    expect(moves(core.calls)).toEqual([]);
  });

  it('a workspace named local on another server is a real one', async () => {
    writeWorkspaceStore({ active: 'local', workspaces: { local: { key: 'rk_live_mine' } } });
    const { run, logs } = setup();
    await run('--hosted', '--name', 'team', '--tools', 'none');
    expect(readWorkspaceStore().active).toBe('local');
    expect(logs.join('\n')).toContain('"local" stays active machine-wide');
  });

  it('a desktop core is left alone, and so is the active workspace it follows', async () => {
    const core = fakeCore({ running: true, agents: [SESSION], followStore: true });
    const net = servers();
    await setup({ ...core.deps, ...net }).run('--tools', 'none');
    core.calls.length = 0;
    const { run, logs } = setup({ ...core.deps, ...net });
    await run('--hosted', '--name', 'team', '--tools', 'codex');

    expect(readWorkspaceStore().active).toBe('local');
    expect(readProjectWorkspaceKey(getProjectPaths().dataDir)).toBe('rk_live_team_remote');
    const output = logs.join('\n');
    expect(output).toContain('"local" stays active machine-wide');
    expect(output).toContain('core running here');
    expect(output).toContain('relay workspace switch team');
    expect(output).not.toContain('Switched this machine');
    expect(moves(core.calls)).toEqual([]);
    expect(core.calls.some(([method]) => method === 'daemon.shutdown')).toBe(false);
  });

  it('a desktop core is left alone on a machine with no active workspace too', async () => {
    const core = fakeCore({
      running: true,
      workspaceName: 'desktop',
      baseUrl: 'https://cast.agentrelay.com',
    });
    const { run, logs } = setup(core.deps);
    await run('--hosted', '--name', 'team', '--tools', 'none');
    expect(readWorkspaceStore().active).toBeUndefined();
    expect(logs.join('\n')).toContain('relay workspace switch team');
  });

  it('only moves sessions on the local workspace, and names the ones it cannot move', async () => {
    const hook: FakeAgent = {
      name: 'hooked',
      address: 'hooked@mac-a1',
      target: { kind: 'codex', id: 'thread-2' },
      webhook: { id: 'w', url: 'https://example.test' },
    };
    const elsewhere: FakeAgent = {
      name: 'desktop-agent',
      address: 'desktop-agent@mac-a9',
      target: { kind: 'codex', id: 'thread-3' },
    };
    // The same name in another workspace is another agent: its id differs.
    const sameName: FakeAgent = {
      name: 'same-name',
      address: 'same-name@mac-z7',
      target: { kind: 'codex', id: 'thread-4' },
    };
    const { core, net } = await solo(
      [SESSION, hook, elsewhere, sameName],
      [SESSION.name, hook.name, sameName.name]
    );
    const { run, logs } = setup({ ...core.deps, ...net });
    await run('--hosted', '--name', 'team', '--tools', 'codex');

    expect(moves(core.calls)).toHaveLength(2);
    const output = logs.join('\n');
    expect(output).toContain('Moved running sessions to "team": codex-api.');
    expect(output).toContain('These sessions stay on "local": hooked.');
    expect(output).toContain('Start a new agent session to join "team".');
    expect(output).not.toContain('desktop-agent');
    expect(output).not.toContain('same-name');
  });

  it('never removes an agent that could not register again or would lose its alias or reply setting', async () => {
    const agents: FakeAgent[] = [
      { name: 'ended', address: 'ended@mac-a1', target: { kind: 'codex', id: 't1' } },
      { name: 'renamed', alias: 'nick', address: 'nick@mac-a1', target: { kind: 'codex', id: 't2' } },
      {
        name: 'answers',
        reply_with_final_answer: true,
        address: 'answers@mac-a1',
        target: { kind: 'codex', id: 't3' },
      },
    ];
    installedProbe();
    const core = fakeCore({ agents, followStore: true, ended: ['ended'] });
    const net = servers(agents.map((agent) => agent.name));
    await setup({ ...core.deps, ...net }).run('--tools', 'codex');
    const { run, logs } = setup({ ...core.deps, ...net });
    await run('--hosted', '--name', 'team', '--tools', 'codex');

    expect(moves(core.calls)).toEqual([]);
    expect(logs.join('\n')).toContain('These sessions stay on "local": ended, renamed, answers.');
  });

  it('prints the name a moved session got when its own is taken on the team', async () => {
    installedProbe();
    const core = fakeCore({ agents: [SESSION], followStore: true, refuseRegister: ['codex-api'] });
    const net = servers();
    await setup({ ...core.deps, ...net }).run('--tools', 'codex');
    const { run, logs } = setup({ ...core.deps, ...net });
    await run('--hosted', '--name', 'team', '--tools', 'codex');
    expect(logs.join('\n')).toContain('Moved running sessions to "team": codex-suggested.');
  });

  it('names a session that left local but could not join the team', async () => {
    installedProbe();
    const core = fakeCore({
      agents: [SESSION],
      followStore: true,
      refuseRegister: ['codex-api', 'undefined'],
    });
    const net = servers();
    await setup({ ...core.deps, ...net }).run('--tools', 'codex');
    const { run, logs } = setup({ ...core.deps, ...net });
    await run('--hosted', '--name', 'team', '--tools', 'codex');
    expect(logs.join('\n')).toContain('These sessions could not join "team": codex-api.');
  });

  it('a team saved under the name local still moves the sessions off the old key', async () => {
    installedProbe();
    const core = fakeCore({ agents: [SESSION], followStore: true });
    const net = servers([SESSION.name], 'local');
    await setup({ ...core.deps, ...net }).run('--tools', 'codex');
    const { run, logs } = setup({ ...core.deps, ...net });
    await run('--hosted', '--name', 'local', '--tools', 'codex');
    expect(readWorkspaceStore().workspaces.local?.key).toBe('rk_live_local_remote');
    expect(logs.join('\n')).toContain('Moved running sessions to "local": codex-api.');
  });

  it('refuses to swap the key under an active name it may not move', async () => {
    writeWorkspaceStore({ active: 'fleet', workspaces: { fleet: { key: 'rk_live_fleet' } } });
    const { run, errors, createWorkspace } = setup();
    await expect(run('--hosted', '--name', 'fleet', '--tools', 'none')).rejects.toThrow('exit:1');
    expect(errors.join('\n')).toContain('Workspace "fleet" is active on this machine');
    expect(createWorkspace).not.toHaveBeenCalled();
    expect(readWorkspaceStore().workspaces.fleet?.key).toBe('rk_live_fleet');
  });

  it('a stopped core started again by this run still moves the sessions', async () => {
    const { core, net } = await solo();
    await setup({ ...core.deps, ...net, isAlive: vi.fn(() => false) }).run('--stop');
    const { run, logs } = setup({ ...core.deps, ...net });
    await run('--hosted', '--name', 'team', '--tools', 'codex');

    expect(core.deps.startCore).toHaveBeenCalledTimes(2);
    expect(logs).toContain('Switched this machine to workspace "team"');
    expect(logs.join('\n')).toContain('Moved running sessions to "team": codex-api.');
  });

  it('says what to do when the core stays on another workspace', async () => {
    installedProbe();
    const core = fakeCore({ agents: [SESSION], followStore: true });
    const net = servers();
    await setup({ ...core.deps, ...net }).run('--tools', 'codex');
    // The core's own environment names a workspace: a refresh changes nothing.
    const { connectCore } = core.deps;
    const pinned = vi.fn(async (socket: string) => {
      const client = await connectCore(socket);
      if (!client) return undefined;
      return {
        ...client,
        call: async <T>(method: string, params?: Record<string, unknown>) =>
          (method === 'workspace.refresh'
            ? {
                state: 'found',
                base_url: 'http://127.0.0.1:8787',
                workspace_name: 'local',
                verification: 'verified',
              }
            : await client.call<T>(method, params)) as T,
      };
    });
    const { run, logs } = setup({ ...core.deps, ...net, connectCore: pinned });
    await run('--hosted', '--name', 'team', '--tools', 'codex');
    expect(logs.join('\n').match(/agents here join that workspace/g)).toHaveLength(1);
    expect(moves(core.calls)).toEqual([]);
  });

  it('moves nothing when the core cannot say it serves the new workspace', async () => {
    const { core, net } = await solo();
    const { connectCore } = core.deps;
    const failing = vi.fn(async (socket: string) => {
      const client = await connectCore(socket);
      if (!client) return undefined;
      return {
        ...client,
        call: async <T>(method: string, params?: Record<string, unknown>) => {
          if (method === 'workspace.refresh') throw new Error('busy');
          return client.call<T>(method, params);
        },
      };
    });
    const { run, logs } = setup({ ...core.deps, ...net, connectCore: failing });
    await run('--hosted', '--name', 'team', '--tools', 'codex');
    expect(moves(core.calls)).toEqual([]);
    expect(logs.join('\n')).toContain('Start a new agent session to join "team".');
  });

  it('--uninstall after a switch turns off injection and keeps the workspace', async () => {
    const { core, net } = await solo();
    await setup({ ...core.deps, ...net }).run('--hosted', '--name', 'team', '--tools', 'codex');
    await setup({ ...core.deps, ...net }).run('--uninstall');
    expect(core.settings.codex_stop_hook).toBe(false);
    expect(core.settings.auto_activate).toBe(false);
    expect(readWorkspaceStore().active).toBe('team');
  });
});

describe('relay init message injection', () => {
  it('starts the core, turns on delivery for the chosen tools, and reuses it on re-run', async () => {
    installedProbe();
    const core = fakeCore();
    const { run, logs, deps } = setup(core.deps);
    await run('--tools', 'claude,codex');

    expect(core.deps.startCore).toHaveBeenCalledTimes(1);
    expect(core.deps.startCore).toHaveBeenCalledWith(
      expect.objectContaining({
        binary: path.join(home, 'bin', 'agent-relay-probe'),
        socket: deps.coreSocket?.(),
      })
    );
    expect(core.sets()).toEqual([
      { direct_delivery_default: true },
      { claude_session_hook: true },
      { codex_stop_hook: true },
      { auto_activate: true },
    ]);
    const output = logs.join('\n');
    expect(output).toContain(`Started the Agent Relay core (agent-relay-probe ${PROBE_VERSION}, pid 5151)`);
    expect(output).toMatch(/Claude Code\s+injected through Claude Code's session inbox/);
    expect(output).toMatch(/Codex\s+injected through PostToolUse, Stop and SessionStart hooks/);
    expect(output).toContain('apply in every project on this machine');
    // One identity per session: no MCP server is added for injected tools.
    expect(fs.existsSync(path.join(project, '.mcp.json'))).toBe(false);
    expect(fs.existsSync(path.join(project, '.codex', 'config.toml'))).toBe(false);
    expect(output).not.toContain('only in projects it trusts');
    expect(output).toContain('Each session joins Relay on its own');
    expect(JSON.parse(fs.readFileSync(path.join(home, 'local', 'core-settings.json'), 'utf8'))).toEqual({
      turnedOn: ['direct_delivery', 'claude_session_hook', 'codex_stop_hook', 'auto_activate'],
      // What --uninstall tidies back to: no Claude settings file or folder yet.
      claudeFiles: {
        [path.join(toolHome, '.claude', 'settings.json')]: { existed: false, backup: false, dir: false },
      },
    });

    const again = setup(core.deps);
    await again.run('--tools', 'claude,codex');
    expect(core.deps.startCore).toHaveBeenCalledTimes(1);
    expect(again.logs.join('\n')).toContain('The Agent Relay core relay init started earlier is running (');
    expect(core.sets()).toHaveLength(4);
  });

  it('attaches to a core it did not start, such as the desktop app, and never starts a second one', async () => {
    const core = fakeCore({ running: true, settings: { auto_activate: true, codex_stop_hook: true } });
    const { run, logs } = setup(core.deps);
    await run('--tools', 'codex');
    expect(core.deps.startCore).not.toHaveBeenCalled();
    expect(core.sets()).toEqual([]);
    expect(logs.join('\n')).toContain('Using the Agent Relay core already running on this machine');
    // Nothing was turned on, so nothing is recorded to turn off.
    expect(fs.existsSync(path.join(home, 'local', 'core-settings.json'))).toBe(false);

    const stop = setup(core.deps);
    await stop.run('--stop');
    expect(core.isUp()).toBe(true);
  });

  it('stops only the core it started', async () => {
    installedProbe();
    const core = fakeCore();
    const { run } = setup(core.deps);
    await run('--tools', 'claude');
    const stop = setup({ ...core.deps, isAlive: vi.fn(() => false) });
    await stop.run('--stop');
    expect(core.isUp()).toBe(false);
    expect(core.calls.some(([method]) => method === 'daemon.shutdown')).toBe(true);
    expect(stop.logs.join('\n')).toContain('Stopped the Agent Relay core relay init started');
    expect(fs.existsSync(path.join(home, 'local', 'core.json'))).toBe(false);
  });

  it('removes the MCP entry an earlier relay init added, so each session has one identity', async () => {
    const mcp = setup();
    await mcp.run('--tools', 'claude', '--delivery', 'mcp', '--scope', 'project');
    expect(mcpJson().mcpServers).toHaveProperty('agent-relay');

    installedProbe();
    const { run, logs } = setup(fakeCore().deps);
    await run('--tools', 'claude', '--scope', 'project');
    expect(fs.existsSync(path.join(project, '.mcp.json'))).toBe(false);
    expect(logs.join('\n')).toMatch(/Claude Code\s+removed the earlier Relay MCP entry from \.mcp\.json/);
  });

  it("keeps the person's own crossSessionInbound and says messages are held", async () => {
    installedProbe();
    const core = fakeCore({ settings: { direct_delivery: false } });
    const { run, logs } = setup(core.deps);
    await run('--tools', 'claude');
    expect(core.settings.direct_delivery).toBe(false);
    expect(logs.join('\n')).toContain('messages are held for your approval unless it is "accept"');
  });

  it('turns off on --uninstall exactly what it turned on, and only for the user scope', async () => {
    installedProbe();
    const core = fakeCore({ running: true, settings: { auto_activate: true } });
    await setup(core.deps).run('--tools', 'claude,devin');

    const projectOnly = setup(core.deps);
    await projectOnly.run('--uninstall', '--scope', 'project');
    expect(core.settings.devin_direct_delivery).toBe(true);
    expect(projectOnly.logs.join('\n')).toContain('Message injection is a per-user setting and was left on');

    const { run, logs } = setup(core.deps);
    await run('--uninstall');
    expect(core.settings).toMatchObject({
      auto_activate: true,
      direct_delivery: false,
      claude_session_hook: false,
      devin_direct_delivery: false,
    });
    expect(logs.join('\n')).toContain(
      'turned off what relay init turned on (direct_delivery, claude_session_hook, devin_direct_delivery)'
    );
    expect(fs.existsSync(path.join(home, 'local', 'core-settings.json'))).toBe(false);
  });

  it('removes the crossSessionInbound it added rather than leaving the hold the core writes', async () => {
    installedProbe();
    const claudeSettings = path.join(toolHome, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(claudeSettings), { recursive: true });
    fs.writeFileSync(claudeSettings, JSON.stringify({ theme: 'dark' }));
    const core = fakeCore({ running: true, settings: { auto_activate: true, claude_session_hook: true } });
    await setup(core.deps).run('--tools', 'claude');
    // What the core does on direct_delivery false: Claude Code's default, hold.
    fs.writeFileSync(claudeSettings, JSON.stringify({ theme: 'dark', crossSessionInbound: 'hold' }));
    await setup(core.deps).run('--uninstall');
    expect(JSON.parse(fs.readFileSync(claudeSettings, 'utf8'))).toEqual({ theme: 'dark' });
  });

  it('starts a core just to turn injection off when none runs, and stops it again', async () => {
    installedProbe();
    const core = fakeCore();
    await setup(core.deps).run('--tools', 'opencode');
    await setup({ ...core.deps, isAlive: vi.fn(() => false) }).run('--stop');
    expect(core.isUp()).toBe(false);

    await setup({ ...core.deps, isAlive: vi.fn(() => false) }).run('--uninstall');
    expect(core.settings.opencode_plugin).toBe(false);
    expect(core.isUp()).toBe(false);
  });

  it('warns when the core serves a different workspace than this project', async () => {
    installedProbe();
    const core = fakeCore({ running: true, workspaceName: 'ghsub-live' });
    const { run, logs } = setup(core.deps);
    await run('--tools', 'claude');
    expect(logs.join('\n')).toContain(
      'serves workspace "ghsub-live" (http://127.0.0.1:8787), not "local": agents here join that workspace'
    );
    expect(logs.join('\n')).toContain('relay workspace switch local');
  });

  it('uses the MCP server for a tool the core cannot deliver to', async () => {
    installedProbe();
    const core = fakeCore();
    const connect = core.deps.connectCore;
    const { run, logs } = setup({
      ...core.deps,
      connectCore: vi.fn(async (socket: string) => {
        const client = await connect(socket);
        if (!client) return undefined;
        return {
          ...client,
          call: async <T>(method: string, params?: Record<string, unknown>) => {
            if (method === 'settings.set' && params && 'grok_leader' in params) {
              throw new Error('Grok is not installed.');
            }
            return client.call<T>(method, params);
          },
        };
      }),
    });
    await expect(run('--tools', 'claude,grok', '--scope', 'project')).resolves.toBeDefined();
    const output = logs.join('\n');
    expect(output).toMatch(/Grok CLI\s+not injected: Grok is not installed\./);
    expect(fs.readFileSync(path.join(project, '.grok', 'config.toml'), 'utf8')).toContain('agent-relay');
    expect(fs.existsSync(path.join(project, '.mcp.json'))).toBe(false);
  });

  it('installs the Pi extension only for Pi, records it, and removes it on --uninstall', async () => {
    installedProbe();
    const core = fakeCore();
    await setup(core.deps).run('--tools', 'codex');
    expect(core.settings.pi_extension).toBe(false);
    expect(core.settings.pi_auto_activate).toBe(false);

    await setup(core.deps).run('--tools', 'pi');
    // Pi sessions join on their own only with Pi's own opt-in on top of auto_activate.
    expect(core.settings).toMatchObject({ pi_extension: true, pi_auto_activate: true, auto_activate: true });
    expect(core.settings.opencode_auto_activate).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(home, 'local', 'core-settings.json'), 'utf8'))).toEqual({
      turnedOn: ['codex_stop_hook', 'auto_activate', 'pi_extension', 'pi_auto_activate'],
      pi: {
        file: path.join(toolHome, '.pi', 'agent', 'extensions', 'agent-relay.js'),
        marker: path.join(toolHome, '.agentworkforce', 'desktop', 'pi-extension.off'),
        extension: false,
        off: false,
        dir: false,
      },
    });

    const toMcp = setup(core.deps);
    await toMcp.run('--tools', 'pi', '--delivery', 'mcp');
    expect(core.settings).toMatchObject({ pi_extension: false, pi_auto_activate: false });
    expect(core.settings.codex_stop_hook).toBe(true);

    await setup(core.deps).run('--tools', 'pi');
    await setup({ ...core.deps, isAlive: vi.fn(() => false) }).run('--uninstall');
    expect(core.settings).toMatchObject({
      pi_extension: false,
      pi_auto_activate: false,
      codex_stop_hook: false,
      auto_activate: false,
    });
  });

  it('lets OpenCode sessions join on their own and turns exactly that off on --uninstall', async () => {
    installedProbe();
    const core = fakeCore();
    await setup(core.deps).run('--tools', 'opencode');
    expect(core.sets()).toEqual([
      { opencode_plugin: true },
      { opencode_auto_activate: true },
      { auto_activate: true },
    ]);
    expect(core.settings.pi_auto_activate).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(home, 'local', 'core-settings.json'), 'utf8'))).toEqual({
      turnedOn: ['opencode_plugin', 'opencode_auto_activate', 'auto_activate'],
      openCode: {
        file: path.join(toolHome, '.config', 'opencode', 'plugins', 'agent-relay.js'),
        plugin: false,
        off: false,
        dir: false,
      },
    });

    await setup({ ...core.deps, isAlive: vi.fn(() => false) }).run('--uninstall');
    expect(core.settings).toMatchObject({
      opencode_plugin: false,
      opencode_auto_activate: false,
      auto_activate: false,
    });
    expect(core.settings.pi_auto_activate).toBe(false);
  });

  // The relay init end-to-end run on 2026-10-29: --uninstall left `{}` in
  // ~/.claude/settings.json and plugins/agent-relay.js.off behind.
  it('leaves the Claude and OpenCode folders as it found them on --uninstall', async () => {
    installedProbe();
    const claude = path.join(toolHome, '.claude');
    fs.mkdirSync(claude);
    fs.writeFileSync(path.join(claude, 'history.jsonl'), 'x\n');
    const opencode = path.join(toolHome, '.config', 'opencode');
    fs.mkdirSync(opencode, { recursive: true });
    const plugin = path.join(opencode, 'plugins', 'agent-relay.js');
    const core = fakeCore({ claudeFiles: [path.join(claude, 'settings.json')], openCodePlugin: plugin });
    await setup(core.deps).run('--tools', 'claude,opencode');
    expect(fs.existsSync(path.join(claude, 'settings.json'))).toBe(true);
    expect(fs.existsSync(plugin)).toBe(true);

    await setup({ ...core.deps, isAlive: vi.fn(() => false) }).run('--uninstall');
    expect(fs.readdirSync(claude)).toEqual(['history.jsonl']);
    expect(fs.readdirSync(opencode)).toEqual([]);
    expect(fs.existsSync(path.join(home, 'local', 'core-settings.json'))).toBe(false);
  });

  // The relay init end-to-end Pi run on 2026-10-30: --uninstall left
  // ~/.agentworkforce/desktop/pi-extension.off, which keeps the desktop app
  // from installing the extension (Pi sessions off), and an empty extensions folder.
  it("leaves Pi's folder and the core's Pi opt-out as it found them on --uninstall", async () => {
    installedProbe();
    const agent = path.join(toolHome, '.pi', 'agent');
    fs.mkdirSync(agent, { recursive: true });
    fs.writeFileSync(path.join(agent, 'auth.json'), '{}');
    const marker = path.join(toolHome, '.agentworkforce', 'desktop', 'pi-extension.off');
    const core = fakeCore({ piAgentDir: agent });
    await setup(core.deps).run('--tools', 'pi');
    expect(fs.existsSync(path.join(agent, 'extensions', 'agent-relay.js'))).toBe(true);

    await setup({ ...core.deps, isAlive: vi.fn(() => false) }).run('--uninstall');
    expect(core.settings).toMatchObject({
      pi_extension: false,
      pi_auto_activate: false,
      auto_activate: false,
    });
    expect(fs.readdirSync(agent)).toEqual(['auth.json']);
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(path.join(home, 'local', 'core-settings.json'))).toBe(false);
  });

  // Review on #2022: turning Pi off in the desktop app after init is the person's choice.
  it('keeps a Pi opt-out marker the person left after init on --uninstall', async () => {
    installedProbe();
    const agent = path.join(toolHome, '.pi', 'agent');
    fs.mkdirSync(agent, { recursive: true });
    const marker = path.join(toolHome, '.agentworkforce', 'desktop', 'pi-extension.off');
    const core = fakeCore({ piAgentDir: agent });
    await setup(core.deps).run('--tools', 'pi');
    // As the desktop app's Pi switch: the extension goes and the marker stays.
    fs.rmSync(path.join(agent, 'extensions', 'agent-relay.js'));
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, 'off by me\n');
    await setup({ ...core.deps, isAlive: vi.fn(() => false) }).run('--uninstall');
    expect(fs.readFileSync(marker, 'utf8')).toBe('off by me\n');
    expect(fs.readdirSync(agent)).toEqual([]);
    expect(fs.existsSync(path.join(home, 'local', 'core-settings.json'))).toBe(false);
  });

  it("keeps a Pi opt-out marker that links to the person's own file on --uninstall", async () => {
    installedProbe();
    const agent = path.join(toolHome, '.pi', 'agent');
    fs.mkdirSync(agent, { recursive: true });
    const marker = path.join(toolHome, '.agentworkforce', 'desktop', 'pi-extension.off');
    const core = fakeCore({ piAgentDir: agent });
    await setup(core.deps).run('--tools', 'pi');
    fs.rmSync(path.join(agent, 'extensions', 'agent-relay.js'));
    const mine = path.join(toolHome, 'pi-off.txt');
    fs.writeFileSync(mine, 'off by me\n');
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.symlinkSync(mine, marker);
    await setup({ ...core.deps, isAlive: vi.fn(() => false) }).run('--uninstall');
    expect(fs.lstatSync(marker).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(mine, 'utf8')).toBe('off by me\n');
  });

  it('keeps a Pi opt-out marker that was there before init', async () => {
    installedProbe();
    const agent = path.join(toolHome, '.pi', 'agent');
    fs.mkdirSync(agent, { recursive: true });
    const marker = path.join(toolHome, '.agentworkforce', 'desktop', 'pi-extension.off');
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, "Agent Relay's Pi extension was turned off (pi_extension).\n");
    const core = fakeCore({ piAgentDir: agent });
    await setup(core.deps).run('--tools', 'pi');
    expect(fs.existsSync(marker)).toBe(false);
    await setup({ ...core.deps, isAlive: vi.fn(() => false) }).run('--uninstall');
    expect(fs.existsSync(marker)).toBe(true);
    expect(fs.readdirSync(agent)).toEqual([]);
  });

  // Review on #2021: a tool rolled back in the same run is tidied too.
  it('removes the Claude settings file it created when Claude is rolled back to MCP', async () => {
    installedProbe();
    const claude = path.join(toolHome, '.claude');
    fs.mkdirSync(claude);
    const core = fakeCore({
      claudeFiles: [path.join(claude, 'settings.json')],
      refuse: ['claude_session_hook'],
    });
    await setup(core.deps).run('--tools', 'claude');
    expect(core.settings).toMatchObject({ direct_delivery: false, claude_session_hook: false });
    expect(fs.readdirSync(claude)).toEqual([]);
  });

  it('keeps a Claude settings file and an OpenCode marker that were there before init', async () => {
    installedProbe();
    const claude = path.join(toolHome, '.claude');
    fs.mkdirSync(claude);
    const file = path.join(claude, 'settings.json');
    const mine = '{ "model": "opus",\n  "permissions": { "allow": ["Bash(npm test *)"] } }';
    fs.writeFileSync(file, mine);
    const plugins = path.join(toolHome, '.config', 'opencode', 'plugins');
    fs.mkdirSync(plugins, { recursive: true });
    fs.writeFileSync(
      path.join(plugins, 'agent-relay.js.off'),
      "Agent Relay's OpenCode plugin was turned off.\n"
    );
    const core = fakeCore({ claudeFiles: [file], openCodePlugin: path.join(plugins, 'agent-relay.js') });
    await setup(core.deps).run('--tools', 'claude,opencode');
    // The core's first edit copies the person's file beside it.
    fs.writeFileSync(`${file}.relay-desktop-backup`, mine);
    await setup({ ...core.deps, isAlive: vi.fn(() => false) }).run('--uninstall');
    expect(fs.readFileSync(file, 'utf8')).toBe(mine);
    expect(fs.existsSync(`${file}.relay-desktop-backup`)).toBe(false);
    expect(fs.existsSync(path.join(plugins, 'agent-relay.js.off'))).toBe(true);
  });

  it('leaves a Pi or OpenCode opt-in the person turned on themselves on --uninstall', async () => {
    installedProbe();
    const core = fakeCore({ running: true, settings: { opencode_auto_activate: true } });
    await setup(core.deps).run('--tools', 'opencode');
    expect(core.sets()).toEqual([{ opencode_plugin: true }, { auto_activate: true }]);
    await setup({ ...core.deps, isAlive: vi.fn(() => false) }).run('--uninstall');
    expect(core.settings).toMatchObject({
      opencode_plugin: false,
      opencode_auto_activate: true,
      auto_activate: false,
    });
  });

  it('gives Pi the MCP server, with no opt-in left on, when the core refuses Pi auto-activation', async () => {
    installedProbe();
    const core = fakeCore({ refuse: ['pi_auto_activate'] });
    const { run, logs } = setup(core.deps);
    await run('--tools', 'pi');
    expect(core.settings).toMatchObject({
      pi_extension: false,
      pi_auto_activate: false,
      auto_activate: false,
    });
    expect(logs.join('\n')).toMatch(/Pi\s+not injected: pi_auto_activate is not available\./);
  });

  it('turns off what it enabled when its record cannot be saved, then uses the MCP server', async () => {
    installedProbe();
    const core = fakeCore({ running: true });
    // A directory where the record goes: writing it fails.
    fs.mkdirSync(path.join(home, 'local', 'core-settings.json'), { recursive: true });
    const { run, logs } = setup(core.deps);
    await run('--tools', 'codex', '--scope', 'project');
    expect(core.settings).toMatchObject({ codex_stop_hook: false, auto_activate: false });
    expect(logs.join('\n')).toContain(
      'Message injection is not available (the Agent Relay core could not be set up'
    );
    expect(fs.readFileSync(path.join(project, '.codex', 'config.toml'), 'utf8')).toContain('agent-relay');
  });

  it('stops without adding MCP when an unrecorded setting cannot be turned off again', async () => {
    installedProbe();
    const core = fakeCore({ running: true });
    fs.mkdirSync(path.join(home, 'local', 'core-settings.json'), { recursive: true });
    const connect = core.deps.connectCore;
    const { run, errors } = setup({
      ...core.deps,
      connectCore: vi.fn(async (socket: string) => {
        const client = await connect(socket);
        if (!client) return undefined;
        return {
          ...client,
          call: async <T>(method: string, params?: Record<string, unknown>) => {
            if (method === 'settings.set' && params && Object.values(params).includes(false)) {
              throw new Error('the core is busy');
            }
            return client.call<T>(method, params);
          },
        };
      }),
    });
    await expect(run('--tools', 'codex')).rejects.toEqual(new ExitSignal(1));
    expect(errors.join('\n')).toContain('could not be turned off again: codex_stop_hook: the core is busy');
    expect(fs.existsSync(path.join(project, '.codex', 'config.toml'))).toBe(false);
  });

  it('rolls back the settings of a tool whose delivery fails, so it has only the MCP route', async () => {
    installedProbe();
    const claudeSettings = path.join(toolHome, '.claude', 'settings.json');
    const core = fakeCore({ refuse: ['claude_session_hook'], claudeFiles: [claudeSettings] });
    fs.mkdirSync(path.dirname(claudeSettings), { recursive: true });
    fs.writeFileSync(claudeSettings, JSON.stringify({ theme: 'dark' }));
    const { run, logs } = setup(core.deps);
    await run('--tools', 'claude', '--scope', 'project');
    expect(core.settings).toMatchObject({
      direct_delivery: false,
      claude_session_hook: false,
      auto_activate: false,
    });
    expect(JSON.parse(fs.readFileSync(claudeSettings, 'utf8'))).toEqual({ theme: 'dark' });
    expect(mcpJson().mcpServers).toHaveProperty('agent-relay');
    expect(logs.join('\n')).toMatch(/Claude Code\s+not injected: claude_session_hook is not available\./);
    expect(fs.existsSync(path.join(home, 'local', 'core-settings.json'))).toBe(false);
  });

  it('turns off what it injected before adding the MCP server for --delivery mcp', async () => {
    installedProbe();
    const core = fakeCore({ running: true });
    await setup(core.deps).run('--tools', 'claude,codex', '--scope', 'project');
    expect(core.settings).toMatchObject({
      auto_activate: true,
      claude_session_hook: true,
      codex_stop_hook: true,
    });

    const toMcp = setup(core.deps);
    await toMcp.run('--tools', 'claude', '--delivery', 'mcp', '--scope', 'project');
    // Claude leaves injection; Codex keeps it, and so automatic activation stays.
    expect(core.settings).toMatchObject({
      auto_activate: true,
      direct_delivery: false,
      claude_session_hook: false,
      codex_stop_hook: true,
    });
    expect(mcpJson().mcpServers).toHaveProperty('agent-relay');
    expect(toMcp.logs.join('\n')).toContain(
      'turned off what relay init had turned on (direct_delivery, claude_session_hook)'
    );
    expect(JSON.parse(fs.readFileSync(path.join(home, 'local', 'core-settings.json'), 'utf8'))).toEqual({
      turnedOn: ['codex_stop_hook', 'auto_activate'],
    });

    await setup(core.deps).run('--tools', 'codex', '--delivery', 'mcp', '--scope', 'project');
    expect(core.settings).toMatchObject({ auto_activate: false, codex_stop_hook: false });
    expect(fs.existsSync(path.join(home, 'local', 'core-settings.json'))).toBe(false);
  });

  it('adds no MCP server for --delivery mcp when injection it turned on cannot be turned off', async () => {
    installedProbe();
    const core = fakeCore({ running: true });
    await setup(core.deps).run('--tools', 'claude');
    // The core has gone and one started for the change never answers.
    const { run, errors } = setup({
      ...core.deps,
      connectCore: vi.fn(async () => undefined),
      isAlive: vi.fn(() => false),
    });
    await expect(run('--tools', 'claude', '--delivery', 'mcp')).rejects.toEqual(new ExitSignal(1));
    expect(errors.join('\n')).toContain('Could not reach the Agent Relay core to turn off message injection');
    expect(fs.existsSync(path.join(project, '.mcp.json'))).toBe(false);
    expect(core.settings.claude_session_hook).toBe(true);
  });

  it('never signals the pid of a recorded core that no longer answers', async () => {
    installedProbe();
    const core = fakeCore();
    await setup(core.deps).run('--tools', 'opencode');
    // The core exits and its pid is reused by an unrelated process.
    await setup({ ...core.deps, isAlive: vi.fn(() => false) }).run('--stop');
    expect(fs.existsSync(path.join(home, 'local', 'core.json'))).toBe(false);
    fs.writeFileSync(
      path.join(home, 'local', 'core.json'),
      JSON.stringify({ pid: 5151, socket: path.join(home, 'no-core.sock'), binary: '/b' })
    );
    const stop = vi.fn();
    const later = setup({ ...core.deps, isAlive: vi.fn(() => true), stop });
    await later.run('--stop');
    expect(stop).not.toHaveBeenCalledWith(5151);
    expect(later.logs.join('\n')).toContain('The Agent Relay core relay init started is no longer running.');
    expect(fs.existsSync(path.join(home, 'local', 'core.json'))).toBe(false);
  });

  it('warns when the core serves another workspace on the same self-hosted server', async () => {
    installedProbe();
    const core = fakeCore({ running: true, workspaceId: 'rw_core' });
    core.settings.auto_activate = true;
    const workspaceFetch = (id: string) =>
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        if (url.pathname === '/v1/workspace') return jsonResponse(200, { ok: true, data: { id, name: 'x' } });
        return jsonResponse(404);
      }) as never;
    // The core's workspace is on http://127.0.0.1:8787, as this server is.
    const other = setup({ ...core.deps, fetch: workspaceFetch('rw_project') });
    await other.run(
      '--url',
      'http://127.0.0.1:8787',
      '--key',
      'rk_live_b',
      '--name',
      'b',
      '--tools',
      'codex'
    );
    expect(other.logs.join('\n')).toContain('serves workspace "local" (http://127.0.0.1:8787), not "b"');

    const same = setup({ ...core.deps, fetch: workspaceFetch('rw_core') });
    await same.run('--url', 'http://127.0.0.1:8787', '--key', 'rk_live_a', '--name', 'a', '--tools', 'codex');
    expect(same.logs.join('\n')).not.toContain('agents here join that workspace');
    expect(same.logs.join('\n')).not.toContain('Could not confirm');
    expect(same.logs.join('\n')).not.toContain('rk_live_');

    const unknown = setup({ ...core.deps, fetch: workspaceFetch('') });
    await unknown.run(
      '--url',
      'http://127.0.0.1:8787',
      '--key',
      'rk_live_c',
      '--name',
      'c',
      '--tools',
      'codex'
    );
    expect(unknown.logs.join('\n')).toContain('Could not confirm that the Agent Relay core serves "c"');
  });

  // Review on #2028: a joined hosted workspace's name is the person's, so a
  // core serving another hosted workspace of the same name is not taken
  // for it when neither side names a workspace id.
  it('does not confirm a joined hosted workspace by its name alone', async () => {
    installedProbe();
    const core = fakeCore({
      running: true,
      baseUrl: 'https://cast.agentrelay.com',
      workspaceName: 'team',
      workspaceId: '',
    });
    core.settings.auto_activate = true;
    const { run, logs } = setup(core.deps);
    await run(
      '--url',
      'https://cast.agentrelay.com',
      '--key',
      'rk_live_other_team',
      '--name',
      'team',
      '--tools',
      'codex'
    );
    const output = logs.join('\n');
    expect(output).toContain('Joined hosted workspace "team"');
    expect(output).toContain('Could not confirm that the Agent Relay core serves "team"');
  });

  it('restores crossSessionInbound on every Claude login the core changed', async () => {
    installedProbe();
    const own = path.join(toolHome, '.claude', 'settings.json');
    const work = path.join(toolHome, '.claude-work', 'settings.json');
    const chosen = path.join(toolHome, '.claude-mine', 'settings.json');
    for (const file of [own, work, chosen]) fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(path.join(toolHome, '.claude-work', '.claude.json'), '{}');
    fs.writeFileSync(path.join(toolHome, '.claude-mine', '.claude.json'), '{}');
    fs.writeFileSync(own, JSON.stringify({ theme: 'dark' }));
    fs.writeFileSync(work, JSON.stringify({}));
    fs.writeFileSync(chosen, JSON.stringify({ crossSessionInbound: 'accept' }));
    const core = fakeCore({
      running: true,
      settings: { auto_activate: true, claude_session_hook: true },
      claudeFiles: [own, work, chosen],
    });
    await setup(core.deps).run('--tools', 'claude');
    expect(JSON.parse(fs.readFileSync(work, 'utf8'))).toEqual({ crossSessionInbound: 'accept' });

    await setup(core.deps).run('--uninstall');
    expect(JSON.parse(fs.readFileSync(own, 'utf8'))).toEqual({ theme: 'dark' });
    expect(JSON.parse(fs.readFileSync(work, 'utf8'))).toEqual({});
    // The person's own accept was theirs: the core turns it to hold, and init puts it back.
    expect(JSON.parse(fs.readFileSync(chosen, 'utf8'))).toEqual({ crossSessionInbound: 'accept' });
  });

  /** This login unset, another with the person's own accept, both followed by the core. */
  function twoClaudeLogins() {
    const own = path.join(toolHome, '.claude', 'settings.json');
    const work = path.join(toolHome, '.claude-work', 'settings.json');
    for (const file of [own, work]) fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(path.join(toolHome, '.claude-work', '.claude.json'), '{}');
    fs.writeFileSync(own, JSON.stringify({ theme: 'dark' }));
    fs.writeFileSync(work, JSON.stringify({ crossSessionInbound: 'accept' }));
    const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
    return { own, work, read, files: [own, work] };
  }

  it("puts back each login's own crossSessionInbound when its record cannot be saved", async () => {
    installedProbe();
    const logins = twoClaudeLogins();
    const core = fakeCore({
      running: true,
      settings: { auto_activate: true, claude_session_hook: true },
      claudeFiles: logins.files,
    });
    fs.mkdirSync(path.join(home, 'local', 'core-settings.json'), { recursive: true });
    await setup(core.deps).run('--tools', 'claude');
    expect(core.settings.direct_delivery).toBe(false);
    expect(logins.read(logins.own)).toEqual({ theme: 'dark' });
    expect(logins.read(logins.work)).toEqual({ crossSessionInbound: 'accept' });
  });

  it("puts back each login's own crossSessionInbound on a switch to MCP", async () => {
    installedProbe();
    const logins = twoClaudeLogins();
    const core = fakeCore({
      running: true,
      settings: { auto_activate: true, claude_session_hook: true },
      claudeFiles: logins.files,
    });
    await setup(core.deps).run('--tools', 'claude');
    expect(logins.read(logins.own)).toEqual({ theme: 'dark', crossSessionInbound: 'accept' });
    await setup(core.deps).run('--tools', 'claude', '--delivery', 'mcp');
    expect(core.settings.direct_delivery).toBe(false);
    expect(logins.read(logins.own)).toEqual({ theme: 'dark' });
    expect(logins.read(logins.work)).toEqual({ crossSessionInbound: 'accept' });
  });

  it("puts back each login's own crossSessionInbound when Claude's delivery is rolled back", async () => {
    installedProbe();
    const logins = twoClaudeLogins();
    const core = fakeCore({
      running: true,
      settings: { auto_activate: true },
      refuse: ['claude_session_hook'],
      claudeFiles: logins.files,
    });
    await setup(core.deps).run('--tools', 'claude');
    expect(core.settings.direct_delivery).toBe(false);
    expect(logins.read(logins.own)).toEqual({ theme: 'dark' });
    expect(logins.read(logins.work)).toEqual({ crossSessionInbound: 'accept' });
  });

  it('stops without adding MCP when a failed tool cannot be rolled back', async () => {
    installedProbe();
    const core = fakeCore({
      running: true,
      settings: { auto_activate: true },
      refuse: ['claude_session_hook'],
    });
    const connect = core.deps.connectCore;
    const { run, errors } = setup({
      ...core.deps,
      connectCore: vi.fn(async (socket: string) => {
        const client = await connect(socket);
        if (!client) return undefined;
        return {
          ...client,
          call: async <T>(method: string, params?: Record<string, unknown>) => {
            if (method === 'settings.set' && params && Object.values(params).includes(false)) {
              throw new Error('the core is busy');
            }
            return client.call<T>(method, params);
          },
        };
      }),
    });
    await expect(run('--tools', 'claude')).rejects.toEqual(new ExitSignal(1));
    const shown = errors.join('\n');
    expect(shown).toContain('direct_delivery stays on (the core is busy)');
    expect(shown).toContain('no Relay MCP server was added');
    expect(fs.existsSync(path.join(project, '.mcp.json'))).toBe(false);
    // Recorded, so --uninstall can still turn it off.
    expect(
      JSON.parse(fs.readFileSync(path.join(home, 'local', 'core-settings.json'), 'utf8')).turnedOn
    ).toContain('direct_delivery');
  });

  it('falls back to the MCP server when the core cannot be started', async () => {
    installedProbe();
    const core = fakeCore();
    const { run, logs } = setup({
      ...core.deps,
      startCore: vi.fn(() => {
        throw new Error('spawn EACCES');
      }),
    });
    await run('--tools', 'claude', '--scope', 'project');
    expect(logs.join('\n')).toContain('the Agent Relay core could not be started (spawn EACCES)');
    expect(mcpJson().mcpServers).toHaveProperty('agent-relay');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'says so when an earlier MCP entry could not be removed',
    async () => {
      await setup().run('--tools', 'claude', '--delivery', 'mcp', '--scope', 'project');
      installedProbe();
      fs.chmodSync(project, 0o555);
      try {
        const { run, logs } = setup(fakeCore().deps);
        await run('--tools', 'claude', '--scope', 'project');
        expect(logs.join('\n')).toMatch(
          /Claude Code\s+could not remove the earlier Relay MCP entry from \.mcp\.json[^]*second identity/
        );
      } finally {
        fs.chmodSync(project, 0o755);
      }
    }
  );

  it('falls back to the MCP server when the core cannot be had', async () => {
    const { run, logs } = setup();
    await run('--tools', 'claude', '--scope', 'project');
    expect(logs.join('\n')).toContain('Message injection is not available (offline)');
    expect(mcpJson().mcpServers).toHaveProperty('agent-relay');
  });

  it('downloads, verifies and installs the pinned core from its probe-v release', async () => {
    const asset = `agent-relay-probe-${PROBE_VERSION}-linux-x64`;
    const url = `https://github.com/AgentWorkforce/relay/releases/download/probe-v${PROBE_VERSION}/${asset}`;
    const body = new TextEncoder().encode('#!/bin/sh\necho agent-relay-probe\n');
    const digest = createHash('sha256').update(body).digest('hex');
    const downloadProbe = vi.fn(async (requested: string) => {
      if (requested === url) return body;
      if (requested === `${url}.sha256`) return new TextEncoder().encode(`${digest}  ${asset}\n`);
      throw new DownloadHttpError(requested, 404);
    });
    const core = fakeCore();
    const probeVersion = vi.fn((binary: string) => (binary.endsWith('.tmp') ? PROBE_VERSION : undefined));
    const { run, logs } = setup({ ...core.deps, downloadProbe, probeVersion });
    await run('--tools', 'claude');
    expect(downloadProbe).toHaveBeenCalledWith(url, expect.anything());
    expect(fs.readFileSync(path.join(home, 'bin', 'agent-relay-probe'))).toEqual(Buffer.from(body));
    expect(logs.join('\n')).toContain(`Installed agent-relay-probe v${PROBE_VERSION}`);
    expect(core.deps.startCore).toHaveBeenCalledTimes(1);
  });

  it('refuses a core whose checksum does not match, and uses the MCP server', async () => {
    const downloadProbe = vi.fn(async (requested: string) =>
      requested.endsWith('.sha256') ? new TextEncoder().encode(`${'0'.repeat(64)}  x\n`) : new Uint8Array([1])
    );
    const core = fakeCore();
    const { run, logs } = setup({ ...core.deps, downloadProbe });
    await run('--tools', 'claude');
    expect(fs.existsSync(path.join(home, 'bin', 'agent-relay-probe'))).toBe(false);
    expect(core.deps.startCore).not.toHaveBeenCalled();
    expect(logs.join('\n')).toMatch(/Message injection is not available \(SHA-256 mismatch/);
  });

  it('guided: shows the injection routes, asks no scope, and proceeds', async () => {
    installedProbe();
    const core = fakeCore();
    const script = scriptedPrompter([['claude'], true]);
    const { run } = setup({ ...core.deps, isInteractive: () => true, prompter: () => script.prompter });
    await run('--interactive', '--hosted');
    expect(script.asked).toEqual(['Which agents should get Relay?', 'Proceed with installation?']);
    const shown = script.shown.join('\n');
    expect(shown).toContain("Claude Code        Claude Code's session inbox");
    expect(shown).toContain('note Message injection');
    expect(shown).toContain('outro Relay is ready.');
    expect(fs.existsSync(path.join(project, '.mcp.json'))).toBe(false);
  });
});

describe('relay init outside a project', () => {
  /** A user home whose .agentworkforce/relay is the relay home, as `~` is. */
  function homeFolder(): { userHome: string; relayHome: string } {
    const userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-init-userhome-'));
    const relayHome = path.join(userHome, '.agentworkforce', 'relay');
    fs.mkdirSync(relayHome, { recursive: true });
    fs.writeFileSync(path.join(relayHome, 'cloud-auth.json'), '{"secret":"kept"}');
    vi.stubEnv('AGENT_RELAY_HOME', relayHome);
    vi.stubEnv('AGENT_RELAY_PROJECT', userHome);
    return { userHome, relayHome };
  }

  it('refuses to run in the home folder and writes no pin into the relay home', async () => {
    const { userHome, relayHome } = homeFolder();
    try {
      const { run, errors, deps } = setup();
      await expect(run('--tools', 'claude')).rejects.toEqual(new ExitSignal(1));
      expect(errors.join('\n')).toMatch(/Relay home.*inside a project folder/s);
      expect(fs.readdirSync(relayHome)).toEqual(['cloud-auth.json']);
      expect(deps.startEngine).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(userHome, { recursive: true, force: true });
    }
  });

  it('refuses --hosted and --key in the home folder too, before reaching any server', async () => {
    const { userHome, relayHome } = homeFolder();
    try {
      for (const args of [
        ['--hosted'],
        ['--key', 'rk_live_joined'],
        ['--url', 'https://relay.corp.test', '--key', 'rk_live_x'],
      ]) {
        const { run, errors, createWorkspace, deps } = setup();
        await expect(run(...args)).rejects.toEqual(new ExitSignal(1));
        expect(errors.join('\n')).toContain('inside a project folder');
        expect(createWorkspace).not.toHaveBeenCalled();
        expect(deps.fetch).not.toHaveBeenCalled();
      }
      expect(fs.readdirSync(relayHome)).toEqual(['cloud-auth.json']);
    } finally {
      fs.rmSync(userHome, { recursive: true, force: true });
    }
  });

  it('also refuses through a symlink to the home folder', async () => {
    const { userHome, relayHome } = homeFolder();
    const link = `${userHome}-link`;
    fs.symlinkSync(userHome, link);
    vi.stubEnv('AGENT_RELAY_PROJECT', link);
    try {
      const { run, errors } = setup();
      await expect(run('--tools', 'none')).rejects.toEqual(new ExitSignal(1));
      expect(errors.join('\n')).toContain('Relay home');
      expect(fs.readdirSync(relayHome)).toEqual(['cloud-auth.json']);
    } finally {
      fs.rmSync(link, { force: true });
      fs.rmSync(userHome, { recursive: true, force: true });
    }
  });

  it('--uninstall in the home folder looks at no project-scope config, only global ones', async () => {
    const { userHome } = homeFolder();
    try {
      // In ~, Grok's project config would be the person's own ~/.grok/config.toml.
      const grok = path.join(userHome, '.grok', 'config.toml');
      fs.mkdirSync(path.dirname(grok), { recursive: true });
      fs.writeFileSync(grok, '[mcp_servers.agent-relay]\ncommand = "mine"\n');
      const inHome = { toolContext: () => ({ projectRoot: userHome, home: toolHome, env: { PATH: '' } }) };
      const { run, logs } = setup(inHome);
      await run('--uninstall');
      expect(logs.join('\n')).not.toContain(grok);
      expect(fs.readFileSync(grok, 'utf8')).toContain('"mine"');
      const scoped = setup(inHome);
      await scoped.run('--uninstall', '--scope', 'project');
      expect(scoped.logs.join('\n')).toContain('Not inside a project');
    } finally {
      fs.rmSync(userHome, { recursive: true, force: true });
    }
  });
});

describe('relay init --uninstall and the command-line copy of the core', () => {
  const copyPath = () => path.join(toolHome, '.local', 'bin', 'agent-relay-probe');
  const corePath = () => path.join(home, 'bin', 'agent-relay-probe');
  function place(file: string, bytes: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes, { mode: 0o755 });
  }

  it('removes ~/.local/bin/agent-relay-probe when it is a copy of the core relay init installed', async () => {
    place(corePath(), 'core 15.0.3');
    place(copyPath(), 'core 15.0.3');
    const { run, logs } = setup();
    await run('--uninstall');
    expect(fs.existsSync(copyPath())).toBe(false);
    expect(fs.existsSync(corePath())).toBe(true);
    expect(logs.join('\n')).toContain(`removed the copy a core relay init started left at ${copyPath()}`);
  });

  it("leaves any other build there (the desktop app's), a link, and a partial uninstall alone", async () => {
    place(corePath(), 'core 15.0.3');
    place(copyPath(), 'desktop core 16.0.0');
    await setup().run('--uninstall');
    expect(fs.readFileSync(copyPath(), 'utf8')).toBe('desktop core 16.0.0');

    fs.rmSync(copyPath());
    fs.symlinkSync(corePath(), copyPath());
    await setup().run('--uninstall');
    expect(fs.lstatSync(copyPath()).isSymbolicLink()).toBe(true);

    fs.rmSync(copyPath());
    place(copyPath(), 'core 15.0.3');
    await setup().run('--uninstall', '--scope', 'project');
    await setup().run('--uninstall', '--tools', 'claude');
    expect(fs.existsSync(copyPath())).toBe(true);
  });
});

describe('relay init in an empty folder under the home folder', () => {
  let userHome: string;
  let folder: string;
  let cwd: string;
  const projectFilesInHome = () =>
    [
      '.mcp.json',
      'opencode.json',
      path.join('.devin', 'mcp_config.json'),
      path.join('.agentworkforce', 'relay', 'workspace-key.json'),
    ].filter((file) => fs.existsSync(path.join(userHome, file)));

  beforeEach(() => {
    cwd = process.cwd();
    userHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-init-walkup-')));
    folder = path.join(userHome, 'scratch', 'empty');
    fs.mkdirSync(folder, { recursive: true });
    fs.mkdirSync(path.join(userHome, '.agentworkforce', 'relay'), { recursive: true });
    vi.stubEnv('HOME', userHome);
    vi.stubEnv('AGENT_RELAY_HOME', path.join(userHome, '.agentworkforce', 'relay'));
    vi.stubEnv('AGENT_RELAY_PROJECT', '');
    process.chdir(folder);
  });

  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(userHome, { recursive: true, force: true });
  });

  /** Init with project-scoped MCP files, resolving the project as the CLI does. */
  const runHere = () =>
    setup({
      toolContext: () => ({ projectRoot: getProjectPaths().projectRoot, home: userHome, env: { PATH: '' } }),
    });

  it('sets up the empty folder itself, not ~, when a relay home is present', async () => {
    const { run } = runHere();
    await run('--tools', 'claude,opencode,devin', '--delivery', 'mcp', '--scope', 'project');
    expect(getProjectPaths().projectRoot).toBe(folder);
    expect(readProjectWorkspaceKey(path.join(folder, '.agentworkforce', 'relay'))).toBeDefined();
    expect(fs.existsSync(path.join(folder, 'opencode.json'))).toBe(true);
    expect(projectFilesInHome()).toEqual([]);
  });

  it('refuses when walking up reaches ~ (a dotfiles ~/.git), writing nothing there', async () => {
    fs.mkdirSync(path.join(userHome, '.git'));
    expect(getProjectPaths().projectRoot).toBe(userHome);
    const { run, errors, deps } = runHere();
    await expect(
      run('--tools', 'claude,opencode,devin', '--delivery', 'mcp', '--scope', 'project')
    ).rejects.toEqual(new ExitSignal(1));
    expect(errors.join('\n')).toMatch(/home folder.*inside a project folder/s);
    expect(deps.startEngine).not.toHaveBeenCalled();
    expect(projectFilesInHome()).toEqual([]);
  });

  it('refuses ~ even when the relay home lives elsewhere', async () => {
    vi.stubEnv('AGENT_RELAY_HOME', path.join(os.tmpdir(), 'relay-init-elsewhere'));
    fs.rmSync(path.join(userHome, '.agentworkforce'), { recursive: true });
    process.chdir(userHome);
    const { run, errors } = runHere();
    await expect(run('--tools', 'opencode', '--delivery', 'mcp', '--scope', 'project')).rejects.toEqual(
      new ExitSignal(1)
    );
    expect(errors.join('\n')).toContain('home folder');
    expect(fs.existsSync(path.join(userHome, 'opencode.json'))).toBe(false);
  });
});
