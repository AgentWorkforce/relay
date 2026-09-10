#!/usr/bin/env node

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { authorizedApiFetch, ensureCloudSession } from '@agent-relay/cloud';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEPLOYMENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const IDEMPOTENCY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$/u;
const RECONCILIATION_HEADER = 'x-agent-relay-ephemeral-reconciliation';
const RELAY_WORKSPACE_ID = /^rw_[a-z0-9]{8}$/;
const OUTPUT_ROOT = path.resolve('qualification-cleanup');

function required(name) {
  const value = process.env[name]?.trim();
  assert(value, `${name} is required`);
  return value;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    assert(key?.startsWith('--') && value !== undefined, `invalid argument ${key ?? '<missing>'}`);
    assert(!(key.slice(2) in args), `duplicate argument ${key}`);
    args[key.slice(2)] = value;
  }
  return args;
}

export function trustedOutputPath(value) {
  const resolved = path.resolve(value);
  const relative = path.relative(OUTPUT_ROOT, resolved);
  assert(
    relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative),
    'qualification output must remain under qualification-cleanup'
  );
  assert(/^(?:reconcile|delete)-[ab]\.json$/u.test(relative), 'qualification output filename is invalid');
  return resolved;
}

function jsonObject(value, label) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  return value;
}

async function cloudAuth() {
  return (await ensureCloudSession({ apiUrl: required('CLOUD_API_URL'), interactive: false })).auth;
}

export async function reconcile({ auth, idempotencyKey, name, deploymentId, expectedWorkspaceId }) {
  assert(IDEMPOTENCY.test(idempotencyKey), 'idempotency key is invalid');
  assert(name.length > 0 && name.length <= 200, 'workspace name is invalid');
  assert(DEPLOYMENT.test(deploymentId), 'deployment id is invalid');
  const query = new URLSearchParams({ ephemeral: 'true', idempotencyKey, name });
  const { response, auth: refreshedAuth } = await authorizedApiFetch(
    auth,
    `/api/v1/workspaces?${query}`,
    { method: 'GET' },
    { interactive: false }
  );
  assert.equal(
    response.headers.get(RECONCILIATION_HEADER),
    'v1',
    'Cloud did not advertise reconciliation contract v1'
  );
  if (response.status === 404) {
    const body = jsonObject(await response.json(), 'reconciliation absence');
    assert.equal(body.code, 'workspace_not_found');
    if (expectedWorkspaceId) {
      assert(UUID.test(expectedWorkspaceId), 'expected workspace id is invalid');
      const { response: exact } = await authorizedApiFetch(
        refreshedAuth,
        `/api/v1/workspaces/${encodeURIComponent(expectedWorkspaceId)}`,
        { method: 'GET' },
        { interactive: false }
      );
      assert.equal(exact.status, 404, 'reconciled workspace exact ID was not proven absent');
    }
    return {
      version: 1,
      kind: 'ephemeral-workspace-reconciliation',
      idempotencyKey,
      expectedName: name,
      absent: true,
      workspaceId: null,
      relayWorkspaceId: null,
      state: 'absent',
      credentialRevealed: false,
      absenceStatus: 404,
      exactWorkspaceId: expectedWorkspaceId ?? null,
      exactAbsenceStatus: expectedWorkspaceId ? 404 : null,
      reconciledAt: new Date().toISOString(),
    };
  }
  assert(response.ok, `Cloud reconciliation failed (HTTP ${response.status})`);
  const value = jsonObject(await response.json(), 'reconciliation response');
  assert(UUID.test(String(value.workspaceId ?? '')), 'reconciliation workspace id is invalid');
  assert.equal(value.requestedRelayfileCloudDeploymentId, deploymentId);
  assert.equal(value.observedRelayfileCloudDeploymentId, deploymentId);
  assert.equal(value.replay, true);
  assert(typeof value.relayWorkspaceId === 'string' && value.relayWorkspaceId.length > 0);
  assert(typeof value.state === 'string' && value.credentialRevealed === false);
  return {
    version: 1,
    kind: 'ephemeral-workspace-reconciliation',
    idempotencyKey,
    expectedName: name,
    absent: false,
    workspaceId: value.workspaceId,
    relayWorkspaceId: value.relayWorkspaceId,
    state: value.state,
    credentialRevealed: value.credentialRevealed,
    reconciledAt: new Date().toISOString(),
  };
}

export async function createWorkspace({
  auth,
  idempotencyKey,
  name,
  deploymentId,
  credentialFile,
  ttlSeconds = 86_400,
}) {
  assert(IDEMPOTENCY.test(idempotencyKey), 'idempotency key is invalid');
  assert(name.length > 0 && name.length <= 200, 'workspace name is invalid');
  assert(DEPLOYMENT.test(deploymentId), 'deployment id is invalid');
  assert(
    Number.isSafeInteger(ttlSeconds) && ttlSeconds >= 60 && ttlSeconds <= 86_400,
    'workspace TTL is invalid'
  );
  assert(typeof credentialFile === 'string' && credentialFile.length > 0, 'credential file is required');
  const { response } = await authorizedApiFetch(
    auth,
    '/api/v1/workspaces',
    {
      method: 'POST',
      headers: { 'idempotency-key': idempotencyKey },
      body: JSON.stringify({
        ephemeral: true,
        name,
        ttlSeconds,
        idempotencyKey,
        relayfileCloudDeploymentId: deploymentId,
      }),
    },
    { interactive: false }
  );
  assert(response.ok, `Cloud workspace creation failed (HTTP ${response.status})`);
  const value = jsonObject(await response.json(), 'workspace creation response');
  assert(UUID.test(String(value.workspaceId ?? '')), 'created workspace id is invalid');
  assert(
    RELAY_WORKSPACE_ID.test(String(value.relayWorkspaceId ?? '')),
    'created Relay workspace id is invalid'
  );
  assert(
    value.state === 'active' && typeof value.expiresAt === 'string',
    'created workspace state is invalid'
  );
  assert(value.ephemeral === true, 'created workspace is not ephemeral');
  assert(value.ttlSeconds === 86_400, 'created workspace TTL is not 24 hours');
  assert(value.requestedRelayfileCloudDeploymentId === deploymentId);
  assert(value.observedRelayfileCloudDeploymentId === deploymentId);
  assert(
    /^[0-9a-f]{64}$/i.test(String(value.relayfileCloudAttestationSha256 ?? '')),
    'Relayfile Cloud attestation digest is invalid'
  );
  const credential = jsonObject(value.credential, 'workspace credential');
  assert(credential.version === 1 && credential.workspaceId === value.workspaceId);
  assert.equal(credential.relayWorkspaceId, value.relayWorkspaceId);
  assert.equal(credential.expiresAt, value.expiresAt);
  assert(jsonObject(credential.cloud, 'cloud credential').accessToken);
  assert(jsonObject(credential.relay, 'Relay credential').workspaceKey);
  await writeFile(credentialFile, `${JSON.stringify(credential, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return {
    version: 1,
    workspaceId: value.workspaceId,
    relayWorkspaceId: value.relayWorkspaceId,
    expiresAt: value.expiresAt,
    state: value.state,
    ephemeral: value.ephemeral,
    ttlSeconds: value.ttlSeconds,
    requestedRelayfileCloudDeploymentId: value.requestedRelayfileCloudDeploymentId,
    observedRelayfileCloudDeploymentId: value.observedRelayfileCloudDeploymentId,
    relayfileCloudAttestationSha256: value.relayfileCloudAttestationSha256,
    credentialFile,
  };
}

export async function deleteAndVerify({ auth, workspaceId }) {
  assert(UUID.test(workspaceId), 'workspace id is invalid');
  const { response, auth: refreshedAuth } = await authorizedApiFetch(
    auth,
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}`,
    {
      method: 'DELETE',
      body: JSON.stringify({ confirm: workspaceId, verifyCascade: true }),
    },
    { interactive: false }
  );
  assert(response.ok, `Cloud workspace deletion failed (HTTP ${response.status})`);
  const deleted = jsonObject(await response.json(), 'delete response');
  assert.equal(deleted.workspaceId, workspaceId);
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.state, 'deleted');
  assert(typeof deleted.idempotent === 'boolean');
  assert(typeof deleted.expiresAt === 'string' && Number.isFinite(Date.parse(deleted.expiresAt)));
  assert(typeof deleted.verifiedAt === 'string' && Number.isFinite(Date.parse(deleted.verifiedAt)));
  assert(typeof deleted.operationId === 'string' && deleted.operationId.length > 0);
  const proof = jsonObject(deleted.proof, 'delete proof');
  for (const [name, fields] of Object.entries({
    daytona: ['workspaceId', 'relayWorkspaceId', 'remaining'],
    cloud: ['workspaceId', 'relayWorkspaceId', 'appWorkspaceRowsRemaining', 'workflowLaunchesInProgress'],
    credentials: ['workspaceId', 'relayWorkspaceId', 'activeSessionsRemaining'],
    relaycast: ['workspaceId', 'relayWorkspaceId', 'deleted', 'agentsAndNodesDeletedByWorkspaceCascade'],
    relayfile: ['workspaceId', 'relayWorkspaceId', 'deleted'],
    registry: ['workspaceId', 'relayWorkspaceId', 'deleted'],
  })) {
    const section = jsonObject(proof[name], `delete proof.${name}`);
    assert.equal(section.workspaceId, workspaceId, `delete proof.${name} workspace mismatch`);
    assert.equal(
      section.relayWorkspaceId,
      deleted.relayWorkspaceId,
      `delete proof.${name} Relay workspace mismatch`
    );
    for (const field of fields) assert(field in section, `delete proof.${name}.${field} is required`);
  }
  const { response: absence } = await authorizedApiFetch(
    refreshedAuth,
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}`,
    { method: 'GET' },
    { interactive: false }
  );
  assert.equal(absence.status, 404, 'deleted workspace was not proven absent');
  return {
    ...deleted,
    absence: { workspaceId, status: 404, verifiedAt: new Date().toISOString() },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const auth = await cloudAuth();
  let value;
  if (args.mode === 'reconcile') {
    value = await reconcile({
      auth,
      idempotencyKey: required('QUALIFICATION_IDEMPOTENCY_KEY'),
      name: required('QUALIFICATION_WORKSPACE_NAME'),
      deploymentId: required('QUALIFICATION_DEPLOYMENT_ID'),
      expectedWorkspaceId: process.env.QUALIFICATION_EXPECTED_WORKSPACE_ID,
    });
  } else if (args.mode === 'delete') {
    value = await deleteAndVerify({ auth, workspaceId: required('QUALIFICATION_WORKSPACE_ID') });
  } else if (args.mode === 'create') {
    value = await createWorkspace({
      auth,
      idempotencyKey: required('QUALIFICATION_IDEMPOTENCY_KEY'),
      name: required('QUALIFICATION_WORKSPACE_NAME'),
      deploymentId: required('QUALIFICATION_DEPLOYMENT_ID'),
      credentialFile: required('QUALIFICATION_CREDENTIAL_FILE'),
    });
  } else {
    throw new Error('--mode must be create, reconcile, or delete');
  }
  if (args.mode !== 'create') {
    const output = trustedOutputPath(required('QUALIFICATION_OUTPUT'));
    await writeFile(output, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  }
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'qualification cleanup failed'}\n`);
    process.exitCode = 1;
  });
}
