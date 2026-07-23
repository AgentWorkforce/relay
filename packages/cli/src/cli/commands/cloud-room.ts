import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import process from 'node:process';
import { Command, InvalidArgumentError } from 'commander';

import { defaultApiUrl } from '@agent-relay/cloud';
import { stripAnsiFast } from '@agent-relay/utils';

import type { CloudDependencies } from './cloud.js';

type CloudRoomDependencies = Pick<
  CloudDependencies,
  'log' | 'error' | 'exit' | 'ensureCloudSession' | 'authorizedApiFetch'
>;
type CloudAuth = Awaited<ReturnType<CloudDependencies['ensureCloudSession']>>['auth'];

type RoomRole = 'viewer' | 'participant';

const CLOUD_WORKSPACE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNIFIED_WORKSPACE_ID_PATTERN = /^rw_[a-z0-9]{8}$/;
const ROOM_RESOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const DEFAULT_INVITATION_LIFETIME_SECONDS = 7 * 24 * 60 * 60;
const MIN_INVITATION_LIFETIME_SECONDS = 60;
const MAX_INVITATION_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
const MAX_ROOM_SECRET_LENGTH = 2_048;

interface CloudRoomIo {
  readStdin: () => Promise<string>;
  readSecretFile: (filePath: string) => Promise<string>;
  writeSecretFile: (filePath: string, value: string) => Promise<void>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!isObject(value)) {
    throw new Error(`Cloud room returned an invalid ${label} response.`);
  }
  return value;
}

function requireStringField(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Cloud room returned an invalid ${label} response.`);
  }
  return value.trim();
}

function requireNullableStringField(
  record: Record<string, unknown>,
  key: string,
  label: string
): string | null {
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new Error(`Cloud room returned an invalid ${label} response.`);
  }
  return value;
}

function requireIsoDateField(record: Record<string, unknown>, key: string, label: string): string {
  const value = requireStringField(record, key, label);
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`Cloud room returned an invalid ${label} response.`);
  }
  return value;
}

function requireResponseRole(record: Record<string, unknown>, label: string): RoomRole {
  const role = record.role;
  if (role !== 'viewer' && role !== 'participant') {
    throw new Error(`Cloud room returned an invalid ${label} response.`);
  }
  return role;
}

function containsForbiddenCredentialField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenCredentialField);
  if (!isObject(value)) return false;
  return Object.entries(value).some(
    ([key, nested]) =>
      /^(?:workspaceKey|relaycastApiKey|relayfileToken|relayfileCredentials|accessToken|refreshToken|authorization|apiKey)$/i.test(
        key
      ) || containsForbiddenCredentialField(nested)
  );
}

type RoomInvite = {
  id: string;
  email: string;
  role: RoomRole;
  expiresAt: string;
  createdAt: string;
  token?: string;
};

function normalizeInvite(value: unknown, requireToken: boolean): RoomInvite {
  const invite = requireObject(value, 'invitation');
  const normalized: RoomInvite = {
    id: requireStringField(invite, 'id', 'invitation'),
    email: requireStringField(invite, 'email', 'invitation'),
    role: requireResponseRole(invite, 'invitation'),
    expiresAt: requireIsoDateField(invite, 'expiresAt', 'invitation'),
    createdAt: requireIsoDateField(invite, 'createdAt', 'invitation'),
  };
  if (requireToken) {
    normalized.token = requireInvitationToken(requireStringField(invite, 'token', 'invitation'));
  }
  return normalized;
}

function normalizeInviteCreate(payload: unknown): { invite: RoomInvite & { token: string } } {
  const response = requireObject(payload, 'invitation');
  return {
    invite: normalizeInvite(response.invite, true) as RoomInvite & { token: string },
  };
}

function normalizeEmailInviteCreate(payload: unknown): {
  invite: RoomInvite;
  delivery: { mode: 'email'; status: 'sent' };
} {
  const response = requireObject(payload, 'email invitation');
  const delivery = requireObject(response.delivery, 'email invitation delivery');
  if (delivery.mode !== 'email' || delivery.status !== 'sent') {
    throw new Error('Cloud room returned an invalid email invitation response.');
  }
  const invite = normalizeInvite(response.invite, false);
  if (containsForbiddenCredentialField(response) || 'token' in requireObject(response.invite, 'invitation')) {
    throw new Error('Cloud room returned a forbidden invitation credential.');
  }
  return { invite, delivery: { mode: 'email', status: 'sent' } };
}

function normalizeInviteList(payload: unknown): { invites: RoomInvite[] } {
  const response = requireObject(payload, 'invitation list');
  if (!Array.isArray(response.invites)) {
    throw new Error('Cloud room returned an invalid invitation list response.');
  }
  return { invites: response.invites.map((invite) => normalizeInvite(invite, false)) };
}

type RoomMember = {
  id: string;
  userId: string;
  email: string | null;
  name: string | null;
  role: RoomRole;
  status: 'active' | 'revoking';
  joinedAt: string;
};

function normalizeMemberList(payload: unknown): { members: RoomMember[] } {
  const response = requireObject(payload, 'member list');
  if (!Array.isArray(response.members)) {
    throw new Error('Cloud room returned an invalid member list response.');
  }
  return {
    members: response.members.map((value) => {
      const member = requireObject(value, 'member list');
      const status = requireStringField(member, 'status', 'member list');
      if (status !== 'active' && status !== 'revoking') {
        throw new Error('Cloud room returned an invalid member list response.');
      }
      return {
        id: requireStringField(member, 'id', 'member list'),
        userId: requireStringField(member, 'userId', 'member list'),
        email: requireNullableStringField(member, 'email', 'member list'),
        name: requireNullableStringField(member, 'name', 'member list'),
        role: requireResponseRole(member, 'member list'),
        status,
        joinedAt: requireIsoDateField(member, 'joinedAt', 'member list'),
      };
    }),
  };
}

function normalizeMembership(payload: unknown): {
  membership: { id: string; workspaceId: string; role: RoomRole };
} {
  const response = requireObject(payload, 'membership');
  const membership = requireObject(response.membership, 'membership');
  return {
    membership: {
      id: requireStringField(membership, 'id', 'membership'),
      workspaceId: requireStringField(membership, 'workspaceId', 'membership'),
      role: requireResponseRole(membership, 'membership'),
    },
  };
}

type RoomSession =
  | { role: 'viewer'; relaycastBaseUrl: string; observerToken: string }
  | {
      role: 'participant';
      relaycastBaseUrl: string;
      agentName: string;
      agentToken: string;
    };

function normalizeRoomSession(payload: unknown): RoomSession {
  const response = requireObject(payload, 'session');
  const role = requireResponseRole(response, 'session');
  const relaycastBaseUrl = requireRelaycastBaseUrl(
    requireStringField(response, 'relaycastBaseUrl', 'session')
  );
  if (role === 'viewer') {
    if (
      typeof response.observerToken !== 'string' ||
      !response.observerToken.trim().startsWith('ot_live_') ||
      response.agentToken !== undefined
    ) {
      throw new Error('Cloud room returned an invalid viewer session response.');
    }
    return { role, relaycastBaseUrl, observerToken: response.observerToken.trim() };
  }
  if (
    typeof response.agentToken !== 'string' ||
    !response.agentToken.trim().startsWith('at_live_') ||
    response.observerToken !== undefined
  ) {
    throw new Error('Cloud room returned an invalid participant session response.');
  }
  return {
    role,
    relaycastBaseUrl,
    agentName: requireStringField(response, 'agentName', 'participant session'),
    agentToken: response.agentToken.trim(),
  };
}

function parsePositiveInteger(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new InvalidArgumentError('Expected a positive whole number.');
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < MIN_INVITATION_LIFETIME_SECONDS ||
    parsed > MAX_INVITATION_LIFETIME_SECONDS
  ) {
    throw new InvalidArgumentError(
      `Expected between ${MIN_INVITATION_LIFETIME_SECONDS} and ${MAX_INVITATION_LIFETIME_SECONDS} seconds.`
    );
  }
  return parsed;
}

function parseRoomRole(value: string): RoomRole {
  if (value === 'viewer' || value === 'participant') {
    return value;
  }
  throw new InvalidArgumentError('Expected role to be one of: viewer, participant');
}

function requireWorkspaceId(value: string): string {
  const workspaceId = value.trim();
  if (!CLOUD_WORKSPACE_UUID_PATTERN.test(workspaceId) && !UNIFIED_WORKSPACE_ID_PATTERN.test(workspaceId)) {
    throw new Error(
      'Unsupported Cloud workspace identifier. Use a Cloud workspace UUID or unified rw_ workspace ID.'
    );
  }
  return workspaceId;
}

function requireResourceId(value: string, label: string): string {
  const resourceId = value.trim();
  // Cloud owns these opaque identifiers. Only reject values that cannot be
  // safely carried in a URL path or terminal; encodeURIComponent handles the
  // remaining printable characters without coupling the CLI to an ID format.
  if (
    !resourceId ||
    resourceId.length > 512 ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(resourceId)
  ) {
    throw new Error(`Invalid ${label}.`);
  }
  return resourceId;
}

function requireEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (email.length > 320 || /[\r\n]/.test(email) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('A valid email address is required.');
  }
  return email;
}

function requireDeviceId(value: string): string {
  const deviceId = value.trim();
  if (!ROOM_RESOURCE_ID_PATTERN.test(deviceId)) {
    throw new Error('Invalid device ID. Use 1-128 letters, numbers, underscores, or hyphens.');
  }
  return deviceId;
}

/** Keep Cloud/user-provided text from controlling or escaping the terminal. */
function sanitizeTerminalCell(value: string): string {
  // eslint-disable-next-line no-control-regex
  return stripAnsiFast(value).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '�');
}

async function defaultReadStdin(): Promise<string> {
  let input = '';
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (input.length > MAX_ROOM_SECRET_LENGTH + 1) {
      throw new Error('Invalid room invitation token.');
    }
  }
  return input;
}

async function defaultReadSecretFile(filePath: string): Promise<string> {
  const noFollow = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW;
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | noFollow);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new Error('Room invitation token file must be a regular file.');
    }
    if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
      throw new Error('Room invitation token file must have owner-only permissions (0600).');
    }
    if (metadata.size > MAX_ROOM_SECRET_LENGTH + 1) {
      throw new Error('Invalid room invitation token.');
    }
    return handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

async function defaultWriteSecretFile(filePath: string, value: string): Promise<void> {
  const noFollow = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW;
  const handle = await fs.open(
    filePath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
    0o600
  );
  try {
    await handle.writeFile(`${value}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function requireInvitationToken(value: string): string {
  const token = value.trim();
  if (
    !token.startsWith('herdr_inv_') ||
    token.length > MAX_ROOM_SECRET_LENGTH ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f-\u009f]/.test(token)
  ) {
    throw new Error('Invalid room invitation token.');
  }
  return token;
}

function requireRelaycastBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Cloud room returned an invalid session response.');
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('Cloud room returned an invalid session response.');
  }
  return url.toString().replace(/\/+$/, '');
}

function canonicalApiBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid Cloud API URL.');
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('Invalid Cloud API URL.');
  }
  return url.toString().replace(/\/+$/, '');
}

function cloudRoomError(response: Response): Error {
  if (response.status === 401) {
    return new Error('Cloud login required. Run `agent-relay cloud login` and retry.');
  }
  if (response.status === 403) {
    return new Error('You do not have permission to perform that room operation.');
  }
  if (response.status === 404) {
    return new Error('The room resource was not found or is no longer available.');
  }
  if (response.status === 409) {
    return new Error('The room operation conflicts with the current membership state.');
  }
  if (response.status === 410) {
    return new Error('The room invitation has expired or was already used.');
  }
  if (response.status === 429) {
    const retryAfter = response.headers.get('retry-after')?.trim();
    return new Error(
      `Cloud room rate limit exceeded.${
        retryAfter ? ` Retry-After: ${retryAfter} seconds.` : ' Wait and retry.'
      }`
    );
  }
  if (response.status >= 400 && response.status < 500) {
    return new Error(`Cloud rejected the room request (${response.status}).`);
  }
  return new Error(`Cloud room request failed (${response.status}).`);
}

async function requestRoomWithAuth(
  deps: CloudRoomDependencies,
  path: string,
  init: RequestInit,
  apiUrl?: string,
  priorAuth?: CloudAuth
): Promise<{ payload: unknown; auth: CloudAuth }> {
  const requestedApiUrl = apiUrl ?? defaultApiUrl();
  const auth =
    priorAuth ??
    (
      await deps.ensureCloudSession({
        apiUrl: requestedApiUrl,
        interactive: false,
      })
    ).auth;
  if (apiUrl && canonicalApiBaseUrl(auth.apiUrl) !== canonicalApiBaseUrl(requestedApiUrl)) {
    throw new Error(
      `Cloud login is bound to ${canonicalApiBaseUrl(
        auth.apiUrl
      )}. Run \`agent-relay cloud login --api-url ${canonicalApiBaseUrl(
        requestedApiUrl
      )} --force\` before using this host.`
    );
  }
  const result = await deps.authorizedApiFetch(auth, path, init, {
    interactive: false,
  });
  const payload = (await result.response.json().catch(() => null)) as unknown;
  if (!result.response.ok) {
    throw cloudRoomError(result.response);
  }
  if (containsForbiddenCredentialField(payload)) {
    throw new Error('Cloud room returned a forbidden workspace or integration credential.');
  }
  return { payload, auth: result.auth };
}

async function requestRoom(
  deps: CloudRoomDependencies,
  path: string,
  init: RequestInit,
  apiUrl?: string
): Promise<unknown> {
  return (await requestRoomWithAuth(deps, path, init, apiUrl)).payload;
}

async function runRoomAction(deps: CloudRoomDependencies, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    deps.error(error instanceof Error ? error.message : String(error));
    deps.exit(1);
  }
}

function logJson(deps: CloudRoomDependencies, payload: unknown): void {
  deps.log(JSON.stringify(payload, null, 2));
}

function textField(record: object, key: string): string | undefined {
  const value = (record as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() ? sanitizeTerminalCell(value.trim()) : undefined;
}

function renderInvites(payload: { invites: RoomInvite[] }, deps: CloudRoomDependencies): void {
  const { invites } = payload;
  if (invites.length === 0) {
    deps.log('No active room invitations.');
    return;
  }
  for (const invite of invites) {
    const id = textField(invite, 'id') ?? 'unknown';
    const email = textField(invite, 'email') ?? 'unknown';
    const role = textField(invite, 'role') ?? 'unknown';
    const expiresAt = textField(invite, 'expiresAt');
    deps.log([id, email, role, expiresAt ? `expires ${expiresAt}` : undefined].filter(Boolean).join('  '));
  }
}

function renderMembers(payload: { members: RoomMember[] }, deps: CloudRoomDependencies): void {
  const { members } = payload;
  if (members.length === 0) {
    deps.log('No room members.');
    return;
  }
  for (const member of members) {
    const id = textField(member, 'id') ?? 'unknown';
    const email = textField(member, 'email') ?? textField(member, 'name') ?? 'unknown';
    const role = textField(member, 'role') ?? 'unknown';
    const status = textField(member, 'status');
    deps.log([id, email, role, status].filter(Boolean).join('  '));
  }
}

export function registerCloudRoomCommands(
  cloudCommand: Command,
  deps: CloudRoomDependencies,
  ioOverrides: Partial<CloudRoomIo> = {}
): void {
  const io: CloudRoomIo = {
    readStdin: defaultReadStdin,
    readSecretFile: defaultReadSecretFile,
    writeSecretFile: defaultWriteSecretFile,
    ...ioOverrides,
  };
  const room = cloudCommand.command('room').description('Manage workspace-scoped multiplayer rooms');

  room
    .command('invite')
    .description('Invite an email address to a workspace room')
    .requiredOption('--workspace <workspace>', 'Cloud UUID or unified rw_ workspace ID')
    .requiredOption('--email <email>', 'Email address bound to the invitation')
    .option('--api-url <url>', 'Cloud API base URL')
    .option('--role <role>', 'Room role: viewer or participant', parseRoomRole, 'participant')
    .option(
      '--expires-in <seconds>',
      'Invitation lifetime in seconds',
      parsePositiveInteger,
      DEFAULT_INVITATION_LIFETIME_SECONDS
    )
    .option('--email-delivery', 'Send the invitation through Agent Relay Cloud email')
    .option('--token-stdout', 'Print only the one-time invitation token')
    .option('--token-file <path>', 'Write the token to a new owner-only 0600 file')
    .option('--json', 'Output the invitation as JSON; manual delivery includes its one-time token')
    .action(
      async (options: {
        workspace: string;
        email: string;
        role: RoomRole;
        expiresIn: number;
        apiUrl?: string;
        emailDelivery?: boolean;
        tokenStdout?: boolean;
        tokenFile?: string;
        json?: boolean;
      }) => {
        await runRoomAction(deps, async () => {
          const manualSinkCount = [options.tokenStdout, Boolean(options.tokenFile), options.json].filter(
            Boolean
          ).length;
          if (
            (options.emailDelivery && (options.tokenStdout || options.tokenFile)) ||
            (!options.emailDelivery && manualSinkCount !== 1)
          ) {
            throw new Error(
              'Use --email-delivery (optionally with --json), or exactly one manual token sink: --token-stdout, --token-file, or --json.'
            );
          }
          const workspaceId = requireWorkspaceId(options.workspace);
          const email = requireEmail(options.email);
          const created = await requestRoomWithAuth(
            deps,
            `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/room/invites`,
            {
              method: 'POST',
              body: JSON.stringify({
                email,
                role: options.role,
                expiresInSeconds: options.expiresIn,
                ...(options.emailDelivery ? { delivery: 'email' } : {}),
              }),
            },
            options.apiUrl
          );
          if (options.emailDelivery) {
            const payload = normalizeEmailInviteCreate(created.payload);
            if (options.json) {
              logJson(deps, payload);
              return;
            }
            deps.log(`Sent ${options.role} room invitation to ${email}.`);
            return;
          }
          const payload = normalizeInviteCreate(created.payload);
          if (options.json) {
            logJson(deps, payload);
            return;
          }
          if (options.tokenStdout) {
            deps.log(payload.invite.token);
            return;
          }
          try {
            await io.writeSecretFile(options.tokenFile ?? '', payload.invite.token);
          } catch (writeError) {
            try {
              await requestRoomWithAuth(
                deps,
                `/api/v1/workspaces/${encodeURIComponent(
                  workspaceId
                )}/room/invites/${encodeURIComponent(payload.invite.id)}`,
                { method: 'DELETE' },
                options.apiUrl,
                created.auth
              );
            } catch {
              throw new Error(
                `Could not write the invitation token. Revocation could not be confirmed; revoke invitation ${sanitizeTerminalCell(
                  payload.invite.id
                )} before retrying.`
              );
            }
            throw writeError;
          }
          deps.log(`Created ${options.role} room invitation for ${email}.`);
          deps.log(
            `Wrote the one-time invitation token to ${sanitizeTerminalCell(options.tokenFile ?? '')}.`
          );
        });
      }
    );

  room
    .command('invites')
    .description('List workspace room invitations')
    .requiredOption('--workspace <workspace>', 'Cloud UUID or unified rw_ workspace ID')
    .option('--api-url <url>', 'Cloud API base URL')
    .option('--json', 'Output invitations as JSON')
    .action(async (options: { workspace: string; apiUrl?: string; json?: boolean }) => {
      await runRoomAction(deps, async () => {
        const workspaceId = requireWorkspaceId(options.workspace);
        const payload = normalizeInviteList(
          await requestRoom(
            deps,
            `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/room/invites`,
            { method: 'GET' },
            options.apiUrl
          )
        );
        if (options.json) {
          logJson(deps, payload);
          return;
        }
        renderInvites(payload, deps);
      });
    });

  room
    .command('revoke-invite')
    .description('Revoke an unused workspace room invitation')
    .argument('<invite-id>', 'Invitation ID')
    .requiredOption('--workspace <workspace>', 'Cloud UUID or unified rw_ workspace ID')
    .option('--api-url <url>', 'Cloud API base URL')
    .option('--json', 'Output the revocation response as JSON')
    .action(
      async (inviteIdInput: string, options: { workspace: string; apiUrl?: string; json?: boolean }) => {
        await runRoomAction(deps, async () => {
          const workspaceId = requireWorkspaceId(options.workspace);
          const inviteId = requireResourceId(inviteIdInput, 'invitation ID');
          await requestRoom(
            deps,
            `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/room/invites/${encodeURIComponent(inviteId)}`,
            { method: 'DELETE' },
            options.apiUrl
          );
          if (options.json) {
            logJson(deps, { ok: true });
            return;
          }
          deps.log(`Revoked room invitation ${inviteId}.`);
        });
      }
    );

  room
    .command('members')
    .description('List workspace room members')
    .requiredOption('--workspace <workspace>', 'Cloud UUID or unified rw_ workspace ID')
    .option('--api-url <url>', 'Cloud API base URL')
    .option('--json', 'Output members as JSON')
    .action(async (options: { workspace: string; apiUrl?: string; json?: boolean }) => {
      await runRoomAction(deps, async () => {
        const workspaceId = requireWorkspaceId(options.workspace);
        const payload = normalizeMemberList(
          await requestRoom(
            deps,
            `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/room/members`,
            { method: 'GET' },
            options.apiUrl
          )
        );
        if (options.json) {
          logJson(deps, payload);
          return;
        }
        renderMembers(payload, deps);
      });
    });

  room
    .command('remove-member')
    .description('Remove a member and revoke their live room access')
    .argument('<member-id>', 'Workspace membership ID')
    .requiredOption('--workspace <workspace>', 'Cloud UUID or unified rw_ workspace ID')
    .option('--api-url <url>', 'Cloud API base URL')
    .option('--json', 'Output the removal response as JSON')
    .action(
      async (memberIdInput: string, options: { workspace: string; apiUrl?: string; json?: boolean }) => {
        await runRoomAction(deps, async () => {
          const workspaceId = requireWorkspaceId(options.workspace);
          const memberId = requireResourceId(memberIdInput, 'membership ID');
          await requestRoom(
            deps,
            `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/room/members/${encodeURIComponent(memberId)}`,
            { method: 'DELETE' },
            options.apiUrl
          );
          if (options.json) {
            logJson(deps, { ok: true });
            return;
          }
          deps.log(`Removed room member ${memberId} and revoked their room sessions.`);
        });
      }
    );

  room
    .command('accept')
    .description('Accept an email-bound room invitation')
    .option('--token-stdin', 'Read the single-use invitation token from stdin')
    .option('--token-file <path>', 'Read the invitation token from an owner-only 0600 file')
    .option('--api-url <url>', 'Cloud API base URL')
    .option('--json', 'Output the accepted membership as JSON')
    .action(
      async (options: { tokenStdin?: boolean; tokenFile?: string; apiUrl?: string; json?: boolean }) => {
        await runRoomAction(deps, async () => {
          if (Boolean(options.tokenStdin) === Boolean(options.tokenFile)) {
            throw new Error('Use exactly one of --token-stdin or --token-file.');
          }
          const token = requireInvitationToken(
            options.tokenStdin ? await io.readStdin() : await io.readSecretFile(options.tokenFile ?? '')
          );
          const payload = normalizeMembership(
            await requestRoom(
              deps,
              '/api/v1/room/invites/accept',
              {
                method: 'POST',
                body: JSON.stringify({ token }),
              },
              options.apiUrl
            )
          );
          if (options.json) {
            logJson(deps, payload);
            return;
          }
          deps.log('Room invitation accepted.');
        });
      }
    );

  room
    .command('revoke-session')
    .description('Revoke this member’s scoped session for one device')
    .requiredOption('--workspace <workspace>', 'Cloud UUID or unified rw_ workspace ID')
    .requiredOption('--device-id <device-id>', 'Stable non-secret identifier for this client')
    .option('--api-url <url>', 'Cloud API base URL')
    .option('--json', 'Output the revocation response as JSON')
    .action(async (options: { workspace: string; deviceId: string; apiUrl?: string; json?: boolean }) => {
      await runRoomAction(deps, async () => {
        const workspaceId = requireWorkspaceId(options.workspace);
        const deviceId = requireDeviceId(options.deviceId);
        await requestRoom(
          deps,
          `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/room/session`,
          {
            method: 'DELETE',
            body: JSON.stringify({ deviceId }),
          },
          options.apiUrl
        );
        if (options.json) {
          logJson(deps, { ok: true });
          return;
        }
        deps.log(`Revoked room session for device ${sanitizeTerminalCell(deviceId)}.`);
      });
    });

  room
    .command('session')
    .description('Create or resume this device’s scoped room session')
    .requiredOption('--workspace <workspace>', 'Cloud UUID or unified rw_ workspace ID')
    .requiredOption('--device-id <device-id>', 'Stable non-secret identifier for this client')
    .option('--api-url <url>', 'Cloud API base URL')
    .option('--json', 'Output the session, including its scoped participant or observer credential')
    .action(async (options: { workspace: string; deviceId: string; apiUrl?: string; json?: boolean }) => {
      await runRoomAction(deps, async () => {
        const workspaceId = requireWorkspaceId(options.workspace);
        const deviceId = requireDeviceId(options.deviceId);
        const payload = normalizeRoomSession(
          await requestRoom(
            deps,
            `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/room/session`,
            {
              method: 'POST',
              body: JSON.stringify({ deviceId }),
            },
            options.apiUrl
          )
        );
        if (options.json) {
          logJson(deps, payload);
          return;
        }
        deps.log(`Room session ready with role ${payload.role}.`);
        deps.log('Scoped credentials are hidden. Trusted clients may request them explicitly with --json.');
      });
    });
}
