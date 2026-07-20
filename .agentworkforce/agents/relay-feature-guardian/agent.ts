/**
 * relay-feature-guardian handler.
 *
 * Hourly cron tick:
 *   1. Read the feature list from the cloned relay repository
 *   2. Load feature progress from an exact, revisioned Relayfile record
 *   3. Pick the next unchecked feature (ordered by criticality then tier)
 *   4. Generate a concise quiz question via ctx.llm
 *   5. Post to Slack with @mentions for Will and Khaliq
 *   6. Persist updated progress
 *
 * After the full manifest is covered, the cycle resets.
 */
import {
  defineAgent,
  type RelayfileCredentials,
  type WorkforceCtx,
  type WorkforceEvent,
} from '@agentworkforce/runtime';
import { input } from '@agentworkforce/delivery';
import { slackClient, type WritebackResult } from '@relayfile/relay-helpers';
import { randomUUID } from 'node:crypto';
import { parse } from 'yaml';

// ── manifest types ────────────────────────────────────────────────────────────

type Criticality = 'critical' | 'hot' | 'standard';

interface ManifestFeature {
  id: string;
  name: string;
  cli: string;
  description: string;
  verify_tier: number;
  mcp?: string;
  location?: string;
}

interface ManifestCategory {
  name: string;
  description?: string;
  criticality: Criticality;
  features: ManifestFeature[];
}

interface Manifest {
  version: string;
  categories: Record<string, ManifestCategory>;
}

// ── feature (flattened view used by this agent) ───────────────────────────────

interface Feature {
  id: string;
  name: string;
  cli: string;
  desc: string;
  tier: number;
  criticality: Criticality;
  mcp?: string;
}

const MANIFEST_RELPATH = '.agentworkforce/features/manifest.yaml';
const RELAY_REPO_RELPATH = 'github/repos/AgentWorkforce/relay';

/**
 * GitHub-scoped repositories are cloned beneath the proactive workspace root.
 * WorkforceCtx currently exposes that workspace root (`sandbox.cwd`), but not
 * an integration-specific repository directory, so derive the clone path from
 * the documented `/github/repos/{owner}/{repo}` layout.
 */
export function resolveManifestPath(workspaceDir: string): string {
  return `${workspaceDir}/${RELAY_REPO_RELPATH}/${MANIFEST_RELPATH}`;
}

async function loadFeatures(ctx: WorkforceCtx): Promise<Feature[]> {
  const absPath = resolveManifestPath(ctx.sandbox.cwd);
  const raw = await ctx.sandbox.readFile(absPath);
  const manifest = parse(raw) as Manifest;
  const features: Feature[] = [];
  for (const category of Object.values(manifest.categories)) {
    for (const f of category.features ?? []) {
      features.push({
        id: f.id,
        name: f.name,
        cli: f.cli,
        desc: f.description,
        tier: f.verify_tier,
        criticality: category.criticality,
        mcp: f.mcp,
      });
    }
  }
  return features;
}

// ── progress tracking ─────────────────────────────────────────────────────────

export interface ProgressState {
  kind: 'relay-feature-guardian:progress';
  version: 3;
  generation: number;
  checkedIds: string[];
  cycleStartedAt: string;
  totalFeatures: number;
  lastPost?: {
    featureId: string;
    ts: string;
  };
}

export const CYCLE_STATE_PATH = '/memory/workspace/relay-feature-guardian/cycle-state.json';
export const STATE_IO_TIMEOUT_MS = 5_000;
export const SLACK_WRITEBACK_TIMEOUT_MS = 15_000;
export const SLACK_WRITEBACK_POLL_MS = 250;

const MAX_STATE_BYTES = 64 * 1024;
const MAX_SAFE_MANIFEST_SHRINK = 1;
const UTF8_ENCODER = new TextEncoder();

export interface ProgressSnapshot {
  state: ProgressState;
  revision: string;
}

export interface ProgressStore {
  load(features: Feature[]): Promise<ProgressSnapshot | null>;
  save(
    state: ProgressState,
    expected: ProgressSnapshot | null,
    features: Feature[]
  ): Promise<ProgressSnapshot>;
}

type FetchLike = typeof fetch;

export class ProgressStateConflictError extends Error {
  constructor(message = 'relay-feature-guardian cycle state revision conflict') {
    super(message);
    this.name = 'ProgressStateConflictError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value;
}

function isSlackTs(value: unknown): value is string {
  return typeof value === 'string' && /^\d+\.\d+$/.test(value.trim());
}

function assertStateSize(content: string): void {
  if (UTF8_ENCODER.encode(content).byteLength > MAX_STATE_BYTES) {
    throw new Error('cycle state exceeds size limit');
  }
}

function parseProgressState(
  value: unknown,
  features: Feature[],
  options: { allowHistoricalIds?: boolean } = {}
): ProgressState {
  if (!isRecord(value)) throw new Error('cycle state must be an object');
  if (value.kind !== 'relay-feature-guardian:progress' || value.version !== 3) {
    throw new Error('cycle state kind/version is invalid');
  }
  if (!Number.isSafeInteger(value.generation) || (value.generation as number) < 1) {
    throw new Error('cycle state generation is invalid');
  }
  if (!isCanonicalIsoTimestamp(value.cycleStartedAt)) {
    throw new Error('cycle state cycleStartedAt is invalid');
  }
  if (
    !Number.isSafeInteger(value.totalFeatures) ||
    (value.totalFeatures as number) < 1 ||
    (value.totalFeatures as number) > 10_000
  ) {
    throw new Error('cycle state totalFeatures is invalid');
  }
  if (!Array.isArray(value.checkedIds) || value.checkedIds.length > (value.totalFeatures as number)) {
    throw new Error('cycle state checkedIds is invalid');
  }

  const knownIds = new Set(features.map((feature) => feature.id));
  const checkedIds = value.checkedIds.map((id) => {
    if (
      typeof id !== 'string' ||
      id.length === 0 ||
      id.length > 256 ||
      (!options.allowHistoricalIds && !knownIds.has(id))
    ) {
      throw new Error('cycle state contains an unknown feature id');
    }
    return id;
  });
  if (new Set(checkedIds).size !== checkedIds.length) {
    throw new Error('cycle state contains duplicate feature ids');
  }

  let lastPost: ProgressState['lastPost'];
  if (value.lastPost !== undefined) {
    if (
      !isRecord(value.lastPost) ||
      typeof value.lastPost.featureId !== 'string' ||
      !checkedIds.includes(value.lastPost.featureId) ||
      !isSlackTs(value.lastPost.ts)
    ) {
      throw new Error('cycle state lastPost is invalid');
    }
    lastPost = {
      featureId: value.lastPost.featureId,
      ts: value.lastPost.ts.trim(),
    };
  }
  if (checkedIds.length > 0 && !lastPost) {
    throw new Error('cycle state with progress requires lastPost');
  }
  if (lastPost && lastPost.featureId !== checkedIds.at(-1)) {
    throw new Error('cycle state lastPost must describe the latest checked feature');
  }

  return {
    kind: 'relay-feature-guardian:progress',
    version: 3,
    generation: value.generation as number,
    checkedIds,
    cycleStartedAt: value.cycleStartedAt,
    totalFeatures: value.totalFeatures as number,
    ...(lastPost ? { lastPost } : {}),
  };
}

function retiredFeatureIds(state: ProgressState, features: Feature[]): string[] {
  const currentIds = new Set(features.map((feature) => feature.id));
  return state.checkedIds.filter((id) => !currentIds.has(id));
}

type ManifestDelta = {
  kind: 'preserve' | 'reset-checked-retirement' | 'unsafe';
  retiredIds: string[];
  removedCount: number;
  reason?: string;
};

/**
 * Complete manifest-delta matrix:
 * - additions and one unchecked removal preserve the current generation;
 * - one checked retirement/rename resets the generation under CAS;
 * - larger shrink or multiple missing checked IDs is suspicious and fail-closed;
 * - manifest read failures never reach this classifier.
 */
function classifyManifestDelta(state: ProgressState, features: Feature[]): ManifestDelta {
  const removedCount = Math.max(0, state.totalFeatures - features.length);
  const retiredIds = retiredFeatureIds(state, features);
  if (removedCount > MAX_SAFE_MANIFEST_SHRINK) {
    return {
      kind: 'unsafe',
      retiredIds,
      removedCount,
      reason: 'manifest feature count shrank by more than one; refusing a partial-manifest reset',
    };
  }
  if (retiredIds.length > 1) {
    return {
      kind: 'unsafe',
      retiredIds,
      removedCount,
      reason: 'multiple checked feature ids disappeared; refusing an ambiguous manifest reset',
    };
  }
  return {
    kind: retiredIds.length === 1 ? 'reset-checked-retirement' : 'preserve',
    retiredIds,
    removedCount,
  };
}

function assertValidTransition(
  previous: ProgressSnapshot | null,
  next: ProgressState,
  features: Feature[]
): void {
  if (!previous) {
    if (next.generation !== 1 || next.checkedIds.length !== 0 || next.lastPost) {
      throw new Error('new cycle state must bootstrap an empty generation 1');
    }
    return;
  }

  const prior = previous.state;
  if (next.generation === prior.generation) {
    if (next.cycleStartedAt !== prior.cycleStartedAt) {
      throw new Error('cycleStartedAt is immutable within a generation');
    }
    if (
      next.checkedIds.length < prior.checkedIds.length ||
      next.checkedIds.length > prior.checkedIds.length + 1 ||
      !prior.checkedIds.every((id, index) => next.checkedIds[index] === id)
    ) {
      throw new Error('cycle progress cannot regress or skip a checkpoint');
    }
    if (next.checkedIds.length === prior.checkedIds.length) {
      if (JSON.stringify(next.lastPost) !== JSON.stringify(prior.lastPost)) {
        throw new Error('reconciliation cannot overwrite lastPost');
      }
    } else if (next.lastPost?.featureId !== next.checkedIds.at(-1)) {
      throw new Error('new progress must checkpoint the newly checked feature');
    }
    return;
  }

  const manifestDelta = classifyManifestDelta(prior, features);
  const retirementResetAllowed = manifestDelta.kind === 'reset-checked-retirement';
  const allCurrentFeaturesChecked = features.every((feature) => prior.checkedIds.includes(feature.id));
  if (
    next.generation !== prior.generation + 1 ||
    (!allCurrentFeaturesChecked && !retirementResetAllowed) ||
    next.checkedIds.length !== 0 ||
    next.lastPost ||
    new Date(next.cycleStartedAt) <= new Date(prior.cycleStartedAt)
  ) {
    throw new Error('cycle generation reset is invalid');
  }
}

async function withDeadline<T>(
  label: string,
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(controller.signal), expired]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function normalizeEtag(value: string | null): string {
  return (value ?? '').trim().replace(/^W\//, '').replace(/^"|"$/g, '');
}

function relayfileStateUrl(credentials: RelayfileCredentials): URL {
  const url = new URL(
    `/v1/workspaces/${encodeURIComponent(credentials.workspaceId)}/fs/file`,
    `${credentials.url.replace(/\/+$/, '')}/`
  );
  url.searchParams.set('path', CYCLE_STATE_PATH);
  return url;
}

function requestHeaders(credentials: RelayfileCredentials, correlationId: string): HeadersInit {
  return {
    Authorization: `Bearer ${credentials.token}`,
    'X-Correlation-Id': correlationId,
  };
}

async function readHttpSnapshot(
  credentials: RelayfileCredentials,
  features: Feature[],
  fetchImpl: FetchLike,
  signal: AbortSignal,
  correlationId: string,
  allowHistoricalIds = false
): Promise<ProgressSnapshot | null> {
  const response = await fetchImpl(relayfileStateUrl(credentials), {
    method: 'GET',
    headers: requestHeaders(credentials, correlationId),
    signal,
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`cycle state GET failed with HTTP ${response.status}`);

  const file = (await response.json()) as unknown;
  if (!isRecord(file) || file.path !== CYCLE_STATE_PATH || typeof file.content !== 'string') {
    throw new Error('cycle state GET returned an invalid file');
  }
  assertStateSize(file.content);
  const bodyRevision = typeof file.revision === 'string' ? file.revision.trim() : '';
  const etagRevision = normalizeEtag(response.headers.get('etag'));
  const revision = bodyRevision || etagRevision;
  if (!revision || (bodyRevision && etagRevision && bodyRevision !== etagRevision)) {
    throw new Error('cycle state GET returned an invalid revision');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(file.content);
  } catch {
    throw new Error('cycle state contains invalid JSON');
  }
  return {
    state: parseProgressState(parsed, features, { allowHistoricalIds }),
    revision,
  };
}

export function createHttpProgressStore(
  credentials: RelayfileCredentials,
  options: { fetchImpl?: FetchLike; timeoutMs?: number } = {}
): ProgressStore {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? STATE_IO_TIMEOUT_MS;
  return {
    load: (features) =>
      withDeadline('cycle state load', timeoutMs, (signal) =>
        readHttpSnapshot(
          credentials,
          features,
          fetchImpl,
          signal,
          `guardian-state-load-${randomUUID()}`,
          true
        )
      ),
    save: (state, expected, features) => {
      const canonical = parseProgressState(state, features);
      if (canonical.totalFeatures !== features.length) {
        throw new Error('cycle state totalFeatures must match the current manifest');
      }
      const content = `${JSON.stringify(canonical)}\n`;
      assertStateSize(content);
      assertValidTransition(expected, canonical, features);
      return withDeadline('cycle state save', timeoutMs, async (signal) => {
        const correlationId = `guardian-state-save-${randomUUID()}`;
        const response = await fetchImpl(relayfileStateUrl(credentials), {
          method: 'PUT',
          headers: {
            ...requestHeaders(credentials, correlationId),
            'Content-Type': 'application/octet-stream',
            'X-Relayfile-Encoding': 'utf-8',
            'X-Relayfile-Content-Type': 'application/json',
            'X-Workspace-Id': credentials.workspaceId,
            'If-Match': expected?.revision ?? '0',
          },
          body: content,
          signal,
        });
        if (response.status === 409) throw new ProgressStateConflictError();
        if (!response.ok) throw new Error(`cycle state PUT failed with HTTP ${response.status}`);

        const readBack = await readHttpSnapshot(credentials, features, fetchImpl, signal, correlationId);
        if (!readBack || JSON.stringify(readBack.state) !== JSON.stringify(canonical)) {
          throw new Error('cycle state read-back did not match the saved state');
        }
        if (expected && readBack.revision === expected.revision) {
          throw new Error('cycle state revision did not advance');
        }
        return readBack;
      });
    },
  };
}

function previewRevision(state: ProgressState): string {
  return `preview:${JSON.stringify(state)}`;
}

function createPreviewProgressStore(ctx: WorkforceCtx): ProgressStore {
  const read = async (features: Feature[], allowHistoricalIds = false): Promise<ProgressSnapshot | null> => {
    let content: string;
    try {
      content = await ctx.files.read(CYCLE_STATE_PATH);
    } catch (error) {
      if (String(error).includes('ENOENT')) return null;
      throw error;
    }
    assertStateSize(content);
    const state = parseProgressState(JSON.parse(content) as unknown, features, {
      allowHistoricalIds,
    });
    return { state, revision: previewRevision(state) };
  };
  return {
    load: (features) => read(features, true),
    save: async (state, expected, features) => {
      const canonical = parseProgressState(state, features);
      if (canonical.totalFeatures !== features.length) {
        throw new Error('cycle state totalFeatures must match the current manifest');
      }
      const content = `${JSON.stringify(canonical)}\n`;
      assertStateSize(content);
      assertValidTransition(expected, canonical, features);
      const current = await read(features, true);
      if (current?.revision !== expected?.revision) throw new ProgressStateConflictError();
      await ctx.files.write(CYCLE_STATE_PATH, content);
      const readBack = await read(features);
      if (!readBack || JSON.stringify(readBack.state) !== JSON.stringify(canonical)) {
        throw new Error('cycle state read-back did not match the saved state');
      }
      return readBack;
    },
  };
}

function createProgressStore(ctx: WorkforceCtx): ProgressStore {
  const credentials = ctx.credentials.tryRequire();
  if (credentials) return createHttpProgressStore(credentials.relayfile);
  if (ctx.agent.id === 'sim-agent' && ctx.deployment.id === 'sim-deployment') {
    return createPreviewProgressStore(ctx);
  }
  throw new Error('exact Relayfile credentials are required for guardian cycle state');
}

export function featurePostIdempotencyKey(cycleStartedAt: string, featureId: string): string {
  return `relay-feature-guardian:${cycleStartedAt}:${featureId}`;
}

export function deliveredSlackTs(result: WritebackResult | null | undefined): string {
  const receipt = result?.receipt as { externalId?: unknown; ts?: unknown } | undefined;
  const externalId = typeof receipt?.externalId === 'string' ? receipt.externalId.trim() : '';
  if (isSlackTs(externalId)) return externalId;
  const ts = typeof receipt?.ts === 'string' ? receipt.ts.trim() : '';
  return isSlackTs(ts) ? ts : '';
}

// ── feature selection ─────────────────────────────────────────────────────────

function pickNextFeature(features: Feature[], checkedIds: Set<string>): Feature | null {
  const critOrder: Record<Criticality, number> = { critical: 0, hot: 1, standard: 2 };
  const ordered = [...features].sort((a, b) => {
    const critDiff = critOrder[a.criticality] - critOrder[b.criticality];
    if (critDiff !== 0) return critDiff;
    return a.tier - b.tier;
  });
  return ordered.find((f) => !checkedIds.has(f.id)) ?? null;
}

// ── quiz generation ───────────────────────────────────────────────────────────

async function generateQuizMessage(ctx: WorkforceCtx, feature: Feature): Promise<string> {
  const mcpNote = feature.mcp ? `\nMCP tool: \`${feature.mcp}\`` : '';
  const tierLabel =
    feature.tier === 1
      ? 'no broker needed'
      : feature.tier === 2
        ? 'broker required'
        : feature.tier === 3
          ? 'broker + agent token'
          : feature.tier === 4
            ? 'broker + two agents'
            : 'cloud auth required';

  const prompt = [
    'You are the Relay Feature Guardian, a proactive Slack bot for the Agent Relay team.',
    'Write a brief, conversational Slack message (3-5 sentences, no markdown headers) asking the team to confirm whether a specific CLI feature is working as intended.',
    'Be specific: name the feature, describe what it should do, show the CLI command, and ask if it behaves this way or if anything has drifted.',
    'End with: "React ✅ if working as expected, 🔧 if something is off, or ❓ if untested."',
    'Keep it casual and direct — this is an internal team check.',
    '',
    `Feature: ${feature.name}`,
    `CLI: ${feature.cli}${mcpNote}`,
    `What it should do: ${feature.desc}`,
    `Verify tier: ${feature.tier} (${tierLabel})`,
    `Criticality: ${feature.criticality}`,
  ].join('\n');

  try {
    const output = await ctx.llm.complete(prompt, { maxTokens: 300 });
    return output.trim();
  } catch {
    return [
      `🔍 *Relay Feature Check: ${feature.name}*`,
      ``,
      `\`${feature.cli}\`${mcpNote}`,
      ``,
      `This should: ${feature.desc}`,
      ``,
      `Is this working as expected right now? React ✅ if yes, 🔧 if something is off, or ❓ if untested.`,
    ].join('\n');
  }
}

// ── agent definition ──────────────────────────────────────────────────────────

export interface GuardianDependencies {
  createSlackClient?: typeof slackClient;
}

export async function runGuardian(
  ctx: WorkforceCtx,
  _event: WorkforceEvent,
  dependencies: GuardianDependencies = {}
): Promise<void> {
  const createSlackClient = dependencies.createSlackClient ?? slackClient;
  const channel = input(ctx, 'SLACK_CHANNEL');
  if (!channel) {
    ctx.log('warn', 'relay-feature-guardian.no-channel', { reason: 'SLACK_CHANNEL not configured' });
    return;
  }

  // Load the live feature list from the manifest
  let features: Feature[];
  try {
    features = await loadFeatures(ctx);
  } catch (err) {
    const absPath = resolveManifestPath(ctx.sandbox.cwd);
    ctx.log('error', 'relay-feature-guardian.manifest-load-failed', { path: absPath, err: String(err) });
    const isNotFound = String(err).includes('ENOENT');
    const errMsg = isNotFound
      ? `⚠️ *relay-feature-guardian* can't find the feature manifest in the cloned relay repository at \`${RELAY_REPO_RELPATH}/${MANIFEST_RELPATH}\`.`
      : `⚠️ *relay-feature-guardian* failed to load the feature manifest: \`${String(err)}\``;
    await createSlackClient()
      .post(channel, errMsg)
      .catch(() => undefined);
    return;
  }
  ctx.log('info', 'relay-feature-guardian.manifest-loaded', {
    path: resolveManifestPath(ctx.sandbox.cwd),
    features: features.length,
  });
  if (features.length === 0) {
    ctx.log('error', 'relay-feature-guardian.no-features', { reason: 'manifest parsed but empty' });
    await createSlackClient()
      .post(
        channel,
        '⚠️ *relay-feature-guardian* loaded the manifest but found no features. Check `.agentworkforce/features/manifest.yaml`.'
      )
      .catch(() => undefined);
    return;
  }

  const totalFeatures = features.length;
  let store: ProgressStore;
  let progress: ProgressSnapshot | null;
  try {
    store = createProgressStore(ctx);
    progress = await store.load(features);
  } catch (err) {
    ctx.log('error', 'relay-feature-guardian.progress-load-failed', { err: String(err) });
    return;
  }

  // A missing exact record is the only bootstrap case. Persist and read back
  // the empty generation before any Slack side effect.
  if (!progress) {
    const initial: ProgressState = {
      kind: 'relay-feature-guardian:progress',
      version: 3,
      generation: 1,
      checkedIds: [],
      cycleStartedAt: new Date().toISOString(),
      totalFeatures,
    };
    try {
      progress = await store.save(initial, null, features);
    } catch (err) {
      ctx.log('error', 'relay-feature-guardian.cycle-checkpoint-failed', { err: String(err) });
      return;
    }
  }

  const manifestDelta = classifyManifestDelta(progress.state, features);
  const { retiredIds } = manifestDelta;
  if (manifestDelta.kind === 'unsafe') {
    ctx.log('error', 'relay-feature-guardian.progress-reconcile-failed', {
      err: manifestDelta.reason,
      previousTotal: progress.state.totalFeatures,
      currentTotal: totalFeatures,
      retiredIds,
    });
    return;
  }

  // A successfully parsed manifest can retire a feature mid-cycle. Historical
  // IDs are accepted only at load; reset them under exact-revision CAS before
  // any Slack side effect so the persisted state is canonical again.
  if (manifestDelta.kind === 'reset-checked-retirement') {
    const previousStart = new Date(progress.state.cycleStartedAt).valueOf();
    const reset: ProgressState = {
      kind: 'relay-feature-guardian:progress',
      version: 3,
      generation: progress.state.generation + 1,
      checkedIds: [],
      cycleStartedAt: new Date(Math.max(Date.now(), previousStart + 1)).toISOString(),
      totalFeatures,
    };
    try {
      progress = await store.save(reset, progress, features);
      ctx.log('info', 'relay-feature-guardian.manifest-retirement-reset', {
        retiredIds,
        generation: progress.state.generation,
        total: totalFeatures,
      });
    } catch (err) {
      ctx.log('error', 'relay-feature-guardian.progress-reconcile-failed', { err: String(err) });
      return;
    }
  } else if (progress.state.totalFeatures !== totalFeatures) {
    // Manifest additions change the denominator but must never discard already
    // checked feature ids or overwrite the last delivered receipt.
    const reconciled: ProgressState = {
      ...progress.state,
      totalFeatures,
    };
    try {
      progress = await store.save(reconciled, progress, features);
    } catch (err) {
      ctx.log('error', 'relay-feature-guardian.progress-reconcile-failed', { err: String(err) });
      return;
    }
  }

  let checkedIds = new Set(progress.state.checkedIds);

  // Pick the next unchecked feature; reset if the cycle is complete
  let feature = pickNextFeature(features, checkedIds);
  if (!feature) {
    ctx.log('info', 'relay-feature-guardian.cycle-complete', { total: totalFeatures });
    const previousStart = new Date(progress.state.cycleStartedAt).valueOf();
    const reset: ProgressState = {
      kind: 'relay-feature-guardian:progress',
      version: 3,
      generation: progress.state.generation + 1,
      checkedIds: [],
      cycleStartedAt: new Date(Math.max(Date.now(), previousStart + 1)).toISOString(),
      totalFeatures,
    };
    try {
      progress = await store.save(reset, progress, features);
    } catch (err) {
      ctx.log('error', 'relay-feature-guardian.cycle-checkpoint-failed', { err: String(err) });
      return;
    }
    checkedIds = new Set();
    feature = pickNextFeature(features, checkedIds);
  }
  if (!feature) return;

  // Build @mention string
  const userWill = input(ctx, 'SLACK_USER_WILL');
  const userKhaliq = input(ctx, 'SLACK_USER_KHALIQ');
  const mentions = [userWill && `<@${userWill}>`, userKhaliq && `<@${userKhaliq}>`].filter(Boolean).join(' ');
  const mentionPrefix = mentions ? `${mentions} — ` : '';

  // Generate quiz message
  const quizBody = await generateQuizMessage(ctx, feature);
  const remaining = totalFeatures - checkedIds.size - 1;
  const progressNote = `_[relay feature check · ${checkedIds.size + 1}/${totalFeatures} · ${remaining} remaining in cycle]_`;
  const message = [mentionPrefix + quizBody, '', progressNote].join('\n');
  ctx.log('info', 'relay-feature-guardian.posting', {
    channel,
    feature: feature.id,
    index: checkedIds.size + 1,
    total: totalFeatures,
    remaining,
  });

  // Post to Slack
  const slack = createSlackClient({
    writebackTimeoutMs: SLACK_WRITEBACK_TIMEOUT_MS,
    writebackPollMs: SLACK_WRITEBACK_POLL_MS,
  });
  let result: WritebackResult;
  try {
    result = await slack.messages.write(
      { channelId: channel },
      {
        text: message,
        idempotencyKey: featurePostIdempotencyKey(progress.state.cycleStartedAt, feature.id),
      }
    );
  } catch (err) {
    ctx.log('error', 'relay-feature-guardian.post-failed', {
      channel,
      feature: feature.id,
      err: String(err),
    });
    throw err;
  }
  const ts = deliveredSlackTs(result);
  if (!ts) {
    ctx.log('error', 'relay-feature-guardian.post-failed', { channel, feature: feature.id });
    throw new Error(`Slack post failed: no timestamp returned for feature ${feature.id}`);
  }

  // Checkpoint immediately after the confirmed provider receipt. The stable
  // idempotency key makes a retry safe if this save times out or the run caps.
  checkedIds.add(feature.id);
  const completed: ProgressState = {
    kind: 'relay-feature-guardian:progress',
    version: 3,
    generation: progress.state.generation,
    checkedIds: [...checkedIds],
    cycleStartedAt: progress.state.cycleStartedAt,
    totalFeatures,
    lastPost: { featureId: feature.id, ts },
  };
  let checkpoint: ProgressSnapshot;
  try {
    checkpoint = await store.save(completed, progress, features);
  } catch (err) {
    ctx.log('error', 'relay-feature-guardian.progress-checkpoint-failed', {
      channel,
      feature: feature.id,
      ts,
      err: String(err),
    });
    return;
  }
  ctx.log('info', 'relay-feature-guardian.posted', {
    channel,
    feature: feature.id,
    ts,
    checkpointRevision: checkpoint.revision,
  });
}

export default defineAgent({
  schedules: [{ name: 'hourly-check', cron: '0 * * * *', tz: 'America/New_York' }],
  handler: runGuardian,
});
