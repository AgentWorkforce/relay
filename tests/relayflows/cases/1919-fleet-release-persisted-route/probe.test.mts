import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Command } from 'commander';
import { expect, test, vi } from 'vitest';

// The runner copies this probe into <target>/.relay-pr-proof/.
import { registerFleetCommands } from '../packages/cli/src/cli/commands/fleet.js';
import { resolveWorkspaceTransport } from '../packages/cli/src/cli/lib/sdk-client.js';
import { writeProjectWorkspaceKey } from '../packages/cli/src/cli/lib/project-workspace-key.js';

const OBSERVATION_PATH = process.env.RELAY_PR1919_OBSERVATION_PATH;
const ISOLATED_ORIGIN = 'https://agent37-cast.agentrelay.com';

test('fleet release uses the persisted route over an ambient base URL', async () => {
  if (!OBSERVATION_PATH) throw new Error('Missing RELAY_PR1919_OBSERVATION_PATH.');

  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-proof-1919-project-'));
  const relayHome = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-proof-1919-home-'));
  const release = vi.fn(async () => ({ name: 'route-probe', released: true, deleted: false }));
  const errors: string[] = [];
  let selectedTransport: ReturnType<typeof resolveWorkspaceTransport> | undefined;

  vi.stubEnv('AGENT_RELAY_PROJECT', projectRoot);
  vi.stubEnv('AGENT_RELAY_HOME', relayHome);
  vi.stubEnv('RELAY_WORKSPACE_KEY', 'rk_live_workspace');
  vi.stubEnv('RELAY_API_KEY', '');
  vi.stubEnv('RELAY_BASE_URL', 'https://cast.agentrelay.com');

  try {
    const dataDir = path.join(projectRoot, '.agentworkforce', 'relay');
    writeProjectWorkspaceKey(dataDir, 'rk_live_workspace', {
      workspaceId: 'rw_route_probe',
      relaycastRoute: 'agent37-isolated',
      relaycastBaseUrl: ISOLATED_ORIGIN,
      relaycastApiKey: 'rk_live_agent37_route_probe',
    });

    const program = new Command();
    program.exitOverride();
    registerFleetCommands(program, {
      resolveSandboxRepository: () => undefined,
      createFleetWorkspaceClient: ((options: Parameters<typeof resolveWorkspaceTransport>[0]) => {
        selectedTransport = resolveWorkspaceTransport(options);
        return { agents: { release } };
      }) as never,
      sdk: {
        createAgentRelay: vi.fn() as never,
        createWorkspaceRelay: vi.fn() as never,
        createWorkspace: vi.fn() as never,
        log: vi.fn(),
        error: (message: unknown) => errors.push(String(message)),
        exit: (() => {
          throw new Error('__exit__');
        }) as never,
      },
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    });

    let commandError: string | undefined;
    try {
      await program.parseAsync(['fleet', 'release', 'route-probe'], { from: 'user' });
    } catch (error) {
      commandError = error instanceof Error ? error.message : String(error);
    }

    const observation = {
      released: release.mock.calls.length === 1,
      baseUrl: selectedTransport?.baseUrl ?? null,
      workspaceKey: selectedTransport?.workspaceKey ?? null,
      error: errors[0] ?? commandError ?? null,
    };
    const baseObserved =
      observation.released === false &&
      observation.baseUrl === null &&
      observation.workspaceKey === null &&
      observation.error?.includes(
        'The requested Relaycast base URL does not match the persisted workspace route.'
      );
    const headObserved =
      observation.released === true &&
      observation.baseUrl === ISOLATED_ORIGIN &&
      observation.workspaceKey === 'rk_live_agent37_route_probe' &&
      observation.error === null;

    expect(baseObserved || headObserved, JSON.stringify(observation)).toBe(true);
    fs.writeFileSync(OBSERVATION_PATH, JSON.stringify({ ...observation, baseObserved, headObserved }));
  } finally {
    vi.unstubAllEnvs();
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(relayHome, { recursive: true, force: true });
  }
});
