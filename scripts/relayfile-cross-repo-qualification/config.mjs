import { chmod, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const arg = process.argv.indexOf('--config');
export async function loadQualificationConfig() {
  if (arg < 0 || !process.argv[arg + 1]) throw new Error('qualification --config is required');
  const file = path.resolve(process.argv[arg + 1]);
  const value = JSON.parse(await readFile(file, 'utf8'));
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(value.runId) || value.artifactDir !== path.dirname(file))
    throw new Error('invalid qualification config identity');
  if (!value.candidates || new Set(Object.values(value.candidates).map((p) => path.resolve(p))).size !== 3)
    throw new Error('qualification candidates must be distinct');
  return value;
}
export async function writeQualificationConfig(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await chmod(file, 0o600);
}
export const CONFIG_ARG = '--config';
if (arg >= 0) {
  const config = await loadQualificationConfig();
  const env = {
    RELAYFILE_QUALIFICATION_RUN_ID: config.runId,
    RELAYFILE_QUALIFICATION_ARTIFACT_DIR: config.artifactDir,
    RELAYFILE_QUALIFICATION_BUNDLE_DIR: config.bundleDir,
    RELAYFILE_QUALIFICATION_CREATE_SANDBOXES: config.createSandboxes ? '1' : '0',
    RELAY_CLOUD_REPO: config.candidates.cloud,
    RELAYFILE_REPO: config.candidates.relayfile,
    RELAYFILE_CLOUD_REPO: config.candidates['relayfile-cloud'],
    RELAYFILE_QUALIFICATION_NPM_VERSION: config.npm.version,
    RELAYFILE_QUALIFICATION_NPM_TARBALL_SHA256: config.npm.tarballSha256,
    RELAYFILE_QUALIFICATION_NPM_SOURCE_SHA: config.npm.sourceSha,
    RELAYFILE_QUALIFICATION_RELEASE_ATTESTATION_SHA256: config.npm.releaseAttestationSha256,
    RELAYFILE_QUALIFICATION_MOUNT_TARBALL_SHA256: config.npm.mountTarballSha256,
    RELAYFILE_QUALIFICATION_DAYTONA_IMAGE: config.daytona.image,
    RELAYFILE_DAYTONA_CPU: config.daytona.cpu,
    RELAYFILE_DAYTONA_MEMORY_MB: config.daytona.memoryMb,
    RELAYFILE_DAYTONA_DISK_GIB: config.daytona.diskGib,
    RELAYFILE_DAYTONA_TTL_MINUTES: config.daytona.ttlMinutes,
  };
  Object.assign(process.env, env);
}
