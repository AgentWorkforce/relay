#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readRegularFileNoFollow } from './safe-file.mjs';

const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const PACKAGE_DIRS = [
  'cli',
  'cloud',
  'config',
  'fleet',
  'harness-driver',
  'harnesses',
  'sdk',
  'session',
  'utils',
];
const REQUIRED_PACKAGE_NAMES = new Set([
  'agent-relay',
  '@agent-relay/cloud',
  '@agent-relay/config',
  '@agent-relay/fleet',
  '@agent-relay/harness-driver',
  '@agent-relay/harnesses',
  '@agent-relay/sdk',
  '@agent-relay/session',
  '@agent-relay/utils',
]);
const PLATFORM_PACKAGE_NAME = /^@agent-relay\/broker-(?:darwin|linux|win32)-(?:arm64|x64)$/;
const CLI_RELATIVE_PATH = 'node_modules/agent-relay/dist/cli/index.js';
const LOCKFILE_NAME = 'candidate-package-lock.json';
const REQUIRED_NPM_VERSION = '10.9.7';
const INSTALL_STRATEGY = 'omit-optional-with-direct-platform-broker';
const NPM_INSTALL_POLICY_ARGS = ['--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund'];
let activePrivateRootHandle;

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requiredString(value, label, pattern) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  const resolved = value.trim();
  if (pattern && !pattern.test(resolved)) throw new Error(`${label} is invalid`);
  return resolved;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function packagePath(root, name) {
  return path.join(packageRoot(root, name), 'package.json');
}

function packageRoot(root, name) {
  const parts = name.startsWith('@') ? name.split('/') : [name];
  return path.join(root, 'node_modules', ...parts);
}

export async function digestInstalledPackageTree(root) {
  const target = path.resolve(root);
  const entries = [];

  async function visit(directory, relativeDirectory = '') {
    const names = (await readdir(directory)).sort((left, right) => left.localeCompare(right, 'en'));
    for (const name of names) {
      const absolute = path.join(directory, name);
      const relative = path.posix.join(relativeDirectory, name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        throw new Error(`installed candidate package contains a symbolic link: ${relative}`);
      }
      if (info.isDirectory()) {
        await visit(absolute, relative);
        continue;
      }
      if (!info.isFile()) {
        throw new Error(`installed candidate package contains a non-regular file: ${relative}`);
      }
      const { bytes, mode } = await readRegularFileNoFollow(absolute, {
        label: `installed candidate package file ${relative}`,
      });
      entries.push({
        path: relative,
        mode: mode.toString(8).padStart(3, '0'),
        size: bytes.length,
        sha256: sha256(bytes),
      });
    }
  }

  await visit(target);
  const manifest = Buffer.from(`${JSON.stringify(entries)}\n`);
  return {
    sha256: sha256(manifest),
    fileCount: entries.length,
    bytes: entries.reduce((total, entry) => total + entry.size, 0),
  };
}

export async function digestInstalledClosureTree(root) {
  const target = path.resolve(root);
  const entries = [];

  async function visit(directory, relativeDirectory = '') {
    const names = (await readdir(directory)).sort((left, right) => left.localeCompare(right, 'en'));
    for (const name of names) {
      const absolute = path.join(directory, name);
      const relative = path.posix.join(relativeDirectory, name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        const linkTarget = await readlink(absolute);
        if (path.isAbsolute(linkTarget) || linkTarget.includes('\\')) {
          throw new Error(`installed candidate closure contains an unsafe symbolic link: ${relative}`);
        }
        const resolved = path.resolve(path.dirname(absolute), linkTarget);
        const relation = path.relative(target, resolved);
        if (relation === '..' || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
          throw new Error(`installed candidate closure contains an escaping symbolic link: ${relative}`);
        }
        entries.push({ path: relative, type: 'symlink', target: linkTarget });
        continue;
      }
      if (info.isDirectory()) {
        await visit(absolute, relative);
        continue;
      }
      if (!info.isFile()) {
        throw new Error(`installed candidate closure contains a non-regular entry: ${relative}`);
      }
      const { bytes, mode } = await readRegularFileNoFollow(absolute, {
        label: `installed candidate closure file ${relative}`,
      });
      entries.push({
        path: relative,
        type: 'file',
        mode: mode.toString(8).padStart(3, '0'),
        size: bytes.length,
        sha256: sha256(bytes),
      });
    }
  }

  await visit(target);
  const manifest = Buffer.from(`${JSON.stringify(entries)}\n`);
  return {
    sha256: sha256(manifest),
    entryCount: entries.length,
    bytes: entries.reduce((total, entry) => total + (entry.size ?? 0), 0),
  };
}

function candidateDependencies(packages) {
  return Object.fromEntries(
    [...packages]
      .sort((left, right) => left.name.localeCompare(right.name, 'en'))
      .map((entry) => [entry.name, `file:../tarballs/${entry.tarballFile}`])
  );
}

function candidateInstallManifest(packages) {
  return {
    name: 'relay-candidate-clean-install',
    private: true,
    version: '0.0.0',
    dependencies: candidateDependencies(packages),
  };
}

function candidateInstallManifestBytes(packages) {
  return `${JSON.stringify(candidateInstallManifest(packages), null, 2)}\n`;
}

export function validateCandidateLockfile(value, packages) {
  const lockfile = object(value, 'candidate package lockfile');
  if (
    lockfile.name !== 'relay-candidate-clean-install' ||
    lockfile.version !== '0.0.0' ||
    lockfile.lockfileVersion !== 3 ||
    lockfile.requires !== true ||
    !lockfile.packages ||
    typeof lockfile.packages !== 'object' ||
    Array.isArray(lockfile.packages)
  ) {
    throw new Error('candidate package lockfile identity is invalid');
  }
  const expectedDependencies = candidateDependencies(packages);
  const root = object(lockfile.packages[''], 'candidate package lockfile root');
  if (
    root.name !== 'relay-candidate-clean-install' ||
    root.version !== '0.0.0' ||
    JSON.stringify(root.dependencies) !== JSON.stringify(expectedDependencies)
  ) {
    throw new Error('candidate package lockfile root dependencies changed');
  }
  const allowedTarballs = new Set(Object.values(expectedDependencies));
  for (const [location, candidate] of Object.entries(lockfile.packages)) {
    const entry = object(candidate, `candidate package lockfile entry ${location || '<root>'}`);
    if (location === '') continue;
    if (
      !location.startsWith('node_modules/') ||
      location.includes('\\') ||
      path.posix.normalize(location) !== location ||
      entry.link === true
    ) {
      throw new Error(`candidate package lockfile has an unsafe package location: ${location}`);
    }
    if (entry.resolved !== undefined) {
      const resolved = requiredString(entry.resolved, `candidate package lockfile ${location}.resolved`);
      if (resolved.startsWith('file:')) {
        if (!allowedTarballs.has(resolved)) {
          throw new Error(`candidate package lockfile has an unexpected file dependency: ${location}`);
        }
      } else {
        let url;
        try {
          url = new URL(resolved);
        } catch {
          throw new Error(`candidate package lockfile has an invalid resolved URL: ${location}`);
        }
        if (
          url.protocol !== 'https:' ||
          url.hostname !== 'registry.npmjs.org' ||
          url.username ||
          url.password
        ) {
          throw new Error(`candidate package lockfile has an untrusted resolved URL: ${location}`);
        }
      }
    }
  }
  return lockfile;
}

function platformPackage(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  const packages = {
    'darwin-arm64': 'broker-darwin-arm64',
    'darwin-x64': 'broker-darwin-x64',
    'linux-arm64': 'broker-linux-arm64',
    'linux-x64': 'broker-linux-x64',
    'win32-x64': 'broker-win32-x64',
  };
  const directory = packages[key];
  if (!directory) throw new Error(`unsupported candidate install platform ${key}`);
  return directory;
}

function brokerRelativePath(platform = process.platform, arch = process.arch) {
  const packageDirectory = platformPackage(platform, arch);
  const binary = platform === 'win32' ? 'agent-relay-broker.exe' : 'agent-relay-broker';
  return path.posix.join('node_modules', '@agent-relay', packageDirectory, 'bin', binary);
}

export function sourceBrokerBuildPlan(platform = process.platform, arch = process.arch) {
  // Validate the same platform/architecture pair that selects the destination
  // package before deriving a build target.
  platformPackage(platform, arch);
  const binary = platform === 'win32' ? 'agent-relay-broker.exe' : 'agent-relay-broker';
  if (platform === 'linux') {
    const target =
      arch === 'x64' ? 'x86_64-unknown-linux-musl' : arch === 'arm64' ? 'aarch64-unknown-linux-musl' : null;
    if (!target) throw new Error(`unsupported portable Linux broker architecture ${arch}`);
    return {
      cargoArgs: ['build', '--locked', '--release', '--bin', 'agent-relay-broker', '--target', target],
      built: path.join('target', target, 'release', binary),
      env: { RUSTFLAGS: '-C target-feature=+crt-static' },
      target,
    };
  }
  return {
    cargoArgs: ['build', '--locked', '--release', '--bin', 'agent-relay-broker'],
    built: path.join('target', 'release', binary),
    env: {},
    target: `${platform}-${arch}-native`,
  };
}

export function sourceBrokerToolchainPlan(
  buildPlan,
  { muslGccAvailable = false, aptGetAvailable = false, sudoAvailable = false, isRoot = false } = {}
) {
  if (!String(buildPlan?.target ?? '').endsWith('-unknown-linux-musl')) return [];
  const commands = [{ command: 'rustup', args: ['target', 'add', buildPlan.target] }];
  if (muslGccAvailable) return commands;
  if (!aptGetAvailable) {
    throw new Error('portable Linux broker staging requires apt-get to provision musl-tools');
  }
  const aptCommand = isRoot ? 'apt-get' : sudoAvailable ? 'sudo' : null;
  if (!aptCommand) {
    throw new Error('portable Linux broker staging requires root or sudo to provision musl-tools');
  }
  const aptPrefix = isRoot ? [] : ['apt-get'];
  commands.push(
    { command: aptCommand, args: [...aptPrefix, 'update'] },
    { command: aptCommand, args: [...aptPrefix, 'install', '-y', 'musl-tools'] }
  );
  return commands;
}

async function executableOnPath(command) {
  for (const directory of String(process.env.PATH ?? '').split(path.delimiter)) {
    if (!directory) continue;
    try {
      await access(path.join(directory, command), fsConstants.X_OK);
      return true;
    } catch {
      // Continue searching PATH.
    }
  }
  return false;
}

async function rejectBundledBrokerContamination() {
  for (const directory of ['packages/sdk/bin', 'packages/harness-driver/bin']) {
    const names = await readdir(directory).catch((error) => {
      if (error?.code === 'ENOENT') return [];
      throw error;
    });
    const brokerFiles = names.filter((name) => name.startsWith('agent-relay-broker'));
    if (brokerFiles.length > 0) {
      throw new Error(
        `${directory} contains an untracked bundled broker; use only the staged platform package`
      );
    }
  }
}

export function privateNpmInvocation(
  args,
  childRoot,
  suffix,
  platform = process.platform,
  parentDescriptorRoot = childRoot
) {
  if (platform !== 'linux') {
    throw new Error('descriptor-bound candidate npm execution is supported only on Linux');
  }
  return {
    args,
    cwd: `${parentDescriptorRoot}${suffix}`,
  };
}

function run(command, args, options = {}) {
  const privateRoot = activePrivateRootHandle;
  const childRoot = privateRoot ? `/proc/self/fd/3` : null;
  const rewritePrivatePath = (value) => {
    if (!privateRoot || !childRoot || typeof value !== 'string') return value;
    for (const root of [privateRoot.root, privateRoot.ioRoot]) {
      if (value === root) return childRoot;
      if (value.startsWith(`${root}${path.sep}`)) {
        return `${childRoot}${value.slice(root.length)}`;
      }
    }
    return value;
  };
  let childArgs = args.map(rewritePrivatePath);
  let childCwd = options.cwd;
  if (privateRoot && typeof options.cwd === 'string') {
    const privatePrefixes = [privateRoot.root, privateRoot.ioRoot];
    const prefix = privatePrefixes.find(
      (root) => options.cwd === root || options.cwd.startsWith(`${root}${path.sep}`)
    );
    if (prefix && command === 'npm') {
      const suffix = options.cwd.slice(prefix.length);
      const parentDescriptorRoot = `/proc/${process.pid}/fd/${privateRoot.handle.fd}`;
      const invocation = privateNpmInvocation(
        childArgs,
        childRoot,
        suffix,
        process.platform,
        parentDescriptorRoot
      );
      childArgs = invocation.args;
      childCwd = invocation.cwd;
    }
  }
  const result = spawnSync(rewritePrivatePath(command), childArgs, {
    cwd: rewritePrivatePath(childCwd),
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 300_000,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, ...options.env, NO_COLOR: '1' },
    ...(privateRoot ? { stdio: ['ignore', 'pipe', 'pipe', privateRoot.handle.fd] } : {}),
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message || '').trim();
    throw new Error(`${command} failed${detail ? `: ${detail.slice(-4096)}` : ''}`);
  }
  return result.stdout;
}

async function stageSourceBroker() {
  const [rootPackage, sourceSha, sourceStatus] = await Promise.all([
    readFile('package.json', 'utf8').then(JSON.parse),
    Promise.resolve(run('git', ['rev-parse', 'HEAD']).trim()),
    Promise.resolve(run('git', ['status', '--porcelain']).trim()),
  ]);
  if (!SHA40.test(sourceSha)) throw new Error('could not resolve a source commit');
  if (sourceStatus) throw new Error('source broker staging requires a clean source tree');
  const packageVersion = requiredString(rootPackage.version, 'root package version', VERSION);
  const buildPlan = sourceBrokerBuildPlan();
  const toolchainCommands = sourceBrokerToolchainPlan(buildPlan, {
    muslGccAvailable: await executableOnPath('musl-gcc'),
    aptGetAvailable: await executableOnPath('apt-get'),
    sudoAvailable: await executableOnPath('sudo'),
    isRoot: typeof process.getuid === 'function' && process.getuid() === 0,
  });
  for (const { command, args } of toolchainCommands) {
    run(command, args, { timeoutMs: 900_000 });
  }
  if (process.platform === 'linux' && !(await executableOnPath('musl-gcc'))) {
    throw new Error('portable Linux broker staging could not provision musl-gcc');
  }
  run('cargo', buildPlan.cargoArgs, {
    timeoutMs: 1_800_000,
    env: { ...buildPlan.env, AGENT_RELAY_VERSION: packageVersion },
  });
  const binary = process.platform === 'win32' ? 'agent-relay-broker.exe' : 'agent-relay-broker';
  const destination = path.join('packages', platformPackage(), 'bin', binary);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(buildPlan.built, destination);
  if (process.platform !== 'win32') await chmod(destination, 0o755);
  const { bytes, mode } = await readRegularFileNoFollow(destination, {
    label: 'staged source broker',
  });
  if (bytes.length < 1 || (process.platform !== 'win32' && mode !== 0o755)) {
    throw new Error('staged source broker is not an executable regular file');
  }
  if (
    run(destination, ['--version'], { timeoutMs: 30_000 }).trim() !== `agent-relay-broker ${packageVersion}`
  ) {
    throw new Error('staged source broker reported a different version');
  }
  if (
    run('git', ['rev-parse', 'HEAD']).trim() !== sourceSha ||
    run('git', ['status', '--porcelain']).trim()
  ) {
    throw new Error('source changed while the broker was staged');
  }
  process.stdout.write(
    `RELAY_SOURCE_BROKER_STAGED package=${platformPackage()} target=${buildPlan.target} bytes=${bytes.length}\n`
  );
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) throw new Error(`unexpected argument ${token}`);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${token} requires a value`);
    options[token.slice(2)] = value;
    index += 1;
  }
  return { command, options };
}

export function validateCandidateInstallAttestation(value, expected = {}) {
  const attestation = object(value, 'candidate install attestation');
  if (attestation.version !== 4 || attestation.kind !== 'relay-candidate-clean-install') {
    throw new Error('candidate install attestation identity is invalid');
  }
  const sourceSha = requiredString(attestation.sourceSha, 'attestation.sourceSha', SHA40);
  const packageVersion = requiredString(attestation.packageVersion, 'attestation.packageVersion', VERSION);
  const cliRelativePath = requiredString(
    attestation.cliRelativePath,
    'attestation.cliRelativePath',
    /^node_modules\/agent-relay\/dist\/cli\/index\.js$/
  );
  if (cliRelativePath !== CLI_RELATIVE_PATH) {
    throw new Error('candidate install CLI relative path is invalid');
  }
  const cliSha256 = requiredString(attestation.cliSha256, 'attestation.cliSha256', SHA256);
  const brokerPath = requiredString(
    attestation.brokerRelativePath,
    'attestation.brokerRelativePath',
    /^node_modules\/@agent-relay\/broker-(?:darwin|linux|win32)-(?:arm64|x64)\/bin\/agent-relay-broker(?:\.exe)?$/
  );
  requiredString(attestation.brokerSha256, 'attestation.brokerSha256', SHA256);
  if (!Number.isSafeInteger(attestation.brokerBytes) || attestation.brokerBytes < 1) {
    throw new Error('attestation.brokerBytes is invalid');
  }
  if (attestation.brokerMode !== '755') throw new Error('attestation.brokerMode must equal 755');
  if (attestation.npmVersion !== REQUIRED_NPM_VERSION) {
    throw new Error(`attestation.npmVersion must equal ${REQUIRED_NPM_VERSION}`);
  }
  if (attestation.installStrategy !== INSTALL_STRATEGY) {
    throw new Error(`attestation.installStrategy must equal ${INSTALL_STRATEGY}`);
  }
  if (attestation.lockfileFile !== LOCKFILE_NAME) {
    throw new Error(`attestation.lockfileFile must equal ${LOCKFILE_NAME}`);
  }
  requiredString(attestation.lockfileSha256, 'attestation.lockfileSha256', SHA256);
  if (!Number.isSafeInteger(attestation.lockfileBytes) || attestation.lockfileBytes < 1) {
    throw new Error('attestation.lockfileBytes is invalid');
  }
  requiredString(attestation.closureTreeSha256, 'attestation.closureTreeSha256', SHA256);
  if (!Number.isSafeInteger(attestation.closureEntryCount) || attestation.closureEntryCount < 1) {
    throw new Error('attestation.closureEntryCount is invalid');
  }
  if (!Number.isSafeInteger(attestation.closureBytes) || attestation.closureBytes < 1) {
    throw new Error('attestation.closureBytes is invalid');
  }
  const platform = requiredString(attestation.platform, 'attestation.platform', /^(?:darwin|linux|win32)$/);
  const arch = requiredString(attestation.arch, 'attestation.arch', /^(?:arm64|x64)$/);
  if (brokerPath !== brokerRelativePath(platform, arch)) {
    throw new Error('candidate install broker path does not match its platform');
  }
  if (attestation.sourceDirty !== false) throw new Error('candidate install source was dirty');
  if (expected.sourceSha && sourceSha !== expected.sourceSha) {
    throw new Error('candidate install source SHA does not match');
  }
  if (expected.packageVersion && packageVersion !== expected.packageVersion) {
    throw new Error('candidate install package version does not match');
  }
  if (expected.cliSha256 && cliSha256 !== expected.cliSha256) {
    throw new Error('candidate install CLI digest does not match');
  }
  if (!Array.isArray(attestation.packages) || attestation.packages.length !== PACKAGE_DIRS.length + 1) {
    throw new Error('candidate install package closure is incomplete');
  }
  const names = new Set();
  const tarballFiles = new Set();
  for (const [index, candidate] of attestation.packages.entries()) {
    const entry = object(candidate, `attestation.packages[${index}]`);
    const name = requiredString(entry.name, `attestation.packages[${index}].name`);
    if (names.has(name)) throw new Error(`duplicate candidate package ${name}`);
    names.add(name);
    const tarballFile = requiredString(
      entry.tarballFile,
      `attestation.packages[${index}].tarballFile`,
      /^[A-Za-z0-9_.-]+\.tgz$/
    );
    if (tarballFiles.has(tarballFile)) throw new Error(`duplicate candidate tarball ${tarballFile}`);
    tarballFiles.add(tarballFile);
    if (entry.version !== packageVersion) throw new Error(`candidate package ${name} has the wrong version`);
    requiredString(entry.tarballSha256, `candidate package ${name} tarballSha256`, SHA256);
    requiredString(
      entry.installedPackageJsonSha256,
      `candidate package ${name} installedPackageJsonSha256`,
      SHA256
    );
    requiredString(entry.installedTreeSha256, `candidate package ${name} installedTreeSha256`, SHA256);
    if (!Number.isSafeInteger(entry.installedTreeFileCount) || entry.installedTreeFileCount < 1) {
      throw new Error(`candidate package ${name} installedTreeFileCount is invalid`);
    }
    if (!Number.isSafeInteger(entry.installedTreeBytes) || entry.installedTreeBytes < 1) {
      throw new Error(`candidate package ${name} installedTreeBytes is invalid`);
    }
  }
  for (const name of REQUIRED_PACKAGE_NAMES) {
    if (!names.has(name)) throw new Error(`candidate install package closure is missing ${name}`);
  }
  const platformNames = [...names].filter((name) => PLATFORM_PACKAGE_NAME.test(name));
  if (platformNames.length !== 1 || platformNames[0] !== `@agent-relay/broker-${platform}-${arch}`) {
    throw new Error('candidate install package closure must contain exactly one platform broker');
  }
  return attestation;
}

export async function verifyCandidateInstall(attestationPath, expected = {}) {
  const target = path.resolve(attestationPath);
  const { bytes } = await readRegularFileNoFollow(target, {
    label: 'candidate install attestation',
    privateMode: true,
    currentUserOwned: true,
  });
  const root = path.dirname(target);
  const expectedCli = path.join(root, 'install', ...CLI_RELATIVE_PATH.split('/'));
  const attestation = validateCandidateInstallAttestation(JSON.parse(bytes.toString('utf8')), {
    ...expected,
  });
  if (expected.cliEntrypoint && path.resolve(expected.cliEntrypoint) !== expectedCli) {
    throw new Error('candidate install CLI entrypoint does not match');
  }
  const installDir = path.join(root, 'install');
  const { bytes: lockfileBytes } = await readRegularFileNoFollow(path.join(root, attestation.lockfileFile), {
    label: 'candidate package lockfile',
    privateMode: true,
    currentUserOwned: true,
  });
  if (
    lockfileBytes.length !== attestation.lockfileBytes ||
    sha256(lockfileBytes) !== attestation.lockfileSha256
  ) {
    throw new Error('candidate package lockfile bytes changed');
  }
  validateCandidateLockfile(JSON.parse(lockfileBytes.toString('utf8')), attestation.packages);
  const [installManifestBytes, installedLockfileBytes, closureTree] = await Promise.all([
    readRegularFileNoFollow(path.join(installDir, 'package.json'), {
      label: 'candidate install manifest',
    }).then((result) => result.bytes),
    readRegularFileNoFollow(path.join(installDir, 'package-lock.json'), {
      label: 'installed candidate lockfile',
    }).then((result) => result.bytes),
    digestInstalledClosureTree(path.join(installDir, 'node_modules')),
  ]);
  if (installManifestBytes.toString('utf8') !== candidateInstallManifestBytes(attestation.packages)) {
    throw new Error('candidate synthetic install manifest changed');
  }
  if (!installedLockfileBytes.equals(lockfileBytes)) {
    throw new Error('candidate installed package lockfile changed');
  }
  if (
    closureTree.sha256 !== attestation.closureTreeSha256 ||
    closureTree.entryCount !== attestation.closureEntryCount ||
    closureTree.bytes !== attestation.closureBytes
  ) {
    throw new Error('candidate complete installed closure changed');
  }
  const brokerPath = path.join(installDir, ...attestation.brokerRelativePath.split('/'));
  const { bytes: brokerBytes, mode: brokerMode } = await readRegularFileNoFollow(brokerPath, {
    label: 'candidate broker',
  });
  if (attestation.platform !== 'win32' && brokerMode !== 0o755) {
    throw new Error('candidate broker mode is not exactly 0755');
  }
  if (sha256(brokerBytes) !== attestation.brokerSha256) {
    throw new Error('candidate broker digest changed');
  }
  if (brokerBytes.length !== attestation.brokerBytes) throw new Error('candidate broker size changed');
  const brokerVersion = run(brokerPath, ['--version'], { timeoutMs: 30_000 }).trim();
  if (brokerVersion !== `agent-relay-broker ${attestation.packageVersion}`) {
    throw new Error('clean-installed candidate broker reported a different version');
  }
  for (const entry of attestation.packages) {
    const installedRoot = packageRoot(installDir, entry.name);
    const [tarballBytes, installedBytes, installedTree] = await Promise.all([
      readRegularFileNoFollow(path.join(root, 'tarballs', entry.tarballFile), {
        label: `candidate tarball ${entry.name}`,
      }).then((result) => result.bytes),
      readRegularFileNoFollow(packagePath(installDir, entry.name), {
        label: `installed package manifest ${entry.name}`,
      }).then((result) => result.bytes),
      digestInstalledPackageTree(installedRoot),
    ]);
    if (sha256(tarballBytes) !== entry.tarballSha256) {
      throw new Error(`candidate tarball digest changed for ${entry.name}`);
    }
    if (sha256(installedBytes) !== entry.installedPackageJsonSha256) {
      throw new Error(`installed package digest changed for ${entry.name}`);
    }
    if (
      installedTree.sha256 !== entry.installedTreeSha256 ||
      installedTree.fileCount !== entry.installedTreeFileCount ||
      installedTree.bytes !== entry.installedTreeBytes
    ) {
      throw new Error(`installed package tree changed for ${entry.name}`);
    }
    const installed = JSON.parse(installedBytes.toString('utf8'));
    if (installed.name !== entry.name || installed.version !== attestation.packageVersion) {
      throw new Error(`installed candidate package identity changed for ${entry.name}`);
    }
  }
  const { bytes: cliBytes } = await readRegularFileNoFollow(expectedCli, {
    label: 'candidate CLI entrypoint',
  });
  if (sha256(cliBytes) !== attestation.cliSha256) {
    throw new Error('candidate install CLI digest changed');
  }
  const reportedVersion = run(process.execPath, [expectedCli, 'version'], { timeoutMs: 30_000 }).trim();
  if (reportedVersion !== `agent-relay v${attestation.packageVersion}`) {
    throw new Error('clean-installed candidate CLI reported a different version');
  }
  return { attestation, attestationSha256: sha256(bytes) };
}

function descriptorRoot(handle) {
  return `/proc/self/fd/${handle.fd}`;
}

export function assertSupportedCandidateOutputPlatform(platform = process.platform) {
  if (platform !== 'linux') {
    throw new Error(
      'candidate prepare/hydrate is supported only on Linux because other Node platforms cannot bind directory I/O to a verified handle'
    );
  }
}

async function verifyPrivateOutputParent(parent) {
  const info = await lstat(parent);
  const mode = info.mode & 0o777;
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (currentUid !== null && info.uid !== currentUid) ||
    mode !== 0o700
  ) {
    throw new Error('candidate output root requires an existing current-user-owned 0700 parent directory');
  }
}

async function createPrivateOutputRootHandle(outputRoot) {
  assertSupportedCandidateOutputPlatform();
  const root = path.resolve(outputRoot);
  const parent = path.dirname(root);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await verifyPrivateOutputParent(parent);
  try {
    // mkdir is the existence check: its atomic EEXIST result avoids a
    // check-then-create window where another process could replace the path.
    await mkdir(root, { mode: 0o700 });
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error('candidate output root must not already exist', { cause: error });
    }
    throw error;
  }
  const openFlags = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;
  const handle = await open(root, openFlags);
  const info = await handle.stat();
  if (!info.isDirectory() || info.isSymbolicLink()) {
    await handle.close();
    throw new Error('candidate output root must be a newly created directory');
  }
  return { root, ioRoot: descriptorRoot(handle), handle };
}

export async function createPrivateOutputRoot(outputRoot) {
  const created = await createPrivateOutputRootHandle(outputRoot);
  await created.handle?.close();
  return path.resolve(outputRoot);
}

async function prepare(outputRoot) {
  const rootHandle = await createPrivateOutputRootHandle(outputRoot);
  const root = rootHandle.ioRoot;
  activePrivateRootHandle = rootHandle;
  return (async () => {
    const tarballDir = path.join(root, 'tarballs');
    const installDir = path.join(root, 'install');
    await Promise.all([mkdir(tarballDir, { mode: 0o700 }), mkdir(installDir, { mode: 0o700 })]);

    const [rootPackage, sourceSha, sourceStatus] = await Promise.all([
      readFile('package.json', 'utf8').then(JSON.parse),
      Promise.resolve(run('git', ['rev-parse', 'HEAD']).trim()),
      Promise.resolve(run('git', ['status', '--porcelain']).trim()),
    ]);
    if (!SHA40.test(sourceSha)) throw new Error('could not resolve a source commit');
    if (sourceStatus) throw new Error('candidate clean install requires a clean source tree');
    const npmVersion = run('npm', ['--version'], { timeoutMs: 30_000 }).trim();
    if (npmVersion !== REQUIRED_NPM_VERSION) {
      throw new Error(`candidate packing requires npm ${REQUIRED_NPM_VERSION}`);
    }
    run('npm', ['run', 'build:core'], { timeoutMs: 1_800_000 });
    if (
      run('git', ['rev-parse', 'HEAD']).trim() !== sourceSha ||
      run('git', ['status', '--porcelain']).trim()
    ) {
      throw new Error('candidate source changed while its build outputs were produced');
    }
    await rejectBundledBrokerContamination();
    const packageVersion = requiredString(rootPackage.version, 'root package version', VERSION);

    const packageDirectories = [...PACKAGE_DIRS, platformPackage()];
    const packed = [];
    for (const directory of packageDirectories) {
      const packageJson = JSON.parse(
        await readFile(path.join('packages', directory, 'package.json'), 'utf8')
      );
      if (packageJson.version !== packageVersion) {
        throw new Error(`${packageJson.name} version does not match the root candidate version`);
      }
      const output = run('npm', [
        'pack',
        '--ignore-scripts',
        '--json',
        '--pack-destination',
        tarballDir,
        path.resolve('packages', directory),
      ]);
      const record = JSON.parse(output)[0];
      const tarballPath = path.join(tarballDir, requiredString(record.filename, `${directory} tarball`));
      const { bytes } = await readRegularFileNoFollow(tarballPath, {
        label: `packed candidate tarball ${directory}`,
      });
      packed.push({
        name: requiredString(packageJson.name, `${directory} package name`),
        version: packageJson.version,
        tarballPath,
        tarballFile: path.basename(tarballPath),
        tarballSha256: sha256(bytes),
      });
    }

    await writeFile(path.join(installDir, 'package.json'), candidateInstallManifestBytes(packed), {
      mode: 0o600,
      flag: 'wx',
    });
    run('npm', ['install', '--package-lock-only', ...NPM_INSTALL_POLICY_ARGS], {
      cwd: installDir,
      timeoutMs: 900_000,
    });
    const producedLockfile = path.join(installDir, 'package-lock.json');
    const { bytes: lockfileBytes } = await readRegularFileNoFollow(producedLockfile, {
      label: 'produced candidate lockfile',
    });
    validateCandidateLockfile(JSON.parse(lockfileBytes.toString('utf8')), packed);
    const portableLockfile = path.join(root, LOCKFILE_NAME);
    await copyFile(producedLockfile, portableLockfile);
    await chmod(portableLockfile, 0o600);
    run('npm', ['ci', ...NPM_INSTALL_POLICY_ARGS], {
      cwd: installDir,
      timeoutMs: 900_000,
    });
    const { bytes: installedLockfileBytes } = await readRegularFileNoFollow(producedLockfile, {
      label: 'installed candidate lockfile',
    });
    if (!installedLockfileBytes.equals(lockfileBytes)) {
      throw new Error('npm ci changed the candidate package lockfile');
    }
    const installedBrokerPackages = (await readdir(path.join(installDir, 'node_modules', '@agent-relay')))
      .filter((name) => name.startsWith('broker-'))
      .sort();
    if (installedBrokerPackages.join('\0') !== [platformPackage()].join('\0')) {
      throw new Error('candidate install materialized the wrong platform broker closure');
    }

    const packages = [];
    for (const entry of packed) {
      const installedRoot = packageRoot(installDir, entry.name);
      const [installedBytes, installedTree] = await Promise.all([
        readRegularFileNoFollow(packagePath(installDir, entry.name), {
          label: `installed package manifest ${entry.name}`,
        }).then((result) => result.bytes),
        digestInstalledPackageTree(installedRoot),
      ]);
      const installed = JSON.parse(installedBytes.toString('utf8'));
      if (installed.name !== entry.name || installed.version !== entry.version) {
        throw new Error(`clean install did not resolve ${entry.name} from the candidate closure`);
      }
      packages.push({
        name: entry.name,
        version: entry.version,
        tarballFile: entry.tarballFile,
        tarballSha256: entry.tarballSha256,
        installedPackageJsonSha256: sha256(installedBytes),
        installedTreeSha256: installedTree.sha256,
        installedTreeFileCount: installedTree.fileCount,
        installedTreeBytes: installedTree.bytes,
      });
    }
    const cliEntrypoint = path.join(installDir, ...CLI_RELATIVE_PATH.split('/'));
    const { bytes: cliBytes } = await readRegularFileNoFollow(cliEntrypoint, {
      label: 'clean-installed candidate CLI entrypoint',
    });
    const reportedVersion = run(process.execPath, [cliEntrypoint, 'version'], {
      timeoutMs: 30_000,
    }).trim();
    if (reportedVersion !== `agent-relay v${packageVersion}`) {
      throw new Error('clean-installed candidate CLI reported a different version');
    }
    const brokerPath = path.join(installDir, ...brokerRelativePath().split('/'));
    const { bytes: brokerBytes, mode: brokerMode } = await readRegularFileNoFollow(brokerPath, {
      label: 'clean-installed candidate broker',
    });
    if (process.platform !== 'win32' && brokerMode !== 0o755) {
      throw new Error('clean-installed candidate broker mode is not exactly 0755');
    }
    const brokerVersion = run(brokerPath, ['--version'], { timeoutMs: 30_000 }).trim();
    if (brokerVersion !== `agent-relay-broker ${packageVersion}`) {
      throw new Error('clean-installed candidate broker reported a different version');
    }
    const closureTree = await digestInstalledClosureTree(path.join(installDir, 'node_modules'));
    const attestation = validateCandidateInstallAttestation({
      version: 4,
      kind: 'relay-candidate-clean-install',
      sourceSha,
      sourceDirty: false,
      packageVersion,
      platform: process.platform,
      arch: process.arch,
      cliRelativePath: CLI_RELATIVE_PATH,
      cliSha256: sha256(cliBytes),
      brokerRelativePath: brokerRelativePath(),
      brokerSha256: sha256(brokerBytes),
      brokerBytes: brokerBytes.length,
      brokerMode: '755',
      npmVersion,
      installStrategy: INSTALL_STRATEGY,
      lockfileFile: LOCKFILE_NAME,
      lockfileSha256: sha256(lockfileBytes),
      lockfileBytes: lockfileBytes.length,
      closureTreeSha256: closureTree.sha256,
      closureEntryCount: closureTree.entryCount,
      closureBytes: closureTree.bytes,
      packages,
    });
    const target = path.join(root, 'candidate-install-attestation.json');
    const handle = await open(target, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(attestation, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    process.stdout.write(
      `RELAY_CANDIDATE_INSTALL_READY cli=${path.join(rootHandle.root, 'install', ...CLI_RELATIVE_PATH.split('/'))}\n`
    );
  })().finally(async () => {
    if (activePrivateRootHandle === rootHandle) activePrivateRootHandle = undefined;
    await rootHandle.handle?.close();
  });
}

async function hydrate(attestationPath, tarballDirectory, outputRoot) {
  const sourceAttestation = path.resolve(attestationPath);
  const [sourceSha, sourceStatus, rootPackage, sourceBytes] = await Promise.all([
    Promise.resolve(run('git', ['rev-parse', 'HEAD']).trim()),
    Promise.resolve(run('git', ['status', '--porcelain']).trim()),
    readFile('package.json', 'utf8').then(JSON.parse),
    readRegularFileNoFollow(sourceAttestation, {
      label: 'portable candidate attestation',
      privateMode: true,
      currentUserOwned: true,
    }).then((result) => result.bytes),
  ]);
  if (sourceStatus) throw new Error('candidate hydration requires a clean source tree');
  const packageVersion = requiredString(rootPackage.version, 'root package version', VERSION);
  const candidate = validateCandidateInstallAttestation(JSON.parse(sourceBytes.toString('utf8')), {
    sourceSha,
    packageVersion,
  });
  if (candidate.platform !== process.platform || candidate.arch !== process.arch) {
    throw new Error('portable candidate platform does not match this host');
  }
  if (run('npm', ['--version'], { timeoutMs: 30_000 }).trim() !== candidate.npmVersion) {
    throw new Error('candidate hydration requires the attested npm version');
  }
  const sourceLockfile = path.join(path.dirname(sourceAttestation), candidate.lockfileFile);
  const { bytes: lockfileBytes } = await readRegularFileNoFollow(sourceLockfile, {
    label: 'portable candidate lockfile',
    privateMode: true,
    currentUserOwned: true,
  });
  if (
    lockfileBytes.length !== candidate.lockfileBytes ||
    sha256(lockfileBytes) !== candidate.lockfileSha256
  ) {
    throw new Error('portable candidate package lockfile bytes changed');
  }
  validateCandidateLockfile(JSON.parse(lockfileBytes.toString('utf8')), candidate.packages);

  const rootHandle = await createPrivateOutputRootHandle(outputRoot);
  const root = rootHandle.ioRoot;
  activePrivateRootHandle = rootHandle;
  return (async () => {
    const tarballRoot = path.join(root, 'tarballs');
    const installDir = path.join(root, 'install');
    await Promise.all([mkdir(tarballRoot, { mode: 0o700 }), mkdir(installDir, { mode: 0o700 })]);
    for (const entry of candidate.packages) {
      const source = path.join(path.resolve(tarballDirectory), entry.tarballFile);
      const { bytes } = await readRegularFileNoFollow(source, {
        label: `portable candidate tarball ${entry.name}`,
      });
      if (sha256(bytes) !== entry.tarballSha256) {
        throw new Error(`portable candidate tarball digest changed for ${entry.name}`);
      }
      const target = path.join(tarballRoot, entry.tarballFile);
      await copyFile(source, target);
    }
    const targetAttestation = path.join(root, 'candidate-install-attestation.json');
    await copyFile(sourceAttestation, targetAttestation);
    await chmod(targetAttestation, 0o600);
    const targetPortableLockfile = path.join(root, candidate.lockfileFile);
    await copyFile(sourceLockfile, targetPortableLockfile);
    await chmod(targetPortableLockfile, 0o600);
    await writeFile(
      path.join(installDir, 'package.json'),
      candidateInstallManifestBytes(candidate.packages),
      {
        mode: 0o600,
        flag: 'wx',
      }
    );
    await copyFile(sourceLockfile, path.join(installDir, 'package-lock.json'));
    run('npm', ['ci', ...NPM_INSTALL_POLICY_ARGS], {
      cwd: installDir,
      timeoutMs: 900_000,
    });
    await verifyCandidateInstall(targetAttestation, { sourceSha, packageVersion });
    process.stdout.write(
      `RELAY_CANDIDATE_INSTALL_HYDRATED cli=${path.join(rootHandle.root, 'install', ...CLI_RELATIVE_PATH.split('/'))}\n`
    );
  })().finally(async () => {
    if (activePrivateRootHandle === rootHandle) activePrivateRootHandle = undefined;
    await rootHandle.handle?.close();
  });
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === 'stage-source-broker') {
    if (Object.keys(options).length > 0) throw new Error('stage-source-broker does not accept options');
    await stageSourceBroker();
    return;
  }
  if (command === 'prepare') {
    await prepare(requiredString(options.output, '--output'));
    return;
  }
  if (command === 'verify') {
    const sourceSha = run('git', ['rev-parse', 'HEAD']).trim();
    if (run('git', ['status', '--porcelain']).trim()) {
      throw new Error('candidate clean install verification requires a clean source tree');
    }
    const result = await verifyCandidateInstall(requiredString(options.attestation, '--attestation'), {
      sourceSha,
    });
    process.stdout.write(`RELAY_CANDIDATE_INSTALL_VERIFIED sha256=${result.attestationSha256}\n`);
    return;
  }
  if (command === 'hydrate') {
    await hydrate(
      requiredString(options.attestation, '--attestation'),
      requiredString(options.tarballs, '--tarballs'),
      requiredString(options.output, '--output')
    );
    return;
  }
  throw new Error('command must be prepare, hydrate, or verify');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
