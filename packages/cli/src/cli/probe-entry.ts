#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { constants, accessSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
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
  const roots = [process.cwd(), resolve(moduleDirectory, '..', '..', '..', '..')];
  for (const root of roots) {
    for (const profile of ['release', 'debug']) {
      const found = executableFile(join(root, 'target', profile, executable));
      if (found) return found;
    }
  }

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

  for (const sibling of [
    join(dirname(process.argv[1] ?? ''), executable),
    join(process.env.HOME ?? '', '.agentworkforce', 'relay', 'bin', executable),
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
