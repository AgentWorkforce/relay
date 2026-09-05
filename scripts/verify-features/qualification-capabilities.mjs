#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function run(cli, args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NO_COLOR: '1' },
  });
  return {
    args,
    status: result.status,
    output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    error: result.error?.message,
  };
}

const SHA40 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

function validEffect(id, effects) {
  const effect = effects?.[id];
  if (!effect || effect.status !== 'PASS') return false;
  if (id === 'candidate-snapshot-selector') {
    return (
      PROVIDER_ID.test(effect.requestedSnapshotId ?? '') &&
      effect.requestedSnapshotId === effect.observedSnapshotId &&
      SHA40.test(effect.sourceGitSha ?? '') &&
      SHA256.test(effect.snapshotManifestSha256 ?? '') &&
      effect.candidateMode === true
    );
  }
  if (id === 'ephemeral-cloud-workspace-create') {
    const ids = effect.workspaceIds;
    const files = effect.credentialFiles;
    return (
      Array.isArray(ids) &&
      ids.length === 2 &&
      new Set(ids).size === 2 &&
      ids.every((value) => UUID.test(value)) &&
      Array.isArray(files) &&
      files.length === 2 &&
      files.every((entry) => ids.includes(entry.workspaceId) && entry.mode === '0600')
    );
  }
  if (id === 'qualified-relayfile-cloud-binding') {
    return (
      typeof effect.requestedDeploymentId === 'string' &&
      effect.requestedDeploymentId.length > 0 &&
      effect.requestedDeploymentId === effect.observedDeploymentId &&
      SHA40.test(effect.sourceGitSha ?? '') &&
      SHA256.test(effect.attestationSha256 ?? '')
    );
  }
  if (id === 'relayfile-258-mib-fleet-auto-mount') {
    return (
      Array.isArray(effect.sandboxIds) &&
      effect.sandboxIds.length === 3 &&
      new Set(effect.sandboxIds).size === 3 &&
      effect.sandboxIds.every((value) => UUID.test(value)) &&
      PROVIDER_ID.test(effect.deploymentId ?? '') &&
      SHA40.test(effect.sourceGitSha ?? '') &&
      SHA256.test(effect.attestationSha256 ?? '') &&
      SHA256.test(effect.endpointIdentitySha256 ?? '') &&
      effect.mountEntrypoint === 'agent-relay fleet spawn --sandbox' &&
      effect.mountMode === 'fleet-auto-mount' &&
      effect.scaleFiles === 851 &&
      effect.scaleDirectories === 454 &&
      effect.scaleBytes === 270_532_608 &&
      effect.scaleManifestSha256 === '905968a14268ec5e8ec38ae1d6b24749e855cac035976a87a65ef43f6612a55a' &&
      Number.isSafeInteger(effect.totalBulkRequests) &&
      effect.totalBulkRequests >= 3 &&
      effect.totalPointRequests === 0 &&
      Number.isSafeInteger(effect.maxCpuMs) &&
      effect.maxCpuMs >= 0 &&
      effect.maxCpuMs <= 120_000 &&
      Number.isSafeInteger(effect.maxPeakRssBytes) &&
      effect.maxPeakRssBytes > 0 &&
      effect.maxPeakRssBytes <= 3 * 1024 * 1024 * 1024 &&
      Array.isArray(effect.exactMarkerHashes) &&
      effect.exactMarkerHashes.length === 3 &&
      effect.exactMarkerHashes.every((value) => SHA256.test(value)) &&
      effect.exactCleanup === true
    );
  }
  if (id === 'ephemeral-cloud-workspace-delete') {
    return (
      Array.isArray(effect.workspaceIds) &&
      effect.workspaceIds.length === 2 &&
      new Set(effect.workspaceIds).size === 2 &&
      effect.workspaceIds.every((value) => UUID.test(value)) &&
      effect.cloudAbsent === true &&
      effect.relayfileAbsent === true &&
      effect.relaycastAbsent === true &&
      effect.fleetAbsent === true &&
      effect.credentialsAbsent === true &&
      effect.registryAbsent === true &&
      Number.isFinite(effect.elapsedSeconds) &&
      effect.elapsedSeconds >= 0 &&
      effect.elapsedSeconds <= 120
    );
  }
  return false;
}

export function assessQualificationCapabilities(executions, effects = {}) {
  const requirements = [
    {
      id: 'candidate-snapshot-selector',
      command: ['fleet', 'spawn', '--help'],
      pattern: /--sandbox-snapshot\b[\s\S]*--sandbox-snapshot-manifest-sha256\b/,
    },
    {
      id: 'ephemeral-cloud-workspace-create',
      command: ['cloud', 'workspace', 'create', '--help'],
      pattern: /--ephemeral\b[\s\S]*--ttl\b[\s\S]*--credential-file\b/,
    },
    {
      id: 'qualified-relayfile-cloud-binding',
      command: ['cloud', 'workspace', 'create', '--help'],
      pattern: /--relayfile-cloud-deployment\b/,
    },
    {
      id: 'relayfile-258-mib-fleet-auto-mount',
      command: ['fleet', 'spawn', '--help'],
      pattern: /--sandbox\b[\s\S]*--sandbox-relayfile-path\b[\s\S]*--no-sandbox-relayfile\b/,
    },
    {
      id: 'ephemeral-cloud-workspace-delete',
      command: ['cloud', 'workspace', 'delete', '--help'],
      pattern: /--confirm\b[\s\S]*--verify-cascade\b/,
    },
  ];
  const results = requirements.map((requirement) => {
    const execution = executions.find(
      (candidate) => JSON.stringify(candidate.args) === JSON.stringify(requirement.command)
    );
    const available =
      execution?.status === 0 && !execution.error && requirement.pattern.test(String(execution.output ?? ''));
    const effectPass = validEffect(requirement.id, effects);
    return {
      id: requirement.id,
      command: requirement.command,
      available,
      effectStatus: effectPass ? 'PASS' : 'BLOCKED',
      status: available && effectPass ? 'PASS' : 'BLOCKED',
    };
  });
  return {
    availabilityReady: results.every(({ available }) => available),
    ready: results.every(({ status }) => status === 'PASS'),
    results,
  };
}

function main() {
  const cliIndex = process.argv.indexOf('--cli');
  const cli = cliIndex >= 0 ? process.argv[cliIndex + 1] : undefined;
  if (!cli) throw new Error('usage: qualification-capabilities.mjs --cli <built-cli>');
  const effectIndex = process.argv.indexOf('--effect-evidence');
  const effectPath = effectIndex >= 0 ? process.argv[effectIndex + 1] : undefined;
  const availabilityOnly = process.argv.includes('--availability-only');
  if (!availabilityOnly && !effectPath) {
    throw new Error('--effect-evidence is required unless --availability-only is explicit');
  }
  const resolved = path.resolve(cli);
  const commands = [
    ['fleet', 'spawn', '--help'],
    ['cloud', 'workspace', 'create', '--help'],
    ['cloud', 'workspace', 'delete', '--help'],
  ];
  const effects = effectPath ? JSON.parse(readFileSync(path.resolve(effectPath), 'utf8')) : {};
  const assessment = assessQualificationCapabilities(
    commands.map((args) => run(resolved, args)),
    effects
  );
  process.stdout.write(`${JSON.stringify(assessment, null, 2)}\n`);
  if (availabilityOnly && !assessment.availabilityReady) {
    throw new Error(
      `release qualification commands are unavailable: ${assessment.results
        .filter(({ available }) => !available)
        .map(({ id }) => id)
        .join(', ')}`
    );
  }
  if (!availabilityOnly && !assessment.ready) {
    throw new Error(
      `release qualification is blocked by missing product capabilities: ${assessment.results
        .filter(({ status }) => status !== 'PASS')
        .map(({ id }) => id)
        .join(', ')}`
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
