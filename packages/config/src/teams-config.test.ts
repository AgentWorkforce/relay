import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearTeamsConfigCache, loadTeamsConfig } from './teams-config.js';

describe('teams config model pins', () => {
  let projectRoot: string;

  beforeEach(() => {
    clearTeamsConfigCache();
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'teams-config-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    clearTeamsConfigCache();
    vi.restoreAllMocks();
  });

  function loadAgent(fields: Record<string, unknown>) {
    fs.writeFileSync(
      path.join(projectRoot, 'teams.json'),
      JSON.stringify({ team: 'platform', agents: [{ name: 'Worker', cli: 'claude', ...fields }] })
    );
    return loadTeamsConfig(projectRoot)?.agents[0];
  }

  it.each([
    ['claude', 'opus'],
    ['codex', 'gpt-5.4'],
    ['opencode', 'openai/gpt-5.2'],
    ['claude', 'future-model'],
  ])('loads and trims a model for %s without catalog validation', (cli, model) => {
    expect(loadAgent({ cli, model: `  ${model}  ` })).toEqual({ name: 'Worker', cli, model });
    expect(console.warn).not.toHaveBeenCalled();
  });

  it.each([null, 42, false, {}, [], '', ' \t\n '])(
    'drops invalid model %j without dropping the agent',
    (model) => {
      expect(loadAgent({ model })).toEqual({ name: 'Worker', cli: 'claude' });
      expect(console.warn).toHaveBeenCalledWith(
        "[teams-config] Agent 'Worker' has invalid 'model' field, ignoring it"
      );
    }
  );

  it('preserves role and task, omits undeclared model and strips unknown keys', () => {
    expect(loadAgent({ role: 'reviewer', task: 'Review tests', unknown: true })).toEqual({
      name: 'Worker',
      cli: 'claude',
      role: 'reviewer',
      task: 'Review tests',
    });
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('preserves inline model arguments alongside the model pin for broker precedence', () => {
    expect(loadAgent({ cli: 'claude --model sonnet', model: 'opus' })).toEqual({
      name: 'Worker',
      cli: 'claude --model sonnet',
      model: 'opus',
    });
  });

  it('keeps the default CLI behavior when a model is pinned', () => {
    expect(loadAgent({ cli: '', model: 'opus' })).toEqual({
      name: 'Worker',
      cli: 'claude',
      model: 'opus',
    });
  });
});
