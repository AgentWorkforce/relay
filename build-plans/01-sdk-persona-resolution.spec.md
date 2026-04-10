# Phase 1 Specification: SDK Persona Resolution Utilities

> Add `resolvePersonaByIdOrIntent()`, `derivePreset()`, and `derivePattern()` to the relay SDK workflows package.

**Phase:** 1 of 5
**Dependencies:** None (foundational phase)
**Target files:**

- `packages/sdk/src/workflows/persona-utils.ts` (new)
- `packages/sdk/src/workflows/__tests__/persona-utils.test.ts` (new)

---

## Goal

Provide a self-contained persona resolution layer inside `@agent-relay/sdk/workflows` that the `--agent` CLI flag and the workflow generator (Phase 2) can consume. The module must:

1. Resolve a `--agent <ref>` CLI value to a concrete intent, preset, and swarm pattern
2. Map persona IDs to intents (reverse lookup) and intents to persona IDs (forward lookup)
3. Derive an `AgentPreset` (`'worker'` | `'analyst'`) from any intent string
4. Derive a `SwarmPattern` (`'dag'` | `'pipeline'`) from any intent string
5. Operate without external dependencies -- pure functions + an in-memory registry

---

## TypeScript Interfaces

### WorkflowGeneratorInput

This is the primary input to the Phase 2 workflow generator, defined here so that Phase 1 types are forward-compatible.

```ts
import type { SwarmPattern, AgentPreset } from './types.js';

/**
 * Complete input for the workflow generator (Phase 2).
 * Phase 1 produces the persona-related fields; CLI parsing fills the rest.
 */
export interface WorkflowGeneratorInput {
  // From CLI parsing
  taskDescription: string;
  workflowName: string; // slugified from taskDescription

  // From persona resolution (Phase 1)
  persona: PersonaProfile;
  selection: PersonaResolution; // includes intent, preset, pattern
  skillPlan: SkillMaterializationPlan;

  // From CLI flags or defaults
  contextFiles: ContextFileSpec[];
  verifications: VerificationSpec[];
  outputFile?: string;
  maxConcurrency: number; // default: 4
  timeout: number; // default: 3_600_000
}

export interface ContextFileSpec {
  /** Step name in the generated workflow, e.g. 'read-publish-yml' */
  stepName: string;
  /** Shell command to capture output, e.g. 'cat .github/workflows/publish.yml' */
  command: string;
}

export interface VerificationSpec {
  /** Step name in the generated workflow, e.g. 'verify-no-npm-token' */
  stepName: string;
  /** Shell command that must exit 0, e.g. 'grep -q "id-token" ...' */
  command: string;
}

export interface SkillMaterializationPlan {
  installs: Array<{ skillId: string; command: string }>;
  manifestPath?: string;
}
```

### PersonaSelection

```ts
/**
 * Input for resolving a persona reference from the CLI.
 */
export interface PersonaSelection {
  /** The --agent value: either a persona ID or an intent string. */
  ref: string;
  /** Optional profile hint for disambiguation when multiple personas share an intent. */
  profile?: PersonaProfile;
  /** Optional context for resolution. */
  context?: {
    workflowType?: string;
    taskType?: string;
  };
}
```

### PersonaResolution

```ts
/**
 * Result of persona resolution -- everything downstream needs to generate a workflow.
 */
export interface PersonaResolution {
  /** The resolved persona profile, if found in the registry. */
  persona?: PersonaProfile;
  /** The resolved intent string (always populated). */
  intent: string;
  /** Derived preset: 'worker' or 'analyst'. */
  preset: AgentPreset;
  /** Derived swarm pattern: 'dag' or 'pipeline'. */
  pattern: SwarmPattern;
  /** Whether a concrete persona was found in the registry. */
  resolved: boolean;
  /** How the ref was interpreted. */
  resolutionType: 'intent' | 'persona_id' | 'derived';
}
```

### PersonaProfile

```ts
/**
 * A persona profile describes an agent's role, capabilities, and defaults.
 */
export interface PersonaProfile {
  id: string;
  name: string;
  description?: string;
  /** Primary intent this persona serves (e.g., 'review', 'debugging'). */
  intent?: string;
  /** Default preset for agents with this persona. */
  preset?: AgentPreset;
  /** Preferred swarm pattern for multi-agent coordination. */
  pattern?: SwarmPattern;
  /** Skills this persona has. */
  skills?: string[];
  /** Additional metadata. */
  metadata?: Record<string, unknown>;
}
```

### PersonaRegistry

```ts
/**
 * In-memory registry of known persona profiles.
 * Built at SDK init time; supports O(1) lookups by ID and intent.
 */
export interface PersonaRegistry {
  byId: Map<string, PersonaProfile>;
  byIntent: Map<string, string[]>;
  register(profile: PersonaProfile): void;
  getById(id: string): PersonaProfile | undefined;
  getByIntent(intent: string): string[];
  buildReverseMap(): Map<string, string>;
}
```

---

## Constant Definitions

### Analyst intents

Intents that map to `preset: 'analyst'` (read-only analysis, no code modification):

```ts
export const ANALYST_INTENTS = [
  'review',
  'architecture-plan',
  'requirements-analysis',
  'security-review',
  'verification',
  'test-strategy',
] as const;
```

### Pipeline intents

Intents that map to `pattern: 'pipeline'` (inherently sequential processing):

```ts
export const PIPELINE_INTENTS = ['requirements-analysis', 'documentation', 'tdd-enforcement'] as const;
```

### Preset derivation table

All 13 production persona intents from the design plan:

| Intent                          | Preset    | Rationale                      |
| ------------------------------- | --------- | ------------------------------ |
| `implement-frontend`            | `worker`  | Modifies UI code               |
| `review`                        | `analyst` | Read-only analysis             |
| `architecture-plan`             | `analyst` | Produces plans, not code       |
| `requirements-analysis`         | `analyst` | Read-only analysis             |
| `debugging`                     | `worker`  | Modifies code to fix bugs      |
| `security-review`               | `analyst` | Read-only analysis             |
| `documentation`                 | `worker`  | Creates/modifies doc files     |
| `verification`                  | `analyst` | Read-only evidence checking    |
| `test-strategy`                 | `analyst` | Produces strategy, not code    |
| `tdd-enforcement`               | `worker`  | May create/modify test files   |
| `flake-investigation`           | `worker`  | Modifies code to fix flakes    |
| `opencode-workflow-correctness` | `worker`  | Modifies config/code           |
| `npm-provenance`                | `worker`  | Modifies workflow/config files |

**Rule:** If intent is in `ANALYST_INTENTS`, return `'analyst'`. Otherwise return `'worker'`.

### Pattern derivation table

| Intent                  | Pattern    | Rationale                                              |
| ----------------------- | ---------- | ------------------------------------------------------ |
| `requirements-analysis` | `pipeline` | Sequential: read -> analyze -> produce -> verify       |
| `documentation`         | `pipeline` | Sequential: read code -> write docs -> verify          |
| `tdd-enforcement`       | `pipeline` | Sequential red-green-refactor cycles                   |
| All other intents       | `dag`      | Parallel context reads + convergent analysis/execution |

**Rule:** If intent is in `PIPELINE_INTENTS`, return `'pipeline'`. Otherwise return `'dag'`.

---

## Function Specifications

### `derivePreset(intent: string): AgentPreset`

Pure function. Case-insensitive. Returns `'analyst'` for analyst intents, `'worker'` otherwise.

```ts
export function derivePreset(intent: string): AgentPreset {
  const normalized = intent.toLowerCase().trim();
  if (ANALYST_INTENTS.includes(normalized as AnalystIntent)) {
    return 'analyst';
  }
  return 'worker';
}
```

### `derivePattern(intent: string): SwarmPattern`

Pure function. Case-insensitive. Returns `'pipeline'` for pipeline intents, `'dag'` otherwise.

```ts
export function derivePattern(intent: string): SwarmPattern {
  const normalized = intent.toLowerCase().trim();
  if (PIPELINE_INTENTS.includes(normalized as PipelineIntent)) {
    return 'pipeline';
  }
  return 'dag';
}
```

### `resolvePersonaByIdOrIntent(ref: string, profile?: PersonaProfile): PersonaResolution`

Two-step lookup with derivation fallback:

1. **Try as intent** -- check `personaRegistry.getByIntent(ref)`. If found, resolve using the first matching persona (or the profile hint if it matches).
2. **Try as persona ID** -- check `personaRegistry.getById(ref)`. If found, extract the intent from the persona.
3. **Fallback** -- treat `ref` as the intent, derive preset and pattern, set `resolved: false`.

```ts
export function resolvePersonaByIdOrIntent(ref: string, profile?: PersonaProfile): PersonaResolution {
  const normalized = ref.toLowerCase().trim();

  // Step 1: Try as intent
  const intentPersonaIds = personaRegistry.getByIntent(normalized);
  if (intentPersonaIds.length > 0) {
    const personaId = profile?.id && intentPersonaIds.includes(profile.id) ? profile.id : intentPersonaIds[0];
    const persona = personaRegistry.getById(personaId);
    const intent = persona?.intent || normalized;
    return {
      persona,
      intent,
      preset: persona?.preset || derivePreset(intent),
      pattern: persona?.pattern || derivePattern(intent),
      resolved: true,
      resolutionType: 'intent',
    };
  }

  // Step 2: Try as persona ID
  const persona = personaRegistry.getById(normalized);
  if (persona) {
    const intent = persona.intent || getPersonaIdToIntentMap().get(normalized) || normalized;
    return {
      persona,
      intent,
      preset: persona.preset || derivePreset(intent),
      pattern: persona.pattern || derivePattern(intent),
      resolved: true,
      resolutionType: 'persona_id',
    };
  }

  // Step 3: Fallback derivation
  return {
    persona: undefined,
    intent: normalized,
    preset: derivePreset(normalized),
    pattern: derivePattern(normalized),
    resolved: false,
    resolutionType: 'derived',
  };
}
```

### Helper functions

```ts
export function isAnalystIntent(intent: string): boolean;
export function isPipelineIntent(intent: string): boolean;
```

### Registry management

```ts
export function initPersonaRegistry(profiles: PersonaProfile[]): void;
export function resetPersonaRegistry(): void;
export function getPersonaIdToIntentMap(): Map<string, string>;
export const personaRegistry: PersonaRegistry;
```

---

## Default persona profiles

The module initializes with 10 default profiles on import. These cover the standard workforce personas:

| ID                        | Name                    | Intent                  | Preset    | Pattern    |
| ------------------------- | ----------------------- | ----------------------- | --------- | ---------- |
| `reviewer-v1`             | Code Reviewer           | `review`                | `analyst` | `dag`      |
| `reviewer-v2`             | Senior Reviewer         | `review`                | `analyst` | `dag`      |
| `architect-v1`            | Architecture Planner    | `architecture-plan`     | `analyst` | `dag`      |
| `requirements-analyst-v1` | Requirements Analyst    | `requirements-analysis` | `analyst` | `pipeline` |
| `security-reviewer-v1`    | Security Reviewer       | `security-review`       | `analyst` | `dag`      |
| `verifier-v1`             | Verification Specialist | `verification`          | `analyst` | `dag`      |
| `test-strategist-v1`      | Test Strategist         | `test-strategy`         | `analyst` | `dag`      |
| `docs-writer-v1`          | Documentation Writer    | `documentation`         | `worker`  | `pipeline` |
| `tdd-coach-v1`            | TDD Coach               | `tdd-enforcement`       | `worker`  | `pipeline` |
| `code-worker-v1`          | Code Worker             | `code-gen`              | `worker`  | `dag`      |

The registry is extensible -- consumers can call `personaRegistry.register()` to add custom profiles or `initPersonaRegistry()` to replace all defaults.

---

## File: `packages/sdk/src/workflows/persona-utils.ts`

### Structure

```
persona-utils.ts
  ├── Intent constants (ANALYST_INTENTS, PIPELINE_INTENTS)
  ├── Type exports (AnalystIntent, PipelineIntent)
  ├── Interface definitions (PersonaProfile, PersonaSelection, PersonaResolution, PersonaRegistry)
  ├── Forward-compatible types (WorkflowGeneratorInput, ContextFileSpec, VerificationSpec, SkillMaterializationPlan)
  ├── Registry implementation (_registry singleton)
  ├── Registry management (init, reset, getPersonaIdToIntentMap)
  ├── Derivation functions (derivePreset, derivePattern)
  ├── Query helpers (isAnalystIntent, isPipelineIntent)
  ├── Resolution function (resolvePersonaByIdOrIntent)
  ├── Convenience wrapper (resolvePersonaSelection)
  ├── Default profiles (DEFAULT_PERSONA_PROFILES)
  └── Auto-init (initPersonaRegistry called on import)
```

### Imports

```ts
import type { AgentPreset } from './types.js';
import type { SwarmPattern } from './types.js';
```

Only depends on types already in the SDK's `workflows/types.ts`. No external dependencies.

---

## File: `packages/sdk/src/workflows/__tests__/persona-utils.test.ts`

### Test structure (vitest)

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
  derivePreset,
  derivePattern,
  resolvePersonaByIdOrIntent,
  isAnalystIntent,
  isPipelineIntent,
  resetPersonaRegistry,
  initPersonaRegistry,
  DEFAULT_PERSONA_PROFILES,
  ANALYST_INTENTS,
  PIPELINE_INTENTS,
  type PersonaProfile,
} from '../persona-utils.js';
```

### Test cases

#### `derivePreset`

| Test               | Input                                                                                                                  | Expected         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------- | ---------------- |
| Analyst intents    | `'review'`, `'architecture-plan'`, `'requirements-analysis'`, `'security-review'`, `'verification'`, `'test-strategy'` | `'analyst'` each |
| Case insensitivity | `'REVIEW'`, `'Security-Review'`                                                                                        | `'analyst'` each |
| Worker intents     | `'code-gen'`, `'refactor'`, `'documentation'`                                                                          | `'worker'` each  |
| Unknown intents    | `'unknown-intent'`, `''`                                                                                               | `'worker'` each  |

#### `derivePattern`

| Test               | Input                                                             | Expected          |
| ------------------ | ----------------------------------------------------------------- | ----------------- |
| Pipeline intents   | `'requirements-analysis'`, `'documentation'`, `'tdd-enforcement'` | `'pipeline'` each |
| Case insensitivity | `'DOCUMENTATION'`, `'TDD-Enforcement'`                            | `'pipeline'` each |
| DAG intents        | `'review'`, `'code-gen'`, `'architecture-plan'`                   | `'dag'` each      |
| Unknown intents    | `'unknown-intent'`, `''`                                          | `'dag'` each      |

#### `isAnalystIntent` / `isPipelineIntent`

- All `ANALYST_INTENTS` entries return `true` for `isAnalystIntent`
- Non-analyst intents return `false`
- All `PIPELINE_INTENTS` entries return `true` for `isPipelineIntent`
- Non-pipeline intents return `false`

#### `resolvePersonaByIdOrIntent`

Each test uses `beforeEach` to reset and reinitialize the registry with `DEFAULT_PERSONA_PROFILES`.

| Test group                | Test                              | Input                                                                                                    | Assertions                                                                                                       |
| ------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Intent resolution**     | Resolve `'review'`                | `resolvePersonaByIdOrIntent('review')`                                                                   | `resolved: true`, `resolutionType: 'intent'`, `persona.id: 'reviewer-v1'`, `preset: 'analyst'`, `pattern: 'dag'` |
|                           | Resolve `'security-review'`       | `resolvePersonaByIdOrIntent('security-review')`                                                          | `resolved: true`, `persona.id: 'security-reviewer-v1'`, `preset: 'analyst'`                                      |
|                           | Resolve `'requirements-analysis'` | `resolvePersonaByIdOrIntent('requirements-analysis')`                                                    | `pattern: 'pipeline'`, `preset: 'analyst'`                                                                       |
|                           | Resolve `'documentation'`         | `resolvePersonaByIdOrIntent('documentation')`                                                            | `pattern: 'pipeline'`, `preset: 'worker'`                                                                        |
| **Persona ID resolution** | Resolve `'reviewer-v2'`           | `resolvePersonaByIdOrIntent('reviewer-v2')`                                                              | `resolved: true`, `resolutionType: 'persona_id'`, `persona.id: 'reviewer-v2'`                                    |
|                           | Resolve `'architect-v1'`          | `resolvePersonaByIdOrIntent('architect-v1')`                                                             | `intent: 'architecture-plan'`, `preset: 'analyst'`                                                               |
| **Fallback derivation**   | Unknown ref                       | `resolvePersonaByIdOrIntent('unknown-persona')`                                                          | `resolved: false`, `resolutionType: 'derived'`, `preset: 'worker'`, `pattern: 'dag'`                             |
| **Profile hint**          | Disambiguate                      | `resolvePersonaByIdOrIntent('review', { id: 'reviewer-v2', name: 'Senior Reviewer', intent: 'review' })` | `persona.id: 'reviewer-v2'` (not `reviewer-v1`)                                                                  |
| **Case handling**         | Uppercase persona ID              | `resolvePersonaByIdOrIntent('REVIEWER-V1')`                                                              | `resolved: true`, `persona.id: 'reviewer-v1'`                                                                    |
|                           | Mixed-case intent                 | `resolvePersonaByIdOrIntent('Security-Review')`                                                          | `resolved: true`, `resolutionType: 'intent'`                                                                     |

#### `DEFAULT_PERSONA_PROFILES`

- All 10 expected persona IDs are present
- All profiles have valid `preset` values (`'lead' | 'worker' | 'reviewer' | 'analyst'`)
- All profiles have valid `pattern` values (any `SwarmPattern` value)

---

## SDK Export Changes

The new file must be re-exported from the workflows index. Add to `packages/sdk/src/workflows/index.ts`:

```ts
export {
  derivePreset,
  derivePattern,
  resolvePersonaByIdOrIntent,
  resolvePersonaSelection,
  isAnalystIntent,
  isPipelineIntent,
  personaRegistry,
  initPersonaRegistry,
  resetPersonaRegistry,
  getPersonaIdToIntentMap,
  DEFAULT_PERSONA_PROFILES,
  ANALYST_INTENTS,
  PIPELINE_INTENTS,
  type PersonaProfile,
  type PersonaSelection,
  type PersonaResolution,
  type PersonaRegistry,
  type AnalystIntent,
  type PipelineIntent,
  type WorkflowGeneratorInput,
  type ContextFileSpec,
  type VerificationSpec,
  type SkillMaterializationPlan,
} from './persona-utils.js';
```

---

## Implementation Notes

1. **No external dependencies.** The module only imports `AgentPreset` and `SwarmPattern` from the existing `types.ts` in the same package. No npm packages, no network calls, no filesystem access.

2. **Registry is a module-level singleton.** The `_registry` object is created once on module load. `DEFAULT_PERSONA_PROFILES` is auto-registered via `initPersonaRegistry()` at the bottom of the file. Tests use `resetPersonaRegistry()` + `initPersonaRegistry()` in `beforeEach` for isolation.

3. **Lazy reverse map.** The `personaIdToIntent` reverse map is built lazily on first `getPersonaIdToIntentMap()` call and cached. `resetPersonaRegistry()` clears the cache.

4. **Case-insensitive matching.** All ref/intent values are normalized to lowercase via `.toLowerCase().trim()` before lookup.

5. **Forward-compatible types.** `WorkflowGeneratorInput`, `ContextFileSpec`, `VerificationSpec`, and `SkillMaterializationPlan` are defined here but consumed in Phase 2. This prevents a Phase 2 dependency back into Phase 1 types.

6. **Pattern follows existing codebase conventions.** The file uses ES module imports with `.js` extensions, `type` keyword for type-only imports, and JSDoc comments for exported functions -- matching the patterns in `builder.ts` and `types.ts`.

---

## Acceptance Criteria

- [ ] `derivePreset()` returns `'analyst'` for all 6 analyst intents and `'worker'` for all others
- [ ] `derivePattern()` returns `'pipeline'` for all 3 pipeline intents and `'dag'` for all others
- [ ] `resolvePersonaByIdOrIntent()` resolves all 10 default persona IDs correctly
- [ ] `resolvePersonaByIdOrIntent()` resolves all registered intents correctly
- [ ] `resolvePersonaByIdOrIntent()` falls back to derivation for unknown refs (does not throw)
- [ ] Profile hint disambiguates when multiple personas share an intent
- [ ] All lookups are case-insensitive
- [ ] `resetPersonaRegistry()` + `initPersonaRegistry()` provides test isolation
- [ ] All tests pass via `vitest`
- [ ] No new external dependencies introduced
- [ ] Types are exported and available to Phase 2 consumers
