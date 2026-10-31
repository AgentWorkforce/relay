/**
 * The agent skill `relay init` installs so every session it injects into
 * knows how to find who is on Agent Relay and message them:
 * `messaging-agents-on-the-relay` from AgentWorkforce/skills, installed for
 * each tool globally with the `skills` CLI (`npx skills add`).
 *
 * Both the skill and the CLI are pinned, so a change to the skills repo
 * cannot change what init installs. Init records each copy it put in place
 * in its record (`core-settings.json`), and `relay init --uninstall` removes
 * exactly those, and only while they are unchanged. A copy that was already
 * there before init, or that the person changed, is never touched.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { findToolTarget, type ToolContext, type ToolId } from './agent-tools-mcp.js';

/** The skill's name in AgentWorkforce/skills. */
export const RELAY_SKILL_NAME = 'messaging-agents-on-the-relay';
/** The skills repo commit init installs the skill from. */
export const RELAY_SKILL_REF = 'ac9fb90d0dd1a1c2fd03c8ba309efd4c62ad4a78';
/** The pinned source, as `skills add` takes it (`<repo>#<ref>`). */
export const RELAY_SKILL_SOURCE = `https://github.com/AgentWorkforce/skills#${RELAY_SKILL_REF}`;
/** The `skills` CLI version init runs through npx. */
export const SKILLS_CLI_PACKAGE = 'skills@1.7.4';

/** The `skills` CLI's agent name for each tool init sets up. */
const SKILLS_AGENT: Record<ToolId, string> = {
  claude: 'claude-code',
  codex: 'codex',
  opencode: 'opencode',
  grok: 'grok',
  pi: 'pi',
  devin: 'devin',
};

/** One copy of the skill init put in place. */
export interface InstalledSkillCopy {
  /** The skill's folder. */
  path: string;
  /** sha256 of its SKILL.md as installed: --uninstall removes it only while it matches. */
  sha256: string;
}

/** What init installed of the skill, kept in `core-settings.json` for `--uninstall`. */
export interface RelaySkillRecord {
  ref: string;
  copies: InstalledSkillCopy[];
  /** Folders init's install created, removed again once empty. */
  createdDirs: string[];
  /** The `skills` CLI's lock file, when init added the skill's entry to it. */
  lock?: { file: string; created: boolean };
}

/** Runs the `skills` CLI with `args`; replaced in tests. */
export type RunSkillsCli = (
  args: string[],
  options: { env: NodeJS.ProcessEnv; cwd: string }
) => { status: number | null; output: string };

/**
 * The real `npx skills@<pinned> …`: no prompts, no telemetry, its output
 * kept for a failure's reason. Windows starts npx (a .cmd) only through a
 * shell; every argument is a fixed word or a path init computed.
 */
export const defaultRunSkillsCli: RunSkillsCli = (args, { env, cwd }) => {
  const options = {
    cwd,
    env,
    encoding: 'utf8' as const,
    stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
    timeout: 180_000,
  };
  const result =
    process.platform === 'win32'
      ? spawnSync(`npx -y ${SKILLS_CLI_PACKAGE} ${args.map((arg) => `"${arg}"`).join(' ')}`, {
          ...options,
          shell: true,
        })
      : spawnSync('npx', ['-y', SKILLS_CLI_PACKAGE, ...args], options);
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? result.error.message : ''}`;
  return { status: result.status, output };
};

/**
 * Where a tool loads global skills, as the `skills` CLI installs them:
 * Claude Code `~/.claude/skills` (or `$CLAUDE_CONFIG_DIR/skills`); Codex,
 * OpenCode and Pi the shared `~/.agents/skills`; Grok `~/.grok/skills`;
 * Devin `$XDG_CONFIG_HOME/devin/skills`.
 */
export function skillsDirFor(id: ToolId, ctx: ToolContext): string {
  const env = ctx.env;
  switch (id) {
    case 'claude':
      return path.join(env.CLAUDE_CONFIG_DIR?.trim() || path.join(ctx.home, '.claude'), 'skills');
    case 'grok':
      return path.join(env.GROK_HOME?.trim() || path.join(ctx.home, '.grok'), 'skills');
    case 'devin':
      return path.join(env.XDG_CONFIG_HOME?.trim() || path.join(ctx.home, '.config'), 'devin', 'skills');
    case 'codex':
    case 'opencode':
    case 'pi':
      return path.join(ctx.home, '.agents', 'skills');
  }
}

/** The `skills` CLI's lock file (`$XDG_STATE_HOME/skills/.skill-lock.json`, else `~/.agents/.skill-lock.json`). */
function lockFile(ctx: ToolContext): string {
  const state = ctx.env.XDG_STATE_HOME?.trim();
  return state
    ? path.join(state, 'skills', '.skill-lock.json')
    : path.join(ctx.home, '.agents', '.skill-lock.json');
}

function readLock(file: string): { skills?: Record<string, { ref?: string }> } & Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function skillHash(dir: string): string | undefined {
  try {
    return createHash('sha256')
      .update(fs.readFileSync(path.join(dir, 'SKILL.md')))
      .digest('hex');
  } catch {
    return undefined;
  }
}

function exists(file: string): boolean {
  return fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined;
}

/** Every missing folder on the way to `file`, deepest first; empty when its folder exists. */
function missingDirs(file: string): string[] {
  const missing: string[] = [];
  for (let dir = path.dirname(file); dir !== path.dirname(dir) && !exists(dir); dir = path.dirname(dir)) {
    missing.push(dir);
  }
  return missing;
}

/** Removes the folders init created, deepest first, each only while it is empty. */
function removeEmptyDirs(dirs: string[]): void {
  for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
    try {
      fs.rmdirSync(dir);
    } catch {
      // Not empty, already gone, or unreadable: left as it is.
    }
  }
}

/** The recorded install, or undefined when the value is not one. */
export function relaySkillRecordOf(value: unknown): RelaySkillRecord | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const copies = Array.isArray(record.copies)
    ? record.copies.filter(
        (copy): copy is InstalledSkillCopy =>
          typeof copy?.path === 'string' && typeof copy?.sha256 === 'string'
      )
    : [];
  const createdDirs = Array.isArray(record.createdDirs)
    ? record.createdDirs.filter((dir): dir is string => typeof dir === 'string')
    : [];
  const lock = record.lock as RelaySkillRecord['lock'] | undefined;
  if (copies.length === 0 && !lock) return undefined;
  return {
    ref: typeof record.ref === 'string' ? record.ref : '',
    copies,
    createdDirs,
    ...(lock && typeof lock.file === 'string'
      ? { lock: { file: lock.file, created: lock.created === true } }
      : {}),
  };
}

/** One line about the skill, and the record to keep. */
export interface SkillInstallResult {
  line: string;
  record: RelaySkillRecord | undefined;
}

/**
 * Install the skill globally for `tools`, where it is not there yet. A copy
 * init installed earlier is refreshed when the pinned ref changed; any
 * other copy already there is the person's and is left as it is. Never
 * throws: a failure is the warning line, and what did land is recorded.
 * @param tools - The tools whose sessions the core injects into
 * @param ctx - Home and environment the tools resolve against
 * @param recorded - What an earlier init installed
 * @param run - Runs the `skills` CLI
 */
export function installRelaySkill(
  tools: ToolId[],
  ctx: ToolContext,
  recorded: RelaySkillRecord | undefined,
  run: RunSkillsCli
): SkillInstallResult {
  const ours = new Map((recorded?.copies ?? []).map((copy) => [copy.path, copy.sha256]));
  const byPath = new Map<string, ToolId[]>();
  for (const id of tools) {
    const dir = path.join(skillsDirFor(id, ctx), RELAY_SKILL_NAME);
    byPath.set(dir, [...(byPath.get(dir) ?? []), id]);
  }
  const install: string[] = [];
  const kept: string[] = [];
  for (const dir of byPath.keys()) {
    const mine = ours.has(dir) && skillHash(dir) === ours.get(dir);
    if (!exists(dir) || (mine && recorded?.ref !== RELAY_SKILL_REF)) install.push(dir);
    else if (!mine) kept.push(dir);
  }
  const label = (dirs: string[]) => dirs.map((dir) => byPath.get(dir)!.map(toolLabel).join(', ')).join(', ');
  const keptNote = kept.length > 0 ? `; already there for ${label(kept)}, left as is` : '';
  if (install.length === 0) {
    return {
      line: `✓ Agent skill        ${RELAY_SKILL_NAME} ${kept.length > 0 ? 'already there' : 'installed'} for ${label([...byPath.keys()])}`,
      record: recorded,
    };
  }

  const lock = lockFile(ctx);
  const lockExisted = exists(lock);
  const lockHadEntry = Boolean(readLock(lock).skills?.[RELAY_SKILL_NAME]);
  const createdDirs = [...install.map((dir) => path.join(dir, 'SKILL.md')), lock].flatMap(missingDirs);
  const agents = install.flatMap((dir) => byPath.get(dir)!.flatMap((id) => ['--agent', SKILLS_AGENT[id]]));
  let result: ReturnType<RunSkillsCli>;
  try {
    result = run(
      ['add', RELAY_SKILL_SOURCE, '--skill', RELAY_SKILL_NAME, '--global', '--copy', '--yes', ...agents],
      // HOME is the tools' home, so the skill lands where they load it.
      { env: { ...ctx.env, HOME: ctx.home, DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1' }, cwd: ctx.home }
    );
  } catch (error) {
    result = { status: null, output: (error as Error).message };
  }

  const landed = install.filter((dir) => skillHash(dir) !== undefined);
  const copies = [
    ...(recorded?.copies ?? []).filter((copy) => !landed.includes(copy.path)),
    ...landed.map((dir) => ({ path: dir, sha256: skillHash(dir)! })),
  ];
  const lockAdded = !lockHadEntry && Boolean(readLock(lock).skills?.[RELAY_SKILL_NAME]);
  const record: RelaySkillRecord | undefined =
    copies.length > 0 || recorded?.lock || lockAdded
      ? {
          ref: landed.length > 0 ? RELAY_SKILL_REF : (recorded?.ref ?? RELAY_SKILL_REF),
          copies,
          createdDirs: [...new Set([...(recorded?.createdDirs ?? []), ...createdDirs.filter(exists)])],
          ...(recorded?.lock
            ? { lock: recorded.lock }
            : lockAdded
              ? { lock: { file: lock, created: !lockExisted } }
              : {}),
        }
      : undefined;
  const missed = install.filter((dir) => !landed.includes(dir));
  if (missed.length === 0) {
    return {
      line: `✓ Agent skill        installed ${RELAY_SKILL_NAME} for ${label(landed)}${keptNote}`,
      record,
    };
  }
  const reason = result.status === 0 ? 'it did not land' : lastLine(result.output) || `exit ${result.status}`;
  return {
    line:
      `! Agent skill        could not install ${RELAY_SKILL_NAME} for ${label(missed)} (${reason}). ` +
      `Messaging still works; to add it: npx ${SKILLS_CLI_PACKAGE} add ${RELAY_SKILL_SOURCE} --skill ${RELAY_SKILL_NAME} --global`,
    record,
  };
}

/**
 * Remove what init installed: each recorded copy still as installed, the
 * lock entry it added, and the folders it created once they are empty.
 * @returns The line to print, or undefined when nothing was recorded
 */
export function uninstallRelaySkill(recorded: RelaySkillRecord | undefined): string | undefined {
  if (!recorded) return undefined;
  const removed: string[] = [];
  const changed: string[] = [];
  for (const copy of recorded.copies) {
    const hash = skillHash(copy.path);
    if (hash === undefined) continue;
    if (hash !== copy.sha256) {
      changed.push(copy.path);
      continue;
    }
    fs.rmSync(copy.path, { recursive: true, force: true });
    removed.push(copy.path);
  }
  if (recorded.lock) {
    const lock = readLock(recorded.lock.file);
    const entry = lock.skills?.[RELAY_SKILL_NAME];
    if (entry && entry.ref === recorded.ref && lock.skills) {
      delete lock.skills[RELAY_SKILL_NAME];
      if (recorded.lock.created && Object.keys(lock.skills).length === 0)
        fs.rmSync(recorded.lock.file, { force: true });
      else fs.writeFileSync(recorded.lock.file, `${JSON.stringify(lock, null, 2)}`);
    }
  }
  removeEmptyDirs(recorded.createdDirs);
  const kept = changed.length > 0 ? `; kept ${changed.join(', ')}, changed since` : '';
  return `✓ Agent skill        removed the ${RELAY_SKILL_NAME} skill relay init installed${removed.length > 0 ? ` (${removed.join(', ')})` : ''}${kept}`;
}

function toolLabel(id: ToolId): string {
  return findToolTarget(id)?.label ?? id;
}

/** The last non-empty line of the CLI's output, without terminal styling, for a failure's reason. */
function lastLine(output: string): string {
  const lines = output
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
    .split('\n')
    .map((line) => line.replace(/^[\s│◇■└┌]+/, '').trim())
    .filter(Boolean);
  return (lines.at(-1) ?? '').slice(0, 200);
}
