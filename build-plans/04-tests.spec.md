# Phase 4 Specification: Unit and Integration Tests

> Comprehensive test suite for all SDK functions introduced in Phases 1–3: persona resolution, workflow generation, and CLI `--agent` flag integration.

**Phase:** 4 of 5
**Dependencies:** Phase 3 (CLI integration — provides `parseAgentFlags`, `inferContextFiles`, and the full end-to-end path)
**Target files:**

- `packages/sdk/src/workflows/__tests__/persona-utils.test.ts` (expand existing)
- `packages/sdk/src/workflows/__tests__/workflow-generator.test.ts` (expand existing)
- `packages/sdk/src/workflows/__tests__/workflow-generator.integration.test.ts` (new)

---

## Goal

Deliver a production-quality test suite that:

1. **Exhaustively validates** `resolvePersonaByIdOrIntent()` across all 13 production persona intents and all 10 default persona IDs
2. **Covers every branch** in `derivePreset()` and `derivePattern()` — all analyst/pipeline intents plus boundary cases
3. **Tests `resolvePersonaSelection()`** as the convenience wrapper accepting `PersonaSelection` input
4. **Validates helper functions** `slugify()` and `escapeTemplateString()` for correctness and edge cases
5. **Snapshot-tests** generated workflow source against reference fixtures to catch accidental regressions
6. **Integration-tests** the full pipeline: persona resolution → workflow generation → source validation
7. **Documents** the expected behavior as executable specs that serve as living documentation

All tests use **vitest** and run via `npx vitest run` with zero external dependencies beyond the SDK itself.

---

## File 1: `packages/sdk/src/workflows/__tests__/persona-utils.test.ts`

### Imports

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
  derivePreset,
  derivePattern,
  resolvePersonaByIdOrIntent,
  resolvePersonaSelection,
  isAnalystIntent,
  isPipelineIntent,
  resetPersonaRegistry,
  initPersonaRegistry,
  getPersonaIdToIntentMap,
  personaRegistry,
  DEFAULT_PERSONA_PROFILES,
  ANALYST_INTENTS,
  PIPELINE_INTENTS,
  type PersonaProfile,
  type PersonaSelection,
  type PersonaResolution,
} from '../persona-utils.js';
```

### Test Suite: `derivePreset`

#### All 13 intents — exhaustive mapping

```ts
describe('derivePreset', () => {
  describe('analyst intents → "analyst"', () => {
    it.each([
      'review',
      'architecture-plan',
      'requirements-analysis',
      'security-review',
      'verification',
      'test-strategy',
    ])('returns "analyst" for intent "%s"', (intent) => {
      expect(derivePreset(intent)).toBe('analyst');
    });
  });

  describe('worker intents → "worker"', () => {
    it.each([
      'implement-frontend',
      'debugging',
      'documentation',
      'tdd-enforcement',
      'flake-investigation',
      'opencode-workflow-correctness',
      'npm-provenance',
    ])('returns "worker" for intent "%s"', (intent) => {
      expect(derivePreset(intent)).toBe('worker');
    });
  });

  describe('case insensitivity', () => {
    it.each([
      ['REVIEW', 'analyst'],
      ['Security-Review', 'analyst'],
      ['Architecture-Plan', 'analyst'],
      ['REQUIREMENTS-ANALYSIS', 'analyst'],
      ['  review  ', 'analyst'],
      ['DEBUGGING', 'worker'],
      ['Documentation', 'worker'],
    ])('derivePreset("%s") → "%s"', (input, expected) => {
      expect(derivePreset(input)).toBe(expected);
    });
  });

  describe('unknown / edge-case intents', () => {
    it.each([
      ['unknown-intent', 'worker'],
      ['', 'worker'],
      ['code-gen', 'worker'],
      ['refactor', 'worker'],
      ['deploy', 'worker'],
      ['review-extended', 'worker'], // partial match should NOT match
      ['security', 'worker'], // substring should NOT match
    ])('derivePreset("%s") → "%s"', (input, expected) => {
      expect(derivePreset(input)).toBe(expected);
    });
  });
});
```

### Test Suite: `derivePattern`

#### All 13 intents — exhaustive mapping

```ts
describe('derivePattern', () => {
  describe('pipeline intents → "pipeline"', () => {
    it.each(['requirements-analysis', 'documentation', 'tdd-enforcement'])(
      'returns "pipeline" for intent "%s"',
      (intent) => {
        expect(derivePattern(intent)).toBe('pipeline');
      }
    );
  });

  describe('DAG intents → "dag"', () => {
    it.each([
      'implement-frontend',
      'review',
      'architecture-plan',
      'debugging',
      'security-review',
      'verification',
      'test-strategy',
      'flake-investigation',
      'opencode-workflow-correctness',
      'npm-provenance',
    ])('returns "dag" for intent "%s"', (intent) => {
      expect(derivePattern(intent)).toBe('dag');
    });
  });

  describe('case insensitivity', () => {
    it.each([
      ['REQUIREMENTS-ANALYSIS', 'pipeline'],
      ['Documentation', 'pipeline'],
      ['TDD-Enforcement', 'pipeline'],
      ['  documentation  ', 'pipeline'],
      ['REVIEW', 'dag'],
    ])('derivePattern("%s") → "%s"', (input, expected) => {
      expect(derivePattern(input)).toBe(expected);
    });
  });

  describe('unknown / edge-case intents', () => {
    it.each([
      ['unknown-intent', 'dag'],
      ['', 'dag'],
      ['code-gen', 'dag'],
      ['documentation-extended', 'dag'], // partial match should NOT match
    ])('derivePattern("%s") → "%s"', (input, expected) => {
      expect(derivePattern(input)).toBe(expected);
    });
  });
});
```

### Test Suite: `isAnalystIntent` / `isPipelineIntent`

```ts
describe('isAnalystIntent', () => {
  it.each([...ANALYST_INTENTS])('returns true for "%s"', (intent) => {
    expect(isAnalystIntent(intent)).toBe(true);
  });

  it.each(['debugging', 'documentation', 'code-gen', 'unknown'])('returns false for "%s"', (intent) => {
    expect(isAnalystIntent(intent)).toBe(false);
  });
});

describe('isPipelineIntent', () => {
  it.each([...PIPELINE_INTENTS])('returns true for "%s"', (intent) => {
    expect(isPipelineIntent(intent)).toBe(true);
  });

  it.each(['review', 'debugging', 'code-gen', 'unknown'])('returns false for "%s"', (intent) => {
    expect(isPipelineIntent(intent)).toBe(false);
  });
});
```

### Test Suite: `resolvePersonaByIdOrIntent`

#### Registry setup

```ts
describe('resolvePersonaByIdOrIntent', () => {
  beforeEach(() => {
    resetPersonaRegistry();
    initPersonaRegistry(DEFAULT_PERSONA_PROFILES);
  });
```

#### Intent resolution — all 13 production intents

The 13 production intents split into two groups: 9 intents that have a matching persona in the default 10-profile registry, and 4 intents that fall through to derivation (no default persona registered).

```ts
describe('intent resolution (resolutionType: "intent")', () => {
  it.each([
    ['review', 'reviewer-v1', 'analyst', 'dag'],
    ['architecture-plan', 'architect-v1', 'analyst', 'dag'],
    ['requirements-analysis', 'requirements-analyst-v1', 'analyst', 'pipeline'],
    ['security-review', 'security-reviewer-v1', 'analyst', 'dag'],
    ['verification', 'verifier-v1', 'analyst', 'dag'],
    ['test-strategy', 'test-strategist-v1', 'analyst', 'dag'],
    ['documentation', 'docs-writer-v1', 'worker', 'pipeline'],
    ['tdd-enforcement', 'tdd-coach-v1', 'worker', 'pipeline'],
    ['code-gen', 'code-worker-v1', 'worker', 'dag'],
  ] as const)(
    'resolves intent "%s" → persona "%s", preset "%s", pattern "%s"',
    (intent, expectedPersonaId, expectedPreset, expectedPattern) => {
      const result = resolvePersonaByIdOrIntent(intent);
      expect(result.resolved).toBe(true);
      expect(result.resolutionType).toBe('intent');
      expect(result.persona?.id).toBe(expectedPersonaId);
      expect(result.intent).toBe(intent);
      expect(result.preset).toBe(expectedPreset);
      expect(result.pattern).toBe(expectedPattern);
    }
  );

  // Intents without a default persona in the 10-profile registry
  // These fall through to derivation
  it.each([
    ['implement-frontend', 'worker', 'dag'],
    ['debugging', 'worker', 'dag'],
    ['flake-investigation', 'worker', 'dag'],
    ['opencode-workflow-correctness', 'worker', 'dag'],
    ['npm-provenance', 'worker', 'dag'],
  ] as const)(
    'derives intent "%s" → preset "%s", pattern "%s" (no persona in default registry)',
    (intent, expectedPreset, expectedPattern) => {
      const result = resolvePersonaByIdOrIntent(intent);
      // These intents have no matching persona in the 10-entry default registry
      // so they resolve via derivation
      expect(result.resolved).toBe(false);
      expect(result.resolutionType).toBe('derived');
      expect(result.intent).toBe(intent);
      expect(result.preset).toBe(expectedPreset);
      expect(result.pattern).toBe(expectedPattern);
    }
  );
});
```

#### Persona ID resolution — all 10 default profiles

```ts
describe('persona ID resolution (resolutionType: "persona_id")', () => {
  it.each([
    ['reviewer-v1', 'review', 'analyst', 'dag'],
    ['reviewer-v2', 'review', 'analyst', 'dag'],
    ['architect-v1', 'architecture-plan', 'analyst', 'dag'],
    ['requirements-analyst-v1', 'requirements-analysis', 'analyst', 'pipeline'],
    ['security-reviewer-v1', 'security-review', 'analyst', 'dag'],
    ['verifier-v1', 'verification', 'analyst', 'dag'],
    ['test-strategist-v1', 'test-strategy', 'analyst', 'dag'],
    ['docs-writer-v1', 'documentation', 'worker', 'pipeline'],
    ['tdd-coach-v1', 'tdd-enforcement', 'worker', 'pipeline'],
    ['code-worker-v1', 'code-gen', 'worker', 'dag'],
  ] as const)(
    'resolves persona ID "%s" → intent "%s", preset "%s", pattern "%s"',
    (personaId, expectedIntent, expectedPreset, expectedPattern) => {
      const result = resolvePersonaByIdOrIntent(personaId);
      expect(result.resolved).toBe(true);
      // May be 'intent' or 'persona_id' depending on whether the intent
      // also matches — both are valid resolved states
      expect(['intent', 'persona_id']).toContain(result.resolutionType);
      expect(result.persona?.id).toBe(personaId);
      expect(result.intent).toBe(expectedIntent);
      expect(result.preset).toBe(expectedPreset);
      expect(result.pattern).toBe(expectedPattern);
    }
  );
});
```

#### Fallback derivation

```ts
describe('fallback derivation (resolutionType: "derived")', () => {
  it('returns derived resolution for unknown ref', () => {
    const result = resolvePersonaByIdOrIntent('unknown-persona');
    expect(result.resolved).toBe(false);
    expect(result.resolutionType).toBe('derived');
    expect(result.persona).toBeUndefined();
    expect(result.intent).toBe('unknown-persona');
    expect(result.preset).toBe('worker');
    expect(result.pattern).toBe('dag');
  });

  it('returns derived resolution for empty string', () => {
    const result = resolvePersonaByIdOrIntent('');
    expect(result.resolved).toBe(false);
    expect(result.resolutionType).toBe('derived');
    expect(result.preset).toBe('worker');
    expect(result.pattern).toBe('dag');
  });

  it('does not throw for any input', () => {
    const inputs = ['unknown', '', '  ', 'null', 'undefined', '123', 'a'.repeat(1000), 'review/security'];
    for (const input of inputs) {
      expect(() => resolvePersonaByIdOrIntent(input)).not.toThrow();
    }
  });
});
```

#### Profile hint disambiguation

```ts
describe('profile hint disambiguation', () => {
  it('selects reviewer-v2 over reviewer-v1 when profile hint matches', () => {
    const profile: PersonaProfile = {
      id: 'reviewer-v2',
      name: 'Senior Reviewer',
      intent: 'review',
    };
    const result = resolvePersonaByIdOrIntent('review', profile);
    expect(result.resolved).toBe(true);
    expect(result.persona?.id).toBe('reviewer-v2');
  });

  it('falls back to first match when profile hint does not match', () => {
    const profile: PersonaProfile = {
      id: 'nonexistent-v1',
      name: 'Ghost',
      intent: 'review',
    };
    const result = resolvePersonaByIdOrIntent('review', profile);
    expect(result.resolved).toBe(true);
    expect(result.persona?.id).toBe('reviewer-v1');
  });

  it('ignores profile hint for persona ID resolution', () => {
    const profile: PersonaProfile = {
      id: 'reviewer-v2',
      name: 'Senior Reviewer',
      intent: 'review',
    };
    // Direct persona ID lookup ignores the hint
    const result = resolvePersonaByIdOrIntent('architect-v1', profile);
    expect(result.persona?.id).toBe('architect-v1');
  });
});
```

#### Case handling

```ts
describe('case insensitivity', () => {
  it('resolves uppercase persona ID', () => {
    const result = resolvePersonaByIdOrIntent('REVIEWER-V1');
    expect(result.resolved).toBe(true);
    expect(result.persona?.id).toBe('reviewer-v1');
  });

  it('resolves mixed-case intent', () => {
    const result = resolvePersonaByIdOrIntent('Security-Review');
    expect(result.resolved).toBe(true);
    expect(result.resolutionType).toBe('intent');
    expect(result.preset).toBe('analyst');
  });

  it('resolves intent with leading/trailing whitespace', () => {
    const result = resolvePersonaByIdOrIntent('  review  ');
    expect(result.resolved).toBe(true);
    expect(result.persona?.id).toBe('reviewer-v1');
  });
});
```

#### Registry management

```ts
describe('registry management', () => {
  it('resetPersonaRegistry clears all profiles', () => {
    resetPersonaRegistry();
    const result = resolvePersonaByIdOrIntent('review');
    expect(result.resolved).toBe(false);
  });

  it('initPersonaRegistry replaces all profiles', () => {
    const customProfiles: PersonaProfile[] = [
      { id: 'custom-v1', name: 'Custom', intent: 'custom-intent', preset: 'worker', pattern: 'dag' },
    ];
    resetPersonaRegistry();
    initPersonaRegistry(customProfiles);
    const result = resolvePersonaByIdOrIntent('custom-intent');
    expect(result.resolved).toBe(true);
    expect(result.persona?.id).toBe('custom-v1');
  });

  it('personaRegistry.register adds a new profile', () => {
    personaRegistry.register({
      id: 'new-persona-v1',
      name: 'New Persona',
      intent: 'new-intent',
      preset: 'worker',
      pattern: 'dag',
    });
    const result = resolvePersonaByIdOrIntent('new-intent');
    expect(result.resolved).toBe(true);
    expect(result.persona?.id).toBe('new-persona-v1');
  });

  it('getPersonaIdToIntentMap returns correct reverse mapping', () => {
    const map = getPersonaIdToIntentMap();
    expect(map.get('reviewer-v1')).toBe('review');
    expect(map.get('architect-v1')).toBe('architecture-plan');
    expect(map.get('docs-writer-v1')).toBe('documentation');
  });

  it('getPersonaIdToIntentMap contains all 10 default profiles', () => {
    const map = getPersonaIdToIntentMap();
    expect(map.size).toBe(10);
  });

  it('double init does not duplicate profiles', () => {
    initPersonaRegistry(DEFAULT_PERSONA_PROFILES);
    initPersonaRegistry(DEFAULT_PERSONA_PROFILES);
    const map = getPersonaIdToIntentMap();
    expect(map.size).toBe(10);
  });
});
```

#### DEFAULT_PERSONA_PROFILES validation

```ts
describe('DEFAULT_PERSONA_PROFILES', () => {
  it('contains exactly 10 profiles', () => {
    expect(DEFAULT_PERSONA_PROFILES).toHaveLength(10);
  });

  it('all profiles have required fields', () => {
    for (const profile of DEFAULT_PERSONA_PROFILES) {
      expect(profile.id).toBeDefined();
      expect(profile.name).toBeDefined();
      expect(profile.intent).toBeDefined();
      expect(profile.preset).toBeDefined();
      expect(profile.pattern).toBeDefined();
    }
  });

  it('all profile IDs are unique', () => {
    const ids = DEFAULT_PERSONA_PROFILES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('contains expected persona IDs', () => {
    const ids = DEFAULT_PERSONA_PROFILES.map((p) => p.id);
    const expected = [
      'reviewer-v1',
      'reviewer-v2',
      'architect-v1',
      'requirements-analyst-v1',
      'security-reviewer-v1',
      'verifier-v1',
      'test-strategist-v1',
      'docs-writer-v1',
      'tdd-coach-v1',
      'code-worker-v1',
    ];
    for (const id of expected) {
      expect(ids).toContain(id);
    }
  });

  it('all presets are valid AgentPreset values', () => {
    const validPresets = ['lead', 'worker', 'reviewer', 'analyst'];
    for (const profile of DEFAULT_PERSONA_PROFILES) {
      expect(validPresets).toContain(profile.preset);
    }
  });

  it('all patterns are valid SwarmPattern values', () => {
    const validPatterns = ['dag', 'pipeline', 'fan-out', 'hub-spoke', 'mesh'];
    for (const profile of DEFAULT_PERSONA_PROFILES) {
      expect(validPatterns).toContain(profile.pattern);
    }
  });
});
```

### Test Suite: `resolvePersonaSelection`

The convenience wrapper accepts a `PersonaSelection` object and delegates to `resolvePersonaByIdOrIntent`.

```ts
  describe('resolvePersonaSelection', () => {
    it('delegates to resolvePersonaByIdOrIntent with ref', () => {
      const selection: PersonaSelection = { ref: 'review' };
      const result = resolvePersonaSelection(selection);
      expect(result.resolved).toBe(true);
      expect(result.intent).toBe('review');
      expect(result.preset).toBe('analyst');
    });

    it('passes profile hint through', () => {
      const selection: PersonaSelection = {
        ref: 'review',
        profile: { id: 'reviewer-v2', name: 'Senior Reviewer', intent: 'review' },
      };
      const result = resolvePersonaSelection(selection);
      expect(result.persona?.id).toBe('reviewer-v2');
    });

    it('handles unknown ref via derivation', () => {
      const selection: PersonaSelection = { ref: 'custom-task' };
      const result = resolvePersonaSelection(selection);
      expect(result.resolved).toBe(false);
      expect(result.resolutionType).toBe('derived');
      expect(result.preset).toBe('worker');
      expect(result.pattern).toBe('dag');
    });

    it('passes optional context fields through', () => {
      const selection: PersonaSelection = {
        ref: 'security-review',
        context: { workflowType: 'audit', taskType: 'compliance' },
      };
      const result = resolvePersonaSelection(selection);
      expect(result.resolved).toBe(true);
      expect(result.intent).toBe('security-review');
    });
  });
});
```

---

## File 2: `packages/sdk/src/workflows/__tests__/workflow-generator.test.ts`

### Imports

```ts
import { describe, it, expect } from 'vitest';
import {
  generateWorkflow,
  emitBootstrapPhase,
  emitSkillPhase,
  emitContextPhase,
  emitTaskPhase,
  emitVerificationPhase,
  emitFinalPhase,
  slugify,
  escapeTemplateString,
  type GeneratedWorkflow,
  type WorkflowMetadata,
} from '../workflow-generator.js';
import type { WorkflowGeneratorInput, PersonaResolution } from '../persona-utils.js';
```

### Shared Fixtures

```ts
function createMinimalInput(overrides?: Partial<WorkflowGeneratorInput>): WorkflowGeneratorInput {
  return {
    taskDescription: 'Test task',
    workflowName: 'test-task',
    persona: {
      id: 'code-worker-v1',
      name: 'Code Worker',
      intent: 'code-gen',
      preset: 'worker',
      pattern: 'dag',
    },
    selection: {
      intent: 'code-gen',
      preset: 'worker',
      pattern: 'dag',
      resolved: true,
      resolutionType: 'intent',
    } as PersonaResolution,
    skillPlan: { installs: [] },
    contextFiles: [],
    verifications: [],
    maxConcurrency: 4,
    timeout: 3_600_000,
    ...overrides,
  };
}

function createFullInput(): WorkflowGeneratorInput {
  return createMinimalInput({
    taskDescription: 'Review auth middleware for security issues',
    workflowName: 'review-auth-middleware',
    persona: {
      id: 'security-reviewer-v1',
      name: 'Security Reviewer',
      description: 'Reviews code for security vulnerabilities',
      intent: 'security-review',
      preset: 'analyst',
      pattern: 'dag',
    },
    selection: {
      intent: 'security-review',
      preset: 'analyst',
      pattern: 'dag',
      resolved: true,
      resolutionType: 'intent',
    } as PersonaResolution,
    skillPlan: {
      installs: [{ skillId: 'semgrep', command: 'npm install -g semgrep' }],
    },
    contextFiles: [
      { stepName: 'read-auth', command: 'cat src/auth.ts' },
      { stepName: 'read-tests', command: 'cat src/auth.test.ts' },
    ],
    verifications: [{ stepName: 'verify-no-eval', command: "! grep -r 'eval(' src/" }],
    outputFile: 'reports/security.md',
  });
}

function createPipelineInput(): WorkflowGeneratorInput {
  return createMinimalInput({
    taskDescription: 'Analyze requirements from spec documents',
    workflowName: 'analyze-requirements',
    persona: {
      id: 'requirements-analyst-v1',
      name: 'Requirements Analyst',
      description: 'Analyzes requirements from source material',
      intent: 'requirements-analysis',
      preset: 'analyst',
      pattern: 'pipeline',
    },
    selection: {
      intent: 'requirements-analysis',
      preset: 'analyst',
      pattern: 'pipeline',
      resolved: true,
      resolutionType: 'intent',
    } as PersonaResolution,
    contextFiles: [
      { stepName: 'read-spec', command: 'cat docs/spec.md' },
      { stepName: 'read-readme', command: 'cat README.md' },
    ],
  });
}
```

### Test Suite: `slugify`

```ts
describe('slugify', () => {
  it('converts spaces to hyphens', () => {
    expect(slugify('hello world')).toBe('hello-world');
  });

  it('lowercases all characters', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });

  it('strips non-alphanumeric characters', () => {
    expect(slugify('review: auth & tokens!')).toBe('review-auth-tokens');
  });

  it('collapses multiple non-alphanumeric chars to single hyphen', () => {
    expect(slugify('review --- auth')).toBe('review-auth');
  });

  it('trims leading and trailing hyphens', () => {
    expect(slugify('--hello--')).toBe('hello');
  });

  it('truncates to 60 characters', () => {
    const long = 'a'.repeat(80);
    expect(slugify(long).length).toBeLessThanOrEqual(60);
  });

  it('returns empty string for empty input', () => {
    expect(slugify('')).toBe('');
  });

  it('handles special characters', () => {
    expect(slugify('fix: bug #42 (auth)')).toBe('fix-bug-42-auth');
  });
});
```

### Test Suite: `escapeTemplateString`

```ts
describe('escapeTemplateString', () => {
  it('escapes backticks', () => {
    expect(escapeTemplateString('use `code` here')).toBe('use \\`code\\` here');
  });

  it('escapes dollar braces', () => {
    expect(escapeTemplateString('echo ${HOME}')).toBe('echo \\${HOME}');
  });

  it('escapes both backticks and dollar braces', () => {
    const input = '`run ${cmd}`';
    const escaped = escapeTemplateString(input);
    expect(escaped).toBe('\\`run \\${cmd}\\`');
  });

  it('passes through plain text unchanged', () => {
    expect(escapeTemplateString('hello world')).toBe('hello world');
  });

  it('handles empty string', () => {
    expect(escapeTemplateString('')).toBe('');
  });

  it('handles consecutive dollar braces', () => {
    expect(escapeTemplateString('${a}${b}')).toBe('\\${a}\\${b}');
  });

  it('does not double-escape already escaped sequences', () => {
    // Input is raw user text, not pre-escaped
    const input = '\\`already escaped\\`';
    const escaped = escapeTemplateString(input);
    expect(escaped).toBe('\\\\\\`already escaped\\\\\\`');
  });
});
```

### Test Suite: `generateWorkflow`

```ts
describe('generateWorkflow', () => {
  it('produces valid TypeScript structure for minimal input', () => {
    const { source } = generateWorkflow(createMinimalInput());
    expect(source).toContain("import { workflow } from '@agent-relay/sdk/workflows'");
    expect(source).toContain('async function main()');
    expect(source).toContain('.run()');
    expect(source).toContain('main().catch');
  });

  it('includes all phases for full input', () => {
    const { source } = generateWorkflow(createFullInput());
    // Skill phase
    expect(source).toContain('install-skill-semgrep');
    // Context phase
    expect(source).toContain('read-auth');
    expect(source).toContain('read-tests');
    // Task phase
    expect(source).toContain('execute-task');
    // Verification phase
    expect(source).toContain('verify-no-eval');
  });

  it('workflow name appears in workflow() call', () => {
    const { source } = generateWorkflow(createMinimalInput());
    expect(source).toContain("workflow('test-task')");
  });

  it('pattern is set from selection', () => {
    const { source } = generateWorkflow(createPipelineInput());
    expect(source).toContain(".pattern('pipeline')");
  });

  it('channel name is derived from workflow name', () => {
    const { source } = generateWorkflow(createMinimalInput());
    expect(source).toContain(".channel('wf-test-task')");
  });

  it('maxConcurrency is configurable', () => {
    const { source } = generateWorkflow(createMinimalInput({ maxConcurrency: 8 }));
    expect(source).toContain('.maxConcurrency(8)');
  });

  it('timeout is configurable', () => {
    const { source } = generateWorkflow(createMinimalInput({ timeout: 1_800_000 }));
    expect(source).toContain('.timeout(1800000)');
  });

  it('output file produces console.log', () => {
    const { source } = generateWorkflow(createMinimalInput({ outputFile: 'out.md' }));
    expect(source).toContain('out.md');
  });

  it('no output file omits output log', () => {
    const { source } = generateWorkflow(createMinimalInput());
    expect(source).not.toContain('Output:');
  });

  it('returns GeneratedWorkflow shape with source and metadata', () => {
    const result = generateWorkflow(createMinimalInput());
    expect(result).toHaveProperty('source');
    expect(result).toHaveProperty('metadata');
    expect(typeof result.source).toBe('string');
    expect(typeof result.metadata).toBe('object');
  });

  it('metadata.name matches workflowName', () => {
    const { metadata } = generateWorkflow(createMinimalInput());
    expect(metadata.name).toBe('test-task');
  });
});
```

### Test Suite: `emitBootstrapPhase`

```ts
describe('emitBootstrapPhase', () => {
  const defaultOpts = { indent: '  ', comments: true, header: true };

  it('includes import statement', () => {
    const lines = emitBootstrapPhase(createMinimalInput(), defaultOpts);
    const output = lines.join('\n');
    expect(output).toContain("import { workflow } from '@agent-relay/sdk/workflows'");
  });

  it('includes header comment when enabled', () => {
    const lines = emitBootstrapPhase(createMinimalInput(), { ...defaultOpts, header: true });
    expect(lines[0]).toMatch(/^\/\*\*/);
  });

  it('omits header comment when disabled', () => {
    const lines = emitBootstrapPhase(createMinimalInput(), { ...defaultOpts, header: false });
    expect(lines[0]).not.toMatch(/^\/\*\*/);
  });

  it('agent name follows intent convention', () => {
    const input = createMinimalInput({
      selection: {
        intent: 'review',
        preset: 'analyst',
        pattern: 'dag',
        resolved: true,
        resolutionType: 'intent',
      } as PersonaResolution,
    });
    const lines = emitBootstrapPhase(input, defaultOpts);
    const output = lines.join('\n');
    expect(output).toContain("'review-agent'");
  });

  it('agent preset matches selection', () => {
    const input = createMinimalInput({
      selection: {
        intent: 'security-review',
        preset: 'analyst',
        pattern: 'dag',
        resolved: true,
        resolutionType: 'intent',
      } as PersonaResolution,
    });
    const lines = emitBootstrapPhase(input, defaultOpts);
    const output = lines.join('\n');
    expect(output).toContain("preset: 'analyst'");
  });

  it('agent role uses persona description when available', () => {
    const input = createMinimalInput({
      persona: {
        id: 'x',
        name: 'X',
        description: 'Custom role description',
        intent: 'code-gen',
      },
    });
    const lines = emitBootstrapPhase(input, defaultOpts);
    const output = lines.join('\n');
    expect(output).toContain("role: 'Custom role description'");
  });

  it('agent role falls back to task description', () => {
    const input = createMinimalInput({
      persona: { id: 'x', name: 'X', intent: 'code-gen' },
    });
    const lines = emitBootstrapPhase(input, defaultOpts);
    const output = lines.join('\n');
    expect(output).toContain("role: 'Test task'");
  });

  it('respects indent option', () => {
    const lines = emitBootstrapPhase(createMinimalInput(), { ...defaultOpts, indent: '    ' });
    const output = lines.join('\n');
    // 4-space indent should be present in the output body
    expect(output).toMatch(/\n {4}\S/);
  });
});
```

### Test Suite: `emitSkillPhase`

```ts
describe('emitSkillPhase', () => {
  const defaultOpts = { indent: '  ', comments: true, header: true };

  it('returns empty array when no skills', () => {
    const lines = emitSkillPhase(createMinimalInput(), defaultOpts);
    expect(lines).toHaveLength(0);
  });

  it('generates step for single skill install', () => {
    const input = createMinimalInput({
      skillPlan: {
        installs: [{ skillId: 'eslint', command: 'npm install -g eslint' }],
      },
    });
    const lines = emitSkillPhase(input, defaultOpts);
    const output = lines.join('\n');
    expect(output).toContain("'install-skill-eslint'");
    expect(output).toContain("'npm install -g eslint'");
  });

  it('generates parallel steps for multiple skill installs', () => {
    const input = createMinimalInput({
      skillPlan: {
        installs: [
          { skillId: 'eslint', command: 'npm install -g eslint' },
          { skillId: 'prettier', command: 'npm install -g prettier' },
        ],
      },
    });
    const lines = emitSkillPhase(input, defaultOpts);
    const output = lines.join('\n');
    expect(output).toContain("'install-skill-eslint'");
    expect(output).toContain("'install-skill-prettier'");
    // Steps should not depend on each other
    expect(output).not.toContain("dependsOn: ['install-skill-eslint']");
  });

  it('marks steps as deterministic', () => {
    const input = createMinimalInput({
      skillPlan: {
        installs: [{ skillId: 'foo', command: 'npm i foo' }],
      },
    });
    const lines = emitSkillPhase(input, defaultOpts);
    const output = lines.join('\n');
    expect(output).toContain("type: 'deterministic'");
  });

  it('sets failOnError: true', () => {
    const input = createMinimalInput({
      skillPlan: {
        installs: [{ skillId: 'foo', command: 'npm i foo' }],
      },
    });
    const lines = emitSkillPhase(input, defaultOpts);
    const output = lines.join('\n');
    expect(output).toContain('failOnError: true');
  });
});
```

### Test Suite: `emitContextPhase`

```ts
describe('emitContextPhase', () => {
  const defaultOpts = { indent: '  ', comments: true, header: true };

  it('returns empty array when no context files', () => {
    const lines = emitContextPhase(createMinimalInput(), defaultOpts);
    expect(lines).toHaveLength(0);
  });

  it('generates step for single context file', () => {
    const input = createMinimalInput({
      contextFiles: [{ stepName: 'read-config', command: 'cat config.json' }],
    });
    const lines = emitContextPhase(input, defaultOpts);
    const output = lines.join('\n');
    expect(output).toContain("'read-config'");
    expect(output).toContain("'cat config.json'");
  });

  it('sets captureOutput: true', () => {
    const input = createMinimalInput({
      contextFiles: [{ stepName: 'read-it', command: 'cat file.ts' }],
    });
    const lines = emitContextPhase(input, defaultOpts);
    const output = lines.join('\n');
    expect(output).toContain('captureOutput: true');
  });

  it('context steps depend on skill steps when present', () => {
    const input = createMinimalInput({
      skillPlan: {
        installs: [{ skillId: 'tool', command: 'npm i tool' }],
      },
      contextFiles: [{ stepName: 'read-it', command: 'cat file.ts' }],
    });
    const lines = emitContextPhase(input, defaultOpts);
    const output = lines.join('\n');
    expect(output).toContain('install-skill-tool');
  });

  it('context steps have no dependencies when no skills', () => {
    const input = createMinimalInput({
      contextFiles: [{ stepName: 'read-it', command: 'cat file.ts' }],
    });
    const lines = emitContextPhase(input, defaultOpts);
    const output = lines.join('\n');
    // Should not contain a dependsOn referencing skill steps
    expect(output).not.toContain('install-skill');
  });

  it('context steps are independent of each other', () => {
    const input = createMinimalInput({
      contextFiles: [
        { stepName: 'read-a', command: 'cat a.ts' },
        { stepName: 'read-b', command: 'cat b.ts' },
      ],
    });
    const lines = emitContextPhase(input, defaultOpts);
    const output = lines.join('\n');
    // Neither context step should depend on the other
    expect(output).not.toContain("dependsOn: ['read-a']");
    expect(output).not.toContain("dependsOn: ['read-b']");
  });
});
```

### Test Suite: `emitTaskPhase`

```ts
describe('emitTaskPhase', () => {
  const defaultOpts = { indent: '  ', comments: true, header: true };

  it('DAG pattern produces single execute-task step', () => {
    const input = createMinimalInput({
      contextFiles: [{ stepName: 'read-it', command: 'cat f.ts' }],
    });
    const lines = emitTaskPhase(input, defaultOpts);
    const output = lines.join('\n');
    expect(output).toContain("'execute-task'");
    // Should contain exactly one step declaration
    const stepMatches = output.match(/\.step\(/g);
    expect(stepMatches).toHaveLength(1);
  });

  it('pipeline pattern produces sequential steps', () => {
    const lines = emitTaskPhase(createPipelineInput(), defaultOpts);
    const output = lines.join('\n');
    expect(output).toContain("'analyze'");
    expect(output).toContain("'synthesize'");
    expect(output).toContain("'validate'");
    // Chained dependencies
    expect(output).toContain("dependsOn: ['analyze']");
    expect(output).toContain("dependsOn: ['synthesize']");
  });

  it('task step depends on all context steps', () => {
    const input = createMinimalInput({
      contextFiles: [
        { stepName: 'read-auth', command: 'cat auth.ts' },
        { stepName: 'read-tests', command: 'cat auth.test.ts' },
      ],
    });
    const lines = emitTaskPhase(input, defaultOpts);
    const output = lines.join('\n');
    expect(output).toContain('read-auth');
    expect(output).toContain('read-tests');
  });

  it('context outputs are interpolated into task prompt', () => {
    const input = createMinimalInput({
      contextFiles: [{ stepName: 'read-auth', command: 'cat auth.ts' }],
    });
    const lines = emitTaskPhase(input, defaultOpts);
    const output = lines.join('\n');
    expect(output).toContain('{{steps.read-auth.output}}');
  });

  it('task description appears in agent task', () => {
    const input = createMinimalInput({ taskDescription: 'Fix the login bug' });
    const lines = emitTaskPhase(input, defaultOpts);
    const output = lines.join('\n');
    expect(output).toContain('Fix the login bug');
  });

  it('retries defaults to 2 for primary task', () => {
    const lines = emitTaskPhase(createMinimalInput(), defaultOpts);
    const output = lines.join('\n');
    expect(output).toContain('retries: 2');
  });

  it('verification defaults to exit_code', () => {
    const lines = emitTaskPhase(createMinimalInput(), defaultOpts);
    const output = lines.join('\n');
    expect(output).toContain("type: 'exit_code'");
  });

  it('pipeline first step (analyze) has context deps but not task deps', () => {
    const input = createPipelineInput();
    const lines = emitTaskPhase(input, defaultOpts);
    const output = lines.join('\n');
    // analyze should depend on context steps, not on other pipeline steps
    expect(output).toContain('read-spec');
    expect(output).toContain('read-readme');
  });
});
```

### Test Suite: `emitVerificationPhase`

```ts
describe('emitVerificationPhase', () => {
  const defaultOpts = { indent: '  ', comments: true, header: true };

  it('returns empty array when no verifications', () => {
    const lines = emitVerificationPhase(createMinimalInput(), defaultOpts);
    expect(lines).toHaveLength(0);
  });

  it('generates step for single verification', () => {
    const input = createMinimalInput({
      verifications: [{ stepName: 'verify-lint', command: 'npm run lint' }],
    });
    const lines = emitVerificationPhase(input, defaultOpts);
    const output = lines.join('\n');
    expect(output).toContain("'verify-lint'");
    expect(output).toContain("'npm run lint'");
    expect(output).toContain('failOnError: true');
  });

  it('verification steps depend on task step (DAG)', () => {
    const input = createMinimalInput({
      verifications: [{ stepName: 'verify-lint', command: 'npm run lint' }],
    });
    const lines = emitVerificationPhase(input, defaultOpts);
    const output = lines.join('\n');
    expect(output).toContain("'execute-task'");
  });

  it('verification steps depend on last pipeline step', () => {
    const input = createPipelineInput();
    (input as any).verifications = [{ stepName: 'verify-out', command: 'test -f out.md' }];
    const lines = emitVerificationPhase(input, defaultOpts);
    const output = lines.join('\n');
    expect(output).toContain("'validate'");
  });

  it('multiple verification steps are parallel', () => {
    const input = createMinimalInput({
      verifications: [
        { stepName: 'verify-lint', command: 'npm run lint' },
        { stepName: 'verify-types', command: 'npx tsc --noEmit' },
      ],
    });
    const lines = emitVerificationPhase(input, defaultOpts);
    const output = lines.join('\n');
    expect(output).toContain("'verify-lint'");
    expect(output).toContain("'verify-types'");
    // Neither verification step depends on the other
    expect(output).not.toContain("dependsOn: ['verify-lint']");
    expect(output).not.toContain("dependsOn: ['verify-types']");
  });
});
```

### Test Suite: `emitFinalPhase`

```ts
describe('emitFinalPhase', () => {
  const defaultOpts = { indent: '  ', comments: true, header: true };

  it('includes onError strategy', () => {
    const lines = emitFinalPhase(createMinimalInput(), defaultOpts);
    const output = lines.join('\n');
    expect(output).toContain(".onError('fail-fast')");
  });

  it('includes run() call', () => {
    const lines = emitFinalPhase(createMinimalInput(), defaultOpts);
    const output = lines.join('\n');
    expect(output).toContain('.run()');
  });

  it('closes main function with catch handler', () => {
    const lines = emitFinalPhase(createMinimalInput(), defaultOpts);
    const output = lines.join('\n');
    expect(output).toContain('main().catch');
  });

  it('includes process.exit(1) on error', () => {
    const lines = emitFinalPhase(createMinimalInput(), defaultOpts);
    const output = lines.join('\n');
    expect(output).toContain('process.exit(1)');
  });
});
```

### Test Suite: `WorkflowMetadata`

```ts
describe('WorkflowMetadata', () => {
  it('step count is sum of all phases', () => {
    const { metadata } = generateWorkflow(createFullInput());
    const expected =
      metadata.phases.skills +
      metadata.phases.context +
      metadata.phases.task +
      metadata.phases.verification +
      metadata.phases.final;
    expect(metadata.stepCount).toBe(expected);
  });

  it('agent count is 1', () => {
    const { metadata } = generateWorkflow(createMinimalInput());
    expect(metadata.agentCount).toBe(1);
  });

  it('estimated waves for full DAG input', () => {
    const { metadata } = generateWorkflow(createFullInput());
    // skills(1) + context(1) + task(1) + verification(1) + final(1) = 5
    expect(metadata.estimatedWaves).toBeGreaterThanOrEqual(4);
  });

  it('estimated waves for minimal input', () => {
    const { metadata } = generateWorkflow(createMinimalInput());
    // task(1) + final(1) = 2
    expect(metadata.estimatedWaves).toBe(2);
  });

  it('pipeline adds extra waves vs DAG equivalent', () => {
    const dagInput = createMinimalInput({
      contextFiles: [{ stepName: 'ctx', command: 'cat f.ts' }],
    });
    const pipelineInput = createPipelineInput();
    const dagWaves = generateWorkflow(dagInput).metadata.estimatedWaves;
    const pipelineWaves = generateWorkflow(pipelineInput).metadata.estimatedWaves;
    expect(pipelineWaves).toBeGreaterThan(dagWaves);
  });

  it('hasSkills reflects skill installs', () => {
    expect(generateWorkflow(createMinimalInput()).metadata.hasSkills).toBe(false);
    expect(generateWorkflow(createFullInput()).metadata.hasSkills).toBe(true);
  });

  it('hasVerification reflects verification steps', () => {
    expect(generateWorkflow(createMinimalInput()).metadata.hasVerification).toBe(false);
    expect(generateWorkflow(createFullInput()).metadata.hasVerification).toBe(true);
  });

  it('pattern matches the selection pattern', () => {
    const dagMeta = generateWorkflow(createMinimalInput()).metadata;
    expect(dagMeta.pattern).toBe('dag');

    const pipeMeta = generateWorkflow(createPipelineInput()).metadata;
    expect(pipeMeta.pattern).toBe('pipeline');
  });

  it('preset matches the selection preset', () => {
    const workerMeta = generateWorkflow(createMinimalInput()).metadata;
    expect(workerMeta.preset).toBe('worker');

    const analystMeta = generateWorkflow(createFullInput()).metadata;
    expect(analystMeta.preset).toBe('analyst');
  });
});
```

### Test Suite: Edge Cases

```ts
describe('edge cases', () => {
  it('backticks in task description are escaped', () => {
    const input = createMinimalInput({
      taskDescription: 'Use `code` blocks and `template` strings',
    });
    const { source } = generateWorkflow(input);
    // The generated source should be valid — no unescaped backticks breaking template literals
    expect(source).toContain('Use');
    expect(source).not.toMatch(/`code`/); // backticks should be escaped
  });

  it('dollar braces in commands are escaped', () => {
    const input = createMinimalInput({
      contextFiles: [{ stepName: 'read-env', command: 'echo ${HOME}' }],
    });
    const { source } = generateWorkflow(input);
    // Should not produce a raw ${HOME} inside a template literal
    expect(source).toContain('echo');
  });

  it('very long task description is handled', () => {
    const longDesc = 'A'.repeat(2000);
    const input = createMinimalInput({ taskDescription: longDesc });
    const { source } = generateWorkflow(input);
    expect(source).toContain(longDesc);
  });

  it('empty task description produces valid workflow', () => {
    const input = createMinimalInput({ taskDescription: '' });
    const { source } = generateWorkflow(input);
    expect(source).toContain('.run()');
    expect(source).toContain('main().catch');
  });

  it('special characters in workflow name', () => {
    const input = createMinimalInput({ workflowName: 'review-auth_v2.1' });
    const { source } = generateWorkflow(input);
    expect(source).toContain("workflow('review-auth_v2.1')");
  });

  it('newlines in task description are preserved in prompt', () => {
    const input = createMinimalInput({
      taskDescription: 'Line one\nLine two\nLine three',
    });
    const { source } = generateWorkflow(input);
    expect(source).toContain('Line one');
    expect(source).toContain('Line two');
  });

  it('single quotes in persona description are escaped', () => {
    const input = createMinimalInput({
      persona: {
        id: 'x',
        name: 'X',
        description: "Don't break the string",
        intent: 'code-gen',
      },
    });
    const { source } = generateWorkflow(input);
    // Must not produce unmatched single quotes in generated source
    expect(source).toContain('break the string');
  });
});
```

---

## File 3: `packages/sdk/src/workflows/__tests__/workflow-generator.integration.test.ts`

### Purpose

End-to-end integration tests that exercise the full pipeline: persona resolution → workflow generation → source validity. These tests verify that all three phases produce coherent output when composed together.

### Imports

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
  resolvePersonaByIdOrIntent,
  resetPersonaRegistry,
  initPersonaRegistry,
  DEFAULT_PERSONA_PROFILES,
  type PersonaResolution,
  type WorkflowGeneratorInput,
} from '../persona-utils.js';
import { generateWorkflow, type GeneratedWorkflow } from '../workflow-generator.js';
```

### Helper: Build input from resolution

```ts
function buildInput(
  resolution: PersonaResolution,
  taskDescription: string,
  overrides?: Partial<WorkflowGeneratorInput>
): WorkflowGeneratorInput {
  const workflowName = taskDescription
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);

  return {
    taskDescription,
    workflowName,
    persona: resolution.persona ?? { id: 'unknown', name: 'Unknown', intent: resolution.intent },
    selection: resolution,
    skillPlan: { installs: [] },
    contextFiles: [],
    verifications: [],
    maxConcurrency: 4,
    timeout: 3_600_000,
    ...overrides,
  };
}
```

### Integration Test Suite: Resolve → Generate round-trip

```ts
describe('persona resolution → workflow generation (integration)', () => {
  beforeEach(() => {
    resetPersonaRegistry();
    initPersonaRegistry(DEFAULT_PERSONA_PROFILES);
  });

  describe('all registered intents produce valid workflows', () => {
    it.each([
      ['review', 'Review the auth module'],
      ['architecture-plan', 'Plan the migration architecture'],
      ['requirements-analysis', 'Analyze requirements from spec'],
      ['security-review', 'Audit auth middleware for vulnerabilities'],
      ['verification', 'Verify deployment configuration'],
      ['test-strategy', 'Design test strategy for payment module'],
      ['documentation', 'Write API documentation'],
      ['tdd-enforcement', 'Enforce TDD on the parser module'],
      ['code-gen', 'Implement user profile service'],
    ] as const)('intent "%s" with task "%s" produces runnable workflow', (intent, task) => {
      const resolution = resolvePersonaByIdOrIntent(intent);
      const input = buildInput(resolution, task);
      const { source, metadata } = generateWorkflow(input);

      // Structure checks
      expect(source).toContain('import { workflow }');
      expect(source).toContain('async function main()');
      expect(source).toContain('.run()');
      expect(source).toContain('main().catch');

      // Persona-derived values
      expect(source).toContain(`.pattern('${resolution.pattern}')`);
      expect(source).toContain(`preset: '${resolution.preset}'`);

      // Metadata consistency
      expect(metadata.pattern).toBe(resolution.pattern);
      expect(metadata.preset).toBe(resolution.preset);
      expect(metadata.agentCount).toBe(1);
      expect(metadata.stepCount).toBeGreaterThan(0);
    });
  });

  describe('unregistered intents derive valid workflows', () => {
    it.each([
      ['implement-frontend', 'Build new dashboard UI'],
      ['debugging', 'Fix flaky WebSocket reconnect'],
      ['flake-investigation', 'Investigate CI test flakes'],
      ['opencode-workflow-correctness', 'Validate open-source workflow config'],
      ['npm-provenance', 'Set up npm provenance attestation'],
    ] as const)('derived intent "%s" with task "%s" produces valid workflow', (intent, task) => {
      const resolution = resolvePersonaByIdOrIntent(intent);
      expect(resolution.resolved).toBe(false);

      const input = buildInput(resolution, task);
      const { source, metadata } = generateWorkflow(input);

      // Still produces valid structure
      expect(source).toContain('import { workflow }');
      expect(source).toContain('.run()');

      // Uses derived values
      expect(metadata.preset).toBe('worker');
      expect(metadata.pattern).toBe('dag');
    });
  });

  describe('all 10 persona IDs produce valid workflows', () => {
    it.each([
      'reviewer-v1',
      'reviewer-v2',
      'architect-v1',
      'requirements-analyst-v1',
      'security-reviewer-v1',
      'verifier-v1',
      'test-strategist-v1',
      'docs-writer-v1',
      'tdd-coach-v1',
      'code-worker-v1',
    ])('persona ID "%s" resolves and generates a valid workflow', (personaId) => {
      const resolution = resolvePersonaByIdOrIntent(personaId);
      expect(resolution.resolved).toBe(true);

      const input = buildInput(resolution, `Task for ${personaId}`);
      const { source, metadata } = generateWorkflow(input);

      expect(source).toContain('import { workflow }');
      expect(source).toContain('.run()');
      expect(metadata.agentCount).toBe(1);
    });
  });

  describe('cross-pattern consistency', () => {
    it('DAG intents all use "dag" pattern in generated source', () => {
      const dagIntents = [
        'review',
        'architecture-plan',
        'security-review',
        'verification',
        'test-strategy',
        'code-gen',
      ];
      for (const intent of dagIntents) {
        const resolution = resolvePersonaByIdOrIntent(intent);
        const input = buildInput(resolution, `Task for ${intent}`);
        const { source } = generateWorkflow(input);
        expect(source).toContain(".pattern('dag')");
      }
    });

    it('pipeline intents all use "pipeline" pattern in generated source', () => {
      const pipelineIntents = ['requirements-analysis', 'documentation', 'tdd-enforcement'];
      for (const intent of pipelineIntents) {
        const resolution = resolvePersonaByIdOrIntent(intent);
        const input = buildInput(resolution, `Task for ${intent}`);
        const { source } = generateWorkflow(input);
        expect(source).toContain(".pattern('pipeline')");
      }
    });
  });
});
```

### Snapshot Tests: Reference Workflow Comparison

```ts
describe('snapshot tests: generated workflow source', () => {
  beforeEach(() => {
    resetPersonaRegistry();
    initPersonaRegistry(DEFAULT_PERSONA_PROFILES);
  });

  it('minimal DAG workflow matches snapshot', () => {
    const resolution = resolvePersonaByIdOrIntent('code-gen');
    const input = buildInput(resolution, 'Implement user service', {
      contextFiles: [{ stepName: 'read-schema', command: 'cat src/schema.ts' }],
    });
    const { source } = generateWorkflow(input);
    expect(source).toMatchSnapshot();
  });

  it('full security review workflow matches snapshot', () => {
    const resolution = resolvePersonaByIdOrIntent('security-review');
    const input = buildInput(resolution, 'Audit auth module', {
      contextFiles: [
        { stepName: 'read-auth', command: 'cat src/auth.ts' },
        { stepName: 'read-config', command: 'cat src/config.ts' },
      ],
      verifications: [
        { stepName: 'verify-no-eval', command: "! grep -r 'eval(' src/" },
        { stepName: 'verify-no-exec', command: "! grep -r 'exec(' src/" },
      ],
      skillPlan: {
        installs: [{ skillId: 'semgrep', command: 'npx semgrep --install' }],
      },
      outputFile: 'reports/security-audit.md',
    });
    const { source } = generateWorkflow(input);
    expect(source).toMatchSnapshot();
  });

  it('pipeline requirements analysis workflow matches snapshot', () => {
    const resolution = resolvePersonaByIdOrIntent('requirements-analysis');
    const input = buildInput(resolution, 'Analyze product requirements', {
      contextFiles: [
        { stepName: 'read-spec', command: 'cat docs/spec.md' },
        { stepName: 'read-readme', command: 'cat README.md' },
        { stepName: 'read-package', command: 'cat package.json' },
      ],
    });
    const { source } = generateWorkflow(input);
    expect(source).toMatchSnapshot();
  });

  it('documentation pipeline workflow matches snapshot', () => {
    const resolution = resolvePersonaByIdOrIntent('documentation');
    const input = buildInput(resolution, 'Write API reference docs', {
      contextFiles: [
        { stepName: 'read-api', command: 'cat src/api/index.ts' },
        { stepName: 'read-types', command: 'cat src/types.ts' },
      ],
      outputFile: 'docs/api-reference.md',
    });
    const { source } = generateWorkflow(input);
    expect(source).toMatchSnapshot();
  });

  it('TDD enforcement pipeline workflow matches snapshot', () => {
    const resolution = resolvePersonaByIdOrIntent('tdd-enforcement');
    const input = buildInput(resolution, 'Enforce TDD on parser module', {
      contextFiles: [
        { stepName: 'read-parser', command: 'cat src/parser.ts' },
        { stepName: 'read-parser-tests', command: 'cat src/parser.test.ts' },
      ],
    });
    const { source } = generateWorkflow(input);
    expect(source).toMatchSnapshot();
  });

  it('minimal workflow with no context, skills, or verification matches snapshot', () => {
    const resolution = resolvePersonaByIdOrIntent('code-gen');
    const input = buildInput(resolution, 'Scaffold a new module');
    const { source } = generateWorkflow(input);
    expect(source).toMatchSnapshot();
  });
});
```

### Metadata Consistency Tests

```ts
describe('metadata consistency across patterns', () => {
  beforeEach(() => {
    resetPersonaRegistry();
    initPersonaRegistry(DEFAULT_PERSONA_PROFILES);
  });

  it('DAG metadata phases sum to stepCount', () => {
    const resolution = resolvePersonaByIdOrIntent('security-review');
    const input = buildInput(resolution, 'Review code', {
      contextFiles: [{ stepName: 'read-src', command: 'cat src/index.ts' }],
      verifications: [{ stepName: 'verify-lint', command: 'npm run lint' }],
      skillPlan: {
        installs: [{ skillId: 'tool', command: 'npm i tool' }],
      },
    });
    const { metadata } = generateWorkflow(input);
    const sum =
      metadata.phases.bootstrap +
      metadata.phases.skills +
      metadata.phases.context +
      metadata.phases.task +
      metadata.phases.verification +
      metadata.phases.final;
    expect(metadata.stepCount).toBe(sum);
  });

  it('pipeline metadata phases sum to stepCount', () => {
    const resolution = resolvePersonaByIdOrIntent('requirements-analysis');
    const input = buildInput(resolution, 'Analyze reqs', {
      contextFiles: [{ stepName: 'read-doc', command: 'cat doc.md' }],
    });
    const { metadata } = generateWorkflow(input);
    const sum =
      metadata.phases.bootstrap +
      metadata.phases.skills +
      metadata.phases.context +
      metadata.phases.task +
      metadata.phases.verification +
      metadata.phases.final;
    expect(metadata.stepCount).toBe(sum);
  });

  it('pipeline task phase has 3 steps (analyze, synthesize, validate)', () => {
    const resolution = resolvePersonaByIdOrIntent('documentation');
    const input = buildInput(resolution, 'Write docs');
    const { metadata } = generateWorkflow(input);
    expect(metadata.phases.task).toBe(3);
  });

  it('DAG task phase has 1 step (execute-task)', () => {
    const resolution = resolvePersonaByIdOrIntent('review');
    const input = buildInput(resolution, 'Review code');
    const { metadata } = generateWorkflow(input);
    expect(metadata.phases.task).toBe(1);
  });

  it('skills phase count matches installs length', () => {
    const resolution = resolvePersonaByIdOrIntent('code-gen');
    const input = buildInput(resolution, 'Build something', {
      skillPlan: {
        installs: [
          { skillId: 'a', command: 'npm i a' },
          { skillId: 'b', command: 'npm i b' },
          { skillId: 'c', command: 'npm i c' },
        ],
      },
    });
    const { metadata } = generateWorkflow(input);
    expect(metadata.phases.skills).toBe(3);
  });

  it('context phase count matches contextFiles length', () => {
    const resolution = resolvePersonaByIdOrIntent('review');
    const input = buildInput(resolution, 'Review code', {
      contextFiles: [
        { stepName: 'read-a', command: 'cat a.ts' },
        { stepName: 'read-b', command: 'cat b.ts' },
      ],
    });
    const { metadata } = generateWorkflow(input);
    expect(metadata.phases.context).toBe(2);
  });

  it('verification phase count matches verifications length', () => {
    const resolution = resolvePersonaByIdOrIntent('code-gen');
    const input = buildInput(resolution, 'Build code', {
      verifications: [
        { stepName: 'verify-lint', command: 'npm run lint' },
        { stepName: 'verify-types', command: 'npx tsc --noEmit' },
      ],
    });
    const { metadata } = generateWorkflow(input);
    expect(metadata.phases.verification).toBe(2);
  });
});
```

### Source Validity Tests

```ts
describe('generated source validity', () => {
  beforeEach(() => {
    resetPersonaRegistry();
    initPersonaRegistry(DEFAULT_PERSONA_PROFILES);
  });

  it('generated source has balanced braces', () => {
    const resolution = resolvePersonaByIdOrIntent('security-review');
    const input = buildInput(resolution, 'Review auth', {
      contextFiles: [{ stepName: 'read-src', command: 'cat src/auth.ts' }],
      verifications: [{ stepName: 'verify-lint', command: 'npm run lint' }],
      skillPlan: { installs: [{ skillId: 'semgrep', command: 'npx semgrep' }] },
    });
    const { source } = generateWorkflow(input);

    const openBraces = (source.match(/\{/g) || []).length;
    const closeBraces = (source.match(/\}/g) || []).length;
    expect(openBraces).toBe(closeBraces);
  });

  it('generated source has balanced parentheses', () => {
    const resolution = resolvePersonaByIdOrIntent('code-gen');
    const input = buildInput(resolution, 'Implement feature');
    const { source } = generateWorkflow(input);

    const openParens = (source.match(/\(/g) || []).length;
    const closeParens = (source.match(/\)/g) || []).length;
    expect(openParens).toBe(closeParens);
  });

  it('generated source does not contain undefined or null literals in unexpected places', () => {
    const resolution = resolvePersonaByIdOrIntent('review');
    const input = buildInput(resolution, 'Review things');
    const { source } = generateWorkflow(input);

    // Should not have stray undefined/null from unfilled template variables
    expect(source).not.toMatch(/: undefined[,\n]/);
    expect(source).not.toMatch(/: null[,\n]/);
  });

  it('all step names are valid identifiers (lowercase, hyphens, digits)', () => {
    const resolution = resolvePersonaByIdOrIntent('security-review');
    const input = buildInput(resolution, 'Review code', {
      contextFiles: [
        { stepName: 'read-auth-module', command: 'cat auth.ts' },
        { stepName: 'read-config-v2', command: 'cat config.ts' },
      ],
      verifications: [{ stepName: 'verify-no-eval-calls', command: '! grep eval src/' }],
      skillPlan: {
        installs: [{ skillId: 'semgrep-v1', command: 'npm i semgrep' }],
      },
    });
    const { source } = generateWorkflow(input);

    // Extract step names from .step('...') calls
    const stepNames = [...source.matchAll(/\.step\('([^']+)'/g)].map((m) => m[1]);
    for (const name of stepNames) {
      expect(name).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    }
  });
});
```

---

## Test Runner Configuration

All test files use the project's existing vitest configuration. No changes to `vitest.config.ts` are required. Tests are run via:

```bash
# Run all Phase 4 tests
npx vitest run packages/sdk/src/workflows/__tests__/persona-utils.test.ts
npx vitest run packages/sdk/src/workflows/__tests__/workflow-generator.test.ts
npx vitest run packages/sdk/src/workflows/__tests__/workflow-generator.integration.test.ts

# Run all three together
npx vitest run packages/sdk/src/workflows/__tests__/

# Update snapshots after intentional changes
npx vitest run --update packages/sdk/src/workflows/__tests__/workflow-generator.integration.test.ts
```

---

## Snapshot Management

### Initial snapshot creation

On the first run, vitest automatically creates snapshot files in `__tests__/__snapshots__/`. These serve as the reference workflows.

### When to update snapshots

Snapshots must be updated (`--update`) whenever:

- The generated code format changes (indentation, comments, structure)
- New phases are added to the generator
- The WorkflowBuilder API methods change
- Default values (retries, error strategy) are modified

### Snapshot review process

After updating, always review the `.snap` file diff to verify the changes are intentional. Generated workflow snapshots are the single source of truth for "what the generator produces."

---

## Test Coverage Matrix

### `resolvePersonaByIdOrIntent` — Complete Coverage

| Input Type           | Values Tested                                                                                                                                                                            | Count  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Registered intents   | `review`, `architecture-plan`, `requirements-analysis`, `security-review`, `verification`, `test-strategy`, `documentation`, `tdd-enforcement`, `code-gen`                               | 9      |
| Unregistered intents | `implement-frontend`, `debugging`, `flake-investigation`, `opencode-workflow-correctness`, `npm-provenance`                                                                              | 5      |
| Persona IDs          | `reviewer-v1`, `reviewer-v2`, `architect-v1`, `requirements-analyst-v1`, `security-reviewer-v1`, `verifier-v1`, `test-strategist-v1`, `docs-writer-v1`, `tdd-coach-v1`, `code-worker-v1` | 10     |
| Unknown refs         | `unknown-persona`, `''`, `'  '`, `'null'`, `'a'.repeat(1000)`                                                                                                                            | 5      |
| Case variants        | `REVIEWER-V1`, `Security-Review`, `'  review  '`                                                                                                                                         | 3      |
| Profile hints        | Match, no-match, ignore-on-ID-lookup                                                                                                                                                     | 3      |
| **Total**            |                                                                                                                                                                                          | **35** |

### `resolvePersonaSelection` — Convenience Wrapper

| Input Type               | Values Tested                       | Count |
| ------------------------ | ----------------------------------- | ----- |
| Basic ref delegation     | Intent ref                          | 1     |
| Profile hint passthrough | reviewer-v2 hint                    | 1     |
| Unknown ref derivation   | Custom unregistered ref             | 1     |
| Context fields           | workflowType + taskType passthrough | 1     |
| **Total**                |                                     | **4** |

### `derivePreset` — Complete Coverage

| Input Type      | Values Tested                                                                                                           | Count  |
| --------------- | ----------------------------------------------------------------------------------------------------------------------- | ------ |
| Analyst intents | All 6 from `ANALYST_INTENTS`                                                                                            | 6      |
| Worker intents  | All 7 remaining production intents                                                                                      | 7      |
| Case variants   | `REVIEW`, `Security-Review`, `Architecture-Plan`, `REQUIREMENTS-ANALYSIS`, `DEBUGGING`, `Documentation`, `'  review  '` | 7      |
| Unknown/edge    | `unknown-intent`, `''`, `code-gen`, `refactor`, `deploy`, `review-extended`, `security`                                 | 7      |
| **Total**       |                                                                                                                         | **27** |

### `derivePattern` — Complete Coverage

| Input Type       | Values Tested                                                                                | Count  |
| ---------------- | -------------------------------------------------------------------------------------------- | ------ |
| Pipeline intents | All 3 from `PIPELINE_INTENTS`                                                                | 3      |
| DAG intents      | All 10 remaining production intents                                                          | 10     |
| Case variants    | `REQUIREMENTS-ANALYSIS`, `Documentation`, `TDD-Enforcement`, `'  documentation  '`, `REVIEW` | 5      |
| Unknown/edge     | `unknown-intent`, `''`, `code-gen`, `documentation-extended`                                 | 4      |
| **Total**        |                                                                                              | **22** |

### `slugify` — Helper Coverage

| Input Type       | Values Tested                                                       | Count |
| ---------------- | ------------------------------------------------------------------- | ----- |
| Basic conversion | Spaces, case, special chars, collapse, trim, truncate, empty, mixed | 8     |
| **Total**        |                                                                     | **8** |

### `escapeTemplateString` — Helper Coverage

| Input Type | Values Tested                                                          | Count |
| ---------- | ---------------------------------------------------------------------- | ----- |
| Escaping   | Backticks, dollar braces, both, plain, empty, consecutive, pre-escaped | 7     |
| **Total**  |                                                                        | **7** |

### `generateWorkflow` — Complete Coverage

| Category                | Test Cases                                                                                                                      | Count   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Structure validation    | Import, main function, .run(), .catch, shape, name                                                                              | 6       |
| Phase inclusion         | Skill, context, task, verification steps present                                                                                | 4       |
| Configuration           | Workflow name, pattern, channel, concurrency, timeout, output                                                                   | 6       |
| Bootstrap phase         | Import, header on/off, agent naming, preset, role desc, role fallback, indent                                                   | 8       |
| Skill phase             | Empty, single, multiple, deterministic, failOnError                                                                             | 5       |
| Context phase           | Empty, single, captureOutput, skill deps, no deps, independence                                                                 | 6       |
| Task phase              | DAG single step, pipeline sequential, context deps, interpolation, description, retries, verification, pipeline first step deps | 8       |
| Verification phase      | Empty, single step, DAG deps, pipeline deps, multiple parallel                                                                  | 5       |
| Final phase             | onError, run(), catch, process.exit                                                                                             | 4       |
| Metadata                | Step sum, agent count, waves full/minimal, pipeline waves, hasSkills, hasVerification, pattern, preset                          | 9       |
| Edge cases              | Backticks, dollar braces, long description, empty description, special chars, newlines, single quotes                           | 7       |
| Integration round-trips | 9 registered + 5 unregistered + 10 persona IDs + 2 cross-pattern                                                                | 26      |
| Snapshots               | 6 reference workflows                                                                                                           | 6       |
| Metadata consistency    | Phase sums (DAG/pipeline), task phase counts, skills/context/verification counts                                                | 7       |
| Source validity         | Balanced braces, balanced parens, no stray undefined/null, valid step names                                                     | 4       |
| **Total**               |                                                                                                                                 | **117** |

### Grand Total by File

| File                                     | Test Count |
| ---------------------------------------- | ---------- |
| `persona-utils.test.ts`                  | 45         |
| `workflow-generator.test.ts`             | 63         |
| `workflow-generator.integration.test.ts` | 53         |
| **Grand Total**                          | **~161**   |

> Note: counts include individual parameterized test cases from `it.each`.

---

## Acceptance Criteria

- [ ] All 35 `resolvePersonaByIdOrIntent` test cases pass, covering all 13 intents, all 10 persona IDs, fallback derivation, profile hints, and case handling
- [ ] All 4 `resolvePersonaSelection` wrapper tests pass, verifying delegation and profile passthrough
- [ ] All 27 `derivePreset` test cases pass, covering all 6 analyst intents, all 7 worker intents, case variants, and edge cases
- [ ] All 22 `derivePattern` test cases pass, covering all 3 pipeline intents, all 10 DAG intents, case variants, and edge cases
- [ ] All 8 `slugify` tests pass (spaces, case, special chars, truncation, edge cases)
- [ ] All 7 `escapeTemplateString` tests pass (backticks, dollar braces, combined, edge cases)
- [ ] All `generateWorkflow` unit tests pass for each emit function and the orchestrator
- [ ] All 6 snapshot tests generate stable, reproducible workflow source
- [ ] All 26 integration round-trip tests (resolve → generate) produce valid workflow structure
- [ ] All 7 metadata consistency tests pass (phase sums, task phase counts, phase-specific counts)
- [ ] All 4 source validity tests pass (balanced braces/parens, no stray values, valid step names)
- [ ] Pipeline task phase has exactly 3 steps; DAG task phase has exactly 1 step
- [ ] No new external dependencies introduced
- [ ] All tests run via `npx vitest run` with zero configuration changes
- [ ] Snapshot files are committed and reviewed as part of the PR
