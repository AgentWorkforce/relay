#!/usr/bin/env node
import './config.mjs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { captureGitProvenance, verifyGitProvenance } from './git-provenance.mjs';
import { PROBE_TIMEOUT_MS } from './probes.mjs';
const execFileAsync = promisify(execFile);
const BUNDLE_TIMEOUT_MS = 900_000;
const dir =
  process.env.RELAYFILE_QUALIFICATION_ARTIFACT_DIR ??
  '.workflow-artifacts/relayfile-cross-repo-qualification';
const runId = process.env.RELAYFILE_QUALIFICATION_RUN_ID ?? '';
const candidates = {
  cloud: process.env.RELAY_CLOUD_REPO ?? process.env.RELAYFILE_CLOUD_CANDIDATE ?? '../cloud',
  relayfile: process.env.RELAYFILE_REPO ?? '../relayfile',
  'relayfile-cloud': process.env.RELAYFILE_CLOUD_REPO ?? '../relayfile-cloud',
};
// Child build commands run from candidate repositories. Keep every generated
// artifact anchored to the qualification runner's cwd so a relative artifact
// directory can never be interpreted inside (and dirty) a candidate checkout.
const out = path.resolve(dir, 'bundle');
const preflightPath = path.resolve(dir, 'preflight.json');
function validRunId(value) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(value);
}
let preflight;
try {
  preflight = JSON.parse(await readFile(preflightPath, 'utf8'));
} catch {
  throw new Error('qualification preflight is missing; bundle creation is blocked');
}
if (!validRunId(runId) || preflight.runId !== runId)
  throw new Error('qualification preflight run ID does not match the requested run');
if (
  preflight.status !== 'READY' ||
  preflight.sandboxCreationAuthorized !== true ||
  process.env.RELAYFILE_QUALIFICATION_CREATE_SANDBOXES !== '1'
)
  throw new Error('qualification preflight is not READY and authorized; bundle creation is blocked');
const candidatePaths = Object.values(candidates).map((candidate) => path.resolve(candidate));
if (new Set(candidatePaths).size !== 3)
  throw new Error('cloud, relayfile, and relayfile-cloud candidates must be three distinct paths');
const requiredProbeModels = { codex: 'gpt-5.6-luna', claude: 'sonnet' };
if (!Array.isArray(preflight.modelProbes) || preflight.modelProbes.length !== 2)
  throw new Error('qualification preflight model probe proof is missing; bundle creation is blocked');
for (const [name, model] of Object.entries(requiredProbeModels)) {
  const probe = preflight.modelProbes.find((value) => value?.name === name);
  if (!probe || probe.model !== model || probe.timeoutMs !== PROBE_TIMEOUT_MS || probe.ok !== true)
    throw new Error(`qualification preflight ${name} model probe did not pass; bundle creation is blocked`);
}
await mkdir(out, { recursive: true });
const artifacts = {};
const gitCandidates = await captureGitProvenance(candidates, { execFileAsync });
for (const [name, repo] of Object.entries(candidates)) {
  const list = path.join(out, `${name}.files`);
  const archive = path.join(out, `${name}.tgz`);
  const listed = await execFileAsync('git', ['-C', repo, 'ls-files', '-co', '--exclude-standard', '-z'], {
    timeout: BUNDLE_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  await writeFile(list, listed.stdout, 'utf8');
  await execFileAsync(
    'python3',
    [
      '-c',
      `import gzip,os,sys,tarfile\nrepo,listing,archive=sys.argv[1:]\nwith open(archive,'wb') as raw:\n  with gzip.GzipFile(fileobj=raw,mode='wb',mtime=0,compresslevel=9) as gz:\n    with tarfile.open(fileobj=gz,mode='w') as tf:\n      for rel in sorted(x for x in open(listing,'rb').read().decode().split('\\0') if x):\n        p=os.path.join(repo,rel)\n        def normalize(info):\n          info.uid=0; info.gid=0; info.uname=''; info.gname=''; info.mtime=0\n          return info\n        tf.add(p,arcname=rel,recursive=False,filter=normalize)`,
      repo,
      list,
      archive,
    ],
    { timeout: BUNDLE_TIMEOUT_MS, killSignal: 'SIGKILL' }
  );
  const bytes = await readFile(archive);
  artifacts[name] = {
    archive: path.basename(archive),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.byteLength,
  };
}
const mountBinary = path.join(out, 'relayfile-mount-linux-amd64');
await execFileAsync(
  'go',
  ['build', '-trimpath', '-buildvcs=false', '-ldflags=-buildid=', '-o', mountBinary, './cmd/relayfile-mount'],
  {
    cwd: candidates.relayfile,
    env: { ...process.env, GOOS: 'linux', GOARCH: 'amd64', CGO_ENABLED: '0' },
    timeout: BUNDLE_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  }
);
const mountBytes = await readFile(mountBinary);
await verifyGitProvenance(candidates, gitCandidates, { execFileAsync });
const candidateProvenance = Object.fromEntries(
  Object.entries(gitCandidates).map(([name, provenance]) => [
    name,
    { ...provenance, archive: artifacts[name].archive, sha256: artifacts[name].sha256 },
  ])
);
await writeFile(
  path.join(out, 'bundle-manifest.json'),
  `${JSON.stringify({ version: 1, runId, artifacts, candidateProvenance, relayfileMount: { file: path.basename(mountBinary), sha256: createHash('sha256').update(mountBytes).digest('hex'), bytes: mountBytes.byteLength, target: 'linux/amd64', goBuild: 'CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -buildvcs=false -ldflags=-buildid=' } }, null, 2)}\n`
);
console.log(
  `QUALIFICATION_BUNDLE_READY run_id=${runId} cloud=${artifacts.cloud.sha256} relayfile=${artifacts.relayfile.sha256} relayfile_cloud=${artifacts['relayfile-cloud'].sha256}`
);
