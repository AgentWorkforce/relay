import path from 'node:path';

import type { CoreDependencies } from '../commands/core.js';

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runUpdateCommand(
  options: { check?: boolean },
  deps: CoreDependencies
): Promise<void> {
  const currentVersion = deps.getVersion();
  deps.log(`Current version: ${currentVersion}`);
  deps.log('Checking for updates...');

  const info = await deps.checkForUpdates(currentVersion);
  if (info.error) {
    deps.error(`Failed to check for updates: ${info.error}`);
    deps.exit(1);
    return;
  }

  if (!info.updateAvailable) {
    deps.log('You are running the latest version.');
    return;
  }

  deps.log(`New version available: ${info.latestVersion ?? 'latest'}`);

  if (options.check) {
    deps.log('Run `agent-relay update` to install.');
    return;
  }

  deps.log('Installing update...');
  try {
    const { stdout, stderr } = await deps.execCommand('npm install -g agent-relay@latest');
    if (stdout.trim().length > 0) {
      deps.log(stdout.trimEnd());
    }
    if (stderr.trim().length > 0) {
      deps.error(stderr.trimEnd());
    }
    deps.log(`Successfully updated to ${info.latestVersion ?? 'latest'}`);
  } catch (err: unknown) {
    deps.error(`Failed to install update: ${toErrorMessage(err)}`);
    deps.log('Try running manually: npm install -g agent-relay@latest');
    deps.exit(1);
  }
}

export async function runUninstallCommand(
  options: {
    keepData?: boolean;
    zed?: boolean;
    zedName?: string;
    snippets?: boolean;
    force?: boolean;
    dryRun?: boolean;
  },
  deps: CoreDependencies
): Promise<void> {
  const paths = deps.getProjectPaths();
  const brokerPidPath = path.join(paths.dataDir, 'broker.pid');
  const runtimePath = path.join(paths.dataDir, 'runtime.json');
  const relaySockPath = path.join(paths.dataDir, 'relay.sock');

  if (deps.fs.existsSync(brokerPidPath)) {
    const pidRaw = deps.fs.readFileSync(brokerPidPath, 'utf-8').trim();
    const pid = Number.parseInt(pidRaw, 10);
    if (!Number.isNaN(pid) && pid > 0) {
      try {
        deps.killProcess(pid, 'SIGTERM');
      } catch {
        // Ignore dead processes.
      }
    }
  }

  if (options.dryRun) {
    if (options.keepData) {
      deps.log(`[dry-run] Would remove: ${brokerPidPath}`);
      deps.log(`[dry-run] Would remove: ${runtimePath}`);
      deps.log(`[dry-run] Would remove: ${relaySockPath}`);
    } else {
      deps.log(`[dry-run] Would remove directory: ${paths.dataDir}`);
    }
    deps.log('[dry-run] Uninstall complete.');
    return;
  }

  if (options.keepData) {
    for (const filePath of [brokerPidPath, runtimePath, relaySockPath]) {
      if (!deps.fs.existsSync(filePath)) {
        continue;
      }
      try {
        deps.fs.unlinkSync(filePath);
      } catch {
        // Best-effort cleanup.
      }
    }

    try {
      for (const file of deps.fs.readdirSync(paths.dataDir)) {
        if (file.startsWith('mcp-identity-')) {
          deps.fs.unlinkSync(path.join(paths.dataDir, file));
        }
      }
    } catch {
      // Ignore read failures.
    }

    deps.log('Removed runtime files (kept data).');
  } else if (deps.fs.existsSync(paths.dataDir)) {
    deps.fs.rmSync(paths.dataDir, { recursive: true, force: true });
    deps.log(`Removed ${paths.dataDir}`);
  }

  if (options.zed) {
    deps.log(`Zed cleanup requested${options.zedName ? ` (${options.zedName})` : ''}.`);
  }
  if (options.snippets) {
    deps.log('Snippet cleanup requested.');
  }

  deps.log('Uninstall complete.');
}
