import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { chmod, readFile, rename, writeFile, mkdir } from 'node:fs/promises';
import {
  createServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { join } from 'node:path';

import type { SendMessageInput } from '@agent-relay/sdk';
import { RelayCast, type AgentClient } from '@relaycast/sdk';
import type {
  MessageCreatedEvent,
  ThreadReplyEvent,
  DmReceivedEvent,
  GroupDmReceivedEvent,
  CommandInvokedEvent,
  ReactionAddedEvent,
  ReactionRemovedEvent,
} from '@relaycast/sdk';
import WebSocket from 'ws';

import { openclawHome } from './config.js';
import {
  DEFAULT_OPENCLAW_GATEWAY_PORT,
  type GatewayConfig,
  type InboundMessage,
  type DeliveryResult,
} from './types.js';
import { SpawnManager } from './spawn/manager.js';
import type { SpawnOptions } from './spawn/types.js';

/**
 * A minimal interface for sending messages via Agent Relay.
 * Accepts either AgentRelayClient or AgentRelay — any object with a
 * compatible sendMessage() method.
 */
export interface RelaySender {
  sendMessage(input: SendMessageInput): Promise<{ event_id: string; targets?: string[] }>;
}

export interface GatewayOptions {
  /** Gateway configuration. */
  config: GatewayConfig;
  /**
   * Pre-existing relay sender for message delivery.
   * Pass the API server's AgentRelay instance so all gateways share a single
   * broker process instead of each spawning their own.
   */
  relaySender?: RelaySender;
}

type InboundTransportState = 'WS_ACTIVE' | 'WS_DEGRADED' | 'POLL_ACTIVE' | 'RECOVERING_WS';
type InboundTransportMode = 'ws' | 'poll';

interface PollEventEnvelope {
  id: string;
  sequence: number;
  timestamp: string;
  payload: Record<string, unknown>;
}

interface PollResponseBody {
  events?: PollEventEnvelope[];
  nextCursor?: string;
  hasMore?: boolean;
}

interface PersistedPollCursorState {
  cursor: string;
  lastSequence: number;
  recentEventIds: string[];
  updatedAt: string;
}

interface InboundProcessingResult {
  committed: boolean;
  reason?: 'duplicate' | 'echo';
  result?: DeliveryResult;
}

interface RealtimeHandlingOptions {
  eventId?: string;
  timestamp?: string;
}

const DEFAULT_POLL_ENDPOINT_PATH = '/messages/poll';
const DEFAULT_POLL_INITIAL_CURSOR = '0';
const DEFAULT_WS_FAILURE_THRESHOLD = 3;
const DEFAULT_POLL_TIMEOUT_SECONDS = 25;
const MAX_POLL_TIMEOUT_SECONDS = 30;
const DEFAULT_POLL_LIMIT = 100;
const MAX_POLL_LIMIT = 500;
const DEFAULT_WS_PROBE_INTERVAL_MS = 60_000;
const DEFAULT_WS_STABLE_GRACE_MS = 10_000;
const POLL_CURSOR_RECENT_EVENT_LIMIT = 256;
const MAX_POLL_CURSOR_LENGTH = 4_096;
const MAX_EVENT_ID_LENGTH = 512;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 30_000;

function pollCursorStatePath(): string {
  return join(openclawHome(), 'workspace', 'relaycast', 'inbound-cursor.json');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function applyJitter(ms: number): number {
  const factor = 1.1 + Math.random() * 0.1;
  return Math.max(0, Math.floor(ms * factor));
}

function hasControlCharacters(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if ((code >= 0 && code <= 31) || code === 127) {
      return true;
    }
  }
  return false;
}

function stripControlChars(value: string): string {
  let out = '';
  for (const char of value) {
    const code = char.charCodeAt(0);
    out += code <= 31 || code === 127 ? ' ' : char;
  }
  return out;
}

function sanitizeOpaqueStateValue(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  if (value.trim().length === 0 || value.length > maxLength) return null;
  if (hasControlCharacters(value)) return null;
  return value;
}

function computeBackoffMs(attempt: number): number {
  const base = Math.min(BACKOFF_BASE_MS * Math.pow(2, Math.max(0, attempt - 1)), BACKOFF_CAP_MS);
  return applyJitter(base);
}

function sanitizePollTimeoutSeconds(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_POLL_TIMEOUT_SECONDS;
  return Math.min(MAX_POLL_TIMEOUT_SECONDS, Math.max(0, Math.floor(value!)));
}

function sanitizePollLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_POLL_LIMIT;
  return Math.min(MAX_POLL_LIMIT, Math.max(1, Math.floor(value!)));
}

function parseRetryAfterMs(retryAfter: string | null): number | null {
  if (!retryAfter) return null;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) {
    return Math.max(0, Math.floor(seconds * 1000));
  }
  const asDate = Date.parse(retryAfter);
  if (Number.isNaN(asDate)) return null;
  return Math.max(0, asDate - Date.now());
}

function normalizeChannelName(channel: string): string {
  return channel.startsWith('#') ? channel.slice(1) : channel;
}

// ---------------------------------------------------------------------------
// Ed25519 device identity for OpenClaw gateway WebSocket auth
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Auth profile system — deterministic profile selection for WS auth across
// OpenClaw/Clawdbot versions. Profiles define key encoding, signature format,
// and payload canonicalization for the device auth handshake.
// ---------------------------------------------------------------------------

interface AuthProfile {
  /** Human-readable profile name (logged on each auth attempt). */
  name: string;
  /** Encoding for the public key sent in the connect message. */
  publicKeyFormat: 'raw-base64url' | 'spki-pem';
  /** Encoding for the Ed25519 signature. */
  signatureEncoding: 'base64url' | 'base64';
}

const AUTH_PROFILES: Record<string, AuthProfile> = {
  default: {
    name: 'default',
    publicKeyFormat: 'raw-base64url',
    signatureEncoding: 'base64url',
  },
  'clawdbot-v1': {
    // Server (openclaw/openclaw device-identity.ts) accepts both PEM and raw-base64url
    // public keys, and decodes signatures in both base64url and base64. Use base64url
    // for consistency — matches the server's own signDevicePayload() output.
    name: 'clawdbot-v1',
    publicKeyFormat: 'raw-base64url',
    signatureEncoding: 'base64url',
  },
};

/**
 * Resolve the auth profile to use. Selection priority:
 * 1. Explicit env var `OPENCLAW_WS_AUTH_COMPAT` (manual override, highest priority)
 * 2. Variant detection: `~/.clawdbot/` detected → clawdbot-v1
 * 3. Default profile (standard OpenClaw, unchanged)
 */
function resolveAuthProfile(): AuthProfile {
  // 1. Manual override (highest priority)
  const envVal = process.env.OPENCLAW_WS_AUTH_COMPAT;
  if (envVal === 'clawdbot' || envVal === 'clawdbot-v1') {
    return AUTH_PROFILES['clawdbot-v1'];
  }
  if (envVal && AUTH_PROFILES[envVal]) {
    return AUTH_PROFILES[envVal];
  }

  // 2. Variant detection via filesystem probing — delegates to openclawHome()
  //    which checks valid parseable config files, not just directory existence.
  //    Strict suffix check avoids false positives from substring matching.
  const home = openclawHome();
  const homeSuffix =
    home
      .replace(/[/\\]+$/, '')
      .split(/[/\\]/)
      .pop() ?? '';
  if (homeSuffix === '.clawdbot' || homeSuffix === 'clawdbot') {
    return AUTH_PROFILES['clawdbot-v1'];
  }

  // 3. Default
  return AUTH_PROFILES['default'];
}

/** Backward-compat helper — returns 'clawdbot' when using clawdbot profile. */
type WsAuthCompat = 'clawdbot' | undefined;
function getWsAuthCompat(): WsAuthCompat {
  const profile = resolveAuthProfile();
  return profile.name === 'clawdbot-v1' ? 'clawdbot' : undefined;
}

interface DeviceIdentity {
  publicKeyB64: string; // base64url-encoded raw Ed25519 public key (default mode)
  publicKeyPem?: string; // PEM-encoded SPKI public key (clawdbot compat mode)
  privateKeyObj: KeyObject; // Node.js KeyObject for signing
  deviceId: string; // SHA-256 hex of the raw public key
}

function generateDeviceIdentity(compat?: WsAuthCompat): DeviceIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');

  // Extract raw 32-byte public key from SPKI DER (12-byte header for Ed25519)
  const rawPublicBytes = publicKey.export({ type: 'spki', format: 'der' }).subarray(12);

  const deviceId = createHash('sha256').update(rawPublicBytes).digest('hex');
  const publicKeyB64 = Buffer.from(rawPublicBytes).toString('base64url');

  const identity: DeviceIdentity = {
    publicKeyB64,
    privateKeyObj: privateKey,
    deviceId,
  };

  if (compat === 'clawdbot') {
    identity.publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
  }

  return identity;
}

/** Path to persisted device identity file. */
function deviceIdentityPath(): string {
  return join(openclawHome(), 'workspace', 'relaycast', 'device.json');
}

interface PersistedDevice {
  publicKeyB64: string;
  privateKeyPkcs8B64: string; // base64-encoded PKCS#8 DER
  deviceId: string;
  /** PEM-encoded SPKI public key — present when generated with clawdbot compat mode. */
  publicKeyPem?: string;
  /** PEM-encoded PKCS#8 private key — present when generated with clawdbot compat mode. */
  privateKeyPem?: string;
}

/**
 * Load a persisted device identity from disk, or generate and persist a new one.
 * This ensures the same device ID survives restarts so the OpenClaw gateway
 * can pair it once and recognize it on subsequent connections.
 */
async function loadOrCreateDeviceIdentity(): Promise<DeviceIdentity> {
  const filePath = deviceIdentityPath();
  const compat = getWsAuthCompat();

  // Attempt to load existing identity (no existsSync — just try the read)
  try {
    const raw = await readFile(filePath, 'utf-8');
    const persisted = JSON.parse(raw) as PersistedDevice;
    const privateKeyObj = createPrivateKey({
      key: Buffer.from(persisted.privateKeyPkcs8B64, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
    // Ensure permissions are tight even if file was created with looser perms
    await chmod(filePath, 0o600).catch(() => {});
    console.log(
      `[openclaw-ws] Loaded persisted device identity (deviceId=${persisted.deviceId.slice(0, 12)}...)`
    );

    const identity: DeviceIdentity = {
      publicKeyB64: persisted.publicKeyB64,
      privateKeyObj,
      deviceId: persisted.deviceId,
    };

    // If compat mode is clawdbot but the persisted device has no PEM keys,
    // derive them on-the-fly from the existing DER key material.
    if (compat === 'clawdbot') {
      if (persisted.publicKeyPem) {
        identity.publicKeyPem = persisted.publicKeyPem;
      } else {
        // Reconstruct SPKI public key from the stored base64url raw bytes
        const rawPublicBytes = Buffer.from(persisted.publicKeyB64, 'base64url');
        // Ed25519 SPKI DER = 12-byte header + 32-byte raw key
        const spkiHeader = Buffer.from('302a300506032b6570032100', 'hex');
        const spkiDer = Buffer.concat([spkiHeader, rawPublicBytes]);
        const publicKeyObj = createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });
        identity.publicKeyPem = publicKeyObj.export({ type: 'spki', format: 'pem' }) as string;
        console.log('[openclaw-ws] Derived PEM public key from existing DER key for clawdbot compat mode');
      }
    }

    return identity;
  } catch (err) {
    // ENOENT is expected on first run; other errors mean corruption
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(
        `[openclaw-ws] Failed to load device identity, generating new: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // Generate fresh and persist via atomic write-then-rename
  const identity = generateDeviceIdentity(compat);
  const pkcs8Der = identity.privateKeyObj.export({ type: 'pkcs8', format: 'der' });
  const persisted: PersistedDevice = {
    publicKeyB64: identity.publicKeyB64,
    privateKeyPkcs8B64: Buffer.from(pkcs8Der).toString('base64'),
    deviceId: identity.deviceId,
  };

  if (compat === 'clawdbot' && identity.publicKeyPem) {
    persisted.publicKeyPem = identity.publicKeyPem;
    persisted.privateKeyPem = identity.privateKeyObj.export({ type: 'pkcs8', format: 'pem' }) as string;
  }

  try {
    const dir = join(openclawHome(), 'workspace', 'relaycast');
    await mkdir(dir, { recursive: true });
    const tmpPath = filePath + '.tmp';
    await writeFile(tmpPath, JSON.stringify(persisted, null, 2) + '\n', { mode: 0o600 });
    await rename(tmpPath, filePath);
    console.log(
      `[openclaw-ws] Persisted new device identity (deviceId=${identity.deviceId.slice(0, 12)}...)`
    );
  } catch (err) {
    console.warn(
      `[openclaw-ws] Could not persist device identity: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return identity;
}

/** Hash helper for diagnostics (no secrets leaked — just truncated SHA-256). */
function shortHash(data: string | Buffer): string {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
  return createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

/**
 * Canonicalization variants to try for debugging. Each produces a different
 * pipe-delimited payload string. The server should match exactly one.
 */
function buildCanonicalVariants(
  device: DeviceIdentity,
  params: {
    clientId: string;
    clientMode: string;
    platform: string;
    deviceFamily: string;
    role: string;
    scopes: string[];
    signedAt: number;
    token: string;
    nonce: string;
  }
): Array<{ name: string; payload: string }> {
  const signedAtMs = String(params.signedAt);
  const signedAtSec = String(Math.floor(params.signedAt / 1000));
  const scopesCsv = params.scopes.join(',');

  return [
    // V0: current default order (v3|deviceId|clientId|clientMode|role|scopes|signedAtMs|token|nonce|platform|deviceFamily)
    {
      name: 'v3-default-ms',
      payload: [
        'v3',
        device.deviceId,
        params.clientId,
        params.clientMode,
        params.role,
        scopesCsv,
        signedAtMs,
        params.token || '',
        params.nonce,
        params.platform,
        params.deviceFamily,
      ].join('|'),
    },
    // V1: signedAt in seconds instead of milliseconds
    {
      name: 'v3-default-sec',
      payload: [
        'v3',
        device.deviceId,
        params.clientId,
        params.clientMode,
        params.role,
        scopesCsv,
        signedAtSec,
        params.token || '',
        params.nonce,
        params.platform,
        params.deviceFamily,
      ].join('|'),
    },
    // V2: no token in payload (token omitted entirely)
    {
      name: 'v3-no-token-ms',
      payload: [
        'v3',
        device.deviceId,
        params.clientId,
        params.clientMode,
        params.role,
        scopesCsv,
        signedAtMs,
        params.nonce,
        params.platform,
        params.deviceFamily,
      ].join('|'),
    },
    // V3: nonce before token (swapped positions)
    {
      name: 'v3-nonce-first-ms',
      payload: [
        'v3',
        device.deviceId,
        params.clientId,
        params.clientMode,
        params.role,
        scopesCsv,
        signedAtMs,
        params.nonce,
        params.token || '',
        params.platform,
        params.deviceFamily,
      ].join('|'),
    },
    // V4: fewer fields — just core identity + nonce + signedAt (minimal)
    {
      name: 'v3-minimal',
      payload: ['v3', device.deviceId, signedAtMs, params.nonce].join('|'),
    },
    // V5: signedAt seconds + no token
    {
      name: 'v3-no-token-sec',
      payload: [
        'v3',
        device.deviceId,
        params.clientId,
        params.clientMode,
        params.role,
        scopesCsv,
        signedAtSec,
        params.nonce,
        params.platform,
        params.deviceFamily,
      ].join('|'),
    },
    // V6: v2 format (no platform/deviceFamily) — used by older gateway versions
    {
      name: 'v2-default-ms',
      payload: [
        'v2',
        device.deviceId,
        params.clientId,
        params.clientMode,
        params.role,
        scopesCsv,
        signedAtMs,
        params.token || '',
        params.nonce,
      ].join('|'),
    },
    // V7: v2 with signedAt in seconds
    {
      name: 'v2-default-sec',
      payload: [
        'v2',
        device.deviceId,
        params.clientId,
        params.clientMode,
        params.role,
        scopesCsv,
        signedAtSec,
        params.token || '',
        params.nonce,
      ].join('|'),
    },
    // V8: v2 without token
    {
      name: 'v2-no-token-ms',
      payload: [
        'v2',
        device.deviceId,
        params.clientId,
        params.clientMode,
        params.role,
        scopesCsv,
        signedAtMs,
        params.nonce,
      ].join('|'),
    },
  ];
}

/** Payload version override for v3↔v2 fallback. */
type PayloadVersionOverride = 'v2' | 'v3' | null;

function signConnectPayload(
  device: DeviceIdentity,
  params: {
    clientId: string;
    clientMode: string;
    platform: string;
    deviceFamily: string;
    role: string;
    scopes: string[];
    signedAt: number;
    token: string;
    nonce: string;
  },
  versionOverride?: PayloadVersionOverride
): string {
  const profile = resolveAuthProfile();

  // Build canonicalization variants for diagnostics
  const variants = buildCanonicalVariants(device, params);

  // Select primary payload version:
  // 1. If versionOverride is set (from fallback), use that directly
  // 2. clawdbot-v1 defaults to v2 (older gateway compat)
  // 3. default profile uses v3
  let primaryName: string;
  if (versionOverride === 'v2') {
    primaryName = 'v2-default-ms';
  } else if (versionOverride === 'v3') {
    primaryName = 'v3-default-ms';
  } else {
    primaryName = profile.name === 'clawdbot-v1' ? 'v2-default-ms' : 'v3-default-ms';
  }
  const primary = variants.find((v) => v.name === primaryName) ?? variants[0];

  const payloadBytes = Buffer.from(primary.payload, 'utf-8');

  const isDebug = process.env.RELAY_LOG_LEVEL === 'DEBUG' || process.env.OPENCLAW_WS_DEBUG === '1';

  // Concise production log — one line with essential info
  console.log(
    `[ws-auth] profile=${profile.name} payload=${primary.name} device=${device.deviceId.slice(0, 12)}...${versionOverride ? ` override=${versionOverride}` : ''}`
  );

  // Verbose debug logging — field hashes and canonicalization matrix
  if (isDebug) {
    console.log(
      `[ws-auth-debug] signedAt=${params.signedAt}ms nonce=${shortHash(params.nonce)} keyFormat=${profile.publicKeyFormat} sigEncoding=${profile.signatureEncoding}`
    );
    console.log(
      `[ws-auth-debug] field hashes: deviceId=${shortHash(device.deviceId)} clientId=${shortHash(params.clientId)} role=${shortHash(params.role)} scopes=${shortHash(params.scopes.join(','))} token=${shortHash(params.token || '')} nonce=${shortHash(params.nonce)}`
    );
    console.log('[ws-auth-debug] canonicalization matrix:');
    for (const v of variants) {
      console.log(`  ${v.name}: hash=${shortHash(v.payload)}`);
    }
    console.log(`[ws-auth-debug] payloadHash=${shortHash(primary.payload)}`);
  }

  // Ed25519 sign — no hash algorithm needed (null), it's built into Ed25519
  const signature = sign(null, payloadBytes, device.privateKeyObj);
  const encoded = Buffer.from(signature).toString(profile.signatureEncoding);

  // Self-verification (debug only): confirm our signature is valid locally.
  if (isDebug) {
    try {
      // Derive public key from private key (same as server would use from our publicKey field)
      const pubKey = createPublicKey(device.privateKeyObj);
      const selfVerifyRaw = verify(null, payloadBytes, pubKey, signature);

      // Also verify the round-trip: decode our encoded signature like the server would
      const decodedSig = Buffer.from(
        encoded,
        profile.signatureEncoding === 'base64url' ? 'base64url' : 'base64'
      );
      const selfVerifyEncoded = verify(null, payloadBytes, pubKey, decodedSig);

      // Verify deviceId matches public key
      const rawPubBytes = pubKey.export({ type: 'spki', format: 'der' }).subarray(12);
      const derivedDeviceId = createHash('sha256').update(rawPubBytes).digest('hex');
      const deviceIdMatch = derivedDeviceId === device.deviceId;

      console.log(
        `[ws-auth-debug] self-verify: raw=${selfVerifyRaw} encoded=${selfVerifyEncoded} deviceIdMatch=${deviceIdMatch} derivedId=${derivedDeviceId.slice(0, 16)}...`
      );
      if (!deviceIdMatch) {
        console.error(
          `[ws-auth-debug] DEVICE ID MISMATCH: derived=${derivedDeviceId} sent=${device.deviceId}`
        );
      }
    } catch (err) {
      console.error(`[ws-auth-debug] self-verify error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return encoded;
}

// ---------------------------------------------------------------------------
// Persistent OpenClaw Gateway WebSocket client
// ---------------------------------------------------------------------------

interface PendingRpc {
  resolve: (value: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** @internal */
export class OpenClawGatewayClient {
  private ws: WebSocket | null = null;
  private authenticated = false;
  private device: DeviceIdentity;
  private token: string;
  private port: number;
  private pendingRpcs = new Map<string, PendingRpc>();
  private rpcIdCounter = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private connectPromise: Promise<void> | null = null;
  private connectResolve: (() => void) | null = null;
  private connectReject: ((error: Error) => void) | null = null;
  private connectTimeout: ReturnType<typeof setTimeout> | null = null;
  private pairingRejected = false;
  private consecutiveFailures = 0;
  /** Payload version override for v3↔v2 fallback (null = use profile default). */
  private payloadVersionOverride: PayloadVersionOverride = null;
  /** Whether a fallback attempt has already been tried this connection cycle. */
  private fallbackAttempted = false;
  /** Auth rejection counters for observability. */
  private authRejectCount = 0;
  private authFallbackCount = 0;

  /** Default timeout for initial connection (30 seconds). */
  private static readonly CONNECT_TIMEOUT_MS = 30_000;
  private static readonly MAX_CONSECUTIVE_FAILURES = 5;
  private static readonly BASE_RECONNECT_MS = 3_000;
  private static readonly MAX_RECONNECT_MS = 30_000;
  /** Slow retry interval after pairing rejection or max failures (60s). */
  private static readonly PAIRING_RETRY_MS = 60_000;

  constructor(token: string, port: number, device?: DeviceIdentity) {
    this.token = token;
    this.port = port;
    this.device = device ?? generateDeviceIdentity(getWsAuthCompat());
  }

  /**
   * Create a client with a persisted device identity (loaded from disk or
   * freshly generated and saved). This ensures the same device ID is reused
   * across restarts so the OpenClaw gateway can pair it once.
   */
  static async create(token: string, port: number): Promise<OpenClawGatewayClient> {
    const device = await loadOrCreateDeviceIdentity();
    return new OpenClawGatewayClient(token, port, device);
  }

  /** Connect and authenticate. Resolves when chat.send is ready, rejects on timeout or error. */
  async connect(): Promise<void> {
    if (this.authenticated && this.ws?.readyState === WebSocket.OPEN) return;

    // Explicit connect() clears pairing rejection so users can retry after fixing their token
    this.pairingRejected = false;
    this.stopped = false;
    // Reset fallback state for fresh connection attempts
    this.payloadVersionOverride = null;
    this.fallbackAttempted = false;

    // Cancel any pending reconnect timer to prevent orphaned WebSocket connections
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.connectPromise = new Promise<void>((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;

      // Set up timeout to prevent indefinite hanging
      this.connectTimeout = setTimeout(() => {
        this.connectTimeout = null;
        if (!this.authenticated) {
          const err = new Error(
            `Connection to OpenClaw gateway timed out after ${OpenClawGatewayClient.CONNECT_TIMEOUT_MS}ms`
          );
          this.connectReject?.(err);
          this.connectReject = null;
          this.connectResolve = null;
        }
      }, OpenClawGatewayClient.CONNECT_TIMEOUT_MS);
    });

    this.doConnect();
    return this.connectPromise;
  }

  private clearConnectTimeout(): void {
    if (this.connectTimeout) {
      clearTimeout(this.connectTimeout);
      this.connectTimeout = null;
    }
  }

  private doConnect(): void {
    if (this.stopped) return;

    let ws: WebSocket;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${this.port}`);
    } catch (err) {
      console.warn(`[openclaw-ws] Connection failed: ${err instanceof Error ? err.message : String(err)}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      console.log('[openclaw-ws] Connected to OpenClaw gateway');
    });

    ws.on('message', (data) => {
      // Guard: ignore messages from superseded WebSocket instances.
      if (this.ws !== ws) return;
      this.handleMessage(data.toString());
    });

    ws.on('close', (code, reason) => {
      // Guard: ignore close events from superseded WebSocket instances.
      // During v3↔v2 fallback, the old WS is replaced before its close fires.
      if (this.ws !== ws) return;

      // Sanitize reason to prevent log injection (newlines, control chars)
      const reasonStr = stripControlChars(reason.toString()).slice(0, 200);
      console.warn(`[openclaw-ws] Disconnected: ${code} ${reasonStr}`);
      const wasAuthenticated = this.authenticated;
      this.authenticated = false;

      // Detect pairing rejection: code 1008 (Policy Violation) with pairing reason
      if (code === 1008 && /pairing|not.paired/i.test(reasonStr)) {
        console.error('[openclaw-ws] Connection closed due to pairing policy. Device is not paired.');
        console.error(`[openclaw-ws] Device ID: ${this.device.deviceId.slice(0, 16)}...`);
        console.error(
          '[openclaw-ws] Run: openclaw devices approve <requestId> (check gateway logs for requestId)'
        );
        this.pairingRejected = true;
      }

      // Reject all pending RPCs
      for (const [id, pending] of this.pendingRpcs) {
        clearTimeout(pending.timer);
        pending.resolve(false);
        this.pendingRpcs.delete(id);
      }
      // If we weren't authenticated yet, reject the connect promise
      if (!wasAuthenticated && this.connectReject) {
        this.clearConnectTimeout();
        const err = new Error(`WebSocket closed before authentication (code=${code})`);
        this.connectReject(err);
        this.connectReject = null;
        this.connectResolve = null;
      }
      if (!this.stopped) {
        this.scheduleReconnect();
      }
    });

    ws.on('error', (err) => {
      // Guard: ignore error events from superseded WebSocket instances.
      if (this.ws !== ws) return;

      console.warn(`[openclaw-ws] Error: ${err.message}`);
      // If we weren't authenticated yet, reject the connect promise
      if (!this.authenticated && this.connectReject) {
        this.clearConnectTimeout();
        this.connectReject(err);
        this.connectReject = null;
        this.connectResolve = null;
      }
    });
  }

  // eslint-disable-next-line complexity
  private handleMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // Handle connect.challenge — sign and respond
    if (msg.type === 'event' && msg.event === 'connect.challenge') {
      const payload = msg.payload as { nonce: string; ts: number };
      console.log('[openclaw-ws] Received connect.challenge, signing...');
      // Log raw challenge payload for debugging canonicalization issues
      if (process.env.RELAY_LOG_LEVEL === 'DEBUG' || process.env.OPENCLAW_WS_DEBUG === '1') {
        console.log(`[ws-auth-debug] challenge payload: ${JSON.stringify(payload)}`);
      }

      const signedAt = Date.now();
      const clientId = 'cli';
      const clientMode = 'cli';
      const platform = process.platform === 'darwin' ? 'macos' : 'linux';
      const deviceFamily = 'cli';
      const role = 'operator';
      const scopes = ['operator.read', 'operator.write'];

      const signature = signConnectPayload(
        this.device,
        {
          clientId,
          clientMode,
          platform,
          deviceFamily,
          role,
          scopes,
          signedAt,
          token: this.token,
          nonce: payload.nonce,
        },
        this.payloadVersionOverride
      );

      // Select public key format based on resolved auth profile.
      const profile = resolveAuthProfile();
      const publicKeyField =
        profile.publicKeyFormat === 'spki-pem' && this.device.publicKeyPem
          ? this.device.publicKeyPem
          : this.device.publicKeyB64;

      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        console.warn('[openclaw-ws] WebSocket not open when trying to send connect');
        return;
      }
      this.ws.send(
        JSON.stringify({
          type: 'req',
          id: 'connect-1',
          method: 'connect',
          params: {
            minProtocol: 3,
            maxProtocol: 3,
            client: {
              id: clientId,
              version: '1.0.0',
              platform,
              mode: clientMode,
              deviceFamily,
            },
            role,
            scopes,
            caps: [],
            commands: [],
            permissions: {},
            auth: { token: this.token },
            locale: 'en-US',
            userAgent: 'relaycast-gateway/1.0.0',
            device: {
              id: this.device.deviceId,
              publicKey: publicKeyField,
              signature,
              signedAt,
              nonce: payload.nonce,
            },
          },
        })
      );
      return;
    }

    // Handle connect response
    if (msg.type === 'res' && msg.id === 'connect-1') {
      if (msg.ok) {
        this.clearConnectTimeout();
        const versionUsed =
          this.payloadVersionOverride ?? (resolveAuthProfile().name === 'clawdbot-v1' ? 'v2' : 'v3');
        console.log(
          `[openclaw-ws] Authenticated successfully (payload=${versionUsed}${this.fallbackAttempted ? ', via fallback' : ''})`
        );
        this.authenticated = true;
        this.consecutiveFailures = 0;
        this.connectResolve?.();
        this.connectResolve = null;
        this.connectReject = null;
      } else {
        const errStr = msg.error ? JSON.stringify(msg.error) : 'Authentication rejected';
        const isPairing = /pairing.required|not.paired/i.test(errStr);
        const isSignatureInvalid = /signature.invalid|device.signature|invalid.signature/i.test(errStr);

        if (isPairing) {
          this.clearConnectTimeout();
          const errObj = msg.error as Record<string, unknown> | undefined;
          const requestId = errObj?.requestId ?? errObj?.request_id ?? '';
          console.error('[openclaw-ws] Pairing rejected — device is not paired with the OpenClaw gateway.');
          if (requestId) {
            console.error(`[openclaw-ws] Approve this device:  openclaw devices approve ${requestId}`);
          }
          console.error(`[openclaw-ws] Device ID: ${this.device.deviceId.slice(0, 16)}...`);
          const configHint =
            getWsAuthCompat() === 'clawdbot' ? '~/.clawdbot/clawdbot.json' : '~/.openclaw/openclaw.json';
          console.error(
            `[openclaw-ws] Ensure OPENCLAW_GATEWAY_TOKEN matches ${configHint} gateway.auth.token`
          );
          this.pairingRejected = true;
        } else if (isSignatureInvalid && !this.fallbackAttempted) {
          // Signature rejected — try the alternate payload version once.
          // Do NOT clear connect timeout — it protects the fallback attempt too.
          this.authRejectCount++;
          this.authFallbackCount++;
          const profile = resolveAuthProfile();
          const currentVersion =
            this.payloadVersionOverride ?? (profile.name === 'clawdbot-v1' ? 'v2' : 'v3');
          const fallbackVersion: PayloadVersionOverride = currentVersion === 'v2' ? 'v3' : 'v2';

          console.warn(
            `[ws-auth] Signature rejected with ${currentVersion} payload — retrying with ${fallbackVersion} fallback (rejects=${this.authRejectCount} fallbacks=${this.authFallbackCount})`
          );
          this.payloadVersionOverride = fallbackVersion;
          this.fallbackAttempted = true;

          // Close current WS and reconnect with the alternate payload.
          // Setting this.ws = null ensures the old WS's close/error handlers
          // no-op via the `this.ws !== ws` guard in doConnect().
          try {
            this.ws?.close();
          } catch {
            // Best effort
          }
          this.ws = null;
          setTimeout(() => this.doConnect(), 0);
          return; // Don't reject the connect promise yet — fallback attempt in progress
        } else {
          this.clearConnectTimeout();
          this.authRejectCount++;
          console.warn(`[openclaw-ws] Auth rejected (rejects=${this.authRejectCount}): ${errStr}`);
        }

        this.connectReject?.(new Error(`OpenClaw gateway auth failed: ${errStr}`));
        this.connectReject = null;
        this.connectResolve = null;
      }
      return;
    }

    // Handle RPC responses
    const id = msg.id as string | undefined;
    if (id && this.pendingRpcs.has(id)) {
      const pending = this.pendingRpcs.get(id)!;
      clearTimeout(pending.timer);
      this.pendingRpcs.delete(id);

      if (msg.ok === false || msg.error) {
        console.warn('[openclaw-ws] RPC error response received');
        pending.resolve(false);
      } else {
        console.log('[openclaw-ws] RPC succeeded');
        pending.resolve(true);
      }
      return;
    }

    // Log other events at debug level
    if (msg.type === 'event') {
      // chat events, tick events, etc. — ignore silently
    }
  }

  /** Send a chat.send RPC. Returns true if accepted. */
  async sendChatMessage(text: string, idempotencyKey?: string): Promise<boolean> {
    if (this.stopped) return false;
    if (!this.authenticated || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Try to reconnect
      try {
        await this.connect();
      } catch {
        return false;
      }
      if (!this.authenticated) return false;
    }

    const id = `chat-${++this.rpcIdCounter}-${Date.now()}`;

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        console.warn(`[openclaw-ws] chat.send ${id} timed out`);
        this.pendingRpcs.delete(id);
        resolve(false);
      }, 15_000);

      this.pendingRpcs.set(id, { resolve, timer });

      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        clearTimeout(timer);
        this.pendingRpcs.delete(id);
        resolve(false);
        return;
      }
      this.ws.send(
        JSON.stringify({
          type: 'req',
          id,
          method: 'chat.send',
          params: {
            sessionKey: 'agent:main:main',
            message: text,
            ...(idempotencyKey ? { idempotencyKey } : {}),
          },
        })
      );
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;

    // After pairing rejection or max failures, switch to slow periodic retry
    // so the gateway can self-heal once pairing is approved externally.
    if (this.pairingRejected || this.consecutiveFailures >= OpenClawGatewayClient.MAX_CONSECUTIVE_FAILURES) {
      if (this.consecutiveFailures === OpenClawGatewayClient.MAX_CONSECUTIVE_FAILURES) {
        console.warn(
          `[openclaw-ws] ${this.consecutiveFailures} consecutive failures — switching to slow retry (every 60s).`
        );
        console.warn(
          '[openclaw-ws] Check that the OpenClaw gateway is running and OPENCLAW_GATEWAY_TOKEN is correct.'
        );
      }
      this.consecutiveFailures++;
      console.log(`[openclaw-ws] Slow retry in ${OpenClawGatewayClient.PAIRING_RETRY_MS / 1000}s...`);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.pairingRejected = false; // Clear flag so connect attempt proceeds
        // Reset fallback state so reconnect tries primary payload version first
        this.payloadVersionOverride = null;
        this.fallbackAttempted = false;
        this.doConnect();
      }, OpenClawGatewayClient.PAIRING_RETRY_MS);
      return;
    }

    this.consecutiveFailures++;

    const delay = Math.min(
      OpenClawGatewayClient.BASE_RECONNECT_MS * Math.pow(2, this.consecutiveFailures - 1),
      OpenClawGatewayClient.MAX_RECONNECT_MS
    );
    console.log(`[openclaw-ws] Reconnecting in ${delay / 1000}s (attempt ${this.consecutiveFailures})...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // Reset fallback state so reconnect tries primary payload version first
      this.payloadVersionOverride = null;
      this.fallbackAttempted = false;
      this.doConnect();
    }, delay);
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    this.clearConnectTimeout();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const [id, pending] of this.pendingRpcs) {
      clearTimeout(pending.timer);
      pending.resolve(false);
      this.pendingRpcs.delete(id);
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Best effort
      }
      this.ws = null;
    }
    this.authenticated = false;
    // Clear any pending connect promise
    this.connectReject = null;
    this.connectResolve = null;
  }
}

// ---------------------------------------------------------------------------
// InboundGateway
// ---------------------------------------------------------------------------

export class InboundGateway {
  private readonly relaySender: RelaySender | null;
  private relayAgentClient: AgentClient | null = null;
  private relayAgentToken: string | null = null;
  private readonly relaycast: RelayCast;
  private readonly config: GatewayConfig;
  private readonly dedupeTtlMs: number;

  private running = false;
  private unsubscribeHandlers: Array<() => void> = [];
  private seenMessageIds = new Map<string, number>();
  private processingMessageIds = new Set<string>();

  /** Persistent WebSocket client for the local OpenClaw gateway. */
  private openclawClient: OpenClawGatewayClient | null = null;

  /** Spawn manager — lives in the gateway so spawned processes survive MCP server restarts. */
  private spawnManager: SpawnManager;
  /** HTTP control server for spawn/list/release commands. */
  private controlServer: HttpServer | null = null;
  /** Port the control server listens on. */
  controlPort = 0;

  private transportState: InboundTransportState = 'WS_DEGRADED';
  private activeTransportMode: InboundTransportMode = 'ws';
  private wsFailureCount = 0;
  private pollLoopPromise: Promise<void> | null = null;
  private pollAbortController: AbortController | null = null;
  private pollLoopStopRequested = false;
  private pollCursorLoaded = false;
  private pollCursor = DEFAULT_POLL_INITIAL_CURSOR;
  private pollLastSequence = 0;
  private pollRecentEventIds: string[] = [];
  private pollFailureCount = 0;
  private probeWsTimer: ReturnType<typeof setInterval> | null = null;
  private wsRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private fallbackCount = 0;
  private lastFallbackReason: string | null = null;
  private fallbackStartedAt: number | null = null;
  private totalFallbackMs = 0;
  private duplicateDropCount = 0;
  private cursorResetCount = 0;

  /** Default control port for the gateway's spawn API. */
  static readonly DEFAULT_CONTROL_PORT = 18790;

  constructor(options: GatewayOptions) {
    this.config = {
      ...options.config,
      channels: options.config.channels.map(normalizeChannelName),
    };
    this.relaySender = options.relaySender ?? null;
    this.relaycast = new RelayCast({
      apiKey: this.config.apiKey,
      baseUrl: this.config.baseUrl,
    });

    const dedupeTtlMs = Number(process.env.RELAYCAST_DEDUPE_TTL_MS ?? 15 * 60 * 1000);
    this.dedupeTtlMs =
      Number.isFinite(dedupeTtlMs) && dedupeTtlMs >= 1000 ? Math.floor(dedupeTtlMs) : 15 * 60 * 1000;

    const parentDepth = Number(process.env.OPENCLAW_SPAWN_DEPTH || 0);
    this.spawnManager = new SpawnManager({ spawnDepth: parentDepth + 1 });
  }

  private isPollFallbackEnabled(): boolean {
    return this.config.transport?.pollFallback?.enabled ?? false;
  }

  private wsFailureThreshold(): number {
    const configured = this.config.transport?.pollFallback?.wsFailureThreshold;
    if (!Number.isFinite(configured) || configured === undefined) {
      return DEFAULT_WS_FAILURE_THRESHOLD;
    }
    return Math.max(1, Math.floor(configured));
  }

  private pollTimeoutSeconds(): number {
    return sanitizePollTimeoutSeconds(this.config.transport?.pollFallback?.timeoutSeconds);
  }

  private pollLimit(): number {
    return sanitizePollLimit(this.config.transport?.pollFallback?.limit);
  }

  private pollInitialCursor(): string {
    return this.config.transport?.pollFallback?.initialCursor?.trim() || DEFAULT_POLL_INITIAL_CURSOR;
  }

  private isWsProbeEnabled(): boolean {
    return this.config.transport?.pollFallback?.probeWs?.enabled ?? true;
  }

  private wsProbeIntervalMs(): number {
    const configured = this.config.transport?.pollFallback?.probeWs?.intervalMs;
    if (!Number.isFinite(configured) || configured === undefined) {
      return DEFAULT_WS_PROBE_INTERVAL_MS;
    }
    return Math.max(1_000, Math.floor(configured));
  }

  private wsStableGraceMs(): number {
    const configured = this.config.transport?.pollFallback?.probeWs?.stableGraceMs;
    if (!Number.isFinite(configured) || configured === undefined) {
      return DEFAULT_WS_STABLE_GRACE_MS;
    }
    return Math.max(1_000, Math.floor(configured));
  }

  private transportHealthSnapshot(): Record<string, unknown> {
    const activeFallbackMs = this.fallbackStartedAt === null ? 0 : Date.now() - this.fallbackStartedAt;
    return {
      mode: this.activeTransportMode,
      state: this.transportState,
      wsFailureCount: this.wsFailureCount,
      fallbackCount: this.fallbackCount,
      lastFallbackReason: this.lastFallbackReason,
      timeInFallbackMs: this.totalFallbackMs + activeFallbackMs,
      duplicateDrops: this.duplicateDropCount,
      cursorResets: this.cursorResetCount,
      lastSequence: this.pollLastSequence,
    };
  }

  private completeFallbackWindow(): void {
    if (this.fallbackStartedAt !== null) {
      this.totalFallbackMs += Date.now() - this.fallbackStartedAt;
      this.fallbackStartedAt = null;
    }
  }

  private cleanupRelaySubscriptions(): void {
    for (const unsubscribe of this.unsubscribeHandlers) {
      try {
        unsubscribe();
      } catch {
        // Best effort
      }
    }
    this.unsubscribeHandlers = [];
  }

  private subscribeRelayChannels(): void {
    if (!this.relayAgentClient) return;
    try {
      this.relayAgentClient.subscribe(this.config.channels);
    } catch {
      // Will subscribe on the next connected event.
    }
  }

  private async connectRelayAgentClient(): Promise<void> {
    if (!this.relayAgentClient) return;
    try {
      await Promise.resolve(this.relayAgentClient.connect());
    } catch (error) {
      console.warn(
        `[gateway] Relaycast WS connect failed: ${error instanceof Error ? error.message : String(error)}`
      );
      await this.handleWsFailure('connect_failed');
    }
  }

  private bindRelayAgentHandlers(): void {
    if (!this.relayAgentClient) return;

    this.cleanupRelaySubscriptions();

    this.unsubscribeHandlers.push(
      this.relayAgentClient.on.connected(() => {
        console.log(
          `[gateway] Relaycast WebSocket connected, subscribing to channels: ${this.config.channels.join(', ')}`
        );
        this.wsFailureCount = 0;
        this.subscribeRelayChannels();
        if (this.transportState === 'POLL_ACTIVE' || this.transportState === 'RECOVERING_WS') {
          this.beginWsRecovery();
          return;
        }
        this.completeFallbackWindow();
        this.transportState = 'WS_ACTIVE';
        this.activeTransportMode = 'ws';
      })
    );
    this.unsubscribeHandlers.push(
      this.relayAgentClient.on.messageCreated((event: MessageCreatedEvent) => {
        if (!this.shouldProcessWsInbound()) return;
        console.log(`[gateway] Realtime message from @${event.message?.agentName} in #${event.channel}`);
        void this.handleRealtimeMessage(event);
      })
    );
    this.unsubscribeHandlers.push(
      this.relayAgentClient.on.threadReply((event: ThreadReplyEvent) => {
        if (!this.shouldProcessWsInbound()) return;
        console.log(
          `[gateway] Thread reply from @${event.message?.agentName} in #${event.channel} (parent: ${event.parentId})`
        );
        void this.handleRealtimeThreadReply(event);
      })
    );
    this.unsubscribeHandlers.push(
      this.relayAgentClient.on.dmReceived((event: DmReceivedEvent) => {
        if (!this.shouldProcessWsInbound()) return;
        console.log(`[gateway] DM from @${event.message?.agentName} (conv: ${event.conversationId})`);
        void this.handleRealtimeDm(event);
      })
    );
    this.unsubscribeHandlers.push(
      this.relayAgentClient.on.groupDmReceived((event: GroupDmReceivedEvent) => {
        if (!this.shouldProcessWsInbound()) return;
        console.log(`[gateway] Group DM from @${event.message?.agentName} (conv: ${event.conversationId})`);
        void this.handleRealtimeGroupDm(event);
      })
    );
    this.unsubscribeHandlers.push(
      this.relayAgentClient.on.commandInvoked((event: CommandInvokedEvent) => {
        if (!this.shouldProcessWsInbound()) return;
        console.log(
          `[gateway] Command /${event.command} invoked by @${event.invokedBy} in #${event.channel}`
        );
        void this.handleRealtimeCommand(event);
      })
    );
    this.unsubscribeHandlers.push(
      this.relayAgentClient.on.reactionAdded((event: ReactionAddedEvent) => {
        if (!this.shouldProcessWsInbound()) return;
        console.log(`[gateway] Reaction :${event.emoji}: added by @${event.agentName} on ${event.messageId}`);
        void this.handleRealtimeReaction(event, 'added');
      })
    );
    this.unsubscribeHandlers.push(
      this.relayAgentClient.on.reactionRemoved((event: ReactionRemovedEvent) => {
        if (!this.shouldProcessWsInbound()) return;
        console.log(
          `[gateway] Reaction :${event.emoji}: removed by @${event.agentName} from ${event.messageId}`
        );
        void this.handleRealtimeReaction(event, 'removed');
      })
    );
    this.unsubscribeHandlers.push(
      this.relayAgentClient.on.reconnecting((attempt: number) => {
        console.warn(`[gateway] Relaycast reconnecting (attempt ${attempt})`);
        void this.handleWsFailure(`reconnecting:${attempt}`);
      })
    );
    this.unsubscribeHandlers.push(
      this.relayAgentClient.on.disconnected(() => {
        console.warn('[gateway] Relaycast disconnected');
        void this.handleWsFailure('disconnected');
      })
    );
    this.unsubscribeHandlers.push(
      this.relayAgentClient.on.error((error?: unknown) => {
        const message = error instanceof Error ? error.message : 'socket error';
        console.warn(`[gateway] Relaycast socket error${message ? `: ${message}` : ''}`);
        void this.handleWsFailure(message || 'socket_error');
      })
    );
  }

  private async replaceRelayAgentClient(agentToken: string): Promise<void> {
    this.cleanupRelaySubscriptions();
    if (this.relayAgentClient) {
      try {
        await this.relayAgentClient.disconnect();
      } catch {
        // Best effort
      }
    }
    this.relayAgentToken = agentToken;
    this.relayAgentClient = this.relaycast.as(agentToken);
    // SDK's onEvent() throws if the WS object doesn't exist yet.
    // connect() synchronously creates the WS and initiates the connection,
    // so we call it before binding handlers. This ensures:
    // 1. The WS object exists when onEvent() is called (no throw)
    // 2. Handlers are bound before the connection fully opens (no missed events)
    // 3. The SDK's double-connect guard (if ws exists, no-op) makes this safe
    try {
      this.relayAgentClient.connect();
    } catch (err) {
      console.warn(
        `[gateway] Relaycast WS connect failed: ${err instanceof Error ? err.message : String(err)}`
      );
      void this.handleWsFailure('connect_failed');
    }
    this.bindRelayAgentHandlers();
  }

  private async refreshRelayAgentRegistration(): Promise<void> {
    const registered = await this.relaycast.agents.registerOrRotate({
      name: this.config.clawName,
      type: 'agent',
      persona: 'Relaycast inbound gateway for OpenClaw',
    });
    await this.replaceRelayAgentClient(registered.token);
    await this.ensureChannelMembership();
    this.subscribeRelayChannels();
  }

  private shouldProcessWsInbound(): boolean {
    return (
      !this.isPollFallbackEnabled() ||
      this.transportState === 'WS_ACTIVE' ||
      this.transportState === 'RECOVERING_WS'
    );
  }

  private async handleWsFailure(reason: string): Promise<void> {
    if (!this.running) return;

    if (this.wsRecoveryTimer) {
      clearTimeout(this.wsRecoveryTimer);
      this.wsRecoveryTimer = null;
    }

    if (this.transportState === 'RECOVERING_WS') {
      console.warn(`[gateway] WS recovery probe failed, remaining on long-poll (${reason})`);
      this.transportState = 'POLL_ACTIVE';
      this.activeTransportMode = 'poll';
      await this.startPollLoop();
      this.startWsProbeLoop();
      return;
    }

    if (this.transportState === 'POLL_ACTIVE') {
      this.lastFallbackReason = reason;
      return;
    }

    this.transportState = 'WS_DEGRADED';
    this.wsFailureCount += 1;

    if (this.isPollFallbackEnabled() && this.wsFailureCount >= this.wsFailureThreshold()) {
      await this.activatePollFallback(reason);
    }
  }

  private async activatePollFallback(reason: string): Promise<void> {
    if (!this.running || !this.isPollFallbackEnabled()) return;
    if (this.transportState === 'POLL_ACTIVE') return;

    await this.ensurePollCursorLoaded();
    this.transportState = 'POLL_ACTIVE';
    this.activeTransportMode = 'poll';
    this.fallbackCount += 1;
    this.lastFallbackReason = reason;
    if (this.fallbackStartedAt === null) {
      this.fallbackStartedAt = Date.now();
    }

    console.warn(`[gateway] Realtime degraded: using long-poll fallback (${reason})`);
    await this.startPollLoop();
    this.startWsProbeLoop();
  }

  private startWsProbeLoop(): void {
    if (!this.isWsProbeEnabled() || this.probeWsTimer) return;

    this.probeWsTimer = setInterval(() => {
      if (!this.running || this.transportState !== 'POLL_ACTIVE') return;
      void this.connectRelayAgentClient();
    }, this.wsProbeIntervalMs());
  }

  private stopWsProbeLoop(): void {
    if (!this.probeWsTimer) return;
    clearInterval(this.probeWsTimer);
    this.probeWsTimer = null;
  }

  private beginWsRecovery(): void {
    if (!this.running) return;

    this.transportState = 'RECOVERING_WS';
    this.stopWsProbeLoop();

    if (this.wsRecoveryTimer) {
      clearTimeout(this.wsRecoveryTimer);
    }

    console.log(`[gateway] WS probe connected, waiting ${this.wsStableGraceMs()}ms before promotion`);
    this.wsRecoveryTimer = setTimeout(() => {
      this.wsRecoveryTimer = null;
      void this.promoteWsTransport();
    }, this.wsStableGraceMs());
  }

  private async promoteWsTransport(): Promise<void> {
    if (!this.running || this.transportState !== 'RECOVERING_WS') return;

    await this.stopPollLoop();
    const catchupDelayMs = await this.pollOnce(0);
    if (catchupDelayMs > 0) {
      console.warn('[gateway] WS promotion catch-up poll failed, remaining on long-poll');
      this.transportState = 'POLL_ACTIVE';
      this.activeTransportMode = 'poll';
      await this.startPollLoop();
      this.startWsProbeLoop();
      return;
    }

    this.completeFallbackWindow();
    this.transportState = 'WS_ACTIVE';
    this.activeTransportMode = 'ws';
    this.wsFailureCount = 0;
    console.log('[gateway] Relaycast WebSocket recovered; promoting WS to active transport');
  }

  private async ensurePollCursorLoaded(): Promise<void> {
    if (this.pollCursorLoaded) return;

    this.pollCursorLoaded = true;
    this.pollCursor = this.pollInitialCursor();

    try {
      const raw = await readFile(pollCursorStatePath(), 'utf-8');
      const parsed = JSON.parse(raw) as Partial<PersistedPollCursorState>;
      const persistedCursor = sanitizeOpaqueStateValue(parsed.cursor, MAX_POLL_CURSOR_LENGTH);
      if (persistedCursor) {
        this.pollCursor = persistedCursor;
      }
      if (Number.isFinite(parsed.lastSequence)) {
        this.pollLastSequence = Math.max(0, Math.floor(parsed.lastSequence ?? 0));
      }
      if (Array.isArray(parsed.recentEventIds)) {
        this.pollRecentEventIds = parsed.recentEventIds
          .map((value) => sanitizeOpaqueStateValue(value, MAX_EVENT_ID_LENGTH))
          .filter((value): value is string => value !== null)
          .slice(-POLL_CURSOR_RECENT_EVENT_LIMIT);
        const now = Date.now();
        for (const eventId of this.pollRecentEventIds) {
          this.seenMessageIds.set(eventId, now);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(
          `[gateway] Failed to load poll cursor state: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  private async persistPollCursorState(): Promise<void> {
    const cursor =
      sanitizeOpaqueStateValue(this.pollCursor, MAX_POLL_CURSOR_LENGTH) ?? this.pollInitialCursor();
    const recentEventIds = this.pollRecentEventIds
      .map((eventId) => sanitizeOpaqueStateValue(eventId, MAX_EVENT_ID_LENGTH))
      .filter((eventId): eventId is string => eventId !== null)
      .slice(-POLL_CURSOR_RECENT_EVENT_LIMIT);
    this.pollCursor = cursor;
    this.pollRecentEventIds = recentEventIds;

    const state: PersistedPollCursorState = {
      cursor,
      lastSequence: this.pollLastSequence,
      recentEventIds,
      updatedAt: new Date().toISOString(),
    };

    const filePath = pollCursorStatePath();
    const tmpPath = `${filePath}.tmp`;
    await mkdir(join(openclawHome(), 'workspace', 'relaycast'), { recursive: true });
    await writeFile(tmpPath, JSON.stringify(state, null, 2) + '\n', 'utf-8');
    await rename(tmpPath, filePath);
  }

  private rememberPollEventId(eventId: string): void {
    const sanitizedEventId = sanitizeOpaqueStateValue(eventId, MAX_EVENT_ID_LENGTH);
    if (!sanitizedEventId) return;
    this.pollRecentEventIds = [
      ...this.pollRecentEventIds.filter((id) => id !== sanitizedEventId),
      sanitizedEventId,
    ].slice(-POLL_CURSOR_RECENT_EVENT_LIMIT);
  }

  private hasRecentPollEventId(eventId: string): boolean {
    return this.pollRecentEventIds.includes(eventId);
  }

  private async commitPollCursorState(nextCursor: string, lastSequence: number): Promise<void> {
    const sanitizedCursor = sanitizeOpaqueStateValue(nextCursor, MAX_POLL_CURSOR_LENGTH);
    if (sanitizedCursor) {
      this.pollCursor = sanitizedCursor;
    }
    this.pollLastSequence = Math.max(this.pollLastSequence, lastSequence);
    await this.persistPollCursorState();
  }

  private async resetPollCursorState(reason: string): Promise<void> {
    this.cursorResetCount += 1;
    this.lastFallbackReason = reason;
    this.pollCursor = this.pollInitialCursor();
    this.pollLastSequence = 0;
    await this.persistPollCursorState();
  }

  private async startPollLoop(): Promise<void> {
    if (this.pollLoopPromise) return;

    this.pollLoopStopRequested = false;
    this.pollLoopPromise = (async () => {
      while (
        this.running &&
        !this.pollLoopStopRequested &&
        (this.transportState === 'POLL_ACTIVE' || this.transportState === 'RECOVERING_WS')
      ) {
        const delayMs = await this.pollOnce(this.pollTimeoutSeconds());
        if (
          !this.running ||
          this.pollLoopStopRequested ||
          !(this.transportState === 'POLL_ACTIVE' || this.transportState === 'RECOVERING_WS')
        ) {
          break;
        }
        if (delayMs > 0) {
          await sleep(delayMs);
        }
      }
    })().finally(() => {
      this.pollLoopPromise = null;
      this.pollAbortController = null;
    });
  }

  private async stopPollLoop(): Promise<void> {
    this.pollLoopStopRequested = true;
    if (this.pollAbortController) {
      this.pollAbortController.abort();
      this.pollAbortController = null;
    }
    if (this.pollLoopPromise) {
      await this.pollLoopPromise.catch(() => undefined);
      this.pollLoopPromise = null;
    }
  }

  // eslint-disable-next-line complexity
  private async pollOnce(timeoutSeconds: number): Promise<number> {
    await this.ensurePollCursorLoaded();

    const baseUrl = new URL(DEFAULT_POLL_ENDPOINT_PATH, this.config.baseUrl);
    baseUrl.searchParams.set('cursor', this.pollCursor);
    baseUrl.searchParams.set('timeout', String(timeoutSeconds));
    baseUrl.searchParams.set('limit', String(this.pollLimit()));

    const timeoutMs = Math.max(5_000, (timeoutSeconds + 5) * 1_000);
    const abortController = new AbortController();
    this.pollAbortController = abortController;
    const timeoutHandle = setTimeout(() => abortController.abort(), timeoutMs);

    try {
      const response = await fetch(baseUrl, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: this.relayAgentToken ? `Bearer ${this.relayAgentToken}` : '',
          'x-api-key': this.config.apiKey,
        },
        signal: abortController.signal,
      });

      if (response.status === 401 || response.status === 403) {
        console.warn(`[gateway] Poll auth rejected (${response.status}); refreshing token`);
        try {
          await this.refreshRelayAgentRegistration();
          this.pollFailureCount = 0;
          return 0;
        } catch (error) {
          console.warn(
            `[gateway] Poll auth refresh failed: ${error instanceof Error ? error.message : String(error)}`
          );
          this.pollFailureCount += 1;
          return computeBackoffMs(this.pollFailureCount);
        }
      }

      if (response.status === 409) {
        console.warn('[gateway] Poll cursor invalid/stale; resetting cursor state');
        this.pollFailureCount = 0;
        await this.resetPollCursorState('cursor_reset');
        return 0;
      }

      if (response.status === 429) {
        this.pollFailureCount += 1;
        const retryAfterMs = parseRetryAfterMs(response.headers.get('Retry-After'));
        return retryAfterMs !== null ? applyJitter(retryAfterMs) : computeBackoffMs(this.pollFailureCount);
      }

      if (response.status >= 500) {
        this.pollFailureCount += 1;
        return computeBackoffMs(this.pollFailureCount);
      }

      if (!response.ok) {
        this.pollFailureCount += 1;
        console.warn(`[gateway] Poll request failed: HTTP ${response.status}`);
        return computeBackoffMs(this.pollFailureCount);
      }

      const body = (await response.json()) as PollResponseBody;
      this.pollFailureCount = 0;
      const processed = await this.processPollResponse(body);
      return processed ? 0 : computeBackoffMs(1);
    } catch (error) {
      if (abortController.signal.aborted) {
        return 0;
      }
      this.pollFailureCount += 1;
      console.warn(
        `[gateway] Poll request failed: ${error instanceof Error ? error.message : String(error)}`
      );
      return computeBackoffMs(this.pollFailureCount);
    } finally {
      clearTimeout(timeoutHandle);
      if (this.pollAbortController === abortController) {
        this.pollAbortController = null;
      }
    }
  }

  private async processPollResponse(body: PollResponseBody): Promise<boolean> {
    const events = Array.isArray(body.events) ? [...body.events] : [];
    events.sort((left, right) => left.sequence - right.sequence);

    let lastSequence = this.pollLastSequence;

    for (const event of events) {
      if (!event || typeof event.id !== 'string' || !Number.isFinite(event.sequence)) {
        continue;
      }

      lastSequence = Math.max(lastSequence, event.sequence);

      if (
        event.sequence <= this.pollLastSequence ||
        this.hasRecentPollEventId(event.id) ||
        this.isSeen(event.id)
      ) {
        this.duplicateDropCount += 1;
        continue;
      }

      const committed = await this.handlePolledEvent(event);
      if (!committed) {
        return false;
      }

      this.rememberPollEventId(event.id);
    }

    const nextCursor = sanitizeOpaqueStateValue(body.nextCursor, MAX_POLL_CURSOR_LENGTH) ?? this.pollCursor;
    await this.commitPollCursorState(nextCursor, lastSequence);
    return true;
  }

  // eslint-disable-next-line complexity
  private async handlePolledEvent(event: PollEventEnvelope): Promise<boolean> {
    const type = typeof event.payload.type === 'string' ? event.payload.type : '';
    const baseOptions: RealtimeHandlingOptions = {
      timestamp: event.timestamp,
    };

    switch (type) {
      case 'message.created':
      case 'message.received':
      case 'message.new':
      case 'message.sent':
        return (
          await this.handleRealtimeMessage(event.payload as unknown as MessageCreatedEvent, baseOptions)
        ).committed;
      case 'thread.reply':
      case 'thread.message.created':
      case 'thread.message.sent':
        return (
          await this.handleRealtimeThreadReply(event.payload as unknown as ThreadReplyEvent, baseOptions)
        ).committed;
      case 'dm.received':
      case 'dm.message.created':
      case 'direct_message.created':
        return (await this.handleRealtimeDm(event.payload as unknown as DmReceivedEvent, baseOptions))
          .committed;
      case 'group_dm.received':
      case 'group_dm.message.created':
        return (
          await this.handleRealtimeGroupDm(event.payload as unknown as GroupDmReceivedEvent, baseOptions)
        ).committed;
      case 'command.invoked':
        return (
          await this.handleRealtimeCommand(event.payload as unknown as CommandInvokedEvent, {
            ...baseOptions,
            eventId: event.id,
          })
        ).committed;
      case 'reaction.added':
        return (
          await this.handleRealtimeReaction(event.payload as unknown as ReactionAddedEvent, 'added', {
            ...baseOptions,
            eventId: event.id,
          })
        ).committed;
      case 'reaction.removed':
        return (
          await this.handleRealtimeReaction(event.payload as unknown as ReactionRemovedEvent, 'removed', {
            ...baseOptions,
            eventId: event.id,
          })
        ).committed;
      default:
        console.warn(`[gateway] Ignoring unknown polled event type: ${type || 'unknown'}`);
        return true;
    }
  }

  /** Start the gateway — register agent and subscribe for realtime events. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Connect to the local OpenClaw gateway WebSocket (persistent connection)
    const token = this.config.openclawGatewayToken ?? process.env.OPENCLAW_GATEWAY_TOKEN;
    const port = this.config.openclawGatewayPort ?? DEFAULT_OPENCLAW_GATEWAY_PORT;

    if (token) {
      this.openclawClient = await OpenClawGatewayClient.create(token, port);
      try {
        await this.openclawClient.connect();
        console.log('[gateway] OpenClaw gateway WebSocket client ready');
      } catch (err) {
        console.warn(
          `[gateway] OpenClaw gateway WS failed (will retry per message): ${err instanceof Error ? err.message : String(err)}`
        );
      }
    } else {
      console.warn('[gateway] No OPENCLAW_GATEWAY_TOKEN — local delivery disabled');
    }

    const registered = await this.relaycast.agents.registerOrGet({
      name: this.config.clawName,
      type: 'agent',
      persona: 'Relaycast inbound gateway for OpenClaw',
    });

    await this.replaceRelayAgentClient(registered.token);

    await this.ensureChannelMembership();

    // Also subscribe explicitly in case the `connected` event fired before
    // the handler ran, or the SDK defers connection readiness.
    this.subscribeRelayChannels();

    console.log(`[gateway] Realtime listening on channels: ${this.config.channels.join(', ')}`);

    // Start spawn control HTTP server
    await this.startControlServer();
  }

  /** Stop the gateway — clean up websocket and relay clients. */
  async stop(): Promise<void> {
    this.running = false;
    this.stopWsProbeLoop();
    if (this.wsRecoveryTimer) {
      clearTimeout(this.wsRecoveryTimer);
      this.wsRecoveryTimer = null;
    }
    this.completeFallbackWindow();
    await this.stopPollLoop();
    this.cleanupRelaySubscriptions();

    if (this.relayAgentClient) {
      try {
        await this.relayAgentClient.disconnect();
      } catch {
        // Best effort
      }
      this.relayAgentClient = null;
    }

    if (this.openclawClient) {
      await this.openclawClient.disconnect();
      this.openclawClient = null;
    }

    // Stop control server and release all spawns
    if (this.controlServer) {
      this.controlServer.close();
      this.controlServer = null;
    }
    await this.spawnManager.releaseAll();

    this.processingMessageIds.clear();
    this.seenMessageIds.clear();
  }

  private cleanupSeenMap(nowMs: number): void {
    for (const [id, seenAt] of this.seenMessageIds.entries()) {
      if (nowMs - seenAt > this.dedupeTtlMs) {
        this.seenMessageIds.delete(id);
      }
    }
  }

  private isSeen(messageId: string): boolean {
    const nowMs = Date.now();
    this.cleanupSeenMap(nowMs);
    return this.seenMessageIds.has(messageId);
  }

  private markSeen(messageId: string): void {
    const nowMs = Date.now();
    this.cleanupSeenMap(nowMs);
    this.seenMessageIds.set(messageId, nowMs);
  }

  private async ensureChannelMembership(): Promise<void> {
    if (!this.relayAgentClient) return;

    for (const channel of this.config.channels) {
      try {
        await this.relayAgentClient.channels.join(channel);
      } catch {
        try {
          await this.relayAgentClient.channels.create({ name: channel });
          await this.relayAgentClient.channels.join(channel);
        } catch {
          // Non-fatal
        }
      }
    }
  }

  private async handleRealtimeMessage(
    event: MessageCreatedEvent,
    options: RealtimeHandlingOptions = {}
  ): Promise<InboundProcessingResult> {
    const channel = normalizeChannelName(event.channel);
    if (!this.config.channels.includes(channel)) return { committed: true };

    const messageId = options.eventId ?? event.message?.id;
    if (!messageId) return { committed: true };

    const inbound: InboundMessage = {
      id: messageId,
      channel,
      from: event.message?.agentName ?? 'unknown',
      text: event.message?.text ?? '',
      timestamp: options.timestamp ?? new Date().toISOString(),
    };

    return this.processInbound(inbound);
  }

  private async handleRealtimeThreadReply(
    event: ThreadReplyEvent,
    options: RealtimeHandlingOptions = {}
  ): Promise<InboundProcessingResult> {
    const channel = normalizeChannelName(event.channel);
    if (!this.config.channels.includes(channel)) return { committed: true };

    const messageId = options.eventId ?? event.message?.id;
    if (!messageId) return { committed: true };

    const inbound: InboundMessage = {
      id: messageId,
      channel,
      from: event.message?.agentName ?? 'unknown',
      text: event.message?.text ?? '',
      timestamp: options.timestamp ?? new Date().toISOString(),
      threadParentId: event.parentId,
    };

    return this.processInbound(inbound);
  }

  private async handleRealtimeDm(
    event: DmReceivedEvent,
    options: RealtimeHandlingOptions = {}
  ): Promise<InboundProcessingResult> {
    const messageId = options.eventId ?? event.message?.id;
    if (!messageId) return { committed: true };

    const inbound: InboundMessage = {
      id: messageId,
      channel: 'dm',
      from: event.message?.agentName ?? 'unknown',
      text: event.message?.text ?? '',
      timestamp: options.timestamp ?? new Date().toISOString(),
      conversationId: event.conversationId,
      kind: 'dm',
    };

    return this.processInbound(inbound);
  }

  private async handleRealtimeGroupDm(
    event: GroupDmReceivedEvent,
    options: RealtimeHandlingOptions = {}
  ): Promise<InboundProcessingResult> {
    const messageId = options.eventId ?? event.message?.id;
    if (!messageId) return { committed: true };

    const inbound: InboundMessage = {
      id: messageId,
      channel: `groupdm:${event.conversationId}`,
      from: event.message?.agentName ?? 'unknown',
      text: event.message?.text ?? '',
      timestamp: options.timestamp ?? new Date().toISOString(),
      conversationId: event.conversationId,
      kind: 'groupdm',
    };

    return this.processInbound(inbound);
  }

  private async handleRealtimeCommand(
    event: CommandInvokedEvent,
    options: RealtimeHandlingOptions = {}
  ): Promise<InboundProcessingResult> {
    const channel = normalizeChannelName(event.channel);
    if (!this.config.channels.includes(channel)) return { committed: true };

    // Commands lack a server-assigned event ID, so we synthesize one.
    // We include args + timestamp to avoid silently dropping legitimate
    // repeat invocations (e.g. /deploy twice in 15 min). This means SDK
    // reconnection replays may deliver a duplicate, but that's less
    // harmful than silently swallowing a real command.
    const argsSlug = event.args ? `_${event.args}` : '';
    const syntheticId =
      options.eventId ?? `cmd_${event.command}_${channel}_${event.invokedBy}${argsSlug}_${Date.now()}`;
    const argsText = event.args ? ` ${event.args}` : '';

    const inbound: InboundMessage = {
      id: syntheticId,
      channel,
      from: event.invokedBy,
      text: `[relaycast:command:${channel}] @${event.invokedBy} /${event.command}${argsText}`,
      timestamp: options.timestamp ?? new Date().toISOString(),
      kind: 'command',
    };

    return this.processInbound(inbound);
  }

  private async handleRealtimeReaction(
    event: ReactionAddedEvent | ReactionRemovedEvent,
    action: 'added' | 'removed',
    options: RealtimeHandlingOptions = {}
  ): Promise<InboundProcessingResult> {
    // Include timestamp so add→remove→re-add of the same emoji isn't
    // silently dropped within the 15-min dedup window. Reactions are soft
    // notifications, so a rare duplicate on SDK reconnect is acceptable.
    const syntheticId =
      options.eventId ??
      `reaction_${event.messageId}_${event.emoji}_${event.agentName}_${action}_${Date.now()}`;
    const text =
      action === 'added'
        ? `[relaycast:reaction] @${event.agentName} reacted ${event.emoji} to message ${event.messageId} (soft notification, no action required)`
        : `[relaycast:reaction] @${event.agentName} removed ${event.emoji} from message ${event.messageId} (soft notification, no action required)`;

    const inbound: InboundMessage = {
      id: syntheticId,
      channel: 'reaction',
      from: event.agentName,
      text,
      timestamp: options.timestamp ?? new Date().toISOString(),
      kind: 'reaction',
    };

    return this.processInbound(inbound);
  }

  private async processInbound(message: InboundMessage): Promise<InboundProcessingResult> {
    if (!this.running) return { committed: false };
    if (this.processingMessageIds.has(message.id) || this.isSeen(message.id)) {
      this.duplicateDropCount += 1;
      return { committed: true, reason: 'duplicate' };
    }

    // Avoid echo loops — skip messages from this claw.
    if (message.from === this.config.clawName) {
      this.markSeen(message.id);
      return { committed: true, reason: 'echo' };
    }

    this.processingMessageIds.add(message.id);

    console.log(`[gateway] Delivering message ${message.id} from @${message.from}: "${message.text}"`);
    try {
      const result = await this.onMessage(message);
      console.log(
        `[gateway] Delivery result: ${result.method} ok=${result.ok}${result.error ? ' error=' + result.error : ''}`
      );
      if (!result.ok) {
        return { committed: false, result };
      }
      this.markSeen(message.id);
      return { committed: true, result };
    } finally {
      this.processingMessageIds.delete(message.id);
    }
  }

  /** Format delivery text with channel, sender, and response hint. */
  private formatDeliveryText(message: InboundMessage): string {
    // Pre-formatted kinds (reaction) already have the full text with hints.
    if (message.kind === 'reaction') {
      return message.text;
    }
    if (message.kind === 'command') {
      return `${message.text}\n(command invocation — respond with: post_message channel="${message.channel}")`;
    }
    if (message.kind === 'dm') {
      return `[relaycast:dm] @${message.from}: ${message.text}\n(reply with: send_dm to="${message.from}")`;
    }
    if (message.kind === 'groupdm') {
      return `[relaycast:groupdm] @${message.from}: ${message.text}\n(reply with: send_dm to="${message.from}")`;
    }
    if (message.threadParentId) {
      return `[thread] [relaycast:${message.channel}] @${message.from}: ${message.text}\n(reply with: reply_to_thread message_id="${message.threadParentId}")`;
    }
    return `[relaycast:${message.channel}] @${message.from}: ${message.text}\n(reply with: post_message channel="${message.channel}" or reply_to_thread message_id="${message.id}")`;
  }

  /** Handle an inbound Relaycast message. */
  private async onMessage(message: InboundMessage): Promise<DeliveryResult> {
    // Try primary delivery via the shared relay sender (no extra broker spawned).
    if (this.relaySender) {
      const ok = await this.deliverViaRelaySender(message);
      if (ok) {
        return { ok: true, method: 'relay_sdk' };
      }
    }

    // Deliver via persistent OpenClaw gateway WebSocket connection
    if (this.openclawClient) {
      const text = this.formatDeliveryText(message);
      const ok = await this.openclawClient.sendChatMessage(text, message.id);
      if (ok) {
        return { ok: true, method: 'gateway_ws' };
      }
    }

    console.warn(`[gateway] Failed to deliver message ${message.id} from @${message.from}`);
    return { ok: false, method: 'failed', error: 'All delivery methods failed' };
  }

  /** Deliver via the caller-provided relay sender (shared broker). */
  private async deliverViaRelaySender(message: InboundMessage): Promise<boolean> {
    if (!this.relaySender) return false;

    const input: SendMessageInput = {
      to: this.config.clawName,
      text: this.formatDeliveryText(message),
      from: message.from,
      data: {
        source: 'relaycast',
        channel: message.channel,
        messageId: message.id,
      },
    };

    try {
      const result = await this.relaySender.sendMessage(input);
      return Boolean(result.event_id) && result.event_id !== 'unsupported_operation';
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Spawn control HTTP server
  // -------------------------------------------------------------------------

  private async startControlServer(): Promise<void> {
    const port = Number(process.env.RELAYCAST_CONTROL_PORT) || InboundGateway.DEFAULT_CONTROL_PORT;

    this.controlServer = createServer((req, res) => {
      void this.handleControlRequest(req, res);
    });

    return new Promise((resolve) => {
      this.controlServer!.listen(port, '127.0.0.1', () => {
        this.controlPort = port;
        console.log(`[gateway] Spawn control API listening on http://127.0.0.1:${port}`);
        resolve();
      });
      this.controlServer!.on('error', (err) => {
        console.warn(`[gateway] Control server failed to start on port ${port}: ${err.message}`);
        this.controlServer = null;
        resolve(); // Non-fatal
      });
    });
  }

  // eslint-disable-next-line complexity
  private async handleControlRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    // CORS for local callers
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'GET' && path === '/health') {
      res.writeHead(200);
      res.end(
        JSON.stringify({
          ok: true,
          status: 'running',
          active: this.spawnManager.size,
          uptime: process.uptime(),
          transport: this.transportHealthSnapshot(),
        })
      );
      return;
    }

    if (req.method === 'POST' && path === '/spawn') {
      const body = await readBody(req);
      try {
        const args = JSON.parse(body) as Record<string, unknown>;
        const name = args.name as string;
        if (!name) {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: '"name" is required' }));
          return;
        }

        const relayApiKey = this.config.apiKey;
        const spawnOpts: SpawnOptions = {
          name,
          relayApiKey,
          role: (args.role as string) || undefined,
          model: (args.model as string) || undefined,
          channels: (args.channels as string[]) || undefined,
          systemPrompt: (args.system_prompt as string) || undefined,
          relayBaseUrl: this.config.baseUrl,
          workspaceId: (args.workspace_id as string) || process.env.OPENCLAW_WORKSPACE_ID,
        };

        const handle = await this.spawnManager.spawn(spawnOpts);
        res.writeHead(200);
        res.end(
          JSON.stringify({
            ok: true,
            name: handle.displayName,
            agentName: handle.agentName,
            id: handle.id,
            gatewayPort: handle.gatewayPort,
            active: this.spawnManager.size,
          })
        );
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    if (req.method === 'GET' && path === '/list') {
      const handles = this.spawnManager.list();
      res.writeHead(200);
      res.end(
        JSON.stringify({
          ok: true,
          active: handles.length,
          claws: handles.map((h) => ({
            name: h.displayName,
            agentName: h.agentName,
            id: h.id,
            gatewayPort: h.gatewayPort,
          })),
        })
      );
      return;
    }

    if (req.method === 'POST' && path === '/release') {
      const body = await readBody(req);
      try {
        const args = JSON.parse(body) as Record<string, unknown>;
        const name = args.name as string | undefined;
        const id = args.id as string | undefined;

        if (!name && !id) {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: 'Provide "name" or "id"' }));
          return;
        }

        let released = false;
        if (id) {
          released = await this.spawnManager.release(id);
        } else if (name) {
          released = await this.spawnManager.releaseByName(name);
        }

        res.writeHead(200);
        res.end(JSON.stringify({ ok: released, active: this.spawnManager.size }));
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', (err) => reject(err));
  });
}
