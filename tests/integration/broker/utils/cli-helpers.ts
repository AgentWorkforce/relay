/**
 * CLI availability helpers for real CLI integration tests.
 *
 * Provides skip logic, CLI detection, and shared test utilities
 * for spawning actual AI CLI tools (claude, codex, gemini, aider, goose, droid, opencode).
 */
import { execSync } from 'node:child_process';
import type { TestContext } from 'node:test';

/**
 * Check if a CLI binary is available on PATH.
 */
export function isCliAvailable(cli: string): boolean {
  try {
    execSync(`which ${cli}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Skip the test if the given CLI is not installed.
 * Returns true if skipped.
 */
export function skipIfCliMissing(t: TestContext, cli: string): boolean {
  if (!isCliAvailable(cli)) {
    t.skip(`${cli} CLI not found on PATH`);
    return true;
  }
  return false;
}

/**
 * Skip all real CLI tests unless RELAY_INTEGRATION_REAL_CLI=1 is set.
 * This prevents slow, resource-heavy tests from running in regular CI.
 * Returns true if skipped.
 */
export function skipIfNotRealCli(t: TestContext): boolean {
  if (process.env.RELAY_INTEGRATION_REAL_CLI !== '1') {
    t.skip('Set RELAY_INTEGRATION_REAL_CLI=1 to run real CLI tests');
    return true;
  }
  return false;
}

/**
 * Sleep helper.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const PREFERRED_CLIS = ['claude', 'codex', 'gemini', 'aider', 'goose', 'droid', 'opencode'];

/**
 * Return the first available CLI from the preference list, or null.
 */
export function firstAvailableCli(): string | null {
  for (const cli of PREFERRED_CLIS) {
    if (isCliAvailable(cli)) return cli;
  }
  return null;
}

/**
 * Skip unless at least one real CLI is available.
 * Returns the CLI name if found, or null if skipped.
 */
export function skipUnlessAnyCli(t: TestContext): string | null {
  if (skipIfNotRealCli(t)) return null;
  const cli = firstAvailableCli();
  if (!cli) {
    t.skip('No supported CLI found on PATH');
    return null;
  }
  return cli;
}
