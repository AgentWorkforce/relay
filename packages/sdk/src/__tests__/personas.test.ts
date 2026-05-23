/**
 * Persona loader + spawn-plan tests.
 *
 * Persona-kit owns the spawn-plan and execution surface; the tests here
 * cover the relay-specific discovery cascade, the parsed PersonaSpec
 * round-trip, and the AgentRelay.spawnPersona / getPersonaSpawnPlan
 * methods.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, test } from 'vitest';

import {
  composePersonaTask,
  defaultPersonaSearchDirs,
  findPersona,
  getPersonaSpawnPlan,
  listPersonas,
  loadPersona,
  resolvePersona,
} from '../personas.js';
import { AgentRelay } from '../relay.js';

interface PersonaJsonOptions {
  id: string;
  intent?: string;
  harness?: 'claude' | 'codex' | 'opencode';
  model?: string;
  systemPrompt?: string;
  description?: string;
  extras?: Record<string, unknown>;
}

function personaJson(opts: PersonaJsonOptions): Record<string, unknown> {
  return {
    id: opts.id,
    intent: opts.intent ?? opts.id,
    description: opts.description ?? `${opts.id} fixture`,
    harness: opts.harness ?? 'claude',
    model: opts.model ?? 'claude-opus-4-6',
    systemPrompt: opts.systemPrompt ?? `You are ${opts.id}.`,
    skills: [],
    harnessSettings: { reasoning: 'medium', timeoutSeconds: 900 },
    ...(opts.extras ?? {}),
  };
}

function makeFixture(): { cwd: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'relay-personas-'));
  const dir = join(root, 'agentworkforce', 'personas');
  mkdirSync(dir, { recursive: true });

  writeFileSync(
    join(dir, 'frontend.json'),
    JSON.stringify(
      personaJson({
        id: 'frontend',
        intent: 'implement-frontend',
        harness: 'claude',
        model: 'claude-opus-4-6',
        systemPrompt: 'You are a senior frontend engineer.',
        extras: {
          permissions: { allow: ['Bash(npm test)'], mode: 'default' },
        },
      }),
    ),
  );

  writeFileSync(
    join(dir, 'codex-reviewer.json'),
    JSON.stringify(
      personaJson({
        id: 'codex-reviewer',
        intent: 'review',
        harness: 'codex',
        model: 'openai-codex/gpt-5-codex',
        systemPrompt: 'You are an efficient code reviewer.',
      }),
    ),
  );

  writeFileSync(
    join(dir, 'opencode-nano.json'),
    JSON.stringify(
      personaJson({
        id: 'opencode-nano',
        intent: 'review',
        harness: 'opencode',
        model: 'opencode/gpt-5-nano',
        systemPrompt: 'You are a concise reviewer.',
      }),
    ),
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
    assert.deepEqual(ids, ['codex-reviewer', 'frontend', 'opencode-nano']);
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

test('loadPersona returns the parsed PersonaSpec verbatim', () => {
  const fix = makeFixture();
  try {
    const spec = loadPersona('frontend', { cwd: fix.cwd });
    assert.equal(spec.id, 'frontend');
    assert.equal(spec.harness, 'claude');
    assert.equal(spec.model, 'claude-opus-4-6');
    assert.match(spec.systemPrompt, /senior frontend engineer/);
    assert.deepEqual(spec.permissions?.allow, ['Bash(npm test)']);
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

test('loadPersona reports "not found" when no valid persona with that id exists', () => {
  // A malformed file at the conventional name no longer blocks the cascade —
  // it is treated the same as a malformed sibling file: skipped during the
  // search, and "not found" is reported if no valid alternative exists. This
  // is the cascade behavior that lets a higher-priority shadow file with bad
  // JSON not break a valid lower-priority persona of the same id.
  const fix = makeFixture();
  try {
    const dir = join(fix.cwd, 'agentworkforce', 'personas');
    writeFileSync(
      join(dir, 'bad.json'),
      JSON.stringify({
        id: 'bad',
        intent: 'review',
        description: 'bad fixture',
        harness: 'not-a-harness',
        model: 'x',
        systemPrompt: 'x',
        skills: [],
        harnessSettings: { reasoning: 'medium', timeoutSeconds: 900 },
      }),
    );
    assert.throws(
      () => loadPersona('bad', { cwd: fix.cwd }),
      /not found/,
    );
  } finally {
    fix.cleanup();
  }
});

test('resolvePersona rejects handler-style personas missing harness/model/systemPrompt', () => {
  // persona-kit ≥3.0.20 made these fields optional for onEvent-driven personas.
  // Relay only spawns interactive personas, so the guard must fire with a
  // clear error rather than producing a malformed ResolvedPersona.
  assert.throws(
    () =>
      resolvePersona({
        id: 'handler-only',
        intent: 'review',
        description: 'cloud handler persona',
        skills: [],
        harnessSettings: { reasoning: 'medium', timeoutSeconds: 900 },
      } as unknown as Parameters<typeof resolvePersona>[0]),
    /no harness/,
  );
});

test('resolvePersona projects PersonaSpec into a PersonaSelection-shaped ResolvedPersona', () => {
  const fix = makeFixture();
  try {
    const spec = loadPersona('frontend', { cwd: fix.cwd });
    const resolved = resolvePersona(spec);
    assert.equal(resolved.personaId, 'frontend');
    assert.equal(resolved.harness, 'claude');
    assert.equal(resolved.model, 'claude-opus-4-6');
    assert.equal(resolved.rationale, '');
    assert.deepEqual(resolved.permissions?.allow, ['Bash(npm test)']);
  } finally {
    fix.cleanup();
  }
});

test('getPersonaSpawnPlan for claude includes system prompt and harness argv', () => {
  const fix = makeFixture();
  try {
    const plan = getPersonaSpawnPlan('frontend', { cwd: fix.cwd });
    assert.equal(plan.cli, 'claude');
    assert.equal(plan.persona.model, 'claude-opus-4-6');
    assert.ok(plan.args.includes('--append-system-prompt'));
    const promptIdx = plan.args.indexOf('--append-system-prompt');
    assert.match(plan.args[promptIdx + 1] ?? '', /senior frontend engineer/);
    assert.ok(plan.args.includes('--allowedTools'));
  } finally {
    fix.cleanup();
  }
});

test('getPersonaSpawnPlan for codex exposes initialPrompt and composePersonaTask folds it in', () => {
  const fix = makeFixture();
  try {
    const plan = getPersonaSpawnPlan('codex-reviewer', { cwd: fix.cwd });
    assert.equal(plan.cli, 'codex');
    assert.match(plan.initialPrompt ?? '', /efficient code reviewer/);
    const taskWithPrompt = composePersonaTask(plan, 'Review the login PR.');
    assert.match(taskWithPrompt ?? '', /efficient code reviewer/);
    assert.match(taskWithPrompt ?? '', /User task:\nReview the login PR\./);
  } finally {
    fix.cleanup();
  }
});

test('getPersonaSpawnPlan for opencode emits a config file with the persona prompt', () => {
  const fix = makeFixture();
  try {
    const plan = getPersonaSpawnPlan('opencode-nano', { cwd: fix.cwd });
    assert.equal(plan.cli, 'opencode');
    assert.ok(plan.configFiles.length > 0);
    const opencodeConfig = plan.configFiles.find((f) => f.path === 'opencode.json');
    assert.ok(opencodeConfig, 'opencode.json config file should be emitted');
    const parsed = JSON.parse(opencodeConfig?.contents ?? '{}');
    assert.equal(parsed.agent['opencode-nano'].model, 'opencode/gpt-5-nano');
    assert.match(parsed.agent['opencode-nano'].prompt, /concise reviewer/);
  } finally {
    fix.cleanup();
  }
});

test('getPersonaSpawnPlan plan is JSON-serializable round-trip', () => {
  const fix = makeFixture();
  try {
    const plan = getPersonaSpawnPlan('frontend', { cwd: fix.cwd });
    const round = JSON.parse(JSON.stringify(plan));
    assert.deepEqual(round, plan);
  } finally {
    fix.cleanup();
  }
});

test('AgentRelay.getPersonaSpawnPlan honors personaDirs from the constructor', () => {
  const fix = makeFixture();
  try {
    const personaDir = join(fix.cwd, 'agentworkforce', 'personas');
    const relay = new AgentRelay({ personaDirs: [personaDir] });
    const plan = relay.getPersonaSpawnPlan('frontend');
    assert.equal(plan.cli, 'claude');
    assert.equal(plan.persona.personaId, 'frontend');
  } finally {
    fix.cleanup();
  }
});

test('AgentRelay.spawnPersona honors constructor personaDirs and executes the plan', async () => {
  const fix = makeFixture();
  try {
    const personaDir = join(fix.cwd, 'agentworkforce', 'personas');
    const relay = new AgentRelay({ personaDirs: [personaDir] });

    let captured: { cli?: string; cwd?: string; args?: string[]; model?: string } = {};
    (relay as unknown as { spawnPty: (input: unknown) => Promise<unknown> }).spawnPty = async (
      input: unknown,
    ) => {
      captured = input as typeof captured;
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

    await relay.spawnPersona('codex-reviewer', { cwd: fix.cwd });

    assert.equal(captured.cli, 'codex');
    assert.equal(captured.model, 'openai-codex/gpt-5-codex');
  } finally {
    fix.cleanup();
  }
});

test('AgentRelay.getPersonaSpawnPlan honors options.persona, bypassing the search cascade', () => {
  const fix = makeFixture();
  try {
    const relay = new AgentRelay({ personaDirs: ['/nonexistent'] });
    const spec = loadPersona('frontend', { cwd: fix.cwd });
    const plan = relay.getPersonaSpawnPlan('frontend', { persona: spec });
    assert.equal(plan.cli, 'claude');
    assert.equal(plan.persona.personaId, 'frontend');
  } finally {
    fix.cleanup();
  }
});

test('findPersona skips a malformed shadow file at the conventional path', () => {
  const fix = makeFixture();
  const otherFix = makeFixture();
  try {
    const shadowDir = join(otherFix.cwd, 'agentworkforce', 'personas');
    // Higher-priority shadow file with the conventional name but bad JSON.
    writeFileSync(join(shadowDir, 'frontend.json'), '{ not valid json');
    const found = findPersona('frontend', {
      cwd: fix.cwd,
      searchDirs: [shadowDir, join(fix.cwd, 'agentworkforce', 'personas')],
    });
    assert.ok(found, 'should fall through to the valid persona in the lower-priority dir');
    assert.match(found?.path ?? '', /frontend\.json$/);
    assert.notMatch(found?.path ?? '', new RegExp(shadowDir));
  } finally {
    otherFix.cleanup();
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
      cwd: otherFix.cwd,
      searchDirs: [join(otherFix.cwd, 'agentworkforce', 'personas')],
    });

    assert.equal(captured.cli, 'claude');
  } finally {
    otherFix.cleanup();
    fix.cleanup();
  }
});
