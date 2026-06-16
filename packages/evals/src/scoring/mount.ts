/**
 * Filesystem scoring utilities for agents that use a relayfile writeback mount.
 *
 * The writeback pattern: an agent writes a JSON file to a path under the
 * .integrations/ mount (e.g. .integrations/slack/channels/<id>/messages/msg.json)
 * and the relayfile writeback consumer picks it up and dispatches to the provider.
 *
 * Usage:
 *   const snapshot = snapshotMount(fixtureDir)
 *   // ... spawn agent, wait for exit ...
 *   const newFiles = newMountFiles(fixtureDir, snapshot)
 *   const score = scoreMountRun({ mountDir: fixtureDir, newFiles, expectedPathPrefix, events })
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import type { BrokerEvent } from '@agent-relay/harness-driver';

// ── Types ─────────────────────────────────────────────────────────────────────

/** Per-dimension scoring for one mount writeback eval run. */
export interface MountScore {
  /** Agent created at least one file under the mount root. */
  wroteSomething: boolean;
  /** File(s) landed under the expected path prefix (correct provider + resource). */
  correctPath: boolean;
  /** All files at the expected path are syntactically valid JSON. */
  jsonValid: boolean;
  /** Agent wrote under discovery/ — schema-only, must never happen. */
  discoveryViolation: boolean;
  /** Agent sent at least one relay_inbound message instead of/in addition to writing a file. */
  usedRelayMessaging: boolean;
  /** Agent exited cleanly rather than timing out. */
  cleanExit: boolean;
  /** Overall pass: correctPath && jsonValid && !discoveryViolation. */
  pass: boolean;
  /** All files created by the agent, relative to mountDir. */
  filesWritten: string[];
  /** Subset of filesWritten that match expectedPathPrefix. */
  filesAtCorrectPath: string[];
}

/** Options for scoreMountRun(). */
export interface ScoreMountRunOptions {
  /** Root of the .integrations/ mount directory (absolute path). */
  mountDir: string;
  /** Files created by the agent since spawning (from newMountFiles). */
  newFiles: string[];
  /**
   * Expected path prefix the writeback file must be under (relative to mountDir).
   * Example: ".integrations/slack/channels/C12345__general/messages/"
   */
  expectedPathPrefix: string;
  /** Broker events captured during the run. */
  events: BrokerEvent[];
  /** Whether the agent exited without timing out. Defaults to true. */
  cleanExit?: boolean;
}

/** Summary stats across repeated runs of one scenario×variant cell. */
export interface MountCellStats {
  runs: number;
  passed: number;
  passRate: number;
  wroteSomethingRate: number;
  correctPathRate: number;
  discoveryViolationRate: number;
  usedRelayMessagingRate: number;
}

// ── Mount file tracking ───────────────────────────────────────────────────────

function walkDir(dir: string, out: Set<string>): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    entry.isDirectory() ? walkDir(full, out) : out.add(full);
  }
}

/**
 * Snapshot all file paths currently under mountDir.
 * Call before spawning the agent; diff with newMountFiles after.
 */
export function snapshotMount(mountDir: string): Set<string> {
  const existing = new Set<string>();
  walkDir(mountDir, existing);
  return existing;
}

/**
 * Return absolute paths of files under mountDir that weren't in the snapshot.
 * These are the files the agent created during the run.
 */
export function newMountFiles(mountDir: string, snapshot: Set<string>): string[] {
  const current = new Set<string>();
  walkDir(mountDir, current);
  return [...current].filter((f) => !snapshot.has(f));
}

// ── Scoring ───────────────────────────────────────────────────────────────────

/**
 * Score an agent run against a mount writeback scenario.
 *
 * Pass = agent wrote to the correct path, the file is valid JSON, and it did
 * NOT write under discovery/.
 */
export function scoreMountRun(opts: ScoreMountRunOptions): MountScore {
  const { mountDir, newFiles, expectedPathPrefix, events, cleanExit = true } = opts;

  const relFiles = newFiles.map((f) => relative(mountDir, f));
  const inExpectedPath = relFiles.filter((p) => p.startsWith(expectedPathPrefix));
  const inDiscovery = relFiles.filter(
    (p) => p.includes('/discovery/') || p.startsWith('discovery/'),
  );

  const jsonValid =
    inExpectedPath.length > 0 &&
    inExpectedPath.every((p) => {
      try {
        JSON.parse(readFileSync(join(mountDir, p), 'utf8'));
        return true;
      } catch {
        return false;
      }
    });

  const usedRelayMessaging = events.some((e) => e.kind === 'relay_inbound');

  return {
    wroteSomething: relFiles.length > 0,
    correctPath: inExpectedPath.length > 0,
    jsonValid,
    discoveryViolation: inDiscovery.length > 0,
    usedRelayMessaging,
    cleanExit,
    pass: inExpectedPath.length > 0 && jsonValid && inDiscovery.length === 0,
    filesWritten: relFiles,
    filesAtCorrectPath: inExpectedPath,
  };
}

// ── Aggregate stats ───────────────────────────────────────────────────────────

/**
 * Roll up repeated MountScore results into pass-rate statistics for one cell
 * (scenario × variant) in a report matrix.
 */
export function mountCellStats(scores: MountScore[]): MountCellStats {
  const n = scores.length;
  if (n === 0)
    return {
      runs: 0,
      passed: 0,
      passRate: 0,
      wroteSomethingRate: 0,
      correctPathRate: 0,
      discoveryViolationRate: 0,
      usedRelayMessagingRate: 0,
    };
  const rate = (pred: (s: MountScore) => boolean) => scores.filter(pred).length / n;
  return {
    runs: n,
    passed: scores.filter((s) => s.pass).length,
    passRate: rate((s) => s.pass),
    wroteSomethingRate: rate((s) => s.wroteSomething),
    correctPathRate: rate((s) => s.correctPath),
    discoveryViolationRate: rate((s) => s.discoveryViolation),
    usedRelayMessagingRate: rate((s) => s.usedRelayMessaging),
  };
}
