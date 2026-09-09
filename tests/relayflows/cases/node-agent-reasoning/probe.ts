import { writeFile } from 'node:fs/promises';
import { Command } from 'commander';
import { expect, test, vi } from 'vitest';
import { registerLocalAgentCommands } from './local-agent.js';
import { buildSpawnPtyBody } from '../../../../harness-driver/src/spawn-request.js';

// Copied alongside the target checkout's command, on both arms. Only the broker
// connection is replaced; Commander, command handling, runtime selection,
// argument construction, and HTTP-body serialization are production code.
test('reasoning flag reaches broker argv or is explicitly absent', async () => {
  const observations: string[] = [];
  for (const command of ['spawn', 'new']) {
    for (const [cli, level, expectedArgs] of [
      ['codex', 'xhigh', ['-c', 'model_reasoning_effort="xhigh"']],
      ['claude', 'max', ['--effort', 'max']],
      ['grok', 'high', ['--reasoning-effort', 'high']],
      ['cursor-agent', 'high', null],
      ['grok', 'max', null],
      ['codex', 'invalid', null],
    ] as const) {
      const bodies: Record<string, unknown>[] = [];
      const errors: string[] = [];
      const attach = vi.fn(async () => 0);
      const connect = vi.fn(async () => ({
        spawnPty: async (input: Parameters<typeof buildSpawnPtyBody>[0]) => {
          bodies.push(buildSpawnPtyBody(input));
        },
        spawnHeadless: async () => {
          throw new Error('Unexpected native spawn');
        },
      }));
      const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
      registerLocalAgentCommands(program.command('node'), {
        connect: connect as never,
        attach,
        cwd: () => process.cwd(),
        log: () => {},
        error: (message) => {
          errors.push(String(message));
        },
        exit: (() => {
          throw new Error('probe-exit');
        }) as never,
      });
      let caught: unknown;
      try {
        await program.parseAsync(
          ['node', 'agent', command, cli, '--model', 'test-model', '--reasoning', level],
          { from: 'user' }
        );
      } catch (error) {
        caught = error;
      }
      if ((caught as { code?: string })?.code === 'commander.unknownOption') {
        expect((caught as Error).message).toContain("'--reasoning'");
        expect(connect).not.toHaveBeenCalled();
        expect(attach).not.toHaveBeenCalled();
        observations.push('absent');
      } else if (expectedArgs) {
        expect(caught).toBeUndefined();
        expect(errors).toEqual([]);
        expect(bodies).toHaveLength(1);
        expect(bodies[0]).toMatchObject({ cli, model: 'test-model', args: expectedArgs });
        expect(attach).toHaveBeenCalledTimes(command === 'new' ? 1 : 0);
        observations.push('fixed');
      } else {
        expect(caught).toBeInstanceOf(Error);
        expect((caught as Error).message).toBe('probe-exit');
        expect(errors.join('\n')).toMatch(/--reasoning.*(not supported|Expected one of:)/);
        expect(connect).not.toHaveBeenCalled();
        expect(bodies).toEqual([]);
        expect(attach).not.toHaveBeenCalled();
        observations.push('fixed');
      }
    }
  }
  expect(new Set(observations).size).toBe(1);
  await writeFile(process.env.RELAY_REASONING_OBSERVATION!, JSON.stringify(observations[0]));
});
