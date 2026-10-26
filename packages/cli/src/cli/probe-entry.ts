#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { constants, accessSync, existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const executable = process.platform === 'win32' ? 'agent-relay-probe.exe' : 'agent-relay-probe';

function executableFile(candidate: string): string | null {
  try {
    accessSync(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return realpathSync(candidate);
  } catch {
    return null;
  }
}

function resolveProbe(): string | null {
  const override = process.env.AGENT_RELAY_PROBE_BIN;
  if (override) return executableFile(resolve(override));

  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const packageName = `@agent-relay/broker-${process.platform}-${process.arch}`;
  const references = [import.meta.url, process.argv[1], join(process.cwd(), 'package.json')].filter(
    (value): value is string => Boolean(value)
  );
  for (const reference of references) {
    try {
      const packageJson = createRequire(reference).resolve(`${packageName}/package.json`);
      const found = executableFile(join(dirname(packageJson), 'bin', executable));
      if (found) return found;
    } catch {
      // Try the next package resolution anchor.
    }
  }

  const sourceRoot = resolve(moduleDirectory, '..', '..', '..', '..');
  if (
    existsSync(join(sourceRoot, 'Cargo.toml')) &&
    existsSync(join(sourceRoot, 'crates', 'probe', 'Cargo.toml'))
  ) {
    for (const profile of ['release', 'debug']) {
      const found = executableFile(join(sourceRoot, 'target', profile, executable));
      if (found) return found;
    }
  }

  for (const sibling of [
    join(dirname(process.argv[1] ?? ''), executable),
    join(homedir(), '.agentworkforce', 'relay', 'bin', executable),
  ]) {
    const found = executableFile(sibling);
    if (found) return found;
  }
  return null;
}

const probe = resolveProbe();
if (!probe) {
  console.error(
    `Relay's native messaging component is missing for ${process.platform}-${process.arch}. Reinstall agent-relay without omitting optional dependencies.`
  );
  process.exit(1);
}

const result = spawnSync(probe, process.argv.slice(2), {
  env: process.env,
  stdio: 'inherit',
  windowsHide: true,
});
if (result.error) {
  console.error(`Could not start Relay's native messaging component: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
