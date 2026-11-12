import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { configPath, runCli, skillText, type CliIo } from './cli.js';
import { handleEventsShimRequest } from './http.js';
import { MemoryEventsShimStore } from './memory-store.js';

const BASE = 'https://shim.test/api/v1/events-shim';

/** A real inbox served in-process, and a CLI environment pointed at a temp HOME. */
async function setupWorld(options: { claude?: boolean; socket?: boolean } = {}) {
  const store = new MemoryEventsShimStore();
  const shimFetch: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const path = new URL(request.url).pathname.replace('/api/v1/events-shim', '');
    return (
      (await handleEventsShimRequest(request, path, {
        deps: { store, sleep: async () => {} },
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
  const io: CliIo = {
    env: { HOME: home },
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    fetchImpl: shimFetch,
    run: (file, args) => {
      runs.push([file, ...args]);
      return options.claude ?? true;
    },
    exists: (path) => Boolean(options.socket) && path.endsWith('relay.sock'),
    sleep: async () => {},
  };
  const post = (body: unknown) =>
    shimFetch(created.webhook_url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { store, io, out, err, runs, home, created, post, shimFetch };
}

describe('events-shim CLI', () => {
  it('setup saves the inbox privately, installs the skill and adds the MCP server to Claude Code', async () => {
    const w = await setupWorld();
    expect(await runCli(['setup', w.created.mcp_url], w.io)).toBe(0);

    const config = JSON.parse(readFileSync(configPath(w.io), 'utf8'));
    expect(config).toMatchObject({ mcpUrl: w.created.mcp_url, webhookUrl: w.created.webhook_url });
    expect(statSync(configPath(w.io)).mode & 0o777).toBe(0o600);
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
    expect(w.out.join('\n')).toContain('no Agent Relay here');
  });

  it('setup says when Agent Relay is running, and prints the manual MCP step without Claude Code', async () => {
    const w = await setupWorld({ claude: false, socket: true });
    expect(await runCli(['setup', w.created.mcp_url], w.io)).toBe(0);
    const printed = w.out.join('\n');
    expect(printed).toContain('Agent Relay is running here');
    expect(printed).toContain('claude mcp add --scope user --transport http webhooks');
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

  it('the relayfile command in the skill runs forward with the flags it passes', async () => {
    const w = await setupWorld();
    await runCli(['setup', w.created.mcp_url], w.io);
    const run = /--run '([^']+)'/.exec(skillText())![1]!;
    const filled = run
      .replace('{{provider}}', 'slack')
      .replace('{{type}}', 'file.created')
      .replace('{{path}}', '/slack/channels/C1/messages/1.json')
      .replace('{{revision}}', 'r1');
    const argv = filled.split(' ').slice(filled.split(' ').indexOf('forward'));
    expect(await runCli(argv, w.io)).toBe(0);
    w.out.length = 0;
    expect(await runCli(['listen', '--timeout', '1'], w.io)).toBe(0);
    expect(w.out.join('\n')).toContain('slack.file.created');
    expect(w.out.join('\n')).toContain('/slack/channels/C1/messages/1.json');
  });
});
