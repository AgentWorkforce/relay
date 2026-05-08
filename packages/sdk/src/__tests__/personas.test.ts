/**
 * Persona loader + translator tests.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';

import {
  buildPersonaSpawnSpec,
  composePersonaTask,
  defaultPersonaSearchDirs,
  findPersona,
  listPersonas,
  loadPersona,
  materializePersonaConfigFiles,
  restorePersonaConfigFiles,
} from '../personas.js';
import { AgentRelay } from '../relay.js';

function makeFixture(): { cwd: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'relay-personas-'));
  const dir = join(root, 'agentworkforce', 'personas');
  mkdirSync(dir, { recursive: true });

  writeFileSync(
    join(dir, 'frontend.json'),
    JSON.stringify({
      id: 'frontend',
      description: 'frontend implementer',
      tiers: {
        best: {
          harness: 'claude',
          model: 'claude-opus-4-6',
          systemPrompt: 'You are a senior frontend engineer.',
        },
        'best-value': {
          harness: 'codex',
          model: 'openai-codex/gpt-5-codex',
          systemPrompt: 'You are an efficient frontend engineer.',
        },
        minimum: {
          harness: 'opencode',
          model: 'opencode/gpt-5-nano',
          systemPrompt: 'You are a concise frontend engineer.',
        },
      },
      permissions: {
        allow: ['Bash(npm test)'],
        mode: 'default',
      },
    }),
  );

  // A second persona with extends to verify cascade lookup
  writeFileSync(
    join(dir, 'frontend-strict.json'),
    JSON.stringify({
      id: 'frontend-strict',
      extends: 'frontend',
      permissions: {
        deny: ['Bash(rm -rf *)'],
      },
    }),
  );

  return {
    cwd: root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('defaultPersonaSearchDirs includes cwd-relative and home-relative dirs', () => {
  const dirs = defaultPersonaSearchDirs('/work/proj');
  assert.equal(dirs[0], '/work/proj/agentworkforce/personas');
  assert.equal(dirs[1], '/work/proj/.agentworkforce/workforce/personas');
  assert.equal(dirs[2], '/work/proj/agentworkforce/workforce/personas');
  assert.match(dirs[3] ?? '', /agentworkforce[\\/]+(workforce[\\/]+)?personas$/);
});

test('listPersonas discovers JSON files under agentworkforce/personas', () => {
  const fix = makeFixture();
  try {
    const personas = listPersonas({ cwd: fix.cwd });
    const ids = personas.map((p) => p.id).sort();
    assert.deepEqual(ids, ['frontend', 'frontend-strict']);
  } finally {
    fix.cleanup();
  }
});

test('findPersona returns spec by id, regardless of filename', () => {
  const fix = makeFixture();
  try {
    const found = findPersona('frontend', { cwd: fix.cwd });
    assert.ok(found);
    assert.equal(found?.id, 'frontend');
    assert.match(found?.path ?? '', /frontend\.json$/);
  } finally {
    fix.cleanup();
  }
});

test('loadPersona resolves the requested tier', () => {
  const fix = makeFixture();
  try {
    const best = loadPersona('frontend', { cwd: fix.cwd });
    assert.equal(best.tier, 'best');
    assert.equal(best.harness, 'claude');
    assert.equal(best.model, 'claude-opus-4-6');
    assert.match(best.systemPrompt, /senior frontend engineer/);

    const value = loadPersona('frontend', { cwd: fix.cwd, tier: 'best-value' });
    assert.equal(value.harness, 'codex');
    assert.equal(value.model, 'openai-codex/gpt-5-codex');

    const min = loadPersona('frontend', { cwd: fix.cwd, tier: 'minimum' });
    assert.equal(min.harness, 'opencode');
    assert.equal(min.model, 'opencode/gpt-5-nano');
  } finally {
    fix.cleanup();
  }
});

test('loadPersona applies extends and merges permissions', () => {
  const fix = makeFixture();
  try {
    const strict = loadPersona('frontend-strict', { cwd: fix.cwd });
    assert.equal(strict.harness, 'claude');
    assert.deepEqual(strict.permissions?.allow, ['Bash(npm test)']);
    assert.deepEqual(strict.permissions?.deny, ['Bash(rm -rf *)']);
    assert.equal(strict.permissions?.mode, 'default');
  } finally {
    fix.cleanup();
  }
});

test('loadPersona throws when persona is missing', () => {
  const fix = makeFixture();
  try {
    assert.throws(() => loadPersona('does-not-exist', { cwd: fix.cwd }), /not found/);
  } finally {
    fix.cleanup();
  }
});

test('buildPersonaSpawnSpec for claude includes system prompt and MCP flags', () => {
  const fix = makeFixture();
  try {
    const persona = loadPersona('frontend', { cwd: fix.cwd });
    const spec = buildPersonaSpawnSpec(persona);
    assert.equal(spec.cli, 'claude');
    assert.equal(spec.model, 'claude-opus-4-6');
    assert.equal(spec.initialPrompt, null);
    assert.deepEqual(spec.configFiles, []);
    assert.ok(spec.args.includes('--append-system-prompt'));
    assert.ok(spec.args.includes('--strict-mcp-config'));
    const promptIdx = spec.args.indexOf('--append-system-prompt');
    assert.match(spec.args[promptIdx + 1] ?? '', /senior frontend engineer/);
    assert.ok(spec.args.includes('--allowedTools'));
  } finally {
    fix.cleanup();
  }
});

test('buildPersonaSpawnSpec for codex strips provider prefix and exposes initialPrompt', () => {
  const fix = makeFixture();
  try {
    const persona = loadPersona('frontend', { cwd: fix.cwd, tier: 'best-value' });
    const spec = buildPersonaSpawnSpec(persona);
    assert.equal(spec.cli, 'codex');
    // codex receives the stripped provider/model form via -m
    assert.deepEqual(spec.args, ['-m', 'gpt-5-codex']);
    assert.match(spec.initialPrompt ?? '', /efficient frontend engineer/);

    const taskWithPrompt = composePersonaTask(spec, 'Refactor the login page.');
    assert.match(taskWithPrompt ?? '', /efficient frontend engineer/);
    assert.match(taskWithPrompt ?? '', /User task:\nRefactor the login page\./);
  } finally {
    fix.cleanup();
  }
});

test('buildPersonaSpawnSpec for opencode emits an opencode.json config file', () => {
  const fix = makeFixture();
  try {
    const persona = loadPersona('frontend', { cwd: fix.cwd, tier: 'minimum' });
    const spec = buildPersonaSpawnSpec(persona);
    assert.equal(spec.cli, 'opencode');
    assert.deepEqual(spec.args, ['--agent', 'frontend']);
    assert.equal(spec.configFiles.length, 1);
    assert.equal(spec.configFiles[0]?.path, 'opencode.json');
    const parsed = JSON.parse(spec.configFiles[0]?.contents ?? '{}');
    assert.equal(parsed.agent.frontend.model, 'opencode/gpt-5-nano');
    assert.match(parsed.agent.frontend.prompt, /concise frontend engineer/);
  } finally {
    fix.cleanup();
  }
});

test('materializePersonaConfigFiles writes and restores files', () => {
  const fix = makeFixture();
  try {
    const target = join(fix.cwd, 'opencode.json');
    writeFileSync(target, '{"original":true}\n', 'utf8');

    const writes = materializePersonaConfigFiles(fix.cwd, [
      { path: 'opencode.json', contents: '{"replaced":true}\n' },
    ]);
    assert.equal(readFileSync(target, 'utf8'), '{"replaced":true}\n');
    assert.equal(writes[0]?.existed, true);

    restorePersonaConfigFiles(writes);
    assert.equal(readFileSync(target, 'utf8'), '{"original":true}\n');
  } finally {
    fix.cleanup();
  }
});

test('materializePersonaConfigFiles removes files that did not previously exist', () => {
  const fix = makeFixture();
  try {
    const target = join(fix.cwd, 'opencode.json');
    const writes = materializePersonaConfigFiles(fix.cwd, [
      { path: 'opencode.json', contents: '{"new":true}\n' },
    ]);
    assert.equal(existsSync(target), true);
    restorePersonaConfigFiles(writes);
    assert.equal(existsSync(target), false);
  } finally {
    fix.cleanup();
  }
});

test('AgentRelay personaDirs option supplies default search dirs to spawnPersona', async () => {
  const fix = makeFixture();
  try {
    const personaDir = join(fix.cwd, 'agentworkforce', 'personas');
    const relay = new AgentRelay({ personaDirs: [personaDir] });

    let captured: { cli?: string; model?: string; args?: string[] } = {};
    // Stub out spawnPty so the test never touches the broker — we only care
    // that the persona was discovered and translated using the constructor's
    // personaDirs / personaTier defaults.
    (relay as unknown as { spawnPty: (input: unknown) => Promise<unknown> }).spawnPty = async (
      input: unknown,
    ) => {
      captured = input as { cli?: string; model?: string; args?: string[] };
      return {
        name: (input as { name: string }).name,
        runtime: 'pty',
        channels: ['general'],
        status: 'ready',
        release: async () => {},
        waitForReady: async () => {},
        waitForExit: async () => 'exited',
        waitForIdle: async () => 'idle',
        sendMessage: async () => ({}),
        subscribe: async () => {},
        unsubscribe: async () => {},
        onOutput: () => () => {},
      };
    };

    await relay.spawnPersona('frontend', {
      cwd: fix.cwd, // spawn cwd; persona lookup uses constructor defaults
      tier: 'best-value',
    });

    assert.equal(captured.cli, 'codex');
    assert.deepEqual(captured.args, ['-m', 'gpt-5-codex']);
  } finally {
    fix.cleanup();
  }
});

test('per-call searchDirs on spawnPersona overrides constructor defaults', async () => {
  const fix = makeFixture();
  const otherFix = makeFixture();
  try {
    const relay = new AgentRelay({
      personaDirs: ['/nonexistent/should/not/be/used'],
    });

    let captured: { cli?: string } = {};
    (relay as unknown as { spawnPty: (input: unknown) => Promise<unknown> }).spawnPty = async (
      input: unknown,
    ) => {
      captured = input as { cli?: string };
      return {
        name: (input as { name: string }).name,
        runtime: 'pty',
        channels: [],
        status: 'ready',
        release: async () => {},
        waitForReady: async () => {},
        waitForExit: async () => 'exited',
        waitForIdle: async () => 'idle',
        sendMessage: async () => ({}),
        subscribe: async () => {},
        unsubscribe: async () => {},
        onOutput: () => () => {},
      };
    };

    await relay.spawnPersona('frontend', {
      searchDirs: [join(otherFix.cwd, 'agentworkforce', 'personas')],
    });

    assert.equal(captured.cli, 'claude');
  } finally {
    otherFix.cleanup();
    fix.cleanup();
  }
});

test('materializePersonaConfigFiles rejects paths that escape cwd', () => {
  const fix = makeFixture();
  try {
    assert.throws(
      () => materializePersonaConfigFiles(fix.cwd, [{ path: '../escape.json', contents: '{}' }]),
      /escapes cwd/,
    );
  } finally {
    fix.cleanup();
  }
});

test('materializePersonaConfigFiles allows nested paths inside cwd', () => {
  const fix = makeFixture();
  try {
    const writes = materializePersonaConfigFiles(fix.cwd, [
      { path: 'sub/dir/opencode.json', contents: '{"nested":true}\n' },
    ]);
    assert.equal(writes.length, 1);
    assert.equal(readFileSync(writes[0]!.path, 'utf8'), '{"nested":true}\n');
    restorePersonaConfigFiles(writes);
    assert.equal(existsSync(writes[0]!.path), false);
  } finally {
    fix.cleanup();
  }
});

test('parsePersonaFile rejects an invalid top-level harness at load time', () => {
  const fix = makeFixture();
  try {
    const dir = join(fix.cwd, 'agentworkforce', 'personas');
    writeFileSync(
      join(dir, 'bad.json'),
      JSON.stringify({ id: 'bad', harness: 'not-a-real-harness', model: 'x', systemPrompt: 'y' }),
    );
    assert.throws(
      () => loadPersona('bad', { cwd: fix.cwd }),
      /persona\.harness must be one of/,
    );
  } finally {
    fix.cleanup();
  }
});

test('parsePersonaFile rejects an invalid harness inside a tier at load time', () => {
  const fix = makeFixture();
  try {
    const dir = join(fix.cwd, 'agentworkforce', 'personas');
    writeFileSync(
      join(dir, 'bad-tier.json'),
      JSON.stringify({
        id: 'bad-tier',
        tiers: {
          best: { harness: 'gpt-5', model: 'gpt-5', systemPrompt: 'x' },
        },
      }),
    );
    assert.throws(
      () => loadPersona('bad-tier', { cwd: fix.cwd }),
      /persona\.tiers\.best\.harness must be one of/,
    );
  } finally {
    fix.cleanup();
  }
});
