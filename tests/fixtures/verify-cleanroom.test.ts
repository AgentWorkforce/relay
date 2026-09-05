import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

// Dependency-free ESM is shared with the Cloud lane sandboxes.
// @ts-expect-error JavaScript module intentionally has no declaration file.
import {
  aggregateMarkdown,
  aggregateRecords,
  captureBoundedOutput,
  cleanEnvironment,
  freshAttemptContext,
  loadCatalog,
  parseFeatureManifest,
  readBoundedResponseText,
  redactEvidence,
  routeInventory,
  validateCloudApiBaseUrl,
  validateCleanroomSeal,
  validateGithubApiUrl,
  validateLaneEvidence,
  validateReviewDraftPath,
  validateReviewProvenance,
  verifyWriteOnceStorage,
} from '../../scripts/verify-features/cleanroom.mjs';

const NONCE = 'a'.repeat(32);

function syntheticProcess(command: string[], mustContain: string[] = []) {
  const now = '2026-09-05T00:00:00.000Z';
  const stdout = mustContain.join('\n');
  return {
    argv: [...command],
    cwd: '/clean/checkout',
    startedAt: now,
    completedAt: now,
    exitCode: 0,
    signal: null,
    timedOut: false,
    leakedProcessGroup: false,
    processGroupCleaned: true,
    error: null,
    stdout,
    stderr: '',
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

function syntheticLaneRecord(matrix: any, profile: string, laneId: string, scope: any, sandboxId: string) {
  const lane = matrix.lanes.find(({ id }: { id: string }) => id === laneId);
  const repeatsFor = (spec: any) => spec.repeats?.[profile] ?? matrix.profiles[profile].defaultRepeats;
  const setupSpecs = [...matrix.commonSetup, ...lane.setup].filter(
    (spec: any) => !spec.profiles || spec.profiles.includes(profile)
  );
  const scenarios = lane.scenarios
    .filter((spec: any) => !spec.profiles || spec.profiles.includes(profile))
    .map((spec: any) => {
      const kind = spec.kind ?? 'command';
      if (kind === 'coverage-gap') {
        return {
          id: spec.id,
          title: spec.title,
          evidence: spec.evidence,
          status: 'blocked',
          reason: spec.reason,
        };
      }
      const repeats = repeatsFor(spec);
      if (kind === 'relayflow-corpus') {
        const attempts = Array.from({ length: repeats }, (_, index) => ({
          attempt: index + 1,
          status: 'pass',
          expectedSignature: 'fixed',
          actualSignature: 'fixed',
          reason: '',
          process: syntheticProcess(['node', 'fixture-corpus-runner']),
        }));
        return {
          id: spec.id,
          title: spec.title,
          evidence: spec.evidence,
          status: 'pass',
          cases: [{ caseId: 'fixture-case', issue: null, status: 'pass', attempts }],
        };
      }
      return {
        id: spec.id,
        title: spec.title,
        evidence: spec.evidence,
        status: 'pass',
        reason: '',
        attempts: Array.from({ length: repeats }, (_, index) => ({
          attempt: index + 1,
          status: 'pass',
          reason: '',
          process: syntheticProcess(spec.command, spec.mustContain),
        })),
      };
    });
  const setup = setupSpecs.map((spec: any) => ({
    id: spec.id,
    status: 'pass',
    reason: '',
    process: syntheticProcess(spec.command, spec.mustContain),
  }));
  return {
    version: 1,
    kind: 'lane',
    nonce: NONCE,
    product: matrix.product,
    profile,
    lane: laneId,
    sandboxId,
    commit: 'f'.repeat(40),
    matrixSha256: 'a'.repeat(64),
    runnerSha256: 'b'.repeat(64),
    startedAt: '2026-09-05T00:00:00.000Z',
    completedAt: '2026-09-05T00:01:00.000Z',
    assignedIssues: scope.issueAssignments[laneId] ?? [],
    assignedMerges: scope.mergeAssignments[laneId] ?? [],
    setup,
    artifacts: Object.fromEntries(
      (lane.requiredArtifacts ?? []).map((name: string) => [
        name,
        { path: matrix.artifacts[name], size: 1, sha256: 'c'.repeat(64) },
      ])
    ),
    scenarios,
    cleanup: { status: 'pass', reason: '' },
    status: scenarios.some(({ status }: { status: string }) => status === 'blocked') ? 'blocked' : 'pass',
  };
}

describe('clean-room verification catalog', () => {
  it('accounts for every feature manifest category exactly once', async () => {
    const source = await readFile('.agentworkforce/features/manifest.yaml', 'utf8');
    const categories = parseFeatureManifest(source);
    const catalog = await loadCatalog('tests/relayflows/cleanroom/relay.matrix.json');

    expect(categories).toHaveLength(29);
    expect(categories.flatMap(({ features }: { features: string[] }) => features)).toHaveLength(194);
    expect(catalog.matrix.lanes).toHaveLength(8);
  });

  it('routes every inventory record to one lane and preserves ambiguous matches', async () => {
    const { matrix } = await loadCatalog('tests/relayflows/cleanroom/relay.matrix.json');
    const routed = routeInventory(
      [
        { number: 1, title: 'fleet PTY injection stalls', labels: [] },
        { number: 2, title: 'unclassified edge condition', labels: [] },
        { number: 1603, title: 'generic lifecycle failure', labels: [] },
      ],
      matrix.lanes
    );

    expect(
      Object.values(routed)
        .flat()
        .map(({ number }: { number: number }) => number)
    ).toEqual([1, 1603, 2]);
    expect(routed['fleet-injection-attach'][0].matchedLanes).toContainEqual({
      id: 'fleet-injection-attach',
      score: 3,
    });
    expect(routed['regression-corpus'][0].number).toBe(2);
    expect(routed['fleet-injection-attach'][1]).toMatchObject({
      number: 1603,
      routingReason: 'explicit-issue-number',
    });
  });

  it('only marks explicitly named features as verified', async () => {
    const { matrix, categories } = await loadCatalog('tests/relayflows/cleanroom/relay.matrix.json');
    const profile = 'smoke';
    const category = categories.find(({ id }: { id: string }) => id === 'workspace');
    const lane = matrix.lanes.find(({ id }: { id: string }) => id === 'workspace-bootstrap');
    const feature = category.features[0];
    const scenario = lane.scenarios.find(({ id }: { id: string }) => id === 'workspace-contract-suite');
    const emptyAssignments = Object.fromEntries(matrix.lanes.map(({ id }: { id: string }) => [id, []]));
    const scope = {
      issues: [],
      recentMerges: [],
      issueAssignments: emptyAssignments,
      mergeAssignments: emptyAssignments,
    };
    const record = syntheticLaneRecord(matrix, profile, lane.id, scope, 'local-test');
    const input = {
      matrix,
      categories,
      profile,
      nonce: NONCE,
      laneRecords: [record],
      scope,
    };

    const sampled = aggregateRecords(input);
    expect(sampled.features.find(({ id }: { id: string }) => id === feature).status).toBe('evidence_gap');

    const originalEvidence = scenario.evidence;
    scenario.coversFeatures = [feature];
    scenario.evidence = matrix.evidencePolicy[category.criticality];
    record.scenarios.find(({ id }: { id: string }) => id === scenario.id).evidence = scenario.evidence;
    const exact = aggregateRecords(input);
    expect(exact.features.find(({ id }: { id: string }) => id === feature).status).toBe('verified');
    delete scenario.coversFeatures;
    scenario.evidence = originalEvidence;
  });

  it('renders a local report without throwing', async () => {
    const { matrix, categories } = await loadCatalog('tests/relayflows/cleanroom/relay.matrix.json');
    const profile = 'smoke';
    const emptyAssignments = Object.fromEntries(matrix.lanes.map(({ id }: { id: string }) => [id, []]));
    const aggregate = aggregateRecords({
      matrix,
      categories,
      profile,
      nonce: NONCE,
      laneRecords: [],
      scope: {
        issues: [{ number: 99, title: 'unproved behavior' }],
        recentMerges: [],
        issueAssignments: {
          ...emptyAssignments,
          'regression-corpus': [{ number: 99, title: 'unproved behavior' }],
        },
        mergeAssignments: emptyAssignments,
      },
    });

    expect(aggregateMarkdown(aggregate)).toContain('#99 [regression-corpus] unproved behavior');
  });

  it('keeps declared coverage gaps yellow and product failures red', async () => {
    const { matrix, categories } = await loadCatalog('tests/relayflows/cleanroom/relay.matrix.json');
    const profile = 'full';
    const emptyAssignments = Object.fromEntries(matrix.lanes.map(({ id }: { id: string }) => [id, []]));
    const scope = {
      issues: [],
      recentMerges: [],
      issueAssignments: emptyAssignments,
      mergeAssignments: emptyAssignments,
    };
    const laneRecords = matrix.profiles[profile].lanes.map((laneId: string, index: number) =>
      syntheticLaneRecord(matrix, profile, laneId, scope, `cloud-sandbox-${index}`)
    );

    const yellow = aggregateRecords({ matrix, categories, scope, laneRecords, profile, nonce: NONCE });
    expect(yellow.verdict).toBe('YELLOW');
    expect(yellow.summary.featureCount).toBe(194);
    expect(yellow.summary.featureEvidenceGaps).toBeGreaterThan(0);
    expect(yellow.features.filter(({ status }: { status: string }) => status === 'uncovered')).toHaveLength(
      0
    );

    laneRecords[0].scenarios[0].status = 'fail';
    laneRecords[0].scenarios[0].attempts.forEach(
      (attempt: { status: string; process: { exitCode: number } }) => {
        attempt.status = 'fail';
        attempt.process.exitCode = 1;
      }
    );
    laneRecords[0].status = 'fail';
    expect(() =>
      validateLaneEvidence(laneRecords[0], { matrix, profile, nonce: NONCE, scope })
    ).not.toThrow();
    const red = aggregateRecords({ matrix, categories, scope, laneRecords, profile, nonce: NONCE });
    expect(red.verdict).toBe('RED');
    expect(red.summary.failingOrFlakyScenarios).toBe(1);
  });

  it('rejects reused sandbox provenance and redacts stored credentials', async () => {
    const { matrix, categories } = await loadCatalog('tests/relayflows/cleanroom/relay.matrix.json');
    const profile = 'full';
    const emptyAssignments = Object.fromEntries(matrix.lanes.map(({ id }: { id: string }) => [id, []]));
    const scope = {
      issues: [],
      recentMerges: [],
      issueAssignments: emptyAssignments,
      mergeAssignments: emptyAssignments,
    };
    const laneRecords = matrix.profiles[profile].lanes.map((laneId: string) =>
      syntheticLaneRecord(matrix, profile, laneId, scope, 'cloud-reused')
    );
    const result = aggregateRecords({
      matrix,
      categories,
      profile,
      nonce: NONCE,
      laneRecords,
      scope,
    });

    expect(result.verdict).toBe('INFRA_BLOCKED');
    expect(result.infrastructure.sandboxProblems).toContain('lane sandbox ids are not unique');
    expect(
      redactEvidence('Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz token=rk_live_deadbeef')
    ).not.toContain('deadbeef');
    expect(redactEvidence('custom fixture abcdefgh12345678', ['abcdefgh12345678'])).toBe(
      'custom fixture [REDACTED_DECLARED_SECRET]'
    );
  });

  it('rejects a synthetic passing lane whose command argv does not match the matrix', async () => {
    const { matrix, categories } = await loadCatalog('tests/relayflows/cleanroom/relay.matrix.json');
    const profile = 'smoke';
    const emptyAssignments = Object.fromEntries(matrix.lanes.map(({ id }: { id: string }) => [id, []]));
    const scope = {
      issues: [],
      recentMerges: [],
      issueAssignments: emptyAssignments,
      mergeAssignments: emptyAssignments,
    };
    const record = syntheticLaneRecord(matrix, profile, 'workspace-bootstrap', scope, 'local-fixture');
    record.scenarios[0].attempts[0].process.argv = ['true'];
    const result = aggregateRecords({
      matrix,
      categories,
      profile,
      nonce: NONCE,
      laneRecords: [record],
      scope,
    });

    expect(result.verdict).toBe('INFRA_BLOCKED');
    expect(result.infrastructure.invalidLanes).toContain('workspace-bootstrap');
  });

  it('counts command evidence in bytes and omits overflow instead of verifying a truncated tail', () => {
    const complete = captureBoundedOutput(['prefix-', 'forbidden-marker'], 64);
    expect(complete).toEqual({
      text: 'prefix-forbidden-marker',
      bytes: 23,
      truncated: false,
    });

    const overflow = captureBoundedOutput(['forbidden-marker-', 'rk_live_', 'splitsecret', 'ééé'], 24);
    expect(overflow.truncated).toBe(true);
    expect(overflow.bytes).toBe(Buffer.byteLength('forbidden-marker-rk_live_splitsecretééé'));
    expect(overflow.text).toBe('[OUTPUT OMITTED: exceeded 24 byte evidence limit]');
    expect(overflow.text).not.toContain('splitsecret');
  });

  it('gives every repeated attempt private state and scrubs undeclared credentials', async () => {
    const laneRoot = await mkdtemp(path.join(os.tmpdir(), 'verify-cleanroom-unit-'));
    const laneContext = {
      laneRoot,
      runRoot: laneRoot,
      isolatedEnvironment: { AGENT_RELAY_HOME: 'relay-state' },
      environmentDefaults: { AGENT_RELAY_TELEMETRY_DISABLED: '1' },
    };
    const secretName = 'VERIFY_CLEANROOM_UNDECLARED_TEST_SECRET';
    process.env[secretName] = 'must-not-leak';

    try {
      const first = await freshAttemptContext(laneContext, 'scenario/1');
      const second = await freshAttemptContext(laneContext, 'scenario/2');
      const firstEnv = cleanEnvironment({
        root: first.runRoot,
        isolatedEnvironment: laneContext.isolatedEnvironment,
        environmentDefaults: laneContext.environmentDefaults,
        context: first,
      });
      const secondEnv = cleanEnvironment({
        root: second.runRoot,
        isolatedEnvironment: laneContext.isolatedEnvironment,
        environmentDefaults: laneContext.environmentDefaults,
        context: second,
      });

      expect(firstEnv.HOME).not.toBe(secondEnv.HOME);
      expect(firstEnv.AGENT_RELAY_HOME).not.toBe(secondEnv.AGENT_RELAY_HOME);
      expect(firstEnv[secretName]).toBeUndefined();
      expect(firstEnv.AGENT_RELAY_TELEMETRY_DISABLED).toBe('1');
    } finally {
      delete process.env[secretName];
      await rm(laneRoot, { recursive: true, force: true });
    }
  });

  it('isolates reviewer drafts by campaign nonce and exact role', () => {
    const root = '.workflow-artifacts/verify-cleanroom';
    const exact = path.resolve(root, NONCE, 'draft-final-codex-signoff.json');
    expect(validateReviewDraftPath(exact, root, NONCE, 'final-codex-signoff')).toBe(exact);
    expect(() =>
      validateReviewDraftPath(
        path.resolve(root, 'draft-final-codex-signoff.json'),
        root,
        NONCE,
        'final-codex-signoff'
      )
    ).toThrow(/exact draft path/);
  });

  it('uses atomic write-once evidence records in file-backed campaigns', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'relay-cleanroom-storage-'));
    try {
      await expect(
        verifyWriteOnceStorage({ nonce: NONCE, source: 'files', artifactRoot: root })
      ).resolves.toMatchObject({ value: 'first' });
      const stored = JSON.parse(await readFile(path.join(root, NONCE, 'write-once-probe.json'), 'utf8'));
      expect(stored.value).toBe('first');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('confines evidence and inventory traffic to authenticated HTTPS origins', () => {
    expect(validateCloudApiBaseUrl('https://cloud.example.test/cloud').toString()).toBe(
      'https://cloud.example.test/cloud/'
    );
    expect(validateCloudApiBaseUrl('http://127.0.0.1:8787').toString()).toBe('http://127.0.0.1:8787/');
    expect(() => validateCloudApiBaseUrl('http://cloud.example.test')).toThrow(/HTTPS/);
    expect(() => validateCloudApiBaseUrl('https://user:secret@cloud.example.test')).toThrow(/credentials/);
    expect(validateGithubApiUrl('https://api.github.com/repos/owner/repo/issues').origin).toBe(
      'https://api.github.com'
    );
    expect(() => validateGithubApiUrl('https://attacker.example/link')).toThrow(/GitHub inventory/);
  });

  it('stops reading Cloud evidence when the byte limit is crossed', async () => {
    await expect(readBoundedResponseText(new Response('exact'), 'fixture', 5)).resolves.toBe('exact');
    await expect(readBoundedResponseText(new Response('too-large'), 'fixture', 5)).rejects.toThrow(
      /exceeds 5 bytes/
    );
  });

  it('binds clean-room signoff to the aggregate, matrix, and runner digests', () => {
    const expected = {
      nonce: NONCE,
      product: 'relay',
      profile: 'full',
      aggregateDigest: 'a'.repeat(64),
      matrixSha256: 'b'.repeat(64),
      runnerSha256: 'c'.repeat(64),
    };
    const seal = {
      version: 1,
      kind: 'cleanroom-campaign-seal',
      ...expected,
      createdAt: '2026-09-05T00:00:00.000Z',
    };
    expect(validateCleanroomSeal(seal, expected)).toBe(seal);
    expect(() => validateCleanroomSeal({ ...seal, runnerSha256: 'd'.repeat(64) }, expected)).toThrow(
      /runnerSha256/
    );
  });

  it('binds review provenance to the exact reviewer executor', () => {
    const expected = { nonce: NONCE, product: 'relay', profile: 'full', role: 'codex-review-1' };
    const provenance = {
      version: 1,
      kind: 'review-provenance',
      ...expected,
      sandboxId: 'cloud-123e4567-e89b-12d3-a456-426614174000',
    };
    expect(validateReviewProvenance(provenance, expected)).toBe(provenance);
    expect(() => validateReviewProvenance({ ...provenance, role: 'claude-review-1' }, expected)).toThrow(
      /reviewer executor/
    );
    expect(() =>
      validateReviewProvenance({ ...provenance, sandboxId: 'copied-from-lane' }, expected)
    ).toThrow(/reviewer executor/);
  });

  it('runs lanes in isolated agents and keeps model reviewers offline behind exported evidence', async () => {
    const source = await readFile('workflows/verify-cleanroom.ts', 'utf8');
    const runner = await readFile('scripts/verify-features/cleanroom.mjs', 'utf8');
    expect(source).toMatch(/const laneAgent\s*=\s*`lane-\$\{lane\}`/);
    expect(source).toMatch(/wf\.agent\(laneAgent/);
    expect(source).toMatch(/agent:\s*laneAgent/);
    expect(source).toMatch(/command\(\s*["']review-export["']/);
    expect(source).toMatch(/command\(\s*["']storage-preflight["']\s*\)/);
    expect(source).toMatch(/command\(\s*["']review-upload["']/);
    expect(source).toContain("const sandboxEnvironmentReference = '${SANDBOX_ID}'");
    expect(source).toContain('"sandboxId": "cloud-${sandboxEnvironmentReference} or local-${role}"');
    expect(runner).toContain('review.sandboxId !== provenance.sandboxId');
    expect(runner).toContain('kind: `review-provenance/${role}`');
    expect(source).toContain('agent.permissions = lanePermissions');
    expect(source).toContain("access: 'restricted' as const");
    expect(source).toContain('exec: [reviewProvenanceCommand(role)]');
    expect(source).not.toContain('CLEANROOM_REVIEW_UPLOADED role=${role}');
  });

  it('accepts GitHub workflow paths with or without an attached ref while verifying any present ref', async () => {
    const workflow = await readFile('.github/workflows/relay-cleanroom-qualification.yml', 'utf8');
    expect(workflow).toMatch(/release:\s*\n\s*types:\s*\[prereleased, published\]/);
    expect(workflow).toContain('github.event.release.prerelease == false');
    expect(workflow).toContain('github.event.release.prerelease == true');
    expect(workflow).toContain('Verify the exact published Relay package closure');
    expect(workflow).toMatch(
      /relayWorkflowRef\s*!==\s*undefined\s*&&\s*relayWorkflowRef\s*!==\s*expectedRelayRef/
    );
  });
});
