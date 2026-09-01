#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  ARTIFACT_ROOT,
  INPUT_PATH,
  PR_PROOF_VERSION,
  PrProofContractError,
  validateCaseManifest,
  validateObservation,
  validateProofInput,
} from './contract.mjs';
import { uploadCloudEvidence, validateCloudEvidenceEnvironment } from './cloud-storage.mjs';
import { runBoundedProcess } from './process-runner.mjs';
import { loadBrokerArtifact } from './stage-broker-artifacts.mjs';

const MAX_OBSERVATION_FILE_BYTES = 64 * 1024;
const LANDLOCK_CASE_LAUNCHER = String.raw`
import ctypes
import json
import os
import sys

SYS_LANDLOCK_CREATE_RULESET = 444
SYS_LANDLOCK_ADD_RULE = 445
SYS_LANDLOCK_RESTRICT_SELF = 446
LANDLOCK_CREATE_RULESET_VERSION = 1
LANDLOCK_RULE_PATH_BENEATH = 1
PR_SET_NO_NEW_PRIVS = 38

WRITE_FILE = 1 << 1
REMOVE_DIR = 1 << 4
REMOVE_FILE = 1 << 5
MAKE_CHAR = 1 << 6
MAKE_DIR = 1 << 7
MAKE_REG = 1 << 8
MAKE_SOCK = 1 << 9
MAKE_FIFO = 1 << 10
MAKE_BLOCK = 1 << 11
MAKE_SYM = 1 << 12
REFER = 1 << 13
TRUNCATE = 1 << 14
MUTATION_RIGHTS = (
    WRITE_FILE
    | REMOVE_DIR
    | REMOVE_FILE
    | MAKE_CHAR
    | MAKE_DIR
    | MAKE_REG
    | MAKE_SOCK
    | MAKE_FIFO
    | MAKE_BLOCK
    | MAKE_SYM
    | REFER
    | TRUNCATE
)

class RulesetAttr(ctypes.Structure):
    _fields_ = [("handled_access_fs", ctypes.c_uint64)]

class PathBeneathAttr(ctypes.Structure):
    _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32)]

libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long

with open("/proc/self/status", "r", encoding="utf-8") as status_file:
    status_lines = status_file.readlines()
effective_capabilities = next(
    (int(line.split()[1], 16) for line in status_lines if line.startswith("CapEff:")),
    None,
)
if effective_capabilities is None:
    raise RuntimeError("secure broker execution could not determine effective Linux capabilities")
CAP_SYS_PTRACE = 19
CAP_SYS_ADMIN = 21
for capability, name in (
    (CAP_SYS_PTRACE, "CAP_SYS_PTRACE"),
    (CAP_SYS_ADMIN, "CAP_SYS_ADMIN"),
):
    if effective_capabilities & (1 << capability):
        raise RuntimeError(f"secure broker execution refuses {name}")

def syscall(number, *args):
    result = libc.syscall(number, *args)
    if result < 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
    return result

abi = syscall(
    SYS_LANDLOCK_CREATE_RULESET,
    ctypes.c_void_p(),
    ctypes.c_size_t(0),
    ctypes.c_uint32(LANDLOCK_CREATE_RULESET_VERSION),
)
if abi < 3:
    raise RuntimeError(f"secure broker execution requires Landlock ABI >= 3, found {abi}")

ruleset_attr = RulesetAttr(MUTATION_RIGHTS)
ruleset_fd = syscall(
    SYS_LANDLOCK_CREATE_RULESET,
    ctypes.byref(ruleset_attr),
    ctypes.sizeof(ruleset_attr),
    ctypes.c_uint32(0),
)

def allow_path(path, rights):
    path_fd = os.open(path, os.O_PATH | os.O_CLOEXEC)
    try:
        rule = PathBeneathAttr(rights, path_fd)
        syscall(
            SYS_LANDLOCK_ADD_RULE,
            ruleset_fd,
            ctypes.c_uint32(LANDLOCK_RULE_PATH_BENEATH),
            ctypes.byref(rule),
            ctypes.c_uint32(0),
        )
    finally:
        os.close(path_fd)

writable_roots = json.loads(sys.argv[1])
if not isinstance(writable_roots, list) or not writable_roots:
    raise RuntimeError("Landlock writable roots are required")
for writable_root in writable_roots:
    if not isinstance(writable_root, str) or not os.path.isabs(writable_root):
        raise RuntimeError("Landlock writable roots must be absolute paths")
    allow_path(writable_root, MUTATION_RIGHTS)

for writable_device in ("/dev/null", "/dev/tty", "/dev/ptmx"):
    if os.path.exists(writable_device):
        allow_path(writable_device, WRITE_FILE)

if libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
    error = ctypes.get_errno()
    raise OSError(error, os.strerror(error))
syscall(SYS_LANDLOCK_RESTRICT_SELF, ruleset_fd, ctypes.c_uint32(0))
os.close(ruleset_fd)

command = sys.argv[2]
os.execvpe(command, [command, *sys.argv[3:]], os.environ)
`;

async function readObservationFile(filePath) {
  const resultFile = await open(
    filePath,
    fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW
  );
  try {
    const resultStat = await resultFile.stat();
    if (!resultStat.isFile()) throw new Error('observation must be a regular, non-symlink file');

    const chunks = [];
    let totalBytes = 0;
    while (totalBytes <= MAX_OBSERVATION_FILE_BYTES) {
      const chunk = Buffer.alloc(Math.min(16 * 1024, MAX_OBSERVATION_FILE_BYTES + 1 - totalBytes));
      const { bytesRead } = await resultFile.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      totalBytes += bytesRead;
    }
    if (totalBytes > MAX_OBSERVATION_FILE_BYTES) {
      throw new Error(`observation must be no larger than ${MAX_OBSERVATION_FILE_BYTES} bytes`);
    }
    return Buffer.concat(chunks, totalBytes).toString('utf8');
  } finally {
    await resultFile.close();
  }
}

export async function runProcess(command, args, options = {}) {
  return runBoundedProcess(command, args, options);
}

async function runChecked(command, args, options = {}) {
  const result = await runProcess(command, args, options);
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error(
      `${command} ${args.join(' ')} ${result.timedOut ? 'timed out' : `failed with exit ${result.exitCode}`}${result.signal ? ` (${result.signal})` : ''}`
    );
  }
  return result;
}

async function checkout(repository, sha, destination) {
  const remote = `https://github.com/${repository}.git`;
  await mkdir(destination, { recursive: true });
  await runChecked('git', ['init', '--quiet', destination]);
  await runChecked('git', ['-C', destination, 'remote', 'add', 'origin', remote]);
  await runChecked('git', ['-C', destination, 'fetch', '--quiet', '--depth=1', 'origin', sha], {
    timeoutMs: 5 * 60_000,
  });
  await runChecked('git', ['-C', destination, 'checkout', '--quiet', '--detach', 'FETCH_HEAD']);
  const result = await runChecked('git', ['-C', destination, 'rev-parse', 'HEAD']);
  const actual = result.stdout.trim();
  if (actual !== sha) throw new Error(`checkout provenance mismatch: expected ${sha}, got ${actual}`);
  return actual;
}

export async function runLandlockedProcess(command, args, { writableRoots, ...options }) {
  try {
    await access('/usr/bin/python3', fsConstants.X_OK);
  } catch {
    throw new Error(
      'secure broker execution requires executable /usr/bin/python3 in the Cloud proof sandbox'
    );
  }
  if (!Array.isArray(writableRoots) || writableRoots.some((root) => !path.isAbsolute(root))) {
    throw new Error('Landlock writable roots must be absolute paths');
  }
  return runProcess(
    '/usr/bin/python3',
    ['-c', LANDLOCK_CASE_LAUNCHER, JSON.stringify(writableRoots), command, ...args],
    options
  );
}

export async function openVerifiedBrokerExecutable({ input, arm, privateRoot, root = process.cwd() }) {
  const artifact = input.runtimeArtifacts?.broker?.[arm];
  if (!artifact) return null;
  if (process.platform !== 'linux') {
    throw new Error('broker-linux-x64 proof artifacts require a Linux proof sandbox');
  }
  const artifactPath = path.resolve(root, artifact.path);
  const expectedRoot = path.join(root, '.relayflow', 'pr-proof-binaries') + path.sep;
  if (!artifactPath.startsWith(expectedRoot)) throw new Error('broker artifact escaped its staging root');
  const loaded = await loadBrokerArtifact({
    arm,
    expectedSha: arm === 'base' ? input.baseSha : input.headSha,
    root,
  });
  if (JSON.stringify(loaded.artifact) !== JSON.stringify(artifact)) {
    throw new Error('broker artifact does not match its proof input binding');
  }
  if (!path.isAbsolute(privateRoot)) {
    throw new Error('private broker root must be an absolute path');
  }

  const privateDirectory = path.join(privateRoot, `verified-broker-${arm}`);
  const privatePath = path.join(privateDirectory, 'agent-relay-broker');
  await mkdir(privateDirectory, { mode: 0o700 });
  await writeFile(privatePath, loaded.contents, { flag: 'wx', mode: 0o500 });
  await chmod(privatePath, 0o500);
  const handle = await open(privatePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== loaded.contents.length) {
      throw new Error('private broker copy is not the verified regular file');
    }
    const privateSha256 = createHash('sha256')
      .update(await handle.readFile())
      .digest('hex');
    if (privateSha256 !== loaded.artifact.sha256) {
      throw new Error('private broker copy changed before execution binding');
    }
    await handle.close();
    await chmod(privateDirectory, 0o500);
    return {
      path: privatePath,
      directory: privateDirectory,
      sha256: loaded.artifact.sha256,
      size: loaded.contents.length,
    };
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(privateDirectory, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyProtectedBrokerExecutable({ brokerPath, expectedSha256, expectedSize }) {
  const handle = await open(brokerPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== expectedSize || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o500) {
      throw new Error('protected broker inode metadata changed during case execution');
    }
    const actualSha256 = createHash('sha256')
      .update(await handle.readFile())
      .digest('hex');
    if (actualSha256 !== expectedSha256) {
      throw new Error('protected broker bytes changed during case execution');
    }
  } finally {
    await handle.close();
  }
}

function sanitizedCaseEnvironment({
  temporaryHome,
  targetDir,
  harnessDir,
  resultPath,
  scratchDir,
  input,
  arm,
  brokerPath,
}) {
  const allowed = ['PATH', 'LANG', 'LC_ALL', 'SYSTEMROOT', 'WINDIR'];
  const env = Object.fromEntries(
    allowed.map((key) => [key, process.env[key]]).filter((entry) => typeof entry[1] === 'string' && entry[1])
  );
  return {
    ...env,
    HOME: temporaryHome,
    TMPDIR: scratchDir,
    TMP: scratchDir,
    TEMP: scratchDir,
    CI: '1',
    AGENT_RELAY_TELEMETRY_DISABLED: '1',
    RELAY_PR_PROOF_ARM: arm,
    RELAY_PR_PROOF_CASE_ID: input.caseId,
    RELAY_PR_PROOF_BASE_SHA: input.baseSha,
    RELAY_PR_PROOF_HEAD_SHA: input.headSha,
    RELAY_PR_PROOF_TARGET_SHA: arm === 'base' ? input.baseSha : input.headSha,
    RELAY_PR_PROOF_TARGET_DIR: targetDir,
    RELAY_PR_PROOF_HARNESS_DIR: harnessDir,
    RELAY_PR_PROOF_RESULT_PATH: resultPath,
    ...(brokerPath ? { RELAY_PR_PROOF_BROKER_BINARY: brokerPath } : {}),
  };
}

function armFromArg() {
  const arm = process.argv[2];
  if (arm !== 'base' && arm !== 'head') throw new Error('Usage: run-arm.mjs <base|head> [input-path]');
  return arm;
}

export async function main() {
  const arm = armFromArg();
  const inputPath = process.argv[3] ?? process.env.RELAY_PR_PROOF_INPUT ?? INPUT_PATH;
  const input = validateProofInput(JSON.parse(await readFile(inputPath, 'utf8')));
  const sandboxId = process.env.SANDBOX_ID?.trim();
  if (!sandboxId) throw new Error('SANDBOX_ID is required; this proof arm must run as a Cloud step');
  // Validate the Cloud evidence handoff before checking out or executing any
  // PR-authored code, so a misconfigured proof cannot do work it cannot attest.
  validateCloudEvidenceEnvironment(input, arm);

  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), `relay-pr-proof-${arm}-`));
  const harnessDir = path.join(temporaryRoot, 'harness');
  const targetDir = path.join(temporaryRoot, 'target');
  const temporaryHome = path.join(temporaryRoot, 'home');
  const resultDir = path.join(temporaryRoot, 'result');
  const resultPath = path.join(resultDir, 'observation.json');
  const scratchDir = path.join(temporaryRoot, 'scratch');
  const brokerDirectory = path.join(temporaryRoot, `verified-broker-${arm}`);
  const targetSha = arm === 'base' ? input.baseSha : input.headSha;
  const evidencePath = path.join(ARTIFACT_ROOT, `${arm}.json`);

  try {
    await Promise.all(
      [temporaryHome, resultDir, scratchDir].map((directory) => mkdir(directory, { recursive: true }))
    );
    const harnessSha = await checkout(input.repository, input.headSha, harnessDir);
    const actualTargetSha = await checkout(input.repository, targetSha, targetDir);

    const manifestPath = path.join(harnessDir, 'tests', 'relayflows', 'cases', input.caseId, 'case.json');
    const headManifest = validateCaseManifest(JSON.parse(await readFile(manifestPath, 'utf8')), {
      caseId: input.caseId,
      kind: input.kind,
    });
    if (JSON.stringify(headManifest) !== JSON.stringify(input.manifest)) {
      throw new Error('Staged case manifest does not match the exact PR head checkout');
    }
    const brokerExecutable = await openVerifiedBrokerExecutable({
      input,
      arm,
      privateRoot: temporaryRoot,
    });
    const brokerPath = brokerExecutable?.path ?? null;

    const [command, ...args] = input.manifest.runner.command;
    const processOptions = {
      cwd: harnessDir,
      env: sanitizedCaseEnvironment({
        temporaryHome,
        targetDir,
        harnessDir,
        resultPath,
        scratchDir,
        input,
        arm,
        brokerPath,
      }),
      timeoutMs: input.manifest.timeoutSeconds * 1000,
    };
    const result = brokerExecutable
      ? await runLandlockedProcess(command, args, {
          ...processOptions,
          writableRoots: [temporaryHome, harnessDir, targetDir, resultDir, scratchDir],
        })
      : await runProcess(command, args, processOptions);
    if (result.timedOut) {
      throw new Error(
        `Case runner exceeded ${input.manifest.timeoutSeconds}s; a timeout cannot count as expected-red evidence`
      );
    }
    if (result.exitCode !== 0) {
      throw new Error(
        `Case runner failed with exit ${result.exitCode}; expected-red behavior must be reported as a successful structured observation`
      );
    }
    if (brokerExecutable) {
      await verifyProtectedBrokerExecutable({
        brokerPath: brokerExecutable.path,
        expectedSha256: brokerExecutable.sha256,
        expectedSize: brokerExecutable.size,
      });
    }

    let observationJson;
    try {
      observationJson = JSON.parse(await readObservationFile(resultPath));
    } catch (error) {
      throw new PrProofContractError('Case runner did not write a valid observation JSON file', [
        error instanceof Error ? error.message : String(error),
      ]);
    }
    const observation = validateObservation(observationJson, {
      caseId: input.caseId,
      arm,
      expected: input.manifest.expected[arm],
    });
    const evidence = {
      version: PR_PROOF_VERSION,
      caseId: input.caseId,
      arm,
      repository: input.repository,
      pullRequest: input.pullRequest,
      targetSha: actualTargetSha,
      harnessSha,
      handoffNonce: input.handoffNonce,
      sandboxId,
      runnerExitCode: result.exitCode,
      outcome: observation.outcome,
      signature: observation.signature,
      details: observation.details,
      capturedStdout: result.stdout.slice(-8_000),
      capturedStderr: result.stderr.slice(-8_000),
      completedAt: new Date().toISOString(),
    };
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    await uploadCloudEvidence(input, arm, evidence);
    console.log(`PR_PROOF_ARM_COMPLETE arm=${arm} case=${input.caseId} sandbox=${sandboxId}`);
  } finally {
    try {
      await chmod(brokerDirectory, 0o700).catch((error) => {
        if (error?.code !== 'ENOENT') throw error;
      });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    if (error instanceof PrProofContractError) {
      for (const detail of error.details) console.error(`- ${detail}`);
    }
    process.exitCode = 1;
  });
}
