import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

interface CheckPrereqConfig {
  relayauthRoot?: string;
  relayfileRoot?: string;
}

interface CheckPrereqsResult {
  ok: boolean;
  missing: string[];
}

interface CachedConfig {
  relayauthRoot?: string;
  relayfileRoot?: string;
}

const REQUIRED_TOOLS: Array<{ command: string; args: string[]; label: string }> = [
  { command: 'node', args: ['--version'], label: 'node' },
  { command: 'npx', args: ['--version'], label: 'npx' },
  { command: 'go', args: ['version'], label: 'go' },
];

function isPathConfig(value: unknown): value is CheckPrereqConfig {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.relayauthRoot === 'string' ||
    typeof candidate.relayfileRoot === 'string'
  );
}

function readCachedConfig(): CachedConfig {
  const configPath = path.resolve('.relay', 'config.json');
  if (!existsSync(configPath)) {
    return {};
  }

  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const data =
      parsed && typeof parsed === 'object' && 'data' in parsed && typeof parsed.data === 'object'
        ? (parsed.data as Record<string, unknown>)
        : parsed;

    return {
      relayauthRoot:
        typeof data.RELAYAUTH_ROOT === 'string'
          ? data.RELAYAUTH_ROOT
          : typeof data.relayauthRoot === 'string'
            ? data.relayauthRoot
            : undefined,
      relayfileRoot:
        typeof data.RELAYFILE_ROOT === 'string'
          ? data.RELAYFILE_ROOT
          : typeof data.relayfileRoot === 'string'
            ? data.relayfileRoot
            : undefined,
    };
  } catch {
    return {};
  }
}

export function resolvePrereqPaths(config: CheckPrereqConfig = {}): {
  relayauthRoot: string;
  relayfileRoot: string;
} {
  const cache = readCachedConfig();
  const cwd = process.cwd();

  const relayauthCandidates = [
    config.relayauthRoot,
    process.env.RELAYAUTH_ROOT,
    cache.relayauthRoot,
    path.join(cwd, 'relayauth'),
    path.join(cwd, '..', 'relayauth'),
    path.join(cwd, '..', '..', 'relayauth'),
  ].filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0);

  const relayauthRoot = path.resolve(
    relayauthCandidates.find((candidate) => existsSync(candidate)) ?? relayauthCandidates[0] ?? path.join(cwd, 'relayauth')
  );

  return {
    relayauthRoot,
    relayfileRoot: path.resolve(
      config.relayfileRoot ??
        process.env.RELAYFILE_ROOT ??
        cache.relayfileRoot ??
        path.join(path.dirname(relayauthRoot), 'relayfile')
    ),
  };
}

function commandAvailable(command: string, args: string[]): boolean {
  const result = spawnSync(command, args, {
    stdio: 'ignore',
  });
  return result.status === 0;
}

function maybeCreateDirectory(target: string): void {
  mkdirSync(target, { recursive: true });
}

export async function checkPrereqs(
  _deps: unknown = {},
  options?: CheckPrereqConfig
): Promise<CheckPrereqsResult> {
  const config = isPathConfig(_deps) ? _deps : isPathConfig(options) ? options : {};
  const { relayauthRoot, relayfileRoot } = resolvePrereqPaths(config);
  const missing: string[] = [];

  for (const tool of REQUIRED_TOOLS) {
    if (!commandAvailable(tool.command, tool.args)) {
      missing.push(tool.label);
    }
  }

  if (!commandAvailable('npx', ['wrangler', '--version'])) {
    missing.push('wrangler');
  }

  const relayfileBinary = path.join(relayfileRoot, 'bin', 'relayfile');
  if (!existsSync(relayfileBinary)) {
    missing.push('relayfile binary');
  }

  const d1StatePath = path.join(relayauthRoot, '.wrangler', 'state', 'v3', 'd1');
  if (!existsSync(d1StatePath)) {
    missing.push('D1 database');
  }

  const distPath = path.join(relayauthRoot, 'packages', 'sdk', 'dist', 'index.js');
  if (!existsSync(distPath)) {
    missing.push('relayauth SDK build (run `npx turbo build` in relayauth root)');
  }

  return {
    ok: missing.length === 0,
    missing,
  };
}
