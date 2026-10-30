/**
 * What `relay init` finds before the core edits a tool's own files, so
 * `relay init --uninstall` can leave them as they were.
 *
 * The core keeps each edit reversible on its own (it takes its hook and
 * rules back out, and copies a file it changes once, beside it, as
 * `.relay-desktop-backup`), but it cannot know which files relay init made:
 * a Claude `settings.json` that only existed for `crossSessionInbound` and
 * the SessionStart hook, or the OpenCode plugin's or Pi extension's off
 * marker. This records
 * that before init turns anything on and tidies only those afterwards.
 */

import fs from 'node:fs';
import path from 'node:path';

import { writeKeepingMode } from './agent-tools-mcp.js';

/** The core's one-time copy of a file as it was (`claude_settings::BACKUP_SUFFIX`). */
export const BACKUP_SUFFIX = '.relay-desktop-backup';

/** The marker the core leaves when the OpenCode plugin is turned off (`opencode::OFF_SUFFIX`). */
export const OPENCODE_OFF_SUFFIX = '.off';

/** The first words of the core's OpenCode off marker; any other file there is not the core's. */
const OPENCODE_OFF_TEXT = "Agent Relay's OpenCode plugin was turned off";

/** The first words of the core's Pi off marker (`pi::setup`); any other file there is not the core's. */
const PI_OFF_TEXT = "Agent Relay's Pi extension was turned off";

/** A Claude login's `settings.json` before init. */
export interface ClaudeFileState {
  /** The settings file existed. */
  existed: boolean;
  /** Its `.relay-desktop-backup` existed. */
  backup: boolean;
  /** Its folder existed. */
  dir: boolean;
}

/** The OpenCode plugin's place before init. */
export interface OpenCodeState {
  /** `<config>/opencode/plugins/agent-relay.js`. */
  file: string;
  /** A file of that name existed. */
  plugin: boolean;
  /** Its off marker existed. */
  off: boolean;
  /** The plugins folder existed. */
  dir: boolean;
}

/** The Pi extension's place before init. */
export interface PiState {
  /** `<Pi agent folder>/extensions/agent-relay.js`. */
  file: string;
  /** The core's off marker, `~/.agentworkforce/desktop/pi-extension.off` (`PiConfig::off_marker`). */
  marker: string;
  /** A file of the extension's name existed. */
  extension: boolean;
  /** The off marker existed. */
  off: boolean;
  /** The extensions folder existed. */
  dir: boolean;
}

const exists = (file: string): boolean => {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
};

/** `file` with links followed, as the core edits it; as given when it does not resolve. */
function resolved(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
}

/**
 * Each Claude settings file's state before init.
 * @param files - The logins' `settings.json` paths
 */
export function claudeFileStates(files: string[]): Record<string, ClaudeFileState> {
  const states: Record<string, ClaudeFileState> = {};
  for (const file of files) {
    states[file] = {
      existed: exists(file),
      backup: exists(`${resolved(file)}${BACKUP_SUFFIX}`),
      dir: exists(path.dirname(file)),
    };
  }
  return states;
}

/**
 * The OpenCode plugin's place before init.
 * @param configDir - OpenCode's global config folder (`<XDG_CONFIG_HOME or ~/.config>/opencode`)
 */
export function openCodeState(configDir: string): OpenCodeState {
  const file = path.join(configDir, 'plugins', 'agent-relay.js');
  return {
    file,
    plugin: exists(file),
    off: exists(`${file}${OPENCODE_OFF_SUFFIX}`),
    dir: exists(path.dirname(file)),
  };
}

/** OpenCode's global config folder, as the core reads it (`OpenCodeConfig::from_env`). */
export function openCodeConfigDir(env: NodeJS.ProcessEnv, home: string): string {
  const configured = env.XDG_CONFIG_HOME?.trim();
  return path.join(
    configured && configured.startsWith('/') ? configured : path.join(home, '.config'),
    'opencode'
  );
}

/** Pi's agent folder, as the core reads it (`PiConfig::from_env`): an absolute `PI_CODING_AGENT_DIR`, else `~/.pi/agent`. */
export function piAgentDir(env: NodeJS.ProcessEnv, home: string): string {
  const configured = env.PI_CODING_AGENT_DIR;
  return configured && path.isAbsolute(configured) ? configured : path.join(home, '.pi', 'agent');
}

/**
 * The Pi extension's place before init.
 * @param agentDir - Pi's agent folder ({@link piAgentDir})
 * @param home - The home the core keeps its data under
 */
export function piState(agentDir: string, home: string): PiState {
  const file = path.join(agentDir, 'extensions', 'agent-relay.js');
  const marker = path.join(home, '.agentworkforce', 'desktop', 'pi-extension.off');
  return {
    file,
    marker,
    extension: exists(file),
    off: exists(marker),
    dir: exists(path.dirname(file)),
  };
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/** Two JSON values with the same content, whatever the key order. */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => sameJson(item, b[i]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && sameJson(left[key], right[key]))
  );
}

const isEmptyObject = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 0;

/** Removes `dir` when it is empty; anything in it stays. */
function removeEmptyDir(dir: string): void {
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {
    // Gone already, or not empty.
  }
}

/**
 * Leaves each Claude login's `settings.json` as it was before init, once
 * the core has taken out what init turned on and the original
 * `crossSessionInbound` is back:
 * - a file that existed goes back byte for byte from the core's copy when
 *   its content is the same as that copy (the person changed nothing since);
 * - a file init created is removed once it is an empty object, with the
 *   core's copy of it, and its folder when init created that and nothing
 *   else is in it.
 *
 * A file the person changed since, a file reached through a link, and a
 * copy that was there before init are left alone.
 * @param states - The states {@link claudeFileStates} recorded before init
 */
export function tidyClaudeSettings(states: Record<string, ClaudeFileState>): void {
  for (const [file, state] of Object.entries(states)) {
    try {
      tidyClaudeFile(file, state);
    } catch {
      // Left as the core wrote it; nothing init added is in it any more.
    }
  }
}

function tidyClaudeFile(file: string, state: ClaudeFileState): void {
  const target = resolved(file);
  const backup = `${target}${BACKUP_SUFFIX}`;
  const current = readJson(target);
  const ownBackup = !state.backup && exists(backup);
  if (state.existed) {
    if (!ownBackup || current === undefined) return;
    const original = fs.readFileSync(backup);
    let saved: unknown;
    try {
      saved = JSON.parse(original.toString('utf8')) as unknown;
    } catch {
      return;
    }
    if (!sameJson(saved, current)) return;
    writeKeepingMode(target, original.toString('utf8'), 0o600);
    fs.rmSync(backup, { force: true });
    return;
  }
  const linked = fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
  if (exists(target) && (linked || !isEmptyObject(current))) return;
  if (ownBackup) fs.rmSync(backup, { force: true });
  fs.rmSync(target, { force: true });
  if (!state.dir) removeEmptyDir(path.dirname(file));
}

/**
 * Removes what turning off an OpenCode plugin init installed left behind:
 * the core's off marker (`agent-relay.js.off`), and the plugins folder when
 * init created it and nothing else is in it. Only where there was neither a
 * plugin file nor a marker before init: a marker that was there is the
 * person's choice (or the desktop app's), and a marker the core did not
 * write is not touched. Run once the core has turned the plugin off.
 * @param state - The state {@link openCodeState} recorded before init
 */
export function tidyOpenCodePlugin(state: OpenCodeState): void {
  if (state.plugin || state.off) return;
  if (exists(state.file)) return;
  const marker = `${state.file}${OPENCODE_OFF_SUFFIX}`;
  try {
    if (fs.readFileSync(marker, 'utf8').startsWith(OPENCODE_OFF_TEXT)) fs.rmSync(marker, { force: true });
  } catch {
    // No marker.
  }
  if (!state.dir) removeEmptyDir(path.dirname(state.file));
}

/**
 * Removes what turning off a Pi extension init installed left behind: the
 * core's off marker (`pi-extension.off`), which would otherwise keep the
 * desktop app from installing the extension and keep Pi sessions off, and
 * the extensions folder when init created it and nothing else is in it.
 * Nothing where there was an extension file before init. A marker that was
 * there (`off`) is the person's choice (or the desktop app's) and is kept,
 * though an extensions folder init created still goes once empty; a marker
 * the core did not write is not touched. Run once the core has
 * turned the extension off.
 * @param state - The state {@link piState} recorded before init
 */
export function tidyPiExtension(state: PiState): void {
  if (state.extension || exists(state.file)) return;
  if (!state.off) {
    try {
      if (fs.readFileSync(state.marker, 'utf8').startsWith(PI_OFF_TEXT))
        fs.rmSync(state.marker, { force: true });
    } catch {
      // No marker.
    }
  }
  if (!state.dir) removeEmptyDir(path.dirname(state.file));
}
