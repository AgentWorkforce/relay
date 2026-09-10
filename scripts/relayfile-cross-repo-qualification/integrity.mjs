import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const SAFE_DIGEST = /^[0-9a-f]{64}$/;

export function isSafeDigest(value) {
  return typeof value === 'string' && SAFE_DIGEST.test(value);
}

async function readEntry(root, relative) {
  const normalized = path.posix.normalize(relative.replaceAll(path.sep, '/'));
  if (normalized.startsWith('../') || normalized.includes('/../') || path.posix.isAbsolute(normalized))
    throw new Error(`unsafe integrity path: ${relative}`);
  const bytes = await readFile(path.join(root, normalized));
  return { path: normalized, bytes };
}

/** Resolve the exact raw-byte evidence set for one run. */
export async function integrityEntries(artifactDir) {
  const entries = [];
  for (const relative of [
    'preflight.json',
    'arm-A.json',
    'arm-B.json',
    'arm-A-verification.json',
    'arm-B-verification.json',
    'aggregate-evidence.json',
  ])
    entries.push(await readEntry(artifactDir, relative));
  const manifestEntry = await readEntry(artifactDir, 'bundle/bundle-manifest.json');
  entries.push(manifestEntry);
  const manifest = JSON.parse(manifestEntry.bytes.toString('utf8'));
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    !manifest.artifacts ||
    !manifest.candidateProvenance ||
    !manifest.relayfileMount
  )
    throw new Error('bundle manifest is malformed');
  for (const name of ['cloud', 'relayfile', 'relayfile-cloud']) {
    const artifact = manifest.artifacts[name];
    const provenance = manifest.candidateProvenance[name];
    if (
      !artifact ||
      !provenance ||
      provenance.name !== name ||
      typeof provenance.repo !== 'string' ||
      !/^[0-9a-f]{40}$/.test(provenance.head ?? '') ||
      provenance.clean !== true ||
      provenance.archive !== artifact.archive ||
      provenance.sha256 !== artifact.sha256
    )
      throw new Error(`bundle manifest candidate provenance is malformed for ${name}`);
  }
  for (const artifact of Object.values(manifest.artifacts)) {
    if (!artifact || typeof artifact.archive !== 'string')
      throw new Error('bundle manifest archive is malformed');
    entries.push(await readEntry(artifactDir, `bundle/${artifact.archive}`));
  }
  if (typeof manifest.relayfileMount.file !== 'string') throw new Error('bundle manifest mount is malformed');
  entries.push(await readEntry(artifactDir, `bundle/${manifest.relayfileMount.file}`));
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

/** Hash path framing plus raw bytes so names and contents cannot be ambiguous. */
export async function computeIntegrity(artifactDir) {
  const entries = await integrityEntries(artifactDir);
  const hash = createHash('sha256');
  for (const entry of entries) {
    hash.update(entry.path, 'utf8');
    hash.update('\0', 'utf8');
    hash.update(String(entry.bytes.byteLength), 'utf8');
    hash.update('\0', 'utf8');
    hash.update(entry.bytes);
  }
  return {
    digest: hash.digest('hex'),
    entries: entries.map((entry) => ({ path: entry.path, bytes: entry.bytes.byteLength })),
  };
}
