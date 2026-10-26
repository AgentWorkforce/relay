'use strict';

const fs = require('node:fs');
const path = require('node:path');

function inspect(filename) {
  try {
    return fs.lstatSync(filename);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function directory(filename) {
  const info = inspect(filename);
  if (!info) return false;
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Refusing an unsafe Cargo build directory: ${filename}`);
  }
  return true;
}

function packageName(workspace) {
  const manifest = path.join(workspace, 'probe', 'Cargo.toml');
  const info = inspect(manifest);
  if (!info || info.isSymbolicLink() || !info.isFile()) {
    throw new Error('Expected a regular probe/Cargo.toml manifest');
  }
  let inPackage = false;
  for (const line of fs.readFileSync(manifest, 'utf8').split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) {
      inPackage = /^\s*\[package\]\s*(?:#.*)?$/.test(line);
      continue;
    }
    if (!inPackage) continue;
    const name = line.match(/^\s*name\s*=\s*(["'])([A-Za-z0-9][A-Za-z0-9_-]*)\1\s*(?:#.*)?$/);
    if (name) return name[2];
  }
  throw new Error('Could not read a safe name from probe/Cargo.toml [package]');
}

function sizeWithoutSymlinks(filename) {
  const info = fs.lstatSync(filename);
  if (info.isSymbolicLink()) {
    throw new Error(`Refusing a symlink in Cargo workspace products: ${filename}`);
  }
  if (info.isFile()) return info.size;
  if (!info.isDirectory()) {
    throw new Error(`Refusing a special Cargo workspace product: ${filename}`);
  }
  return fs
    .readdirSync(filename)
    .reduce((bytes, name) => bytes + sizeWithoutSymlinks(path.join(filename, name)), 0);
}

function pruneWorkspaceArtifacts({ workspace, profile }) {
  if (!['debug', 'release'].includes(profile)) {
    throw new Error('Cargo cache profile must be debug or release');
  }
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) {
    throw new Error('GITHUB_WORKSPACE must be an absolute repository path');
  }
  const root = path.resolve(workspace);
  if (!directory(root) || !directory(path.join(root, 'probe'))) {
    throw new Error('Expected the checked-out probe package');
  }
  const name = packageName(root);
  const summary = { fingerprints: 0, buildDirectories: 0, dependencyFiles: 0, bytes: 0 };
  // Validate every parent/container before collecting a deletion plan. Never
  // follow a target, profile or artifact-directory symlink outside this tree.
  const target = path.join(root, 'probe', 'target');
  if (!directory(target)) return summary;
  const buildProfile = path.join(target, profile);
  if (!directory(buildProfile)) return summary;
  const containers = {};
  for (const container of ['.fingerprint', 'build', 'deps']) {
    const filename = path.join(buildProfile, container);
    if (directory(filename)) containers[container] = filename;
  }
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const packageHash = new RegExp(`^${escapedName}-([0-9a-f]{8,64})$`);
  const hashes = new Set();
  const plan = [];
  for (const entry of containers['.fingerprint'] ? fs.readdirSync(containers['.fingerprint']) : []) {
    const match = entry.match(packageHash);
    if (!match) continue;
    const filename = path.join(containers['.fingerprint'], entry);
    directory(filename);
    hashes.add(match[1]);
    plan.push({ filename, kind: 'fingerprints' });
  }
  for (const entry of containers.build ? fs.readdirSync(containers.build) : []) {
    if (!packageHash.test(entry)) continue;
    const filename = path.join(containers.build, entry);
    directory(filename);
    plan.push({ filename, kind: 'buildDirectories' });
  }
  for (const entry of containers.deps ? fs.readdirSync(containers.deps) : []) {
    // Cargo puts the target hash immediately before the extension(s), e.g.
    // libprobe-HASH.rlib, hosting-HASH.exe or probe-HASH.pdb. The target name
    // alone cannot distinguish workspace tests from dependency build tools.
    const match = entry.match(/^[^.]+-([0-9a-f]{8,64})(?:\..*)?$/);
    if (!match || !hashes.has(match[1])) continue;
    const filename = path.join(containers.deps, entry);
    const info = fs.lstatSync(filename);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`Refusing an unsafe Cargo workspace artifact: ${filename}`);
    }
    plan.push({ filename, kind: 'dependencyFiles' });
  }
  // Validate nested products before the first deletion, including symlinks
  // inside workspace build-script outputs. Dependency directories are untouched.
  for (const product of plan) summary.bytes += sizeWithoutSymlinks(product.filename);
  for (const product of plan) {
    fs.rmSync(product.filename, { recursive: true });
    summary[product.kind] += 1;
  }
  return summary;
}

module.exports = { pruneWorkspaceArtifacts };

if (require.main === module) {
  try {
    const result = pruneWorkspaceArtifacts({
      workspace: path.join(process.env.GITHUB_WORKSPACE, 'apps', 'desktop'),
      profile: process.env.INPUT_PROFILE,
    });
    console.log(
      `Pruned Cargo workspace products: ${result.fingerprints} fingerprints, ` +
        `${result.buildDirectories} build directories, ${result.dependencyFiles} artifact files, ` +
        `${result.bytes} bytes. Dependency build scripts and proc-macros are retained.`
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
