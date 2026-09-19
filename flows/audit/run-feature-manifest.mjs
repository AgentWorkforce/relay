#!/usr/bin/env node

/**
 * Generate, check, and run `relay.audit.feature-manifest`, then report the
 * audit's own verdict as this process's exit code.
 *
 * v1 did the exit-code derivation after `wf.run()` returned, inside the flow
 * file. A generated spec is run by the `flows` CLI, whose exit code says
 * whether the RUN succeeded, not whether the manifest drifted — and those are
 * different questions: a clean run that found drift must still exit 1 so a
 * scheduler sees it without reading logs. So the derivation moves here,
 * reading the same `audit-exit.txt` the `enforce` step reads.
 *
 *   0  manifest matches the derived surface
 *   1  drift — an issue and draft PR were opened
 *   2  the audit could not run, or the harness broke
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

// Must match ARTIFACTS in flows/audit/feature-manifest.spec.ts exactly.
const ARTIFACTS = '.workflow-artifacts/audit-feature-manifest';
const SPEC = '.workflow-artifacts/flows/relay.audit.feature-manifest.json';

function run(command, args) {
  const { status } = spawnSync(command, args, { stdio: 'inherit' });
  return status ?? 2;
}

const generated = run(process.execPath, [
  '--experimental-strip-types',
  'flows/audit/feature-manifest.spec.ts',
  '--out',
  SPEC,
]);
if (generated !== 0) {
  console.error('[audit-feature-manifest] could not generate the flow spec');
  process.exit(2);
}
// Preflight before running: a spec that cannot resolve its CLI should say so
// rather than fail midway through an audit.
if (run('npx', ['flows', 'check', SPEC]) !== 0) {
  console.error('[audit-feature-manifest] flows check refused the generated spec');
  process.exit(2);
}
run('npx', ['flows', 'run', SPEC]);

const exitFile = `${ARTIFACTS}/audit-exit.txt`;
if (!existsSync(exitFile)) {
  console.error(
    `[audit-feature-manifest] no ${exitFile} — the audit step did not complete. ` +
      'Treating as harness breakage.'
  );
  process.exit(2);
}

const auditExit = Number(readFileSync(exitFile, 'utf8').trim());
let report = null;
const reportFile = `${ARTIFACTS}/audit.json`;
if (existsSync(reportFile)) {
  try {
    report = JSON.parse(readFileSync(reportFile, 'utf8'));
  } catch {
    report = null;
  }
}

if (auditExit === 0) {
  console.log('[audit-feature-manifest] manifest is clean');
  process.exit(0);
}
if (auditExit === 1) {
  const undocumented = report?.undocumentedCommands ?? [];
  const stale = report?.staleCommands ?? [];
  console.error(
    `[audit-feature-manifest] DRIFT: ${undocumented.length} undocumented, ${stale.length} stale. ` +
      'Undocumented commands are unverified commands.'
  );
  process.exit(1);
}
console.error(`[audit-feature-manifest] the audit could not run (exit ${auditExit})`);
process.exit(2);
