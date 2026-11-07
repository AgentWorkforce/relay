import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { registerSkillsCommands, type SkillsDependencies } from './skills.js';
import type { HarnessTarget, InstallResult, TargetContext } from '../lib/skills-install.js';

const SKILL = '---\nname: orchestrating-agent-relay\ndescription: d\n---\n\n# Orchestrate\n';

function harness(overrides: Partial<SkillsDependencies> = {}) {
  const log = vi.fn();
  const error = vi.fn();
  const exit = vi.fn(() => {
    throw new Error('exit');
  }) as never;
  const install = vi.fn((_skill, plan): InstallResult[] =>
    plan.harnesses.map((h: HarnessTarget) => ({
      harnessId: h.id,
      label: h.label,
      path: `/x/${h.id}`,
      status: 'installed' as const,
    }))
  );
  const ctx: TargetContext = { projectRoot: '/proj', homeDir: '/home/me' };
  const deps: Partial<SkillsDependencies> = {
    fetchSkill: vi.fn(async () => SKILL),
    promptScope: vi.fn(async () => 'project'),
    promptHarnesses: vi.fn(async () => ['claude']),
    getContext: () => ctx,
    isInteractive: () => true,
    install,
    log,
    error,
    exit,
    ...overrides,
  };
  const program = new Command();
  program.exitOverride();
  registerSkillsCommands(program, deps);
  return { program, log, error, install, deps };
}

async function run(program: Command, args: string[]): Promise<void> {
  await program.parseAsync(['skills', 'add', ...args], { from: 'user' });
}

describe('relay skills add', () => {
  it('installs from flags without prompting', async () => {
    const { program, install, deps } = harness();
    await run(program, ['--global', '--harness', 'claude,codex']);
    expect(deps.promptScope).not.toHaveBeenCalled();
    expect(deps.promptHarnesses).not.toHaveBeenCalled();
    const [, plan] = install.mock.calls[0];
    expect(plan.scope).toBe('global');
    expect(plan.harnesses.map((h: HarnessTarget) => h.id)).toEqual(['claude', 'codex']);
  });

  it('installs into every harness with --all', async () => {
    const { program, install } = harness();
    await run(program, ['--local', '--all']);
    const [, plan] = install.mock.calls[0];
    expect(plan.harnesses.length).toBeGreaterThanOrEqual(5);
  });

  it('prompts for scope and harnesses when no flags are given', async () => {
    const { program, deps, install } = harness();
    await run(program, []);
    expect(deps.promptScope).toHaveBeenCalled();
    expect(deps.promptHarnesses).toHaveBeenCalled();
    const [, plan] = install.mock.calls[0];
    expect(plan.scope).toBe('project');
    expect(plan.harnesses.map((h: HarnessTarget) => h.id)).toEqual(['claude']);
  });

  it('cancels cleanly when the scope prompt is aborted', async () => {
    const { program, install, log } = harness({ promptScope: vi.fn(async () => null) });
    await run(program, []);
    expect(install).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join(' ')).toContain('Cancelled');
  });

  it('cancels when no harness is selected', async () => {
    const { program, install } = harness({ promptHarnesses: vi.fn(async () => []) });
    await run(program, ['--local']);
    expect(install).not.toHaveBeenCalled();
  });

  it('errors on an unknown harness id', async () => {
    const { program, error } = harness();
    await expect(run(program, ['--local', '--harness', 'nope'])).rejects.toThrow('exit');
    expect(error.mock.calls.flat().join(' ')).toContain('Unknown harness');
  });

  it('errors when both --global and --local are given', async () => {
    const { program, error } = harness();
    await expect(run(program, ['--global', '--local', '--all'])).rejects.toThrow('exit');
    expect(error.mock.calls.flat().join(' ')).toContain('only one of');
  });

  it('refuses to prompt in a non-interactive terminal', async () => {
    const { program, error } = harness({ isInteractive: () => false });
    await expect(run(program, [])).rejects.toThrow('exit');
    expect(error.mock.calls.flat().join(' ')).toContain('Non-interactive');
  });

  it('surfaces a download failure', async () => {
    const { program, error } = harness({
      fetchSkill: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    await expect(run(program, ['--local', '--all'])).rejects.toThrow('exit');
    expect(error.mock.calls.flat().join(' ')).toContain('boom');
  });
});
