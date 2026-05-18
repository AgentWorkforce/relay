import ignore, { type Ignore } from 'ignore';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentPreset } from '../workflows/types.js';

import type { AgentPermissions, CompiledAgentPermissions, CompileInput, PermissionSource } from './types.js';

type FileAction = 'read' | 'write';

interface ExpandedPreset {
  read: string[];
  write: string[];
  deny: string[];
}

interface DotfileRules {
  deny: string[];
  readonly: string[];
}

interface NormalizedFileRules {
  read: string[];
  write: string[];
  deny: string[];
}

type CompileInputWithWorkdir = CompileInput & {
  workdir?: string;
};

const SKIPPED_DIRS = new Set(['.git', '.relay', 'node_modules']);

function cleanPatterns(content: string): string[] {
  return content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

function unique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const normalized = String(value ?? '').trim();
    if (normalized === '' || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

function normalizeRelativePath(value: string): string {
  return String(value ?? '')
    .trim()
    .replace(/\\/gu, '/')
    .replace(/^\.\/+/u, '')
    .replace(/^\/+/u, '')
    .replace(/\/+/gu, '/');
}

function normalizeRelayPath(value: string): string {
  const normalized = normalizeRelativePath(value);
  return normalized === '' ? '/' : `/${normalized}`;
}

function normalizeAclDir(relativeDir: string): string {
  const normalized = normalizeRelativePath(relativeDir);
  return normalized === '' || normalized === '.' ? '/' : `/${normalized}`;
}

function readPatternFile(filePath: string): string[] {
  if (!existsSync(filePath)) {
    return [];
  }

  return cleanPatterns(readFileSync(filePath, 'utf8'));
}

function createMatcher(patterns: readonly string[]): Ignore {
  const matcher = ignore();
  if (patterns.length > 0) {
    matcher.add([...patterns]);
  }
  return matcher;
}

function loadDotfileRules(projectDir: string, agentName: string): DotfileRules {
  const resolvedProjectDir = path.resolve(projectDir);

  return {
    deny: unique([
      ...readPatternFile(path.join(resolvedProjectDir, '.agentignore')),
      ...readPatternFile(path.join(resolvedProjectDir, `.${agentName}.agentignore`)),
    ]),
    readonly: unique([
      ...readPatternFile(path.join(resolvedProjectDir, '.agentreadonly')),
      ...readPatternFile(path.join(resolvedProjectDir, `.${agentName}.agentreadonly`)),
    ]),
  };
}

function normalizeFileRules(permissions: AgentPermissions): NormalizedFileRules {
  return {
    read: unique(permissions.files?.read ?? []),
    write: unique(permissions.files?.write ?? []),
    deny: unique(permissions.files?.deny ?? []),
  };
}

function resolveScopedWorkdirPatterns(projectDir: string, workdir?: string): string[] | undefined {
  if (!workdir) {
    return undefined;
  }

  const resolvedProjectDir = path.resolve(projectDir);
  const resolvedWorkdir = path.resolve(resolvedProjectDir, workdir);
  const relativeWorkdir = normalizeRelativePath(path.relative(resolvedProjectDir, resolvedWorkdir));

  if (relativeWorkdir === '' || relativeWorkdir === '.') {
    return undefined;
  }

  if (relativeWorkdir === '..' || relativeWorkdir.startsWith('../')) {
    return [];
  }

  return unique([relativeWorkdir, `${relativeWorkdir}/**`]);
}

function matchesAny(relativePath: string, matcher: Ignore): boolean {
  return matcher.ignores(normalizeRelativePath(relativePath));
}

function walkProjectFiles(projectDir: string, currentDir = projectDir, files: string[] = []): string[] {
  const entries = readdirSync(currentDir, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name)
  );

  for (const entry of entries) {
    if (entry.isDirectory() && SKIPPED_DIRS.has(entry.name)) {
      continue;
    }

    const fullPath = path.join(currentDir, entry.name);
    const relativePath = normalizeRelativePath(path.relative(projectDir, fullPath));

    if (entry.isDirectory()) {
      walkProjectFiles(projectDir, fullPath, files);
      continue;
    }

    files.push(relativePath);
  }

  return files;
}

function buildSources(
  dotfileRules: DotfileRules,
  preset: AgentPermissions['access'],
  presetRules: ExpandedPreset,
  fileRules: NormalizedFileRules,
  rawScopes: readonly string[],
  inherited: boolean
): PermissionSource[] {
  const sources: PermissionSource[] = [];

  if (inherited && (dotfileRules.deny.length > 0 || dotfileRules.readonly.length > 0)) {
    sources.push({
      type: 'dotfile',
      label: 'dotfiles',
      ruleCount: dotfileRules.deny.length + dotfileRules.readonly.length,
    });
  }

  if (presetRules.read.length > 0 || presetRules.write.length > 0 || presetRules.deny.length > 0) {
    sources.push({
      type: 'preset',
      label: `access: ${preset ?? 'readwrite'}`,
      ruleCount: presetRules.read.length + presetRules.write.length + presetRules.deny.length,
    });
  }

  if (fileRules.read.length > 0 || fileRules.write.length > 0 || fileRules.deny.length > 0) {
    sources.push({
      type: 'yaml',
      label: 'permissions.files',
      ruleCount: fileRules.read.length + fileRules.write.length + fileRules.deny.length,
    });
  }

  if (rawScopes.length > 0) {
    sources.push({
      type: 'scope',
      label: 'permissions.scopes',
      ruleCount: rawScopes.length,
    });
  }

  return sources;
}

function buildAcl(
  agentName: string,
  readonlyPaths: readonly string[],
  readwritePaths: readonly string[],
  deniedPaths: readonly string[]
): Record<string, string[]> {
  const aclMap = new Map<string, Set<string>>();

  const addRule = (relativePath: string, rule: string): void => {
    const aclDir = normalizeAclDir(path.posix.dirname(normalizeRelativePath(relativePath)));
    const rules = aclMap.get(aclDir) ?? new Set<string>();
    rules.add(rule);
    aclMap.set(aclDir, rules);
  };

  for (const relativePath of readonlyPaths) {
    addRule(relativePath, 'read');
  }

  for (const relativePath of readwritePaths) {
    addRule(relativePath, 'read');
    addRule(relativePath, 'write');
  }

  const deniedDirs = new Map<string, { denied: number; allowed: number }>();
  for (const relativePath of deniedPaths) {
    const aclDir = normalizeAclDir(path.posix.dirname(normalizeRelativePath(relativePath)));
    const summary = deniedDirs.get(aclDir) ?? { denied: 0, allowed: 0 };
    summary.denied += 1;
    deniedDirs.set(aclDir, summary);
  }

  for (const relativePath of [...readonlyPaths, ...readwritePaths]) {
    const aclDir = normalizeAclDir(path.posix.dirname(normalizeRelativePath(relativePath)));
    const summary = deniedDirs.get(aclDir) ?? { denied: 0, allowed: 0 };
    summary.allowed += 1;
    deniedDirs.set(aclDir, summary);
  }

  for (const [aclDir, summary] of deniedDirs.entries()) {
    if (summary.denied > 0 && summary.allowed === 0) {
      const rules = aclMap.get(aclDir) ?? new Set<string>();
      rules.add(`deny:agent:${agentName}`);
      aclMap.set(aclDir, rules);
    }
  }

  return Object.fromEntries(
    [...aclMap.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([aclDir, rules]) => [aclDir, [...rules].sort()])
  );
}

function pathsToScopes(paths: readonly string[], action: FileAction): string[] {
  return unique(
    [...paths]
      .map((relativePath) => normalizeRelativePath(relativePath))
      .filter((relativePath) => relativePath !== '')
      .sort((left, right) => left.localeCompare(right))
      .map((relativePath) => `relayfile:fs:${action}:${normalizeRelayPath(relativePath)}`)
  );
}

function buildReadonlyPatterns(
  presetRules: ExpandedPreset,
  dotfileRules: DotfileRules,
  fileRules: NormalizedFileRules
): string[] {
  const presetReadonly = presetRules.write.length === 0 ? presetRules.read : [];
  const yamlReadonly = fileRules.read.filter((pattern) => !fileRules.write.includes(pattern));

  return unique([...dotfileRules.readonly, ...presetReadonly, ...yamlReadonly]);
}

function buildReadwritePatterns(presetRules: ExpandedPreset, fileRules: NormalizedFileRules): string[] {
  return unique([...presetRules.write, ...fileRules.write]);
}

function buildDeniedPatterns(dotfileRules: DotfileRules, fileRules: NormalizedFileRules): string[] {
  return unique([...dotfileRules.deny, ...fileRules.deny]);
}

export function defaultPermissionsForPreset(preset: AgentPreset | undefined): AgentPermissions {
  switch (preset) {
    case 'lead':
      return { access: 'full' };
    case 'reviewer':
    case 'analyst':
      return { access: 'readonly' };
    case 'worker':
      return { access: 'readwrite' };
    default:
      return {};
  }
}

export function expandPreset(
  preset: AgentPermissions['access'],
  options?: { projectDir?: string; workdir?: string }
): ExpandedPreset {
  const scopedWorkdirPatterns =
    preset === 'readwrite' && options?.projectDir
      ? resolveScopedWorkdirPatterns(options.projectDir, options.workdir)
      : undefined;

  switch (preset ?? 'readwrite') {
    case 'readonly':
      return { read: ['**'], write: [], deny: [] };
    case 'restricted':
      return { read: [], write: [], deny: [] };
    case 'full':
      return { read: ['**'], write: ['**'], deny: [] };
    case 'readwrite':
    default:
      return {
        read: scopedWorkdirPatterns ?? ['**'],
        write: scopedWorkdirPatterns ?? ['**'],
        deny: [],
      };
  }
}

export function globsToScopes(globs: string[], action: FileAction): string[] {
  return unique(
    globs
      .map((glob) => normalizeRelativePath(glob))
      .filter((glob) => glob !== '')
      .map((glob) => `relayfile:fs:${action}:${normalizeRelayPath(glob)}`)
  );
}

export function compileAgentPermissions(input: CompileInput): CompiledAgentPermissions {
  const permissions = input.permissions ?? {};
  const effectiveAccess = permissions.access ?? 'readwrite';
  const inherited = effectiveAccess !== 'full' && permissions.inherit !== false;
  const projectDir = path.resolve(input.projectDir);
  const scopedInput = input as CompileInputWithWorkdir;

  const dotfileRules = inherited ? loadDotfileRules(projectDir, input.agentName) : { deny: [], readonly: [] };
  const presetRules = expandPreset(effectiveAccess, {
    projectDir,
    workdir: scopedInput.workdir,
  });
  const fileRules = normalizeFileRules(permissions);
  const rawScopes = unique(permissions.scopes ?? []);

  const dotDenyMatcher = createMatcher(dotfileRules.deny);
  const dotReadonlyMatcher = createMatcher(dotfileRules.readonly);
  const presetReadMatcher = createMatcher(presetRules.read);
  const presetWriteMatcher = createMatcher(presetRules.write);
  const fileReadMatcher = createMatcher(fileRules.read);
  const fileWriteMatcher = createMatcher(fileRules.write);
  const fileDenyMatcher = createMatcher(fileRules.deny);

  const readonlyPaths: string[] = [];
  const readwritePaths: string[] = [];
  const deniedPaths: string[] = [];

  for (const relativePath of walkProjectFiles(projectDir)) {
    const dotDenied = inherited && matchesAny(relativePath, dotDenyMatcher);
    const dotReadonly = inherited && !dotDenied && matchesAny(relativePath, dotReadonlyMatcher);
    const yamlRead = matchesAny(relativePath, fileReadMatcher);
    const yamlWrite = matchesAny(relativePath, fileWriteMatcher);
    const yamlDeny = matchesAny(relativePath, fileDenyMatcher);
    const explicitYamlGrant = yamlRead || yamlWrite;

    if (yamlDeny) {
      deniedPaths.push(relativePath);
      continue;
    }

    if (dotDenied && !explicitYamlGrant) {
      deniedPaths.push(relativePath);
      continue;
    }

    const presetRead = matchesAny(relativePath, presetReadMatcher);
    const presetWrite = matchesAny(relativePath, presetWriteMatcher);

    const canRead = explicitYamlGrant || presetRead || presetWrite;
    let canWrite = yamlWrite || presetWrite;

    if (dotReadonly && !yamlWrite) {
      canWrite = false;
    }

    if (canWrite) {
      readwritePaths.push(relativePath);
      continue;
    }

    if (canRead) {
      readonlyPaths.push(relativePath);
      continue;
    }

    deniedPaths.push(relativePath);
  }

  readonlyPaths.sort((left, right) => left.localeCompare(right));
  readwritePaths.sort((left, right) => left.localeCompare(right));
  deniedPaths.sort((left, right) => left.localeCompare(right));

  const readonlyPatterns = buildReadonlyPatterns(presetRules, dotfileRules, fileRules);
  const readwritePatterns = buildReadwritePatterns(presetRules, fileRules);
  const deniedPatterns = buildDeniedPatterns(dotfileRules, fileRules);

  const scopes = mergePermissionSources(
    [
      ...pathsToScopes([...readonlyPaths, ...readwritePaths], 'read'),
      ...pathsToScopes(readwritePaths, 'write'),
    ],
    [],
    rawScopes
  );

  return {
    agentName: input.agentName,
    workspace: input.workspace,
    effectiveAccess,
    inherited,
    sources: buildSources(dotfileRules, effectiveAccess, presetRules, fileRules, rawScopes, inherited),
    readonlyPatterns,
    readwritePatterns,
    deniedPatterns,
    readonlyPaths,
    readwritePaths,
    deniedPaths,
    scopes,
    network: permissions.network,
    exec: permissions.exec ? [...permissions.exec] : undefined,
    acl: buildAcl(input.agentName, readonlyPaths, readwritePaths, deniedPaths),
    summary: {
      readonly: readonlyPaths.length,
      readwrite: readwritePaths.length,
      denied: deniedPaths.length,
      customScopes: rawScopes.length,
    },
  };
}

export function mergeAcl(compilations: readonly CompiledAgentPermissions[]): Record<string, string[]> {
  const merged = new Map<string, Set<string>>();

  for (const compilation of compilations) {
    for (const [directory, rules] of Object.entries(compilation.acl)) {
      const bucket = merged.get(directory) ?? new Set<string>();
      for (const rule of rules) {
        bucket.add(rule);
      }
      merged.set(directory, bucket);
    }
  }

  return Object.fromEntries(
    [...merged.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([directory, rules]) => [directory, [...rules].sort()])
  );
}

export function resolveAgentPermissions(
  agentName: string,
  permissions: AgentPermissions | undefined,
  projectDir: string,
  workspace: string
): CompiledAgentPermissions {
  return compileAgentPermissions({
    agentName,
    workspace,
    projectDir,
    permissions: permissions ?? {},
  });
}

export function compileAgentScopes(input: CompileInput): CompiledAgentPermissions {
  return compileAgentPermissions(input);
}

export function mergePermissionSources(
  dotfileScopes: string[],
  yamlScopes: string[],
  rawScopes: string[]
): string[] {
  return unique([...dotfileScopes, ...yamlScopes, ...rawScopes]);
}

export const expandAccessPreset = expandPreset;
export const globToScopes = (globs: string[], action: FileAction, _projectDir?: string): string[] =>
  globsToScopes(globs, action);
