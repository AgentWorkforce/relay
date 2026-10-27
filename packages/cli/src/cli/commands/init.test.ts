import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CANCELLED, type InitPrompter } from '../lib/init-prompts.js';
import { boundOrigin } from '../lib/relaycast-origin-binding.js';
import { readWorkspaceStore } from '../lib/workspace-store.js';
import { DownloadHttpError, engineAssetName } from '../lib/relaycast-engine-install.js';
import { LOCAL_ENGINE_VERSION, registerInitCommand, type InitCommandDependencies } from './init.js';

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
    // Offline by default: no test reaches GitHub, and the npm path is the fallback.
    downloadEngine: vi.fn(async () => {
      throw new Error('offline');
    }),
    engineVersion: vi.fn(() => undefined),
    enginePlatform: () => ({ platform: 'linux', arch: 'x64', musl: false }),
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

  it('requires --url and --key together', async () => {
    const { run, errors } = setup();
    await expect(run('--url', 'https://relay.corp.test')).rejects.toEqual(new ExitSignal(1));
    expect(errors.join('\n')).toContain('--url and --key together');
  });

  it('creates a hosted workspace and prints the one command another machine runs to join', async () => {
    const { run, logs, createWorkspace } = setup();
    await run('--hosted', '--name', 'team');
    expect(createWorkspace).toHaveBeenCalledWith('team', 'https://cast.agentrelay.com');
    expect(logs.join('\n')).toContain('relay workspace join team rk_live_team_remote');
    expect(boundOrigin('rk_live_team_remote')).toBeUndefined();
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
  it('connects the detected tools at project scope by default', async () => {
    fs.mkdirSync(path.join(toolHome, '.claude'));
    fs.mkdirSync(path.join(toolHome, '.codex'));
    const { run, logs } = setup();
    await run();
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
    expect(output).toContain('trust this project');
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
    await first.run('--tools', 'claude');
    const before = fs.readFileSync(path.join(project, '.mcp.json'), 'utf8');
    const { run, logs } = setup();
    await run('--tools', 'claude');
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
    await run('--yes', '--tools', 'claude');
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
    ]);
    const { run, createWorkspace } = setup({ isInteractive: () => true, prompter: () => script.prompter });
    await run();

    expect(script.asked).toEqual([
      'Where should your agents talk?',
      'Server URL',
      'Workspace key',
      'Which agents should get Relay?',
      'Installation scope',
      'Proceed with installation?',
    ]);
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

  it('only asks what the flags did not answer', async () => {
    const script = scriptedPrompter([true]);
    const { run } = setup({ isInteractive: () => true, prompter: () => script.prompter });
    await run('--hosted', '--tools', 'grok', '--scope', 'global');
    expect(script.asked).toEqual(['Proceed with installation?']);
    expect(fs.readFileSync(path.join(toolHome, '.grok', 'config.toml'), 'utf8')).toContain('enabled = true');
  });

  it('stops without installing when the person cancels', async () => {
    const script = scriptedPrompter(['local', ['claude'], 'project', CANCELLED]);
    const { run } = setup({ isInteractive: () => true, prompter: () => script.prompter });
    await run();
    expect(script.shown.join('\n')).toContain('cancel Setup cancelled');
    expect(fs.existsSync(path.join(project, '.mcp.json'))).toBe(false);
  });

  it('shows the CLI fallback when no agent is chosen', async () => {
    const script = scriptedPrompter(['local', []]);
    const { run } = setup({ isInteractive: () => true, prompter: () => script.prompter });
    await run();
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
