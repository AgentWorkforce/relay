import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import { track } from '@agent-relay/telemetry';

import {
  ensureAuthenticated,
  authorizedApiFetch,
  readStoredAuth,
  clearStoredAuth,
  defaultApiUrl,
  AUTH_FILE_PATH,
  REFRESH_WINDOW_MS,
  runWorkflow,
  getRunStatus,
  getRunLogs,
  syncWorkflowPatch,
  cancelWorkflow,
  connectProvider,
  getProviderHelpText,
  normalizeProvider,
  type WhoAmIResponse,
  type WorkflowFileType,
} from '@agent-relay/cloud';

import { defaultExit } from '../lib/exit.js';
import { errorClassName } from '../lib/telemetry-helpers.js';

// ── Types ────────────────────────────────────────────────────────────────────

type ExitFn = (code: number) => never;

export interface CloudDependencies {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: ExitFn;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function withDefaults(overrides: Partial<CloudDependencies> = {}): CloudDependencies {
  return {
    log: (...args: unknown[]) => console.log(...args),
    error: (...args: unknown[]) => console.error(...args),
    exit: defaultExit,
    ...overrides,
  };
}

function parsePositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError('Expected a positive integer.');
  }
  return parsed;
}

function parseNonNegativeInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new InvalidArgumentError('Expected a non-negative integer.');
  }
  return parsed;
}

function parseWorkflowFileType(value: string): WorkflowFileType {
  if (value === 'yaml' || value === 'ts' || value === 'py') {
    return value;
  }
  throw new InvalidArgumentError('Expected workflow type to be one of: yaml, ts, py');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function renderPatchPushResults(patches: unknown, log: (...args: unknown[]) => void): void {
  if (!isObject(patches)) {
    return;
  }

  const entries = Object.entries(patches);
  if (entries.length === 0) {
    return;
  }

  log('Patches:');
  for (const [name, rawEntry] of entries) {
    if (!isObject(rawEntry)) {
      log(`  ${name}: patch pending - run still active`);
      continue;
    }

    const pushedTo = rawEntry.pushedTo;
    if (isObject(pushedTo) && typeof pushedTo.prUrl === 'string') {
      const branch = typeof pushedTo.branch === 'string' ? ` (${pushedTo.branch})` : '';
      log(`  ${name}: ${pushedTo.prUrl}${branch}`);
      continue;
    }

    const pushError = rawEntry.pushError;
    if (isObject(pushError)) {
      const code = typeof pushError.code === 'string' ? pushError.code : 'unknown';
      const message = typeof pushError.message === 'string' ? pushError.message : 'push failed';
      log(`  ${name}: push failed: ${code}: ${message}`);
      continue;
    }

    log(`  ${name}: patch pending - run still active`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Command registration ─────────────────────────────────────────────────────

export function registerCloudCommands(program: Command, overrides: Partial<CloudDependencies> = {}): void {
  const deps = withDefaults(overrides);

  const cloudCommand = program
    .command('cloud')
    .description('Cloud account, provider auth, and workflow commands');

  // ── login ──────────────────────────────────────────────────────────────────

  cloudCommand
    .command('login')
    .description('Authenticate with Agent Relay Cloud via browser')
    .option('--api-url <url>', 'Cloud API base URL')
    .option('--force', 'Force re-authentication even if already logged in')
    .action(async (options: { apiUrl?: string; force?: boolean }) => {
      const started = Date.now();
      let success = false;
      let errorClass: string | undefined;
      try {
        const apiUrl = options.apiUrl || defaultApiUrl();

        if (!options.force) {
          const existing = await readStoredAuth();
          if (existing && existing.apiUrl === apiUrl) {
            const expiresAt = Date.parse(existing.accessTokenExpiresAt);
            if (!Number.isNaN(expiresAt) && expiresAt - Date.now() > REFRESH_WINDOW_MS) {
              deps.log(`Already logged in to ${existing.apiUrl}`);
              success = true;
              return;
            }
          }
        }

        await ensureAuthenticated(apiUrl, { force: options.force });
        success = true;
      } catch (err) {
        errorClass = errorClassName(err);
        throw err;
      } finally {
        track('cloud_auth', {
          action: 'login',
          success,
          duration_ms: Date.now() - started,
          ...(errorClass ? { error_class: errorClass } : {}),
        });
      }
    });

  // ── logout ─────────────────────────────────────────────────────────────────

  cloudCommand
    .command('logout')
    .description('Clear stored cloud credentials')
    .action(async () => {
      const started = Date.now();
      let success = false;
      let errorClass: string | undefined;
      try {
        const auth = await readStoredAuth();
        if (!auth) {
          deps.log('Not logged in.');
          success = true;
          return;
        }

        try {
          const revokeUrl = new URL(
            'api/v1/auth/token/revoke',
            auth.apiUrl.endsWith('/') ? auth.apiUrl : `${auth.apiUrl}/`
          );
          await fetch(revokeUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ token: auth.refreshToken }),
          });
        } catch {
          // best-effort revoke
        }

        await clearStoredAuth();
        deps.log('Logged out.');
        success = true;
      } catch (err) {
        errorClass = errorClassName(err);
        throw err;
      } finally {
        track('cloud_auth', {
          action: 'logout',
          success,
          duration_ms: Date.now() - started,
          ...(errorClass ? { error_class: errorClass } : {}),
        });
      }
    });

  // ── whoami ─────────────────────────────────────────────────────────────────

  cloudCommand
    .command('whoami')
    .description('Show current authentication status')
    .option('--api-url <url>', 'Cloud API base URL')
    .action(async (options: { apiUrl?: string }) => {
      const started = Date.now();
      let success = false;
      let errorClass: string | undefined;
      try {
        const apiUrl = options.apiUrl || defaultApiUrl();
        const auth = await ensureAuthenticated(apiUrl);
        const { response } = await authorizedApiFetch(auth, '/api/v1/auth/whoami', {
          method: 'GET',
        });

        const payload = (await response.json().catch(() => null)) as
          | (WhoAmIResponse & { error?: string })
          | null;

        if (!response.ok || !payload?.authenticated) {
          throw new Error(payload?.error || 'Failed to resolve auth status');
        }

        deps.log(`API URL: ${auth.apiUrl}`);
        deps.log(`Auth source: ${payload.source}`);
        deps.log(`Subject type: ${payload.subjectType ?? 'session'}`);
        deps.log(
          `User: ${payload.user.name || '(no name)'}${payload.user.email ? ` <${payload.user.email}>` : ''}`
        );
        deps.log(`Organization: ${payload.currentOrganization.name}`);
        deps.log(`Workspace: ${payload.currentWorkspace.name}`);
        deps.log(`Scopes: ${payload.scopes.length > 0 ? payload.scopes.join(', ') : '(none)'}`);
        deps.log(`Token file: ${AUTH_FILE_PATH}`);
        success = true;
      } catch (err) {
        errorClass = errorClassName(err);
        throw err;
      } finally {
        track('cloud_auth', {
          action: 'whoami',
          success,
          duration_ms: Date.now() - started,
          ...(errorClass ? { error_class: errorClass } : {}),
        });
      }
    });

  // ── connect ────────────────────────────────────────────────────────────────

  cloudCommand
    .command('connect')
    .description('Connect a provider via interactive SSH session')
    .argument('<provider>', `Provider to connect (${getProviderHelpText()})`)
    .option('--api-url <url>', 'Cloud API base URL')
    .option('--language <language>', 'Sandbox language/image', 'typescript')
    .option('--timeout <seconds>', 'Connection timeout in seconds', parsePositiveInteger, 300)
    .action(async (providerArg: string, options: { apiUrl?: string; language: string; timeout: number }) => {
      const started = Date.now();
      let success = false;
      let errorClass: string | undefined;
      const trackedProvider = normalizeProvider(providerArg);
      try {
        const result = await connectProvider({
          provider: providerArg,
          apiUrl: options.apiUrl,
          language: options.language,
          timeoutMs: options.timeout * 1000,
          io: { log: deps.log, error: deps.error },
        });
        success = result.success;
      } catch (err) {
        errorClass = errorClassName(err);
        throw err;
      } finally {
        track('cloud_auth', {
          action: 'connect',
          success,
          duration_ms: Date.now() - started,
          provider: trackedProvider,
          ...(errorClass ? { error_class: errorClass } : {}),
        });
      }
    });

  // ── run ────────────────────────────────────────────────────────────────────

  cloudCommand
    .command('run')
    .description('Submit a workflow run')
    .argument('<workflow>', 'Workflow file path or inline workflow content')
    .option('--api-url <url>', 'Cloud API base URL')
    .option('--file-type <type>', 'Workflow type: yaml, ts, or py', parseWorkflowFileType)
    .option('--sync-code', 'Upload the current working directory before running')
    .option('--no-sync-code', 'Skip uploading the current working directory')
    .option('--resume <runId>', 'Resume a previously failed cloud workflow run from where it left off')
    .option('--start-from <step>', 'Start from a specific step in cloud and skip predecessor steps')
    .option(
      '--previous-run-id <runId>',
      'Use cached outputs from a previous cloud run when starting from a step'
    )
    .option('--json', 'Print raw JSON response', false)
    .action(
      async (
        workflow: string,
        options: {
          apiUrl?: string;
          fileType?: WorkflowFileType;
          syncCode?: boolean;
          resume?: string;
          startFrom?: string;
          previousRunId?: string;
          json?: boolean;
        }
      ) => {
        const started = Date.now();
        let success = false;
        let errorClass: string | undefined;
        try {
          const result = await runWorkflow(workflow, options);
          if (options.json) {
            deps.log(JSON.stringify(result, null, 2));
          } else {
            deps.log(`Run created: ${result.runId}`);
            if (typeof result.sandboxId === 'string') {
              deps.log(`Sandbox: ${result.sandboxId}`);
            }
            deps.log(`Status: ${result.status}`);
            renderPatchPushResults(result.patches, deps.log);
            deps.log(`\nView logs:  agent-relay cloud logs ${result.runId} --follow`);
            deps.log(`Sync code:  agent-relay cloud sync ${result.runId}`);
          }
          success = true;
        } catch (err) {
          errorClass = errorClassName(err);
          throw err;
        } finally {
          track('cloud_workflow_run', {
            has_explicit_file_type: Boolean(options.fileType),
            sync_code: options.syncCode !== false,
            json_output: Boolean(options.json),
            success,
            duration_ms: Date.now() - started,
            ...(errorClass ? { error_class: errorClass } : {}),
          });
        }
      }
    );

  // ── status ─────────────────────────────────────────────────────────────────

  cloudCommand
    .command('status')
    .description('Fetch workflow run status')
    .argument('<runId>', 'Workflow run id')
    .option('--api-url <url>', 'Cloud API base URL')
    .option('--json', 'Print raw JSON response', false)
    .action(async (runId: string, options: { apiUrl?: string; json?: boolean }) => {
      const result = await getRunStatus(runId, options);
      if (options.json) {
        deps.log(JSON.stringify(result, null, 2));
        return;
      }

      deps.log(`Run: ${result.runId ?? runId}`);
      deps.log(`Status: ${result.status ?? 'unknown'}`);
      if (typeof result.sandboxId === 'string') {
        deps.log(`Sandbox: ${result.sandboxId}`);
      }
      if (typeof result.updatedAt === 'string') {
        deps.log(`Updated: ${result.updatedAt}`);
      }
      renderPatchPushResults(result.patches, deps.log);
    });

  // ── logs ───────────────────────────────────────────────────────────────────

  cloudCommand
    .command('logs')
    .description('Read workflow run logs')
    .argument('<runId>', 'Workflow run id')
    .option('--api-url <url>', 'Cloud API base URL')
    .option('--follow', 'Poll until the run is done', false)
    .option('--poll-interval <seconds>', 'Polling interval while following', parsePositiveInteger, 2)
    .option('--offset <bytes>', 'Start reading logs from a byte offset', parseNonNegativeInteger, 0)
    .option('--agent <name>', 'Read logs for a specific agent')
    .option('--sandbox-id <sandboxId>', 'Read logs for a specific step sandbox')
    .option('--json', 'Print raw JSON responses', false)
    .action(
      async (
        runId: string,
        options: {
          apiUrl?: string;
          follow?: boolean;
          pollInterval?: number;
          offset?: number;
          agent?: string;
          sandboxId?: string;
          json?: boolean;
        }
      ) => {
        let offset = options.offset ?? 0;
        const sandboxId = options.agent ?? options.sandboxId;

        while (true) {
          const result = await getRunLogs(runId, {
            apiUrl: options.apiUrl,
            offset,
            sandboxId,
          });

          if (options.json) {
            deps.log(JSON.stringify(result, null, 2));
          } else if (result.content) {
            process.stdout.write(result.content);
          }

          offset = result.offset;
          if (!options.follow || result.done) {
            break;
          }

          await sleep((options.pollInterval ?? 2) * 1000);
        }
      }
    );

  // ── sync ───────────────────────────────────────────────────────────────────

  cloudCommand
    .command('sync')
    .description('Download and apply code changes from a completed workflow run')
    .argument('<runId>', 'Workflow run id')
    .option('--api-url <url>', 'Cloud API base URL')
    .option('--dir <path>', 'Local directory to apply the patch to', '.')
    .option('--dry-run', 'Download and display the patch without applying', false)
    .action(async (runId: string, options: { apiUrl?: string; dir?: string; dryRun?: boolean }) => {
      const targetDir = path.resolve(options.dir ?? '.');
      deps.log(`Fetching patch for run ${runId}...`);

      const result = await syncWorkflowPatch(runId, { apiUrl: options.apiUrl });

      // Multi-path responses target different repos and can't be applied to a
      // single --dir. Surface them in dry-run, otherwise direct the user to
      // apply manually. Single-patch runs continue to apply automatically.
      if (result.patches) {
        const entries = Object.entries(result.patches);
        const withChanges = entries.filter(([, p]) => p.hasChanges);
        if (withChanges.length === 0) {
          deps.log('No changes to sync — the workflow did not modify any files.');
          return;
        }
        if (options.dryRun) {
          for (const [name, p] of withChanges) {
            deps.log(`\n--- Patch for "${name}" (dry run) ---`);
            process.stdout.write(p.patch);
            deps.log(`\n--- End patch for "${name}" ---`);
          }
          return;
        }
        deps.error(
          `This run produced ${withChanges.length} per-path patch${withChanges.length === 1 ? '' : 'es'} ` +
            `(${withChanges.map(([n]) => n).join(', ')}). "cloud sync" only applies single-patch runs. ` +
            `Use --dry-run to inspect each patch, then apply manually in the correct repo.`
        );
        deps.exit(1);
        return;
      }

      if (!result.hasChanges || !result.patch) {
        deps.log('No changes to sync — the workflow did not modify any files.');
        return;
      }

      if (typeof result.patch !== 'string' || !result.patch) {
        throw new Error('Server reported changes but returned no patch data. The response may be malformed.');
      }

      if (options.dryRun) {
        deps.log('\n--- Patch (dry run) ---');
        process.stdout.write(result.patch);
        deps.log('\n--- End patch ---');
        return;
      }

      const { execSync } = await import('node:child_process');
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-sync-'));
      const tmpPatch = path.join(tmpDir, 'changes.patch');
      fs.writeFileSync(tmpPatch, result.patch, { mode: 0o600 });

      try {
        const stat = execSync(`git apply --stat "${tmpPatch}"`, {
          cwd: targetDir,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        if (stat.trim()) {
          deps.log('\nFiles changed by agent:');
          deps.log(stat);
        }

        execSync(`git apply "${tmpPatch}"`, {
          cwd: targetDir,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        deps.log('Patch applied successfully.');
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        deps.error(`Failed to apply patch: ${message}`);
        deps.error(`Patch saved to: ${tmpPatch}`);
        deps.exit(1);
      }
    });

  // ── cancel ─────────────────────────────────────────────────────────────────

  cloudCommand
    .command('cancel')
    .description('Cancel a running workflow')
    .argument('<runId>', 'Workflow run id')
    .option('--api-url <url>', 'Cloud API base URL')
    .option('--json', 'Print raw JSON response', false)
    .action(async (runId: string, options: { apiUrl?: string; json?: boolean }) => {
      const result = await cancelWorkflow(runId, options);
      if (options.json) {
        deps.log(JSON.stringify(result, null, 2));
        return;
      }

      deps.log(`Run: ${result.runId ?? runId}`);
      deps.log(`Status: ${result.status ?? 'unknown'}`);
    });
}
