/**
 * The agent skill `relay init` installs so every session it injects into
 * knows how to find who is on Agent Relay and message them:
 * `messaging-agents-on-the-relay` from AgentWorkforce/skills, installed for
 * each tool globally with the `skills` CLI (`npx skills add`).
 *
 * Both the skill and the CLI are pinned, so a change to the skills repo
 * cannot change what init installs. Init records each copy it put in place
 * in its record (`core-settings.json`), and `relay init --uninstall` removes
 * exactly those, and only while every file in them is unchanged. A copy that was already
 * there before init, or that the person changed, is never touched.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  TOOL_IDS,
  findToolTarget,
  writeKeepingMode,
  type ToolContext,
  type ToolId,
} from './agent-tools-mcp.js';

/** The skill's name in AgentWorkforce/skills. */
export const RELAY_SKILL_NAME = 'messaging-agents-on-the-relay';
/** The skills repo commit init installs the skill from. */
export const RELAY_SKILL_REF = '410a9de7241f9e7305a562954e674997056cc701';
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
  /** The skills repo commit this copy was installed from. */
  ref: string;
  /** sha256 over every file in the folder as installed: --uninstall removes it only while it matches. */
  treeSha256: string;
}

/** The skill's entry in the `skills` CLI's lock file, as init found and left it. */
export interface SkillLockRecord {
  file: string;
  /** Init created the lock file. */
  created: boolean;
  /** The entry before init first wrote it, or null when there was none: what --uninstall puts back. */
  original: unknown;
  /** The ref init last wrote there: --uninstall touches the entry only while it still names it. */
  ref: string;
}

/** What init installed of the skill, kept in `core-settings.json` for `--uninstall`. */
export interface RelaySkillRecord {
  copies: InstalledSkillCopy[];
  /** Folders init's install created, removed again once empty. */
  createdDirs: string[];
  /** The `skills` CLI's lock entries init wrote, one per lock file. */
  locks: SkillLockRecord[];
}

/** Runs the `skills` CLI with `args`; replaced in tests. */
export type RunSkillsCli = (
  args: string[],
  options: { env: NodeJS.ProcessEnv; cwd: string }
) => { status: number | null; output: string };

/** The only characters an argument to the `skills` CLI may hold: no shell syntax on any platform. */
const PLAIN_ARGUMENT = /^[A-Za-z0-9@:/._#=+-]+$/;

/**
 * The real `npx skills@<pinned> …`: no prompts, no telemetry, its output
 * kept for a failure's reason. Windows starts npx (a .cmd) only through a
 * shell, so every argument must be a plain word (`PLAIN_ARGUMENT`); any
 * other is refused before anything runs.
 * @param args - The `skills` CLI's arguments
 * @param options - Its environment and working folder
 * @returns Its exit status and combined output
 */
export const defaultRunSkillsCli: RunSkillsCli = (args, { env, cwd }) => {
  const words = ['-y', SKILLS_CLI_PACKAGE, ...args];
  const unsafe = words.find((word) => !PLAIN_ARGUMENT.test(word));
  if (unsafe !== undefined) {
    return { status: null, output: `refused an argument with shell characters: ${unsafe}` };
  }
  const options = {
    cwd,
    env,
    encoding: 'utf8' as const,
    stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
    timeout: 180_000,
  };
  const result =
    process.platform === 'win32'
      ? spawnSync(`npx ${words.join(' ')}`, { ...options, shell: true })
      : spawnSync('npx', words, options);
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? result.error.message : ''}`;
  return { status: result.status, output };
};

/**
 * Where a tool loads global skills, as the `skills` CLI installs them:
 * Claude Code `~/.claude/skills` (or `$CLAUDE_CONFIG_DIR/skills`); Codex,
 * OpenCode and Pi the shared `~/.agents/skills`; Grok `~/.grok/skills`;
 * Devin `$XDG_CONFIG_HOME/devin/skills`.
 * @param id - The tool
 * @param ctx - Home and environment the tool resolves against
 * @returns The tool's global skills folder
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

/** The skill's own folder for `id`. */
function skillDir(id: ToolId, ctx: ToolContext): string {
  return path.join(skillsDirFor(id, ctx), RELAY_SKILL_NAME);
}

/** The `skills` CLI's lock file (`$XDG_STATE_HOME/skills/.skill-lock.json`, else `~/.agents/.skill-lock.json`). */
function lockFile(ctx: ToolContext): string {
  const state = ctx.env.XDG_STATE_HOME?.trim();
  return state
    ? path.join(state, 'skills', '.skill-lock.json')
    : path.join(ctx.home, '.agents', '.skill-lock.json');
}

type SkillLock = { skills?: Record<string, { ref?: string } | undefined> } & Record<string, unknown>;

function readLock(file: string): SkillLock {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * sha256 over every entry under `dir` (its relative path, then a file's
 * contents or a link's target), or undefined when `dir` is not a real
 * folder or cannot be read. Any added, removed or changed file changes it.
 */
function treeHash(dir: string): string | undefined {
  const hash = createHash('sha256');
  const walk = (current: string, relative: string): void => {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const name = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) {
        hash.update(`d\0${name}\0`);
        walk(full, name);
      } else if (entry.isSymbolicLink()) {
        hash.update(`l\0${name}\0${fs.readlinkSync(full)}\0`);
      } else {
        hash.update(`f\0${name}\0`).update(fs.readFileSync(full)).update('\0');
      }
    }
  };
  try {
    if (!fs.lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) return undefined;
    walk(dir, '');
    return hash.digest('hex');
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

/**
 * Read the recorded install.
 * @param value - The `relaySkill` value of `core-settings.json`
 * @returns The record, or undefined when the value is not one
 */
export function relaySkillRecordOf(value: unknown): RelaySkillRecord | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const copies = Array.isArray(record.copies)
    ? record.copies.filter(
        (copy): copy is InstalledSkillCopy =>
          typeof copy?.path === 'string' &&
          typeof copy?.ref === 'string' &&
          typeof copy?.treeSha256 === 'string'
      )
    : [];
  const createdDirs = Array.isArray(record.createdDirs)
    ? record.createdDirs.filter((dir): dir is string => typeof dir === 'string')
    : [];
  const locks = (Array.isArray(record.locks) ? (record.locks as Partial<SkillLockRecord>[]) : []).flatMap(
    (raw) =>
      typeof raw?.file === 'string' && typeof raw?.ref === 'string'
        ? [{ file: raw.file, created: raw.created === true, original: raw.original ?? null, ref: raw.ref }]
        : []
  );
  if (copies.length === 0 && locks.length === 0) return undefined;
  return { copies, createdDirs, locks };
}

/** One line about the skill, and the record to keep. */
export interface SkillInstallResult {
  line: string;
  record: RelaySkillRecord | undefined;
  /** Only what this run newly created: what to take back out if `record` cannot be saved. */
  undo?: RelaySkillRecord;
}

/**
 * Install the skill globally for `tools`, where it is not there yet. A copy
 * init installed earlier is refreshed when it is from another pinned ref
 * and unchanged; any other copy already there is the person's and is left
 * as it is. Never throws: a failure is the warning line, and only what did
 * land is recorded as current, so a failed refresh is tried again next time.
 * @param tools - The tools whose sessions the core injects into
 * @param ctx - Home and environment the tools resolve against
 * @param recorded - What an earlier init installed
 * @param run - Runs the `skills` CLI
 * @returns The line to print and the record to keep
 */
export function installRelaySkill(
  tools: ToolId[],
  ctx: ToolContext,
  recorded: RelaySkillRecord | undefined,
  run: RunSkillsCli
): SkillInstallResult {
  try {
    return install(tools, ctx, recorded, run);
  } catch (error) {
    return { line: failureLine(tools.map(toolLabel).join(', '), (error as Error).message), record: recorded };
  }
}

/** The folders to install into (absent, or init's own unchanged copy from another ref) and those left as they are. */
function plan(
  dirs: string[],
  recorded: RelaySkillRecord | undefined
): { before: Map<string, string | undefined>; kept: string[] } {
  const ours = new Map((recorded?.copies ?? []).map((copy) => [copy.path, copy]));
  const before = new Map<string, string | undefined>();
  const kept: string[] = [];
  for (const dir of dirs) {
    const copy = ours.get(dir);
    if (!exists(dir)) {
      before.set(dir, undefined);
      continue;
    }
    const now = treeHash(dir);
    if (!copy || now !== copy.treeSha256) kept.push(dir);
    else if (copy.ref !== RELAY_SKILL_REF) before.set(dir, now);
  }
  return { before, kept };
}

/** The lock entry this run wrote, as `--uninstall` would need it; undefined when it wrote none. */
function lockWritten(file: string, existed: boolean, entryBefore: unknown): SkillLockRecord | undefined {
  const before = (entryBefore as { ref?: string } | undefined)?.ref;
  if (readLock(file).skills?.[RELAY_SKILL_NAME]?.ref !== RELAY_SKILL_REF || before === RELAY_SKILL_REF) {
    return undefined;
  }
  return { file, created: !existed, original: entryBefore ?? null, ref: RELAY_SKILL_REF };
}

/** The recorded lock entries after `written`: an earlier entry for its file keeps what init first found. */
function mergeLocks(recorded: SkillLockRecord[], written: SkillLockRecord | undefined): SkillLockRecord[] {
  if (!written) return recorded;
  const earlier = recorded.find((entry) => entry.file === written.file);
  return [
    ...recorded.filter((entry) => entry.file !== written.file),
    earlier ? { ...earlier, ref: written.ref } : written,
  ];
}

function install(
  tools: ToolId[],
  ctx: ToolContext,
  recorded: RelaySkillRecord | undefined,
  run: RunSkillsCli
): SkillInstallResult {
  const byPath = new Map<string, ToolId[]>();
  for (const id of tools) byPath.set(skillDir(id, ctx), [...(byPath.get(skillDir(id, ctx)) ?? []), id]);
  const { before, kept } = plan([...byPath.keys()], recorded);
  const targets = [...before.keys()];
  const label = (dirs: string[]) => dirs.map((dir) => byPath.get(dir)!.map(toolLabel).join(', ')).join(', ');
  if (targets.length === 0) {
    const state = kept.length > 0 ? 'already there' : 'installed';
    return {
      line: `✓ Agent skill        ${RELAY_SKILL_NAME} ${state} for ${label([...byPath.keys()])}`,
      record: recorded,
    };
  }

  const lock = lockFile(ctx);
  const lockExisted = exists(lock);
  const entryBefore = readLock(lock).skills?.[RELAY_SKILL_NAME];
  const createdDirs = [...targets.map((dir) => path.join(dir, 'SKILL.md')), lock].flatMap(missingDirs);
  const agents = targets.flatMap((dir) => byPath.get(dir)!.flatMap((id) => ['--agent', SKILLS_AGENT[id]]));
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

  // A copy is current only if this run put it there: new, or written by a
  // run that succeeded. An old copy a failed refresh left keeps its old ref.
  const after = new Map(targets.map((dir) => [dir, treeHash(dir)]));
  const landed = targets.filter((dir) => {
    const hash = after.get(dir);
    return (
      hash !== undefined && (before.get(dir) === undefined || result.status === 0 || hash !== before.get(dir))
    );
  });
  const copies = [
    ...(recorded?.copies ?? []).filter((copy) => !landed.includes(copy.path)),
    ...landed.map((dir) => ({ path: dir, ref: RELAY_SKILL_REF, treeSha256: after.get(dir)! })),
  ];
  const written = lockWritten(lock, lockExisted, entryBefore);
  const locks = mergeLocks(recorded?.locks ?? [], written);
  const made = createdDirs.filter(exists);
  const record: RelaySkillRecord | undefined =
    copies.length > 0 || locks.length > 0
      ? { copies, createdDirs: [...new Set([...(recorded?.createdDirs ?? []), ...made])], locks }
      : undefined;
  const undo: RelaySkillRecord = {
    copies: copies.filter((copy) => landed.includes(copy.path) && before.get(copy.path) === undefined),
    createdDirs: made,
    locks: written ? [written] : [],
  };
  const missed = targets.filter((dir) => !landed.includes(dir));
  if (missed.length > 0) {
    const reason =
      result.status === 0 ? 'it did not land' : lastLine(result.output) || `exit ${result.status}`;
    return { line: failureLine(label(missed), reason), record, undo };
  }
  const keptNote = kept.length > 0 ? `; already there for ${label(kept)}, left as is` : '';
  return {
    line: `✓ Agent skill        installed ${RELAY_SKILL_NAME} for ${label(landed)}${keptNote}`,
    record,
    undo,
  };
}

function failureLine(tools: string, reason: string): string {
  return (
    `! Agent skill        could not install ${RELAY_SKILL_NAME} for ${tools} (${reason}). ` +
    `Messaging still works; to add it: npx ${SKILLS_CLI_PACKAGE} add ${RELAY_SKILL_SOURCE} --skill ${RELAY_SKILL_NAME} --global`
  );
}

/** What `--uninstall` did with the skill, and what is still recorded. */
export interface SkillUninstallResult {
  line: string;
  /**
   * What it could not remove, kept for a later `--uninstall`: paths this
   * environment resolves elsewhere (another `CLAUDE_CONFIG_DIR`, `GROK_HOME`,
   * `XDG_CONFIG_HOME` or `XDG_STATE_HOME`) and paths that failed. Undefined
   * when nothing is left.
   */
  remaining: RelaySkillRecord | undefined;
}

/**
 * Remove what init installed: each recorded copy whose every file is as
 * installed, the lock entries it wrote (putting back what they replaced),
 * and the folders it created once they are empty. Only the skill's own
 * folder in a tool's skills folder and the `skills` CLI's lock file, as this
 * environment resolves them, are ever touched, whatever the record says.
 * Never throws: what it could not reach or remove stays recorded, and the
 * line says so.
 * @param recorded - What init installed
 * @param ctx - Home and environment the tools resolve against
 * @returns The line to print and the record to keep, or undefined when nothing was recorded
 */
export function uninstallRelaySkill(
  recorded: RelaySkillRecord | undefined,
  ctx: ToolContext
): SkillUninstallResult | undefined {
  if (!recorded) return undefined;
  const allowed = new Set(TOOL_IDS.map((id) => skillDir(id, ctx)));
  const lock = lockFile(ctx);
  const removed: string[] = [];
  const changed: string[] = [];
  const failed: InstalledSkillCopy[] = [];
  const elsewhere = recorded.copies.filter((copy) => !allowed.has(copy.path));
  for (const copy of recorded.copies) {
    if (!allowed.has(copy.path)) continue;
    const hash = treeHash(copy.path);
    if (hash === undefined) continue;
    if (hash !== copy.treeSha256) {
      changed.push(copy.path);
      continue;
    }
    try {
      fs.rmSync(copy.path, { recursive: true, force: true });
      removed.push(copy.path);
    } catch {
      failed.push(copy);
    }
  }
  const locksElsewhere = recorded.locks.filter((entry) => entry.file !== lock);
  const locksFailed = recorded.locks.filter((entry) => entry.file === lock && !restoreLock(entry));
  const roots = [...allowed, lock];
  removeEmptyDirs(
    recorded.createdDirs.filter((dir) => roots.some((root) => root.startsWith(dir + path.sep)))
  );
  const left = [...elsewhere, ...failed];
  const leftLocks = [...locksElsewhere, ...locksFailed];
  const remaining: RelaySkillRecord | undefined =
    left.length > 0 || leftLocks.length > 0
      ? {
          copies: left,
          createdDirs: recorded.createdDirs.filter((dir) => fs.existsSync(dir)),
          locks: leftLocks,
        }
      : undefined;
  const notes = [
    ...(removed.length > 0 ? [` (${removed.join(', ')})`] : []),
    ...(changed.length > 0 ? [`; kept ${changed.join(', ')}, changed since`] : []),
  ];
  const away = [...elsewhere.map((copy) => copy.path), ...locksElsewhere.map((entry) => entry.file)];
  if (away.length > 0) {
    notes.push(
      `. Not removed, because this environment resolves the tools' folders elsewhere: ${away.join(', ')}. ` +
        'Run relay init --uninstall again with the CLAUDE_CONFIG_DIR, GROK_HOME, XDG_CONFIG_HOME and ' +
        'XDG_STATE_HOME that relay init ran with to remove them'
    );
  }
  const stuck = [...failed.map((copy) => copy.path), ...locksFailed.map((entry) => entry.file)];
  if (stuck.length > 0)
    notes.push(`. Could not remove ${stuck.join(', ')}; run relay init --uninstall again`);
  return {
    line: `${remaining ? '!' : '✓'} Agent skill        removed the ${RELAY_SKILL_NAME} skill relay init installed${notes.join('')}`,
    remaining,
  };
}

/**
 * Put the lock entry back as init found it, while it still names the ref init
 * wrote. The file is replaced in one step, keeping its mode, and a link to it
 * stays a link.
 * @returns false when the lock file could not be changed
 */
function restoreLock(record: SkillLockRecord): boolean {
  const lock = readLock(record.file);
  if (!lock.skills || lock.skills[RELAY_SKILL_NAME]?.ref !== record.ref) return true;
  if (record.original) lock.skills[RELAY_SKILL_NAME] = record.original as { ref?: string };
  else delete lock.skills[RELAY_SKILL_NAME];
  try {
    if (record.created && Object.keys(lock.skills).length === 0) fs.rmSync(record.file, { force: true });
    else writeKeepingMode(fs.realpathSync(record.file), JSON.stringify(lock, null, 2));
    return true;
  } catch {
    return false;
  }
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
