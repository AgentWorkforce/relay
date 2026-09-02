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
const INHERITED_CASE_ENVIRONMENT_KEYS = ['PATH', 'LANG', 'LC_ALL', 'SYSTEMROOT', 'WINDIR'];
const CASE_ENVIRONMENT_KEYS = [
  ...INHERITED_CASE_ENVIRONMENT_KEYS,
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'CI',
  'AGENT_RELAY_TELEMETRY_DISABLED',
  'RELAY_PR_PROOF_ARM',
  'RELAY_PR_PROOF_CASE_ID',
  'RELAY_PR_PROOF_BASE_SHA',
  'RELAY_PR_PROOF_HEAD_SHA',
  'RELAY_PR_PROOF_TARGET_SHA',
  'RELAY_PR_PROOF_TARGET_DIR',
  'RELAY_PR_PROOF_HARNESS_DIR',
  'RELAY_PR_PROOF_RESULT_PATH',
  'RELAY_PR_PROOF_BROKER_BINARY',
];
const LANDLOCK_CASE_LAUNCHER = String.raw`
import ctypes
import errno
import json
import os
import sys

SYS_LANDLOCK_CREATE_RULESET = 444
SYS_LANDLOCK_ADD_RULE = 445
SYS_LANDLOCK_RESTRICT_SELF = 446
SYS_UNSHARE = 272
SYS_CAPSET = 126
SYS_CLOSE_RANGE = 436
LANDLOCK_CREATE_RULESET_VERSION = 1
LANDLOCK_RULE_PATH_BENEATH = 1
PR_SET_NO_NEW_PRIVS = 38
PR_GET_SECUREBITS = 27
PR_SET_SECUREBITS = 28
PR_CAPBSET_DROP = 24
PR_CAP_AMBIENT = 47
PR_CAP_AMBIENT_CLEAR_ALL = 4
CLONE_NEWNS = 0x00020000
MS_NOSUID = 2
MS_NOEXEC = 8
MS_REC = 16384
MS_PRIVATE = 1 << 18
LINUX_CAPABILITY_VERSION_3 = 0x20080522
SECBIT_NOROOT = 1 << 0
SECBIT_NOROOT_LOCKED = 1 << 1
SECBIT_KEEP_CAPS_LOCKED = 1 << 5
LOCKED_SECUREBITS = SECBIT_NOROOT | SECBIT_NOROOT_LOCKED | SECBIT_KEEP_CAPS_LOCKED

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

class CapHeader(ctypes.Structure):
    _fields_ = [("version", ctypes.c_uint32), ("pid", ctypes.c_int32)]

class CapData(ctypes.Structure):
    _fields_ = [
        ("effective", ctypes.c_uint32),
        ("permitted", ctypes.c_uint32),
        ("inheritable", ctypes.c_uint32),
    ]

libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long
libc.mount.argtypes = [
    ctypes.c_char_p,
    ctypes.c_char_p,
    ctypes.c_char_p,
    ctypes.c_ulong,
    ctypes.c_char_p,
]
libc.mount.restype = ctypes.c_int

def syscall(number, *args):
    result = libc.syscall(number, *args)
    if result < 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
    return result

def mount(source, target, filesystem, flags, data):
    result = libc.mount(
        source.encode() if source is not None else None,
        target.encode(),
        filesystem.encode() if filesystem is not None else None,
        flags,
        data.encode() if data is not None else None,
    )
    if result != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error), target)

try:
    original_uid = int(sys.argv[1])
    original_gid = int(sys.argv[2])
except (IndexError, ValueError) as error:
    raise RuntimeError("secure broker execution requires numeric caller uid and gid") from error
if original_uid <= 0 or original_gid <= 0:
    raise RuntimeError("secure broker execution refuses a root caller uid or gid")
if os.geteuid() != 0 or os.getegid() != 0:
    raise RuntimeError("secure broker execution requires its fixed trusted sudo bootstrap")

syscall(SYS_UNSHARE, ctypes.c_int(CLONE_NEWNS))
mount(None, "/", None, MS_REC | MS_PRIVATE, None)
mount(
    "devpts",
    "/dev/pts",
    "devpts",
    MS_NOSUID | MS_NOEXEC,
    "newinstance,ptmxmode=0666,mode=0600,max=64",
)
if os.path.realpath("/dev/ptmx") != "/dev/pts/ptmx":
    raise RuntimeError("secure broker execution requires /dev/ptmx to resolve inside private devpts")
if any(entry.isdecimal() for entry in os.listdir("/dev/pts")):
    raise RuntimeError("secure broker execution requires a fresh empty private devpts instance")
try:
    controlling_tty = os.open("/dev/tty", os.O_WRONLY | os.O_CLOEXEC)
except OSError as error:
    if error.errno not in (errno.ENXIO, errno.ENODEV, errno.ENOENT):
        raise
else:
    os.close(controlling_tty)
    raise RuntimeError("secure broker execution refuses an inherited controlling TTY")

if libc.prctl(PR_SET_SECUREBITS, LOCKED_SECUREBITS, 0, 0, 0) != 0:
    error = ctypes.get_errno()
    raise OSError(error, os.strerror(error))
with open("/proc/sys/kernel/cap_last_cap", "r", encoding="ascii") as cap_file:
    last_capability = int(cap_file.read().strip())
for capability in range(last_capability + 1):
    if libc.prctl(PR_CAPBSET_DROP, capability, 0, 0, 0) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
if libc.prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0) != 0:
    error = ctypes.get_errno()
    raise OSError(error, os.strerror(error))

os.setgroups([])
os.setresgid(original_gid, original_gid, original_gid)
os.setresuid(original_uid, original_uid, original_uid)
cap_header = CapHeader(LINUX_CAPABILITY_VERSION_3, 0)
cap_data = (CapData * 2)()
syscall(SYS_CAPSET, ctypes.byref(cap_header), ctypes.byref(cap_data))

if os.getresuid() != (original_uid, original_uid, original_uid):
    raise RuntimeError("secure broker execution did not restore the caller uid")
if os.getresgid() != (original_gid, original_gid, original_gid) or os.getgroups():
    raise RuntimeError("secure broker execution did not restore the caller gid without groups")
with open("/proc/self/status", "r", encoding="utf-8") as status_file:
    status_values = {
        line.split(":", 1)[0]: line.split(":", 1)[1].strip()
        for line in status_file
        if ":" in line
    }
for capability_set in ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"):
    encoded = status_values.get(capability_set)
    if encoded is None or int(encoded, 16) != 0:
        raise RuntimeError(f"secure broker execution requires zero {capability_set}")
if libc.prctl(PR_GET_SECUREBITS, 0, 0, 0, 0) != LOCKED_SECUREBITS:
    raise RuntimeError("secure broker execution requires locked non-root securebits")

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

writable_roots = json.loads(sys.argv[3])
if not isinstance(writable_roots, list) or not writable_roots:
    raise RuntimeError("Landlock writable roots are required")
for writable_root in writable_roots:
    if not isinstance(writable_root, str) or not os.path.isabs(writable_root):
        raise RuntimeError("Landlock writable roots must be absolute paths")
    allow_path(writable_root, MUTATION_RIGHTS)

for writable_device in ("/dev/null", "/dev/ptmx"):
    if os.path.exists(writable_device):
        allow_path(writable_device, WRITE_FILE)

allow_path("/dev/pts", WRITE_FILE)

if libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
    error = ctypes.get_errno()
    raise OSError(error, os.strerror(error))
with open("/proc/self/status", "r", encoding="utf-8") as status_file:
    no_new_privs = next(
        (line.split()[1] for line in status_file if line.startswith("NoNewPrivs:")),
        None,
    )
if no_new_privs != "1":
    raise RuntimeError("secure broker execution requires NoNewPrivs=1")
syscall(SYS_LANDLOCK_RESTRICT_SELF, ruleset_fd, ctypes.c_uint32(0))
os.close(ruleset_fd)

case_environment = json.loads(sys.argv[4])
if not isinstance(case_environment, dict) or any(
    not isinstance(key, str) or not isinstance(value, str)
    for key, value in case_environment.items()
):
    raise RuntimeError("secure broker execution requires a string-to-string case environment")
command = sys.argv[5]
syscall(
    SYS_CLOSE_RANGE,
    ctypes.c_uint(3),
    ctypes.c_uint(0xFFFFFFFF),
    ctypes.c_uint(0),
)
os.execvpe(command, [command, *sys.argv[6:]], case_environment)
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
    await Promise.all([
      access('/usr/bin/python3', fsConstants.X_OK),
      access('/usr/bin/sudo', fsConstants.X_OK),
    ]);
  } catch {
    throw new Error(
      'secure broker execution requires executable /usr/bin/python3 and /usr/bin/sudo in the Cloud proof sandbox'
    );
  }
  if (!Array.isArray(writableRoots) || writableRoots.some((root) => !path.isAbsolute(root))) {
    throw new Error('Landlock writable roots must be absolute paths');
  }
  const originalUid = process.getuid?.();
  const originalGid = process.getgid?.();
  if (
    !Number.isSafeInteger(originalUid) ||
    !Number.isSafeInteger(originalGid) ||
    originalUid <= 0 ||
    originalGid <= 0
  ) {
    throw new Error('secure broker execution requires a non-root numeric caller uid and gid');
  }
  const caseEnvironment =
    options.env ??
    Object.fromEntries(
      INHERITED_CASE_ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]).filter(
        (entry) => typeof entry[1] === 'string' && entry[1]
      )
    );
  if (
    typeof caseEnvironment !== 'object' ||
    Array.isArray(caseEnvironment) ||
    Object.entries(caseEnvironment).some(
      ([key, value]) =>
        !CASE_ENVIRONMENT_KEYS.includes(key) ||
        key.includes('=') ||
        key.includes('\0') ||
        typeof value !== 'string' ||
        value.includes('\0')
    )
  ) {
    throw new Error('secure broker execution requires a string-to-string case environment');
  }
  return runProcess(
    '/usr/bin/sudo',
    [
      '-n',
      '--',
      '/usr/bin/python3',
      '-I',
      '-S',
      '-c',
      LANDLOCK_CASE_LAUNCHER,
      String(originalUid),
      String(originalGid),
      JSON.stringify(writableRoots),
      JSON.stringify(caseEnvironment),
      command,
      ...args,
    ],
    { ...options, env: caseEnvironment }
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
  const env = Object.fromEntries(
    INHERITED_CASE_ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]).filter(
      (entry) => typeof entry[1] === 'string' && entry[1]
    )
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
