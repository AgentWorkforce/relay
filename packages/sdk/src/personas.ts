/**
 * Persona loading and translation.
 *
 * A persona is a JSON file that describes a pre-configured agent: which
 * harness (CLI) to use, which model, what system prompt to inject, plus
 * optional MCP servers and permission flags. Personas live in
 * `<cwd>/agentworkforce/personas`, the AgentWorkforce home directory, or
 * any directory the caller passes explicitly.
 *
 * Translation from a resolved persona to `{bin, args}` delegates to
 * `@agentworkforce/harness-kit#buildInteractiveSpec`, so relay always
 * produces the same launch args the AgentWorkforce CLI does.
 *
 * The schema mirrors the AgentWorkforce persona format
 * (see https://github.com/AgentWorkforce/workforce). Skills installation,
 * mount policy, sidecar markdown, input rendering, and routing profiles
 * are deliberately not handled here — callers needing those should use
 * the `agentworkforce` CLI directly.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';

import {
  buildInteractiveSpec,
  type BuildInteractiveSpecInput,
  type InteractiveConfigFile,
  type InteractiveSpec,
} from '@agentworkforce/harness-kit';
import {
  HARNESS_VALUES,
  PERSONA_TIERS,
  type Harness,
  type McpServerSpec,
  type PersonaPermissions,
  type PersonaTier,
} from '@agentworkforce/workload-router';

// ── Re-exports for callers ─────────────────────────────────────────────────

export type { Harness, McpServerSpec, PersonaPermissions, PersonaTier };
export { HARNESS_VALUES, PERSONA_TIERS };

// ── On-disk persona schema (permissive, like workforce's LocalPersonaOverride) ──

export interface PersonaTierSpec {
  harness?: Harness;
  model?: string;
  systemPrompt?: string;
  /** Free-form harness settings (reasoning level, timeout) — not consumed by spawnPty today. */
  harnessSettings?: Record<string, unknown>;
}

/** Raw persona file shape. */
export interface PersonaFile {
  id: string;
  intent?: string;
  description?: string;
  tags?: string[];
  /** Used for every tier when set without `tiers`. Ignored when `tiers` is set. */
  systemPrompt?: string;
  /** Top-level harness/model — used when there are no tiers. */
  harness?: Harness;
  model?: string;
  permissions?: PersonaPermissions;
  mcpServers?: Record<string, McpServerSpec>;
  /** Per-tier overrides. A tier set here takes precedence over the top-level fields. */
  tiers?: Partial<Record<PersonaTier, PersonaTierSpec>>;
  /** Inherits from another persona id (looked up in the same search dirs). One level deep. */
  extends?: string;
}

/** A persona file located on disk. */
export interface DiscoveredPersona {
  id: string;
  path: string;
  spec: PersonaFile;
}

/** A persona resolved against a tier — ready for {@link buildPersonaSpawnSpec}. */
export interface ResolvedPersona {
  id: string;
  /** Absolute path to the JSON file the spec came from. */
  source: string;
  tier: PersonaTier;
  harness: Harness;
  model: string;
  systemPrompt: string;
  description?: string;
  permissions?: PersonaPermissions;
  mcpServers?: Record<string, McpServerSpec>;
}

export interface PersonaLoadOptions {
  cwd?: string;
  /** Override the default search-dir cascade. */
  searchDirs?: string[];
  /** Extra dirs appended after the default cascade. */
  extraDirs?: string[];
  /** Tier to resolve. Defaults to 'best'. */
  tier?: PersonaTier;
}

/**
 * The shape `AgentRelay.spawnPersona` needs to drive `spawnPty`. Built by
 * {@link buildPersonaSpawnSpec} from a {@link ResolvedPersona}.
 */
export interface PersonaSpawnSpec {
  /** CLI to launch (matches relay's AgentCli union: 'claude' | 'codex' | 'opencode'). */
  cli: string;
  model: string;
  args: string[];
  /**
   * If non-null, append this as the final positional arg to the CLI invocation.
   * Codex uses this to carry the system prompt; claude / opencode return null.
   */
  initialPrompt: string | null;
  /**
   * Files the caller must materialize (relative to spawn cwd) before launching
   * the agent. Used by opencode to drop an `opencode.json` carrying the
   * persona's agent definition. Empty for claude / codex.
   */
  configFiles: InteractiveConfigFile[];
  /** Non-fatal warnings from the harness-kit translation step. */
  warnings: string[];
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
      try {
        if (!statSync(path).isFile()) continue;
      } catch {
        continue;
      }
      let spec: PersonaFile;
      try {
        spec = parsePersonaFile(JSON.parse(readFileSync(path, 'utf8')), path);
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
export function findPersona(
  id: string,
  options: PersonaLoadOptions = {},
): DiscoveredPersona | undefined {
  const dirs = effectiveSearchDirs(options);
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const candidate = join(dir, `${id}.json`);
    if (existsSync(candidate)) {
      try {
        const spec = parsePersonaFile(JSON.parse(readFileSync(candidate, 'utf8')), candidate);
        if (spec.id === id) return { id, path: candidate, spec };
      } catch {
        // fall through to scan dir for files with mismatched filenames
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
        const spec = parsePersonaFile(JSON.parse(readFileSync(path, 'utf8')), path);
        if (spec.id === id) return { id, path, spec };
      } catch {
        continue;
      }
    }
  }
  return undefined;
}

// ── Resolution ─────────────────────────────────────────────────────────────

/**
 * Load and resolve a persona by id. Searches the cascade, applies the
 * chosen tier, and resolves a single level of `extends` against the same
 * cascade. Throws if the persona is missing required fields for the tier.
 */
export function loadPersona(id: string, options: PersonaLoadOptions = {}): ResolvedPersona {
  const discovered = findPersona(id, options);
  if (!discovered) {
    const dirs = effectiveSearchDirs(options);
    throw new Error(
      `Persona "${id}" not found. Searched:\n  ${dirs.join('\n  ')}\n` +
        'Set searchDirs / extraDirs to include the directory containing the persona file.',
    );
  }

  const tier: PersonaTier = options.tier ?? 'best';
  let spec = discovered.spec;

  if (spec.extends) {
    const base = findPersona(spec.extends, options);
    if (!base) {
      throw new Error(
        `Persona "${id}" extends "${spec.extends}" but the base could not be found in the search cascade.`,
      );
    }
    spec = mergeSpecs(base.spec, spec);
  }

  const tierSpec = spec.tiers?.[tier];
  const harness = (tierSpec?.harness ?? spec.harness) as Harness | undefined;
  const model = tierSpec?.model ?? spec.model;
  const systemPrompt = tierSpec?.systemPrompt ?? spec.systemPrompt;

  if (!harness) {
    throw new Error(
      `Persona "${id}" tier "${tier}" has no harness; set tiers.${tier}.harness or top-level harness.`,
    );
  }
  if (!HARNESS_VALUES.includes(harness)) {
    throw new Error(
      `Persona "${id}" tier "${tier}" uses unsupported harness "${String(harness)}". ` +
        `Supported: ${HARNESS_VALUES.join(', ')}.`,
    );
  }
  if (!model) {
    throw new Error(
      `Persona "${id}" tier "${tier}" has no model; set tiers.${tier}.model or top-level model.`,
    );
  }
  if (!systemPrompt) {
    throw new Error(
      `Persona "${id}" tier "${tier}" has no systemPrompt; set tiers.${tier}.systemPrompt or top-level systemPrompt.`,
    );
  }

  return {
    id: spec.id,
    source: discovered.path,
    tier,
    harness,
    model,
    systemPrompt,
    description: spec.description,
    permissions: spec.permissions,
    mcpServers: spec.mcpServers,
  };
}

// ── Merge (extends) ────────────────────────────────────────────────────────

function mergeSpecs(base: PersonaFile, override: PersonaFile): PersonaFile {
  const tiers: PersonaFile['tiers'] = {};
  for (const tier of PERSONA_TIERS) {
    const baseTier = base.tiers?.[tier];
    const overrideTier = override.tiers?.[tier];
    if (overrideTier || baseTier) {
      tiers[tier] = { ...(baseTier ?? {}), ...(overrideTier ?? {}) };
    }
  }

  return {
    id: override.id,
    intent: override.intent ?? base.intent,
    description: override.description ?? base.description,
    tags: override.tags ?? base.tags,
    systemPrompt: override.systemPrompt ?? base.systemPrompt,
    harness: override.harness ?? base.harness,
    model: override.model ?? base.model,
    permissions: mergePermissions(base.permissions, override.permissions),
    mcpServers: { ...(base.mcpServers ?? {}), ...(override.mcpServers ?? {}) },
    tiers: Object.keys(tiers).length > 0 ? tiers : undefined,
  };
}

function mergePermissions(
  base: PersonaPermissions | undefined,
  override: PersonaPermissions | undefined,
): PersonaPermissions | undefined {
  if (!base && !override) return undefined;
  const allow = dedupe([...(base?.allow ?? []), ...(override?.allow ?? [])]);
  const deny = dedupe([...(base?.deny ?? []), ...(override?.deny ?? [])]);
  return {
    ...(allow.length > 0 ? { allow } : {}),
    ...(deny.length > 0 ? { deny } : {}),
    ...(override?.mode ?? base?.mode ? { mode: override?.mode ?? base?.mode } : {}),
  };
}

// ── Validation ─────────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePersonaFile(value: unknown, source: string): PersonaFile {
  if (!isPlainObject(value)) {
    throw new Error(`${source}: persona must be a JSON object`);
  }
  if (typeof value.id !== 'string' || !value.id.trim()) {
    throw new Error(`${source}: persona.id must be a non-empty string`);
  }
  return value as unknown as PersonaFile;
}

// ── Translation: persona → spawn args ──────────────────────────────────────

/**
 * Translate a resolved persona into the bin/args spawnPty needs. Delegates
 * to {@link buildInteractiveSpec} from `@agentworkforce/harness-kit` so
 * relay produces the same launch shape the AgentWorkforce CLI does.
 */
export function buildPersonaSpawnSpec(persona: ResolvedPersona): PersonaSpawnSpec {
  const input: BuildInteractiveSpecInput = {
    harness: persona.harness,
    personaId: persona.id,
    model: persona.model,
    systemPrompt: persona.systemPrompt,
    ...(persona.mcpServers ? { mcpServers: persona.mcpServers } : {}),
    ...(persona.permissions ? { permissions: persona.permissions } : {}),
  };
  const spec: InteractiveSpec = buildInteractiveSpec(input);
  return {
    cli: spec.bin,
    model: persona.model,
    args: [...spec.args],
    initialPrompt: spec.initialPrompt,
    configFiles: [...spec.configFiles],
    warnings: [...spec.warnings],
  };
}

/**
 * Codex has no system-prompt flag, so the persona's instructions must ride
 * on the task. Combines them in the same shape the agentworkforce
 * harness-kit uses for non-interactive codex runs.
 */
export function composePersonaTask(
  spec: Pick<PersonaSpawnSpec, 'initialPrompt'>,
  userTask: string | undefined,
): string | undefined {
  if (!spec.initialPrompt) return userTask;
  if (!userTask) return spec.initialPrompt;
  return `${spec.initialPrompt}\n\nUser task:\n${userTask}`;
}

// ── Config-file materialization helpers ────────────────────────────────────

/** Tracks a file we wrote, so the caller can restore the prior contents. */
export interface MaterializedConfigFile {
  /** Absolute path that was written. */
  path: string;
  /** Whether a file existed at this path before we wrote. */
  existed: boolean;
  /** Prior contents (only set when existed is true). */
  previous?: string;
}

/**
 * Write each persona config file into `cwd`. Refuses absolute paths or
 * paths that escape `cwd`. Returns handles the caller can pass to
 * {@link restorePersonaConfigFiles}.
 */
export function materializePersonaConfigFiles(
  cwd: string,
  files: readonly InteractiveConfigFile[],
): MaterializedConfigFile[] {
  const out: MaterializedConfigFile[] = [];
  const cwdAbs = resolvePath(cwd);
  for (const file of files) {
    if (!file.path) throw new Error('persona config file path must be non-empty');
    if (isAbsolute(file.path)) {
      throw new Error(`persona config file path must be relative: ${file.path}`);
    }
    const target = resolvePath(cwd, file.path);
    if (target !== cwdAbs && !target.startsWith(cwdAbs + '/')) {
      throw new Error(`persona config file path escapes cwd: ${file.path}`);
    }
    const existed = existsSync(target);
    const previous = existed ? readFileSync(target, 'utf8') : undefined;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.contents, 'utf8');
    out.push({ path: target, existed, previous });
  }
  return out;
}

/**
 * Restore the original state of files written by
 * {@link materializePersonaConfigFiles}. Files that did not exist before
 * are removed; files that did exist are written back to their prior
 * contents. Errors are swallowed — restore is best-effort cleanup.
 */
export function restorePersonaConfigFiles(writes: readonly MaterializedConfigFile[]): void {
  for (const write of [...writes].reverse()) {
    try {
      if (write.existed) {
        writeFileSync(write.path, write.previous ?? '', 'utf8');
      } else {
        rmSync(write.path, { force: true });
      }
    } catch {
      // best-effort
    }
  }
}
