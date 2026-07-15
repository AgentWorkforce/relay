/**
 * Reflex feature state.
 *
 * A single global toggle stored at `~/.agentworkforce/reflex.json` (NOT
 * per-repo). Written by `agent-relay reflex on/off`; read by the runtime to
 * decide whether to capture + push session history to relayhistory-cloud
 * in-process. This module is the single source of truth for the file shape and
 * location so the command and the runtime never drift.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ReflexState {
  enabled: boolean;
  enabledAt?: string;
}

function reflexDir(home: string = homedir()): string {
  return join(home, '.agentworkforce');
}

/** Absolute path to the reflex state file (`~/.agentworkforce/reflex.json`). */
export function getReflexStateFile(home: string = homedir()): string {
  return join(reflexDir(home), 'reflex.json');
}

/** Read the reflex state, or `null` when it was never written / is malformed. */
export function readReflexState(home: string = homedir()): ReflexState | null {
  const file = getReflexStateFile(home);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as ReflexState;
  } catch {
    return null;
  }
}

/** Persist the reflex state (creates `~/.agentworkforce/` as needed). */
export function writeReflexState(state: ReflexState, home: string = homedir()): void {
  mkdirSync(reflexDir(home), { recursive: true });
  writeFileSync(getReflexStateFile(home), JSON.stringify(state, null, 2), 'utf-8');
}

/** Whether Reflex capture is currently enabled. */
export function isReflexEnabled(home: string = homedir()): boolean {
  return readReflexState(home)?.enabled === true;
}
