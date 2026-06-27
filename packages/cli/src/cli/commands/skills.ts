import type { Command } from 'commander';

import { getProjectPaths } from '@agent-relay/config';

import { defaultExit } from '../lib/exit.js';
import {
  HARNESS_TARGETS,
  ORCHESTRATE_SKILL,
  defaultTargetContext,
  fetchSkill,
  findHarnessTarget,
  installSkill,
  parseSkill,
  type HarnessTarget,
  type InstallResult,
  type SkillScope,
  type TargetContext,
} from '../lib/skills-install.js';
import { selectHarnesses, selectScope } from '../lib/skills-tui.js';

type ExitFn = (code: number) => never;

/** The plan resolved either interactively or from flags. */
interface SkillPlan {
  scope: SkillScope;
  harnesses: HarnessTarget[];
}

export interface SkillsDependencies {
  fetchSkill: (url: string) => Promise<string>;
  promptScope: () => Promise<SkillScope | null>;
  promptHarnesses: (harnesses: HarnessTarget[]) => Promise<string[] | null>;
  getContext: () => TargetContext;
  isInteractive: () => boolean;
  install: (
    skill: ReturnType<typeof parseSkill>,
    plan: SkillPlan,
    ctx: TargetContext
  ) => InstallResult[];
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: ExitFn;
}

function resolveProjectRoot(): string {
  const paths = getProjectPaths() as { projectRoot?: string };
  return paths.projectRoot ?? process.cwd();
}

function withDefaults(overrides: Partial<SkillsDependencies> = {}): SkillsDependencies {
  return {
    fetchSkill,
    promptScope: () => selectScope(),
    promptHarnesses: (harnesses) => selectHarnesses(harnesses),
    getContext: () => defaultTargetContext(resolveProjectRoot()),
    isInteractive: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
    install: (skill, plan, ctx) =>
      installSkill({ skill, scope: plan.scope, harnesses: plan.harnesses, ctx }),
    log: (...args: unknown[]) => console.log(...args),
    error: (...args: unknown[]) => console.error(...args),
    exit: defaultExit,
    ...overrides,
  };
}

interface AddOptions {
  global?: boolean;
  local?: boolean;
  harness?: string;
  all?: boolean;
}

/** Parse `--harness a,b` into a deduped list of ids. */
function parseHarnessFlag(raw: string | undefined): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))];
}

/** Resolve scope from flags, or null when it must be asked interactively. */
function scopeFromFlags(opts: AddOptions, deps: SkillsDependencies): SkillScope | null {
  if (opts.global && opts.local) {
    deps.error('Choose only one of --global or --local.');
    deps.exit(1);
  }
  if (opts.global) return 'global';
  if (opts.local) return 'project';
  return null;
}

/** Resolve harness targets from flags, or null when they must be asked. */
function harnessesFromFlags(opts: AddOptions, deps: SkillsDependencies): HarnessTarget[] | null {
  if (opts.all) return [...HARNESS_TARGETS];
  const ids = parseHarnessFlag(opts.harness);
  if (ids.length === 0) return null;
  const resolved: HarnessTarget[] = [];
  for (const id of ids) {
    const target = findHarnessTarget(id);
    if (!target) {
      deps.error(
        `Unknown harness "${id}". Known harnesses: ${HARNESS_TARGETS.map((t) => t.id).join(', ')}.`
      );
      deps.exit(1);
    }
    resolved.push(target);
  }
  return resolved;
}

async function resolvePlan(opts: AddOptions, deps: SkillsDependencies): Promise<SkillPlan | null> {
  let scope = scopeFromFlags(opts, deps);
  let harnesses = harnessesFromFlags(opts, deps);

  const needsPrompt = scope === null || harnesses === null;
  if (needsPrompt && !deps.isInteractive()) {
    deps.error(
      'Non-interactive terminal: specify the scope and harnesses with flags, e.g.\n' +
        '  agent-relay skills add --global --harness claude,codex\n' +
        '  agent-relay skills add --local --all'
    );
    deps.exit(1);
  }

  if (scope === null) {
    scope = await deps.promptScope();
    if (scope === null) return null;
  }

  if (harnesses === null) {
    const ids = await deps.promptHarnesses([...HARNESS_TARGETS]);
    if (ids === null || ids.length === 0) return null;
    harnesses = ids.map((id) => findHarnessTarget(id)).filter((t): t is HarnessTarget => Boolean(t));
  }

  return { scope, harnesses };
}

function reportResults(results: InstallResult[], deps: SkillsDependencies): number {
  const ok = results.filter((r) => r.status !== 'failed');
  const failed = results.filter((r) => r.status === 'failed');

  for (const r of ok) {
    const verb = r.status === 'overwritten' ? 'Updated' : 'Installed';
    deps.log(`  \x1b[32m✓\x1b[0m ${verb} ${r.label} → ${r.path}`);
  }
  for (const r of failed) {
    deps.error(`  \x1b[31m✗\x1b[0m ${r.label} → ${r.path}: ${r.error}`);
  }

  if (ok.length > 0) {
    deps.log('');
    deps.log(
      `/${ORCHESTRATE_SKILL.slug} is ready in ${ok.length} harness${ok.length === 1 ? '' : 'es'}.`
    );
  }
  return failed.length > 0 ? 1 : 0;
}

export function registerSkillsCommands(
  program: Command,
  overrides: Partial<SkillsDependencies> = {}
): void {
  const deps = withDefaults(overrides);
  const group = program
    .command('skills')
    .description('Install Agent Relay skills into your coding harnesses');

  group
    .command('add')
    .description(`Install the /${ORCHESTRATE_SKILL.slug} skill into one or more harnesses`)
    .option('-g, --global', 'Install into your global (home) config')
    .option('-l, --local', 'Install into the current project')
    .option('--harness <ids>', 'Comma-separated harness ids (claude, codex, cursor, gemini, opencode)')
    .option('--all', 'Install into every supported harness')
    .action(async (opts: AddOptions) => {
      const plan = await resolvePlan(opts, deps);
      if (!plan) {
        deps.log('Cancelled. Nothing was installed.');
        return;
      }

      let raw: string;
      try {
        raw = await deps.fetchSkill(ORCHESTRATE_SKILL.url);
      } catch (err) {
        deps.error(err instanceof Error ? err.message : String(err));
        deps.exit(1);
        return;
      }

      const skill = parseSkill(raw);
      const ctx = deps.getContext();
      deps.log(
        `Installing /${ORCHESTRATE_SKILL.slug} (${plan.scope === 'global' ? 'global' : 'this project'})…`
      );
      const results = deps.install(skill, plan, ctx);
      const code = reportResults(results, deps);
      if (code !== 0) deps.exit(code);
    });
}
