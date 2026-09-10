import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
const arm = await readFile(new URL('./arm.mjs', import.meta.url), 'utf8');
const workflow = await readFile(new URL('./workflow.ts', import.meta.url), 'utf8');
const bundle = await readFile(new URL('./bundle.mjs', import.meta.url), 'utf8');
const gitProvenance = await readFile(new URL('./git-provenance.mjs', import.meta.url), 'utf8');
const aggregate = await readFile(new URL('./aggregate.mjs', import.meta.url), 'utf8');
const evidenceAggregate = await readFile(new URL('./aggregate-evidence.mjs', import.meta.url), 'utf8');
const signoff = await readFile(new URL('./record-signoff.mjs', import.meta.url), 'utf8');
const acceptance = await readFile(new URL('./final-acceptance.mjs', import.meta.url), 'utf8');
const absence = await readFile(new URL('./absence.mjs', import.meta.url), 'utf8');
const issue490Probe = await readFile(new URL('./issue-490-probe.mjs', import.meta.url), 'utf8');
const createBlock = arm.slice(
  arm.indexOf('const create = await run'),
  arm.indexOf('created = create.exitCode')
);

test('arm uses one immutable bundle, deterministic installs, and the relayfile-cloud cwd', () => {
  assert.match(arm, /bundle-manifest\.json/);
  assert.match(arm, /immutable bundle belongs to a different run ID/);
  assert.match(arm, /npm ci --no-audit --no-fund/);
  assert.match(arm, /'--cwd',\s*'\/qualification\/relayfile-cloud'/);
  assert.match(arm, /pollUntilAbsent/);
  assert.match(arm, /preflight\.status !== 'READY'/);
  assert.match(arm, /copied .* archive hash does not match/);
  assert.match(arm, /timeout: options\.timeoutMs/);
  assert.match(arm, /DAYTONA_CONTEXT_CLEANUP/);
  assert.match(arm, /path\.join\(bundleDir, 'bundle-manifest\.json'\)/);
  assert.match(arm, /candidateProvenance/);
  assert.match(arm, /\[0-9a-f\]\{40\}/);
  assert.match(arm, /apt-get install -y --no-install-recommends procps ca-certificates/);
  assert.match(arm, /rm -rf \/var\/lib\/apt\/lists\/\*/);
  assert.match(arm, /RELAY_PR_PROOF_RESULT_PATH=\/tmp\/workspace-acl-provisioning-admission\.json/);
  assert.match(arm, /const value = JSON\.parse\(exactText\)/);
  assert.match(arm, /\.\.\.toVitestEvidenceSummary\(cloudResult\)/);
  assert.match(arm, /\.\.\.toVitestEvidenceSummary\(relayResult\)/);
  assert.doesNotMatch(arm, /\.\.\.cloudResult/);
  assert.doesNotMatch(arm, /\.\.\.relayResult/);
  assert.match(arm, /exact\.stdout.*populated only by cat'ing RELAY_PR_PROOF_RESULT_PATH/);
  assert.doesNotMatch(arm, /lastIndexOf\('\n\{'\)/);
  assert.match(arm, /let createAttempted = false/);
  assert.match(arm, /cleanupEvidence\.attempted = createAttempted/);
  assert.match(arm, /const runTest[\s\S]*timeoutMs: 300_000/);
  assert.match(createBlock, /timeoutMs: 900_000/);
  assert.match(arm, /Always probe the generated[\s\S]*name after the delete attempt/);
  assert.match(arm, /cleanupEvidence\.sandboxAbsent = await verifyAbsent\(target\)/);
  assert.match(arm, /npm pack relayfile@\$\{npmVersion\}/);
  assert.match(arm, /sha256sum \/tmp\/relayfile-npm\/relayfile-\$\{npmVersion\}\.tgz/);
  assert.match(arm, /release-attestation\.json/);
  assert.match(arm, /RELAYFILE_QUALIFICATION_RELEASE_ATTESTATION_SHA256/);
  assert.doesNotMatch(arm, /npm view relayfile@\$\{npmVersion\} gitHead/);
  assert.match(arm, /issue490Evidence/);
  assert.match(arm, /issue-490-probe\.mjs/);
  assert.match(issue490Probe, /node_modules\/\.bin\/relayfile/);
  assert.match(arm, /@relayfile\/mount-linux-x64\/bin\/relayfile-mount/);
  assert.doesNotMatch(issue490Probe, /go test/);
  assert.match(issue490Probe, /onceWsUpgradeCount = wsUpgradeCount/);
  assert.match(issue490Probe, /issue-490-\$\{entrypoint\}-state\/state\.json/);
  assert.match(issue490Probe, /child\.once\('error'/);
  assert.match(issue490Probe, /Date\.now\(\) \+ 10_000/);
  assert.match(issue490Probe, /workspaceId: 'issue-490', providers: \[\]/);
  assert.match(issue490Probe, /aud: 'relayfile', agent_name/);
  assert.match(arm, /legs: \{ coldMount, acl, issue490 \}/);
});

test('fan-out depends on the single bundle step and fresh phase identities', () => {
  assert.match(workflow, /dependsOn: \['bundle-candidates'\]/);
  for (const phase of ['review', 'fix', 'final-review'])
    assert.match(workflow, new RegExp(`\\$\\{provider\\}-${phase}`));
  assert.doesNotMatch(workflow, /final-fix/);
  assert.doesNotMatch(workflow, /timeoutMs/);
  assert.doesNotMatch(workflow, /RELAYFILE_QUALIFICATION_RUN_ID=\$\{/);
  assert.match(workflow, /qualification\/\$\{RUN_ID\}/);
  assert.match(workflow, /aggregate-evidence\.mjs/);
  assert.match(workflow, /final-acceptance\.mjs/);
  assert.match(workflow, /dependsOn: \['write-report'\]/);
  assert.match(workflow, /failOnError: true/);
  assert.match(workflow, /\$\{ARTIFACT_DIR\}\/preflight\.json/);
  assert.match(workflow, /immutable bundle/);
  assert.match(workflow, /Adjudicate every finding/);
  assert.match(workflow, /BLOCKED verdict for this run/);
  assert.match(workflow, /import \{ ClaudeModels \} from '@agent-relay\/config'/);
  assert.match(workflow, /model: provider === 'claude' \? ClaudeModels\.SONNET : 'gpt-5\.6-luna'/);
  assert.doesNotMatch(workflow, /GPT_5_1_CODEX_MINI/);
  assert.match(workflow, /capture-integrity\.mjs/);
  assert.match(workflow, /verify-integrity\.mjs/);
  assert.match(workflow, /steps\.capture-integrity\.output/);
});

test('real-run preflight probes reviewer auth and model with bounded exact commands', async () => {
  const preflight = await readFile(new URL('./preflight.mjs', import.meta.url), 'utf8');
  const probes = await readFile(new URL('./probes.mjs', import.meta.url), 'utf8');
  assert.match(preflight, /runProbe\(probe/);
  assert.match(preflight, /modelProbes/);
  assert.match(preflight, /timeoutMs: PROBE_TIMEOUT_MS/);
  assert.match(preflight, /failure: 'probe skipped because sandbox creation is disabled'/);
  assert.match(preflight, /RELAYFILE_QUALIFICATION_NPM_VERSION/);
  assert.match(preflight, /RELAYFILE_QUALIFICATION_NPM_TARBALL_SHA256/);
  assert.match(preflight, /RELAYFILE_QUALIFICATION_NPM_SOURCE_SHA/);
  assert.match(probes, /'gpt-5\.6-luna'/);
  assert.match(probes, /model: 'gpt-5\.6-luna'/);
  assert.match(probes, /model: 'sonnet'/);
  assert.match(probes, /'--ephemeral'/);
  assert.match(probes, /'--ignore-rules'/);
  assert.match(probes, /'--permission-mode',\s*'plan'/);
  assert.match(probes, /PROBE_TIMEOUT_MS = 30_000/);
  assert.match(probes, /PROBE_KILL_SIGNAL = 'SIGKILL'/);
  assert.doesNotMatch(preflight, /--version/);
});

test('delayed Daytona deletion uses bounded backoff polling', () => {
  assert.match(absence, /while \(now\(\) < deadline\)/);
  assert.match(absence, /initialDelayMs = 250/);
  assert.match(absence, /Math\.min\(delayMs \* 2, maxDelayMs\)/);
  assert.match(absence, /inventoryAbsent\(target, run, deadline, now\)/);
  assert.match(absence, /timeoutMs: Math\.min\(10_000, remaining\)/);
  assert.match(absence, /--cursor/);
  assert.match(acceptance, /aggregate\?\.runId[\s\S]*aggregate\?\.verdict !== 'PASS'/);
  assert.match(acceptance, /verifiedByScript !== true/);
});

test('bundle archive normalizes metadata for identical arm hashes', () => {
  assert.match(bundle, /mtime=0/);
  assert.match(bundle, /sorted\(/);
  assert.match(bundle, /git', \['-C', repo, 'ls-files', '-co'/);
  assert.match(gitProvenance, /'status', '--porcelain=v1'/);
  assert.match(gitProvenance, /'rev-parse', 'HEAD'/);
  assert.match(bundle, /captureGitProvenance/);
  assert.match(bundle, /verifyGitProvenance/);
  assert.match(gitProvenance, /became dirty during bundle creation/);
  assert.match(gitProvenance, /git HEAD changed during bundle creation/);
  assert.match(bundle, /candidateProvenance/);
  assert.match(gitProvenance, /full 40-hex commit/);
  assert.match(bundle, /preflight is not READY/);
  assert.match(bundle, /GOOS: 'linux'/);
  assert.match(bundle, /relayfile-mount-linux-amd64/);
  assert.match(bundle, /const out = path\.resolve\(dir, 'bundle'\)/);
  assert.match(bundle, /const preflightPath = path\.resolve\(dir, 'preflight\.json'\)/);
  assert.match(bundle, /path\.join\(out, 'bundle-manifest\.json'\)/);
  assert.match(bundle, /BUNDLE_TIMEOUT_MS/);
  assert.match(bundle, /killSignal: 'SIGKILL'/);
});

test('evidence aggregation is independent from final signoff aggregation', () => {
  assert.match(evidenceAggregate, /requireSignoffs: false/);
  assert.match(aggregate, /aggregate-evidence\.json/);
  assert.match(aggregate, /COMPREHENSIVELY_SATISFIED/);
  assert.match(signoff, /finalReview\?\.value\?\.verdict !== 'COMPREHENSIVELY_SATISFIED'/);
});
