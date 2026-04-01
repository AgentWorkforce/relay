import ignore, { type Ignore } from 'ignore';
import * as relayauthCore from '@relayauth/core';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export interface DotfilePermissions {
  agentName: string;
  projectDir: string;
  ignored: Ignore;
  readonly: Ignore;
  ignoredPatterns: string[];
  readonlyPatterns: string[];
}

export interface CompiledDotfiles {
  workspace: string;
  agentName: string;
  ignoredPatterns: string[];
  readonlyPatterns: string[];
  ignoredPaths: string[];
  readonlyPaths: string[];
  readwritePaths: string[];
  acl: Record<string, string[]>;
  scopes: string[];
  summary: {
    ignored: number;
    readonly: number;
    readwrite: number;
  };
}

function cleanPatterns(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

function loadPatterns(matcher: Ignore, filePath: string): string[] {
  if (!existsSync(filePath)) {
    return [];
  }

  const content = readFileSync(filePath, 'utf8');
  matcher.add(content);
  return cleanPatterns(content);
}

function parseDotfilesSource(projectDir: string, agentName: string): DotfilePermissions {
  const resolvedProjectDir = path.resolve(projectDir);
  const ignored = ignore();
  const readonly = ignore();

  const ignoredPatterns = [
    ...loadPatterns(ignored, path.join(resolvedProjectDir, '.agentignore')),
    ...loadPatterns(ignored, path.join(resolvedProjectDir, `.${agentName}.agentignore`)),
  ];
  const readonlyPatterns = [
    ...loadPatterns(readonly, path.join(resolvedProjectDir, '.agentreadonly')),
    ...loadPatterns(readonly, path.join(resolvedProjectDir, `.${agentName}.agentreadonly`)),
  ];

  return {
    agentName,
    projectDir: resolvedProjectDir,
    ignored,
    readonly,
    ignoredPatterns,
    readonlyPatterns,
  };
}

function isIgnored(relativePath: string, perms: DotfilePermissions): boolean {
  return perms.ignored.ignores(relativePath);
}

function isReadonly(relativePath: string, perms: DotfilePermissions): boolean {
  if (isIgnored(relativePath, perms)) {
    return false;
  }
  return perms.readonly.ignores(relativePath);
}

function hasDotfilesSource(projectDir: string): boolean {
  return readdirSync(projectDir).some((entry) =>
    entry === '.agentignore' ||
    entry === '.agentreadonly' ||
    /^\.[^.].*\.agentignore$/.test(entry) ||
    /^\.[^.].*\.agentreadonly$/.test(entry),
  );
}

function discoverAgentsSource(projectDir: string): string[] {
  const agents = new Set<string>();
  for (const entry of readdirSync(projectDir)) {
    const match = entry.match(/^\.(.+)\.(agentignore|agentreadonly)$/);
    if (match) {
      agents.add(match[1]);
    }
  }
  return [...agents].sort((a, b) => a.localeCompare(b));
}

function normalizeAclDir(relativeDir: string): string {
  if (relativeDir === '.' || relativeDir === '') {
    return '/';
  }
  const normalized = `/${relativeDir}`.replace(/\/+/g, '/');
  return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

function addRule(map: Map<string, Set<string>>, aclDir: string, rule: string): void {
  const existing = map.get(aclDir) ?? new Set<string>();
  existing.add(rule);
  map.set(aclDir, existing);
}

function addScope(scopes: Set<string>, action: 'read' | 'write', relativePath: string): void {
  const normalized = `/${relativePath.replace(/\\/g, '/')}`;
  scopes.add(`relayfile:fs:${action}:${normalized}`);
}

function walkProjectFiles(
  projectDir: string,
  callback: (relativePath: string, isDirectory: boolean) => void,
  currentDir = projectDir,
): void {
  const entries = readdirSync(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === '.relay' || entry.name === 'node_modules') {
      continue;
    }

    const fullPath = path.join(currentDir, entry.name);
    const relativePath = path.relative(projectDir, fullPath).replace(/\\/g, '/');
    callback(relativePath, entry.isDirectory());
    if (entry.isDirectory()) {
      walkProjectFiles(projectDir, callback, fullPath);
    }
  }
}

function compileDotfilesSource(projectDir: string, agentName: string, workspace: string): CompiledDotfiles {
  const perms = parseDotfilesSource(projectDir, agentName);
  const aclMap = new Map<string, Set<string>>();
  const scopes = new Set<string>();
  const ignoredPaths: string[] = [];
  const readonlyPaths: string[] = [];
  const readwritePaths: string[] = [];

  const dirFiles = new Map<string, { ignored: string[]; allowed: string[] }>();

  walkProjectFiles(path.resolve(projectDir), (relativePath, isDirectory) => {
    if (isDirectory) {
      return;
    }

    const dir = normalizeAclDir(path.dirname(relativePath));
    const entry = dirFiles.get(dir) ?? { ignored: [], allowed: [] };

    if (isIgnored(relativePath, perms)) {
      ignoredPaths.push(relativePath);
      entry.ignored.push(relativePath);
    } else {
      entry.allowed.push(relativePath);
      addScope(scopes, 'read', relativePath);
      if (isReadonly(relativePath, perms)) {
        readonlyPaths.push(relativePath);
      } else {
        readwritePaths.push(relativePath);
        addScope(scopes, 'write', relativePath);
      }
    }

    dirFiles.set(dir, entry);
  });

  for (const [dir, { ignored, allowed }] of dirFiles.entries()) {
    if (ignored.length > 0 && allowed.length === 0) {
      addRule(aclMap, dir, `deny:agent:${agentName}`);
    }
  }

  const acl: Record<string, string[]> = {};
  for (const [aclDir, rules] of aclMap.entries()) {
    acl[aclDir] = [...rules].sort();
  }

  return {
    workspace,
    agentName,
    ignoredPatterns: perms.ignoredPatterns,
    readonlyPatterns: perms.readonlyPatterns,
    ignoredPaths: ignoredPaths.sort(),
    readonlyPaths: readonlyPaths.sort(),
    readwritePaths: readwritePaths.sort(),
    acl,
    scopes: [...scopes].sort(),
    summary: {
      ignored: ignoredPaths.length,
      readonly: readonlyPaths.length,
      readwrite: readwritePaths.length,
    },
  };
}

type RelayauthDotfileExports = {
  parseDotfiles: typeof parseDotfilesSource;
  compileDotfiles: typeof compileDotfilesSource;
  discoverAgents: typeof discoverAgentsSource;
  hasDotfiles: typeof hasDotfilesSource;
};

const relayauthDotfiles = relayauthCore as unknown as Partial<RelayauthDotfileExports>;

export const parseDotfiles = relayauthDotfiles.parseDotfiles ?? parseDotfilesSource;
export const compileDotfiles = relayauthDotfiles.compileDotfiles ?? compileDotfilesSource;
export const discoverAgents = relayauthDotfiles.discoverAgents ?? discoverAgentsSource;
export const hasDotfiles = relayauthDotfiles.hasDotfiles ?? hasDotfilesSource;
