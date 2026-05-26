/**
 * Persona loading and spawn-plan construction.
 *
 * A persona is a JSON file that describes a pre-configured agent: harness,
 * model, system prompt, skills, MCP servers, mount policy, sidecar
 * markdown, inputs, and per-spawn env. Personas live in
 * `<cwd>/agentworkforce/personas`, the AgentWorkforce home directory, or
 * any directory the caller passes explicitly.
 *
 * The persona schema is owned by `@agentworkforce/persona-kit` and is the
 * same shape the `agentworkforce` CLI consumes. This module owns the
 * relay-specific search-dir cascade and file discovery; it delegates
 * everything else (parsing, spawn-plan construction, side-effect execution)
 * to persona-kit so relay and the workforce CLI behave identically.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';

import {
  HARNESS_VALUES,
  buildPersonaSpawnPlan,
  executePersonaSpawnPlan,
  isIntent,
  parsePersonaSpec,
  resolveSidecar,
  sidecarSelectionFields,
  type ExecuteOptions,
  type ExecutionHandle,
  type Harness,
  type McpServerSpec,
  type PersonaInputSpec,
  type PersonaMount,
  type PersonaPermissions,
  type PersonaSkill,
  type PersonaSpawnPlan,
  type PersonaSpec,
  type PlanOptions,
  type ResolvedPersona,
  type SkillMaterializationPlan,
} from '@agentworkforce/persona-kit';

// ── Re-exports for SDK consumers ───────────────────────────────────────────

export { HARNESS_VALUES, buildPersonaSpawnPlan, executePersonaSpawnPlan };

export type {
  ExecuteOptions,
  ExecutionHandle,
  Harness,
  McpServerSpec,
  PersonaInputSpec,
  PersonaMount,
  PersonaPermissions,
  PersonaSkill,
  PersonaSpawnPlan,
  PersonaSpec,
  PlanOptions,
  ResolvedPersona,
  SkillMaterializationPlan,
};

// ── Discovery types ────────────────────────────────────────────────────────

export interface PersonaLoadOptions {
  cwd?: string;
  /** Override the default search-dir cascade. */
  searchDirs?: string[];
  /** Extra dirs appended after the default cascade. */
  extraDirs?: string[];
}

/** A persona file located on disk. */
export interface DiscoveredPersona {
  id: string;
  path: string;
  spec: PersonaSpec;
}

// ── Default search dirs ────────────────────────────────────────────────────

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return p;
}

/**
 * The default cascade. First match wins for a given persona id.
 *
 * 1. `<cwd>/agentworkforce/personas`            (the path most projects pick)
 * 2. `<cwd>/.agentworkforce/workforce/personas` (workforce CLI's project default)
 * 3. `<cwd>/agentworkforce/workforce/personas`  (alt workforce layout)
 * 4. `$AGENT_WORKFORCE_HOME/personas` if set, else `~/.agentworkforce/workforce/personas`
 */
export function defaultPersonaSearchDirs(cwd: string = process.cwd()): string[] {
  const dirs: string[] = [
    join(cwd, 'agentworkforce', 'personas'),
    join(cwd, '.agentworkforce', 'workforce', 'personas'),
    join(cwd, 'agentworkforce', 'workforce', 'personas'),
  ];

  const home = process.env.AGENT_WORKFORCE_HOME?.trim();
  if (home) {
    dirs.push(join(expandHome(home), 'personas'));
  } else {
    dirs.push(join(homedir(), '.agentworkforce', 'workforce', 'personas'));
  }

  return dirs;
}

function effectiveSearchDirs(options: PersonaLoadOptions): string[] {
  const cwd = options.cwd ?? process.cwd();
  const base = options.searchDirs
    ? options.searchDirs.map((d) => normalizeDir(d, cwd))
    : defaultPersonaSearchDirs(cwd);
  const extras = (options.extraDirs ?? []).map((d) => normalizeDir(d, cwd));
  return dedupe([...base, ...extras]);
}

function normalizeDir(input: string, cwd: string): string {
  const expanded = expandHome(input.trim());
  return isAbsolute(expanded) ? resolvePath(expanded) : resolvePath(cwd, expanded);
}

function dedupe<T>(items: T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

// ── Parsing ────────────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePersonaJson(raw: unknown, source: string): PersonaSpec {
  if (!isPlainObject(raw)) {
    throw new Error(`${source}: persona must be a JSON object`);
  }
  const intent = raw.intent;
  if (typeof intent !== 'string' || !intent.trim()) {
    throw new Error(`${source}: persona.intent must be a non-empty string`);
  }
  if (!isIntent(intent)) {
    throw new Error(`${source}: persona.intent "${intent}" is not a known PersonaIntent`);
  }
  // persona-kit's parser cross-checks the file's declared intent against an
  // "expected" intent; relay loads personas by id so it has no expected intent
  // — feed the file's own intent back in to make the mismatch check a no-op
  // while keeping the rest of the schema validation.
  return parsePersonaSpec(raw, intent);
}

// ── Discovery ──────────────────────────────────────────────────────────────

/**
 * List every persona discoverable across the search-dir cascade. When the
 * same id appears in multiple dirs, only the first match (by cascade order)
 * is returned.
 */
export function listPersonas(options: PersonaLoadOptions = {}): DiscoveredPersona[] {
  const dirs = effectiveSearchDirs(options);
  const byId = new Map<string, DiscoveredPersona>();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of entries) {
      if (!file.endsWith('.json')) continue;
      const path = join(dir, file);
      let spec: PersonaSpec;
      try {
        // Single read avoids a TOCTOU between stat and readFileSync — if the
        // entry is a directory, vanished, or unreadable we skip it.
        spec = parsePersonaJson(JSON.parse(readFileSync(path, 'utf8')), path);
      } catch {
        continue;
      }
      if (!byId.has(spec.id)) {
        byId.set(spec.id, { id: spec.id, path, spec });
      }
    }
  }
  return [...byId.values()];
}

/**
 * Find a persona file by id across the search-dir cascade.
 * Returns undefined if not found.
 */
export function findPersona(id: string, options: PersonaLoadOptions = {}): DiscoveredPersona | undefined {
  const dirs = effectiveSearchDirs(options);
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const candidate = join(dir, `${id}.json`);
    let candidateBytes: string | undefined;
    try {
      candidateBytes = readFileSync(candidate, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (candidateBytes !== undefined) {
      try {
        const spec = parsePersonaJson(JSON.parse(candidateBytes), candidate);
        if (spec.id === id) return { id, path: candidate, spec };
      } catch {
        // A bad shadow file at the conventional path shouldn't block a
        // valid persona lower in the cascade. The directory-scan fallback
        // below already tolerates parse failures the same way.
      }
    }
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of entries) {
      if (!file.endsWith('.json')) continue;
      const path = join(dir, file);
      try {
        const spec = parsePersonaJson(JSON.parse(readFileSync(path, 'utf8')), path);
        if (spec.id === id) return { id, path, spec };
      } catch {
        continue;
      }
    }
  }
  return undefined;
}

/**
 * Load a persona by id from the search-dir cascade. Returns the parsed
 * {@link PersonaSpec} verbatim — callers wanting a spawn plan should pass
 * the result to {@link resolvePersona} + {@link buildPersonaSpawnPlan},
 * or use {@link getPersonaSpawnPlan} as a one-shot.
 */
export function loadPersona(id: string, options: PersonaLoadOptions = {}): PersonaSpec {
  const discovered = findPersona(id, options);
  if (!discovered) {
    const dirs = effectiveSearchDirs(options);
    throw new Error(
      `Persona "${id}" not found. Searched:\n  ${dirs.join('\n  ')}\n` +
        'Set searchDirs / extraDirs to include the directory containing the persona file.'
    );
  }
  return discovered.spec;
}

// ── Resolution ─────────────────────────────────────────────────────────────

/**
 * Project a {@link PersonaSpec} (the on-disk form) into a
 * {@link ResolvedPersona} (persona-kit's spawn-input form). Used as glue
 * between {@link loadPersona} and {@link buildPersonaSpawnPlan}.
 *
 * persona-kit ≥3.0.20 makes `harness` / `model` / `systemPrompt` optional
 * on {@link PersonaSpec} for handler-style (`onEvent`-driven) personas
 * that never spawn a harness directly. Relay only spawns interactive
 * personas, so the missing fields are rejected with a clear error rather
 * than letting the cast fail silently downstream.
 *
 * Relay has no routing/selection layer, so the `rationale` field is left
 * empty.
 */
export function resolvePersona(spec: PersonaSpec): ResolvedPersona {
  const { harness, model, systemPrompt } = spec;
  if (!harness) {
    throw new Error(
      `Persona "${spec.id}" has no harness — relay only spawns interactive personas. ` +
        'Handler-style (onEvent-driven) personas should be deployed via the workforce CLI.'
    );
  }
  if (!model) {
    throw new Error(`Persona "${spec.id}" has no model.`);
  }
  if (!systemPrompt) {
    throw new Error(`Persona "${spec.id}" has no systemPrompt.`);
  }
  const sidecar = resolveSidecar(spec);
  return {
    personaId: spec.id,
    harness,
    model,
    systemPrompt,
    harnessSettings: spec.harnessSettings,
    skills: spec.skills,
    rationale: '',
    ...(spec.inputs ? { inputs: spec.inputs } : {}),
    ...(spec.env ? { env: spec.env } : {}),
    ...(spec.mcpServers ? { mcpServers: spec.mcpServers } : {}),
    ...(spec.permissions ? { permissions: spec.permissions } : {}),
    ...(spec.mount ? { mount: spec.mount } : {}),
    ...sidecarSelectionFields(sidecar),
  };
}

export interface PersonaSpawnPlanOptions extends PersonaLoadOptions, PlanOptions {}

/**
 * One-shot helper: load a persona by id and build its spawn plan. The plan
 * describes everything the persona would do at spawn (skills installs,
 * mount policy, sidecar writes, harness argv, env) without executing any
 * of it. Useful for authoring tools, validators, and dry-runs.
 */
export function getPersonaSpawnPlan(
  personaId: string,
  options: PersonaSpawnPlanOptions = {}
): PersonaSpawnPlan {
  const spec = loadPersona(personaId, options);
  const resolved = resolvePersona(spec);
  const planOptions: PlanOptions = {};
  if (options.installRoot !== undefined) planOptions.installRoot = options.installRoot;
  if (options.envOverrides !== undefined) planOptions.envOverrides = options.envOverrides;
  if (options.inputValues !== undefined) planOptions.inputValues = options.inputValues;
  if (options.processEnv !== undefined) planOptions.processEnv = options.processEnv;
  if (options.includeProcessEnv !== undefined) planOptions.includeProcessEnv = options.includeProcessEnv;
  return buildPersonaSpawnPlan(resolved, planOptions);
}

// ── Codex initial-prompt composition ───────────────────────────────────────

/**
 * Codex has no system-prompt flag, so the persona's instructions ride on
 * the task. {@link buildPersonaSpawnPlan} exposes the persona's resolved
 * prompt as `plan.initialPrompt` for that case; everything else returns
 * `undefined` and the user task passes through unchanged.
 */
export function composePersonaTask(
  plan: Pick<PersonaSpawnPlan, 'initialPrompt'>,
  userTask: string | undefined
): string | undefined {
  if (!plan.initialPrompt) return userTask;
  if (!userTask) return plan.initialPrompt;
  return `${plan.initialPrompt}\n\nUser task:\n${userTask}`;
}
