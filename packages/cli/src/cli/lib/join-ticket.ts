import type { AttachMode } from './attach-mode.js';
import { describeError } from './describe-error.js';
import { resolveBaseUrl } from './sdk-client.js';

const DEFAULT_RELAYCAST_BASE_URL = 'https://cast.agentrelay.com';
const REDEEM_PATH = '/v1/workspace/join-tickets/redeem';
const JOIN_TICKET_PATTERN = /^rjt_live_[0-9a-f]{64}$/;

type JoinTicketScope = {
  purpose?: unknown;
  node?: unknown;
  agent?: unknown;
  mode?: unknown;
};

type JoinTicketRedemptionPayload = {
  ok?: unknown;
  data?: {
    workspace_id?: unknown;
    workspace_key?: unknown;
    scope?: JoinTicketScope;
  };
  error?: {
    code?: unknown;
    message?: unknown;
  };
};

export interface RedeemJoinTicketOptions {
  ticket: string;
  node: string;
  agent: string;
  mode: AttachMode;
  env?: NodeJS.ProcessEnv;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

export interface RedeemedJoinTicket {
  workspaceId: string;
  workspaceKey: string;
}

type NormalizedJoinTicketRequest = Pick<RedeemJoinTicketOptions, 'ticket' | 'node' | 'agent' | 'mode'>;

export class JoinTicketRedemptionError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly status?: number
  ) {
    super(message);
    this.name = 'JoinTicketRedemptionError';
  }
}

function cleanString(value: unknown): string | undefined {
  const cleaned = typeof value === 'string' ? value.trim() : '';
  return cleaned || undefined;
}

function asRedemptionPayload(value: unknown): JoinTicketRedemptionPayload {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JoinTicketRedemptionPayload)
    : {};
}

function matchesAttachScope(
  scope: JoinTicketScope | undefined,
  options: Pick<RedeemJoinTicketOptions, 'node' | 'agent' | 'mode'>
): boolean {
  return (
    scope?.purpose === 'node_attach' &&
    scope.node === options.node &&
    scope.agent === options.agent &&
    scope.mode === options.mode
  );
}

/**
 * Ensure a server/network error can never echo the one-time ticket into the
 * terminal, even if a future ticket format is not yet known to the shared
 * credential-prefix redactor.
 */
function withoutRawTicket(message: string, ticket: string): string {
  return message.split(ticket).join('[redacted join ticket]');
}

function normalizeRequest(options: RedeemJoinTicketOptions): NormalizedJoinTicketRequest {
  const ticket = cleanString(options.ticket);
  if (!ticket || !JOIN_TICKET_PATTERN.test(ticket)) {
    throw new JoinTicketRedemptionError(
      'Error: Invalid workspace join ticket. Request a new attach command.',
      'invalid_request'
    );
  }
  const node = cleanString(options.node);
  const agent = cleanString(options.agent);
  if (!node || !agent) {
    throw new JoinTicketRedemptionError(
      'Error: A workspace join ticket requires a node and agent.',
      'invalid_request'
    );
  }
  return { ticket, node, agent, mode: options.mode };
}

function redemptionBaseUrl(options: RedeemJoinTicketOptions): string {
  return (
    cleanString(options.baseUrl) ??
    resolveBaseUrl({ env: options.env }) ??
    DEFAULT_RELAYCAST_BASE_URL
  ).replace(/\/+$/, '');
}

function failedRedemption(
  payload: JoinTicketRedemptionPayload,
  status: number,
  ticket: string
): JoinTicketRedemptionError {
  const detail = cleanString(payload.error?.message) ?? `redemption request failed (HTTP ${status})`;
  return new JoinTicketRedemptionError(
    `Error: Could not redeem workspace join ticket: ${withoutRawTicket(detail, ticket)}`,
    cleanString(payload.error?.code),
    status
  );
}

function credentialFromPayload(
  payload: JoinTicketRedemptionPayload,
  request: NormalizedJoinTicketRequest,
  status: number
): RedeemedJoinTicket {
  const workspaceId = cleanString(payload.data?.workspace_id);
  const workspaceKey = cleanString(payload.data?.workspace_key);
  if (
    !workspaceId ||
    !workspaceKey?.startsWith('rk_live_') ||
    !matchesAttachScope(payload.data?.scope, request)
  ) {
    throw new JoinTicketRedemptionError(
      'Error: Workspace join ticket redemption returned an invalid credential response.',
      'invalid_response',
      status
    );
  }
  return { workspaceId, workspaceKey };
}

/** Redeem a scope-bound, single-use join ticket for a persistable workspace credential. */
export async function redeemJoinTicket(options: RedeemJoinTicketOptions): Promise<RedeemedJoinTicket> {
  const request = normalizeRequest(options);
  const fetchFn = options.fetch ?? globalThis.fetch;

  let response: Response;
  try {
    response = await fetchFn(`${redemptionBaseUrl(options)}${REDEEM_PATH}`, {
      method: 'POST',
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
      body: JSON.stringify(request),
    });
  } catch (error) {
    throw new JoinTicketRedemptionError(
      `Error: Could not redeem workspace join ticket: ${withoutRawTicket(
        describeError(error),
        request.ticket
      )}`,
      'join_ticket_request_failed'
    );
  }

  const payload = asRedemptionPayload(await response.json().catch(() => ({})));
  if (!response.ok || payload.ok !== true) {
    throw failedRedemption(payload, response.status, request.ticket);
  }
  return credentialFromPayload(payload, request, response.status);
}
