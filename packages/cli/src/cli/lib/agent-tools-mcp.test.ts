import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CLIENT_ENV_KEY,
  MANAGED_ENV_KEY,
  MANAGED_ENV_VALUE,
  TOOL_IDS,
  TOOL_TARGETS,
  detectTools,
  findToolTarget,
  installTool,
  parseToolsFlag,
  resolveMcpLaunch,
  uninstallTool,
  type InstallScope,
  type McpLaunch,
  type RunTool,
  type ToolContext,
  type ToolId,
} from './agent-tools-mcp.js';

let root: string;
let ctx: ToolContext;

const launch: McpLaunch = { command: '/opt/relay/bin/agent-relay', args: ['mcp'], reason: 'test' };
const moved: McpLaunch = { command: '/usr/local/bin/agent-relay', args: ['mcp'], reason: 'test' };

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-tools-'));
  const home = path.join(root, 'home');
  const projectRoot = path.join(root, 'my-project');
  fs.mkdirSync(home);
  fs.mkdirSync(projectRoot);
  // An empty PATH: no tool CLI is found, so the config files are written directly.
  ctx = { home, projectRoot, env: { PATH: '' } };
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const target = (id: ToolId) => findToolTarget(id)!;
const read = (file: string) => fs.readFileSync(file, 'utf8');

/** Where each tool keeps its config, per scope, relative to the project or home. */
const EXPECTED_PATHS: Record<ToolId, Record<InstallScope, string>> = {
  claude: { project: 'my-project/.mcp.json', global: 'home/.claude.json' },
  codex: { project: 'my-project/.codex/config.toml', global: 'home/.codex/config.toml' },
  opencode: { project: 'my-project/opencode.json', global: 'home/.config/opencode/opencode.json' },
  grok: { project: 'my-project/.grok/config.toml', global: 'home/.grok/config.toml' },
  pi: { project: 'my-project/.pi/mcp.json', global: 'home/.pi/agent/mcp.json' },
  devin: { project: 'my-project/.devin/mcp_config.json', global: 'home/.config/devin/mcp_config.json' },
};

/** Unrelated content a person already has in each tool's config. */
function existingContent(id: ToolId): string {
  if (id === 'codex' || id === 'grok') {
    return '# my settings\nmodel = "o3"\n\n[mcp_servers.github]\ncommand = "gh-mcp"\nargs = []\n';
  }
  const container = id === 'opencode' ? 'mcp' : 'mcpServers';
  return `${JSON.stringify({ theme: 'dark', [container]: { github: { command: 'gh-mcp' } } }, null, 4)}\n`;
}

function expectUnrelatedContentKept(id: ToolId, text: string): void {
  if (id === 'codex' || id === 'grok') {
    expect(text).toContain('# my settings\nmodel = "o3"');
    expect(text).toContain('[mcp_servers.github]\ncommand = "gh-mcp"');
    return;
  }
  const doc = JSON.parse(text);
  expect(doc.theme).toBe('dark');
  expect(doc[id === 'opencode' ? 'mcp' : 'mcpServers'].github).toEqual({ command: 'gh-mcp' });
}

describe('tool config locations', () => {
  it.each(TOOL_IDS.flatMap((id) => (['project', 'global'] as const).map((scope) => [id, scope] as const)))(
    '%s %s scope',
    (id, scope) => {
      expect(path.relative(root, target(id).configPath(scope, ctx))).toBe(EXPECTED_PATHS[id][scope]);
    }
  );

  it('honours CODEX_HOME, XDG_CONFIG_HOME, PI_CODING_AGENT_DIR and CLAUDE_CONFIG_DIR', () => {
    ctx.env = {
      PATH: '',
      CODEX_HOME: '/x/codex',
      XDG_CONFIG_HOME: '/x/config',
      PI_CODING_AGENT_DIR: '/x/pi',
      CLAUDE_CONFIG_DIR: '/x/claude',
    };
    expect(target('codex').configPath('global', ctx)).toBe('/x/codex/config.toml');
    expect(target('opencode').configPath('global', ctx)).toBe('/x/config/opencode/opencode.json');
    expect(target('devin').configPath('global', ctx)).toBe('/x/config/devin/mcp_config.json');
    expect(target('pi').configPath('global', ctx)).toBe('/x/pi/mcp.json');
    expect(target('claude').configPath('global', ctx)).toBe('/x/claude/.claude.json');
  });
});

describe('detectTools', () => {
  it('finds a tool by its executable on PATH or its config directory', () => {
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'grok'), 'not executable', { mode: 0o644 });
    fs.mkdirSync(path.join(ctx.home, '.claude'));
    fs.mkdirSync(path.join(ctx.home, '.config', 'devin'), { recursive: true });
    ctx.env = { PATH: bin };

    const found = detectTools(ctx);
    expect(found.map((tool) => tool.id)).toEqual(['claude', 'codex', 'devin']);
    expect(found.find((tool) => tool.id === 'codex')?.binaryPath).toBe(path.join(bin, 'codex'));
    expect(found.find((tool) => tool.id === 'claude')?.configDir).toBe(path.join(ctx.home, '.claude'));
  });

  it('finds nothing on a clean machine', () => {
    expect(detectTools(ctx)).toEqual([]);
  });
});

describe('parseToolsFlag', () => {
  it('accepts tool names, all, and none', () => {
    expect(parseToolsFlag('claude, Codex,claude')).toEqual(['claude', 'codex']);
    expect(parseToolsFlag('all')).toEqual([...TOOL_IDS]);
    expect(parseToolsFlag('none')).toEqual([]);
  });

  it('rejects unknown and unsupported tools', () => {
    expect(() => parseToolsFlag('claude,cursor')).toThrow(/Unknown tool for --tools: cursor/);
    expect(() => parseToolsFlag('gemini,vscode')).toThrow(/Unknown tools/);
    expect(() => parseToolsFlag('all,claude')).toThrow(/cannot be combined/);
    expect(() => parseToolsFlag(' , ')).toThrow(/needs a value/);
  });
});

describe.each(TOOL_IDS)('%s config writer', (id) => {
  describe.each(['project', 'global'] as const)('%s scope', (scope) => {
    const op = () => ({ ctx, scope, useToolCli: false });
    const file = () => target(id).configPath(scope, ctx);

    it('creates the config with a marked entry', () => {
      expect(installTool(target(id), launch, op())).toMatchObject({ status: 'installed', method: 'file' });
      const text = read(file());
      expect(text).toContain(launch.command);
      expect(text).toContain(MANAGED_ENV_KEY);
      expect(text).toContain(`${CLIENT_ENV_KEY}`);
      expect(text).not.toMatch(/rk_live|at_live|RELAY_API_KEY|RELAY_WORKSPACE_KEY/);
    });

    it('merges into an existing config, keeps its mode, and is idempotent', () => {
      fs.mkdirSync(path.dirname(file()), { recursive: true });
      fs.writeFileSync(file(), existingContent(id), { mode: 0o640 });
      fs.chmodSync(file(), 0o640);

      expect(installTool(target(id), launch, op()).status).toBe('installed');
      const first = read(file());
      expectUnrelatedContentKept(id, first);
      expect(fs.statSync(file()).mode & 0o777).toBe(0o640);

      expect(installTool(target(id), launch, op()).status).toBe('unchanged');
      expect(read(file())).toBe(first);

      expect(installTool(target(id), moved, op()).status).toBe('updated');
      const updated = read(file());
      expect(updated).toContain(moved.command);
      expect(updated).not.toContain(launch.command);
      expect(updated.split('agent-relay"').length).toBeLessThanOrEqual(first.split('agent-relay"').length);
      expectUnrelatedContentKept(id, updated);
    });

    it('leaves an agent-relay entry it did not add, on install and uninstall', () => {
      const own =
        id === 'codex' || id === 'grok'
          ? '[mcp_servers.agent-relay]\ncommand = "npx"\nargs = ["agent-relay", "mcp"]\n'
          : `${JSON.stringify({ [id === 'opencode' ? 'mcp' : 'mcpServers']: { 'agent-relay': { command: 'npx' } } }, null, 2)}\n`;
      fs.mkdirSync(path.dirname(file()), { recursive: true });
      fs.writeFileSync(file(), own);

      expect(installTool(target(id), launch, op()).status).toBe('kept');
      expect(uninstallTool(target(id), op()).status).toBe('kept');
      expect(read(file())).toBe(own);
    });

    it('uninstall removes only its entry', () => {
      fs.mkdirSync(path.dirname(file()), { recursive: true });
      fs.writeFileSync(file(), existingContent(id));
      installTool(target(id), launch, op());

      expect(uninstallTool(target(id), op()).status).toBe('removed');
      const text = read(file());
      expect(text).not.toContain(MANAGED_ENV_KEY);
      expect(text).not.toContain('agent-relay');
      expectUnrelatedContentKept(id, text);
      expect(uninstallTool(target(id), op()).status).toBe('absent');
    });

    it('uninstall deletes a config it created and that is now empty', () => {
      installTool(target(id), launch, op());
      expect(uninstallTool(target(id), op()).status).toBe('removed');
      expect(fs.existsSync(file())).toBe(false);
    });
  });
});

describe('formats', () => {
  const op = (scope: InstallScope) => ({ ctx, scope, useToolCli: false });

  it('writes Claude Code .mcp.json in the shape claude mcp add uses', () => {
    installTool(target('claude'), launch, op('project'));
    expect(JSON.parse(read(path.join(ctx.projectRoot, '.mcp.json')))).toEqual({
      mcpServers: {
        'agent-relay': {
          type: 'stdio',
          command: launch.command,
          args: ['mcp'],
          env: { [MANAGED_ENV_KEY]: MANAGED_ENV_VALUE, [CLIENT_ENV_KEY]: 'claude' },
        },
      },
    });
  });

  it('writes OpenCode local servers as a command array with environment', () => {
    installTool(target('opencode'), launch, op('project'));
    expect(JSON.parse(read(path.join(ctx.projectRoot, 'opencode.json')))).toEqual({
      $schema: 'https://opencode.ai/config.json',
      mcp: {
        'agent-relay': {
          type: 'local',
          command: [launch.command, 'mcp'],
          enabled: true,
          environment: { [MANAGED_ENV_KEY]: MANAGED_ENV_VALUE, [CLIENT_ENV_KEY]: 'opencode' },
        },
      },
    });
  });

  it('writes Devin stdio servers with a transport', () => {
    installTool(target('devin'), launch, op('global'));
    const doc = JSON.parse(read(path.join(ctx.home, '.config', 'devin', 'mcp_config.json')));
    expect(doc.mcpServers['agent-relay']).toMatchObject({ transport: 'stdio', command: launch.command });
    expect(fs.statSync(path.join(ctx.home, '.config', 'devin', 'mcp_config.json')).mode & 0o777).toBe(0o600);
  });

  it('writes Codex and Grok TOML tables, Grok with enabled = true', () => {
    installTool(target('codex'), launch, op('global'));
    installTool(target('grok'), launch, op('project'));
    expect(read(path.join(ctx.home, '.codex', 'config.toml'))).toBe(
      '[mcp_servers.agent-relay]\n' +
        `command = "${launch.command}"\n` +
        'args = ["mcp"]\n\n' +
        '[mcp_servers.agent-relay.env]\n' +
        `${MANAGED_ENV_KEY} = "${MANAGED_ENV_VALUE}"\n` +
        `${CLIENT_ENV_KEY} = "codex"\n`
    );
    expect(read(path.join(ctx.projectRoot, '.grok', 'config.toml'))).toContain('enabled = true');
  });

  it('keeps TOML comments and the tables after ours when removing it', () => {
    const file = path.join(ctx.home, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'model = "o3"\n');
    installTool(target('codex'), launch, op('global'));
    fs.appendFileSync(file, '\n# my github server\n[mcp_servers.github]\ncommand = "gh-mcp"\n');
    uninstallTool(target('codex'), op('global'));
    expect(read(file)).toBe('model = "o3"\n\n# my github server\n[mcp_servers.github]\ncommand = "gh-mcp"\n');
  });

  it('leaves no trailing blank lines when its table was last', () => {
    const file = path.join(ctx.home, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '[projects."/w"]\ntrust_level = "trusted"\n');
    installTool(target('codex'), launch, op('global'));
    uninstallTool(target('codex'), op('global'));
    expect(read(file)).toBe('[projects."/w"]\ntrust_level = "trusted"\n');
  });

  it('treats an inline TOML agent-relay definition as the person’s own', () => {
    const file = path.join(ctx.home, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const own = '[mcp_servers]\nagent-relay = { command = "npx", args = ["agent-relay", "mcp"] }\n';
    fs.writeFileSync(file, own);
    expect(installTool(target('codex'), launch, op('global')).status).toBe('kept');
    expect(read(file)).toBe(own);
  });

  it('refuses to rewrite a config that is not plain JSON', () => {
    const file = path.join(ctx.projectRoot, '.mcp.json');
    fs.writeFileSync(file, '{ // a comment\n}');
    const result = installTool(target('claude'), launch, op('project'));
    expect(result.status).toBe('failed');
    expect(result.message).toContain('left unchanged');
    expect(read(file)).toBe('{ // a comment\n}');
  });
});

describe('installing through the tool CLI', () => {
  function withBinary(name: string): void {
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, name), '#!/bin/sh\n', { mode: 0o755 });
    ctx.env = { PATH: bin };
  }

  it('runs claude mcp add with the scope, the marker env and the command', () => {
    withBinary('claude');
    const runTool = vi.fn<RunTool>((_binary, _args, options) => {
      // Simulate what claude mcp add --scope project writes.
      fs.writeFileSync(
        path.join(options.cwd, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            'agent-relay': {
              type: 'stdio',
              command: launch.command,
              args: ['mcp'],
              env: { [MANAGED_ENV_KEY]: MANAGED_ENV_VALUE, [CLIENT_ENV_KEY]: 'claude' },
            },
          },
        })
      );
      return { status: 0, output: '' };
    });
    const result = installTool(target('claude'), launch, { ctx, scope: 'project', runTool });
    expect(result).toMatchObject({ status: 'installed', method: 'cli' });
    expect(runTool).toHaveBeenCalledWith(
      path.join(root, 'bin', 'claude'),
      [
        'mcp',
        'add',
        '--scope',
        'project',
        'agent-relay',
        '-e',
        `${MANAGED_ENV_KEY}=${MANAGED_ENV_VALUE}`,
        '-e',
        `${CLIENT_ENV_KEY}=claude`,
        '--',
        launch.command,
        'mcp',
      ],
      expect.objectContaining({ cwd: ctx.projectRoot })
    );
  });

  it.each([
    [
      'codex',
      'global',
      ['mcp', 'add', '--env', expect.any(String), '--env', expect.any(String), 'agent-relay', '--'],
    ],
    ['grok', 'project', ['mcp', 'add', 'agent-relay', '--scope', 'project', '-e']],
    ['pi', 'project', ['mcp', 'add', 'agent-relay', '-l', '--env']],
    ['pi', 'global', ['mcp', 'add', 'agent-relay', '--env']],
    ['devin', 'global', ['mcp', 'add', 'agent-relay', '--scope', 'user', '-e']],
  ] as const)('builds %s mcp add for %s scope', (id, scope, prefix) => {
    const args = target(id).cliAdd!(scope, launch, { A: '1', B: '2' })!;
    expect(args.slice(0, prefix.length)).toEqual(prefix);
    expect(args.slice(-2)).toEqual(id === 'grok' ? ['--', 'mcp'] : [launch.command, 'mcp']);
  });

  it('has no CLI path for Codex project scope or OpenCode', () => {
    expect(target('codex').cliAdd!('project', launch, {})).toBeUndefined();
    expect(target('opencode').cliAdd).toBeUndefined();
  });

  it('falls back to writing the file when the CLI fails', () => {
    withBinary('devin');
    const runTool = vi.fn<RunTool>(() => ({ status: 2, output: 'unknown flag' }));
    const result = installTool(target('devin'), launch, { ctx, scope: 'project', runTool });
    expect(runTool).toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'installed', method: 'file' });
    expect(read(path.join(ctx.projectRoot, '.devin', 'mcp_config.json'))).toContain(MANAGED_ENV_KEY);
  });

  it('removes its own old entry first so claude mcp add does not refuse a duplicate', () => {
    installTool(target('claude'), launch, { ctx, scope: 'project', useToolCli: false });
    withBinary('claude');
    const seen: string[] = [];
    const runTool = vi.fn<RunTool>((_binary, _args, options) => {
      seen.push(read(path.join(options.cwd, '.mcp.json')));
      return { status: 1, output: 'boom' };
    });
    expect(installTool(target('claude'), moved, { ctx, scope: 'project', runTool }).status).toBe('updated');
    expect(seen[0]).not.toContain('agent-relay');
    expect(read(path.join(ctx.projectRoot, '.mcp.json'))).toContain(moved.command);
  });
});

describe('resolveMcpLaunch', () => {
  function executable(file: string): string {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '#!/bin/sh\n', { mode: 0o755 });
    return file;
  }

  it('honours AGENT_RELAY_MCP_COMMAND', () => {
    ctx.env = { PATH: '', AGENT_RELAY_MCP_COMMAND: '/custom/relay --flag mcp' };
    expect(resolveMcpLaunch({ ctx })).toMatchObject({ command: '/custom/relay', args: ['--flag', 'mcp'] });
  });

  it('uses the agent-relay on PATH when it is the running CLI', () => {
    const real = executable(path.join(root, 'lib', 'node_modules', 'agent-relay', 'dist', 'cli', 'index.js'));
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.symlinkSync(real, path.join(bin, 'agent-relay'));
    fs.symlinkSync(real, path.join(bin, 'relay'));
    ctx.env = { PATH: bin };
    const result = resolveMcpLaunch({ ctx, execPath: '/usr/bin/node', script: path.join(bin, 'relay') });
    expect(result).toMatchObject({ command: path.join(bin, 'agent-relay'), args: ['mcp'] });
    expect(result.warning).toBeUndefined();
  });

  it('uses the installed launcher instead of a temporary npx copy', () => {
    const launcher = executable(path.join(ctx.home, '.agentworkforce', 'relay', 'bin', 'agent-relay'));
    const npx = executable(
      path.join(ctx.home, '.npm', '_npx', 'abc', 'node_modules', 'agent-relay', 'index.js')
    );
    expect(resolveMcpLaunch({ ctx, execPath: '/usr/bin/node', script: npx })).toMatchObject({
      command: launcher,
      args: ['mcp'],
    });
  });

  it('warns when only a temporary npx copy exists', () => {
    const npx = executable(
      path.join(ctx.home, '.npm', '_npx', 'abc', 'node_modules', 'agent-relay', 'index.js')
    );
    const result = resolveMcpLaunch({ ctx, execPath: '/usr/bin/node', script: npx });
    expect(result).toMatchObject({ command: '/usr/bin/node', args: [npx, 'mcp'] });
    expect(result.warning).toMatch(/npx cache/);
  });

  it('re-enters a Bun standalone binary directly', () => {
    expect(
      resolveMcpLaunch({ ctx, execPath: '/opt/agent-relay', script: '/$bunfs/root/agent-relay', isBun: true })
    ).toMatchObject({ command: '/opt/agent-relay', args: ['mcp'] });
  });

  it('falls back to the running script by absolute path', () => {
    expect(
      resolveMcpLaunch({ ctx, execPath: '/usr/bin/node', script: '/src/relay/dist/cli/index.js' })
    ).toMatchObject({ command: '/usr/bin/node', args: ['/src/relay/dist/cli/index.js', 'mcp'] });
  });
});

it('offers exactly the supported tools', () => {
  expect(TOOL_TARGETS.map((t) => t.id)).toEqual(['claude', 'codex', 'opencode', 'grok', 'pi', 'devin']);
});
