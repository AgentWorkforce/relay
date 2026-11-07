/**
 * Support code for the obligation-lifecycle conformance fixture.
 *
 * The fixture proves one property: **an obligation is discharged only when the
 * obligating author (or its named discharge delegate) confirms it was
 * answered** — not on read, not on the recipient's belief that it replied, and
 * not on a timer. The defect being guarded against is that a message can be
 * delivered, injected, read and never answered, and nothing in the system can
 * tell that state apart from an answered one.
 *
 * Everything here is deliberately written so that the *assertions* are honest
 * on today's substrate even though the *mechanism* does not exist yet. Where
 * something cannot be asserted truthfully it is named as a proxy or left
 * pending, in code, rather than weakened until it passes.
 *
 * ── What exists today, and what does not ────────────────────────────────────
 *
 * Exists:
 *   - The production send path: `createAgentClient({ agentToken }).dm(...)`,
 *     which is the exact call `mcp__agent-relay__send_dm` makes
 *     (packages/cli/src/cli/mcp/messaging-tools.ts, `send_dm` handler ->
 *     `getAgentClient(as).dm(to, text, ...)`).
 *   - Reactions: `.react(messageId, emoji)` / `.unreact(...)`. They store
 *     `{ id, message_id, agent_id, emoji, created_at }` and carry no
 *     `recipient` field and no tombstone.
 *   - Read state: `.markRead(messageId)`. On the PTY path the broker also sets
 *     it automatically after echo verification — see
 *     crates/broker/src/runtime/delivery.rs, whose own doc comment says a
 *     read-ack means "delivered to the recipient location", not proof that a
 *     model turn cognitively processed the message.
 *   - A real model-turn signal, but only on the native (AI-SDK) runtime:
 *     `turn.settled` (packages/harnesses/src/ai-sdk/harness-host.ts), surfaced
 *     to a driver client through `getAgentEventHistory`.
 *   - Boomerang (`crates/broker/src/obligation.rs`, `ObligationStore`): wired
 *     into `crates/broker/src/runtime/maintenance.rs`. Obligating DMs
 *     (containing OBLIGATION_MARKER) register an ObligationRecord; the 500 ms
 *     maintenance tick drains due obligations and re-injects a knock carrying
 *     RETURN_MARKER to the recipient (up to 3 times). A ✅ reaction from the
 *     author discharges the obligation. Toggle: `RELAY_OBLIGATION_BOOMERANG=0`
 *     disables all boomerang; `RELAY_OBLIGATION_INTERVAL_MS=<ms>` sets the
 *     return interval. After successful injection the broker emits a
 *     `relay_inbound` event carrying `obligation_msg_id`, which `waitForReturn`
 *     observes on the native path.
 *
 * Does not exist (deferred):
 *   - Any `obligation` object on the wire. `send_dm` has no field for it, so
 *     this fixture carries it as a text envelope (see `OBLIGATION_MARKER`) and
 *     that is a stand-in, not the protocol shape.
 *   - Any semantic on a reaction. A `done` from the author and a `done` from
 *     the recipient are byte-identical records; neither names a recipient.
 *   - Any organisational edge, so `dischargeDelegate` and the escalation ladder
 *     have no one to resolve to. Arm C therefore names its escalation target
 *     explicitly rather than resolving it.
 *   - Discharge by delegate: current implementation enforces author-only
 *     discharge per the load-bearing clearing rule in obligation.rs.
 *
 * ── Prerequisite worth checking before reading any result ───────────────────
 *
 * Every send here is Relaycast-mediated. The broker has no local-injection
 * shortcut even for a worker running in its own process (see the comment in
 * crates/broker/src/runtime/api.rs on the `/api/send` path), so an inbound
 * message only reaches a worker if the broker is a live delivery node that
 * Relaycast can route back to. Where that is not the case, nothing is delivered
 * and no arm can say anything about obligations. `waitForDelivery` raises a
 * ConformancePreconditionError for exactly that case rather than letting it be
 * misread as a boomerang finding.
 */
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';

import type { BrokerEvent } from '@agent-relay/harness-driver';
import { createNativeHarnessLaunch } from '@agent-relay/harnesses';
import { createAgentClient, createWorkspaceClient } from '@agent-relay/sdk';
import { RelayCast } from '@relaycast/sdk';

import { BrokerHarness, checkPrerequisites, ensureApiKey, uniqueSuffix } from './broker-harness.js';
import { sleep } from './cli-helpers.js';

// ── Environment gating ───────────────────────────────────────────────────────
//
// The repo gates expensive integration fixtures behind `std::env::var`-style
// opt-in flags (`RELAY_INTEGRATION_REAL_CLI=1` in mcp-injection.test.ts). This
// fixture follows the same idiom with its own flag so it never runs in normal
// CI: it is expected to FAIL on unmodified main, by design.

/** Opt-in gate. Without it every arm skips. */
export const CONFORMANCE_FLAG = 'RELAY_OBLIGATION_CONFORMANCE';

/**
 * The control toggle. `0` means "run the suite with the boomerang mechanism
 * disabled"; arms A and C must then go RED. It is exported to the broker
 * process as well as read here, so that a future broker-side implementation can
 * honour it with the repo's usual `std::env::var("RELAY_OBLIGATION_BOOMERANG")`
 * check without the fixture changing shape.
 *
 * A suite that stays green with the mechanism removed is passing vacuously,
 * which is the same failure shape as the bug itself.
 */
export const BOOMERANG_FLAG = 'RELAY_OBLIGATION_BOOMERANG';

/** Which substrate the arms run against. See `ConformancePath`. */
export const PATH_FLAG = 'RELAY_OBLIGATION_PATH';

/** Flat return interval, in ms. Also exported to the broker process. */
export const INTERVAL_FLAG = 'RELAY_OBLIGATION_INTERVAL_MS';

/** Model id for the native path (for example `openai/gpt-4o-mini`). */
export const MODEL_FLAG = 'RELAY_OBLIGATION_MODEL';

/** CLI name for the PTY path (for example `claude`). */
export const CLI_FLAG = 'RELAY_OBLIGATION_CLI';

/** AI-SDK adapter backing the native path. */
const NATIVE_ADAPTER = 'pi';

/**
 * `native`
 *   A real model behind the AI-SDK sidecar. `turn.settled` is emitted when
 *   model generation actually completes, so "the recipient took a model turn"
 *   is PROVABLE here. This is the only path on which the spec's assertion can
 *   be made truthfully today, which is why it is the default.
 *
 * `pty`
 *   The default production runtime. Delivery is confirmed by echo verification
 *   and read state is then set by the broker with no model in the loop. There
 *   is no model-turn signal to assert against, so this path uses a PROXY —
 *   see `assertRecipientTookTurn`.
 *
 * `native-fixture`
 *   The scripted sidecar at tests/integration/broker/fixtures/native-sidecar.js.
 *   Its `turn.settled` frames are real protocol frames but the turn is a
 *   script, not a model. Useful only for exercising the fixture's own wiring
 *   without model credentials; it is NEVER counted as proof.
 */
export type ConformancePath = 'native' | 'pty' | 'native-fixture';

export function conformancePath(): ConformancePath {
  const raw = (process.env[PATH_FLAG] ?? 'native').trim();
  if (raw === 'native' || raw === 'pty' || raw === 'native-fixture') return raw;
  throw new Error(`${PATH_FLAG} must be one of native | pty | native-fixture (got "${raw}")`);
}

/** True when the suite is running as the control: mechanism disabled. */
export function boomerangDisabled(): boolean {
  return (process.env[BOOMERANG_FLAG] ?? '1').trim() === '0';
}

export function returnIntervalMs(): number {
  const raw = process.env[INTERVAL_FLAG];
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5_000;
}

/**
 * Skip unless the fixture is explicitly opted into and its prerequisites exist.
 * Returns true when the caller should return immediately.
 */
export function skipUnlessConformance(t: TestContext): boolean {
  if (process.env[CONFORMANCE_FLAG] !== '1') {
    t.skip(`Set ${CONFORMANCE_FLAG}=1 to run the obligation-lifecycle conformance fixture`);
    return true;
  }
  const missing = checkPrerequisites();
  if (missing) {
    t.skip(missing);
    return true;
  }
  if (conformancePath() === 'native' && !process.env[MODEL_FLAG]) {
    // Deliberately a skip and not a silent downgrade to the scripted sidecar.
    // The spec's assertion is on a *model* turn; running it against a script
    // and reporting green would be exactly the substitution this issue exists
    // to stop.
    t.skip(
      `${PATH_FLAG}=native requires ${MODEL_FLAG} (a real model id) so the model-turn assertion is provable`
    );
    return true;
  }
  return false;
}

// ── The obligating event ─────────────────────────────────────────────────────

/**
 * PLACEHOLDER, and marked as one on purpose.
 *
 * The protocol puts the obligation in a structured `obligation` object on the
 * event. Nothing on this wire carries it: `send_dm` takes `{ to, text, mode,
 * attachments }` and no more. Until the field exists the fixture encodes the
 * object into the message text behind a marker so the arms can be written
 * against the real send path today.
 *
 * When the wire field lands, this envelope is deleted and the object moves into
 * the `dm(...)` options. The arms do not change.
 */
export const OBLIGATION_MARKER = '@@c2a-obligation@@';

/** The knock a boomerang return is expected to carry. Does not exist yet. */
export const RETURN_MARKER = '@@c2a-obligation-return@@';

export interface ObligationDeclaration {
  blocks: 'halted' | 'degraded' | 'none';
  defaultAction: string;
  dischargeDelegate?: string;
}

export function obligatingText(question: string, declaration: ObligationDeclaration): string {
  return `${question}\n${OBLIGATION_MARKER}${JSON.stringify(declaration)}`;
}

// ── Identities ───────────────────────────────────────────────────────────────

export interface ConformanceIdentity {
  name: string;
  /** Agent token (`at_live_...`), the credential every production call uses. */
  token: string;
}

/**
 * Register an identity and keep its token.
 *
 * The recipient's token is minted here and handed to the broker at spawn time
 * (`spawnPty`/`spawnHeadless` accept `agentToken`). That matters: it is the only
 * way the fixture can emit the recipient's own read-marks and reactions through
 * the production path instead of inventing a test-only side door. Letting the
 * broker mint the token would rotate this one and lock the fixture out.
 */
export async function registerIdentity(apiKey: string, name: string): Promise<ConformanceIdentity> {
  const workspace = createWorkspaceClient({ workspaceKey: apiKey });
  const registration = await workspace.agents.registerOrRotate({ name });
  const token = registration.token;
  assert.ok(typeof token === 'string' && token.length > 0, `no agent token minted for "${name}"`);
  return { name: registration.name ?? name, token };
}

export function clientFor(identity: ConformanceIdentity) {
  // The exact factory `mcp__agent-relay__send_dm` builds its client with.
  return createAgentClient({ agentToken: identity.token });
}

/** Send an obligating DM through the production send path. */
export async function sendObligatingDm(
  author: ConformanceIdentity,
  recipient: string,
  question: string,
  declaration: ObligationDeclaration
): Promise<string> {
  const response = (await clientFor(author).dm(recipient, obligatingText(question, declaration))) as Record<
    string,
    unknown
  >;
  const messageId = extractMessageId(response);
  assert.ok(messageId, `send_dm returned no message id: ${JSON.stringify(response)}`);
  return messageId;
}

function extractMessageId(response: Record<string, unknown>): string | undefined {
  const direct = response.id ?? response.message_id ?? response.messageId;
  if (typeof direct === 'string') return direct;
  const nested = response.message;
  if (nested && typeof nested === 'object') {
    const id = (nested as Record<string, unknown>).id;
    if (typeof id === 'string') return id;
  }
  return undefined;
}

// ── Signals ──────────────────────────────────────────────────────────────────
//
// The protocol names signals, not glyphs. The store carries glyphs, so the map
// below is the fixture's own and is the third substrate gap: nothing on the
// wire distinguishes `done` from any other emoji, and no reaction can name the
// recipient it discharges. A discharging reaction that names no recipient
// discharges nothing, so on today's substrate *no* reaction is well-formed
// enough to discharge — which is a gap, not a pass.

export const SIGNAL_GLYPH = {
  seen: '👀',
  agree: '👍',
  working: '🔧',
  queued: '🕐',
  claimed: '✋',
  done: '✅',
  declined: '🙅',
  blocked: '🚧',
  unclear: '❓',
} as const;

export type Signal = keyof typeof SIGNAL_GLYPH;

export async function emitSignal(
  actor: ConformanceIdentity,
  messageId: string,
  signal: Signal
): Promise<void> {
  await clientFor(actor).react(messageId, SIGNAL_GLYPH[signal]);
}

/**
 * Read the stored reaction records for a message.
 *
 * Read back rather than re-written: reactions are unique per
 * (message, agent, emoji), so probing by reacting again fails at the store and
 * would mask what is being inspected.
 */
export async function readReactions(
  apiKey: string,
  messageId: string
): Promise<Array<Record<string, unknown>>> {
  const relay = new RelayCast({ apiKey });
  // relay.messages.reactions() returns ReactionGroup[] — each group has
  // { emoji: string, count: number, agents: string[] } where `agents` is a list
  // of agent name strings. The substrate gap test needs per-actor records so it
  // can (a) assert two distinct reactors are stored and (b) compare their key
  // shapes. Flatten into one record per agent name, carrying the emoji from the
  // group, so the shape assertion in the substrate gap test is meaningful rather
  // than trivially true with a single group entry.
  const groups = (await relay.messages.reactions(messageId)) as unknown as Array<{
    emoji: string;
    count: number;
    agents: string[];
  }>;
  return groups.flatMap((group) =>
    group.agents.map((agentName) => ({ emoji: group.emoji, agent_name: agentName }))
  );
}

// ── Model-turn evidence ──────────────────────────────────────────────────────

/**
 * Evidence that the recipient took a turn.
 *
 * The distinction between the two kinds is the whole point of the fixture and
 * must never be collapsed. `proof` is a signal emitted when model generation
 * completed. `proxy` is a downstream side effect that is *consistent with* a
 * turn having happened and is not the same claim — it is the same class of
 * inference as "the message was echoed to stdout, therefore it was read", which
 * is the substitution this issue exists to stop.
 */
export type TurnEvidence =
  | { kind: 'proof'; source: 'native:turn.settled'; turnId: string }
  | { kind: 'proxy'; source: 'pty:agent-emitted-message'; detail: string }
  | { kind: 'scripted'; source: 'native-fixture:turn.settled'; turnId: string };

export interface TurnWatch {
  /** Sequence cursor (native) or event index (pty) captured before the stimulus. */
  baseline: number;
}

/** Capture the cursor a later `assertRecipientTookTurn` measures from. */
export async function watchForTurn(
  harness: BrokerHarness,
  recipient: string,
  path: ConformancePath
): Promise<TurnWatch> {
  if (path === 'pty') return { baseline: harness.getEvents().length };
  const history = await harness.client.getAgentEventHistory(recipient, 0);
  return { baseline: history.high_water_sequence };
}

/**
 * The single pluggable assertion the spec requires: "each assertion is on
 * whether the recipient model took a turn, not on whether an event was
 * emitted."
 *
 * There is one implementation per delivery path and the arms call only this
 * helper, so that when a PTY model-turn signal is added later the arms do not
 * get rewritten — only the `pty` branch below does.
 *
 * @returns evidence, whose `kind` says how strong the claim is. Callers that
 *   need proof must check it; the helper will not silently upgrade a proxy.
 */
export async function assertRecipientTookTurn(
  harness: BrokerHarness,
  recipient: string,
  watch: TurnWatch,
  options: { timeoutMs: number; path: ConformancePath }
): Promise<TurnEvidence> {
  const { timeoutMs, path } = options;

  if (path === 'native' || path === 'native-fixture') {
    // PROOF (native) — `turn.settled` is emitted by the AI-SDK harness host
    // once model generation actually completes
    // (packages/harnesses/src/ai-sdk/harness-host.ts). The broker forwards the
    // sidecar's canonical agent-event stream verbatim
    // (crates/broker/src/runtime/worker_events.rs, `agent_event` branch) and
    // the replay buffer keys it per agent, so a `turn.settled` with a sequence
    // above the pre-stimulus high-water mark is a turn that happened after the
    // stimulus and not a replay of an earlier one.
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const history = await harness.client.getAgentEventHistory(recipient, watch.baseline);
      const settled = history.events.find((entry) => entry.event.kind === 'turn.settled');
      if (settled) {
        const turnId = String((settled.event as Record<string, unknown>).turnId ?? 'unknown');
        return path === 'native'
          ? { kind: 'proof', source: 'native:turn.settled', turnId }
          : { kind: 'scripted', source: 'native-fixture:turn.settled', turnId };
      }
      await sleep(250);
    }
    throw new Error(
      `recipient "${recipient}" did not take a model turn within ${timeoutMs}ms ` +
        `(no turn.settled above sequence ${watch.baseline})`
    );
  }

  // PROXY, NOT PROOF — read this before trusting it.
  //
  // The PTY path has no model-turn signal a test can consume. The broker does
  // emit `turn.started`/`turn.settled` for PTY workers
  // (crates/broker/src/runtime/worker_events.rs, `publish_pty_busy` /
  // `publish_pty_idle`) but it labels them `fidelity: "inferred"` in its own
  // capability report, derives them from stdout busy/idle boundaries, and
  // publishes them only to the hosted event stream — they are not on the local
  // agent-event history a driver client can read, which `getAgentEventHistory`
  // serves and which only ever holds native sidecar frames
  // (crates/broker/src/replay_buffer.rs keys it on `agent_event`). So the
  // strongest thing
  // available here is that the agent subsequently emitted a relay message of
  // its own, which is evidence and not proof. It is returned as `kind: 'proxy'`
  // so no caller can mistake it for the spec's assertion, and it is the branch
  // to replace the day a real PTY turn signal exists.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const emitted = harness
      .getEvents()
      .slice(watch.baseline)
      .find(
        (event: BrokerEvent) =>
          event.kind === 'relay_inbound' && (event as { from: string }).from === recipient
      );
    if (emitted) {
      return {
        kind: 'proxy',
        source: 'pty:agent-emitted-message',
        detail: `relay_inbound from ${recipient}`,
      };
    }
    await sleep(250);
  }
  throw new Error(
    `recipient "${recipient}" emitted no message within ${timeoutMs}ms ` +
      `(PROXY for a model turn on the PTY path — see assertRecipientTookTurn)`
  );
}

/** Assert the evidence is strong enough for the path being exercised. */
export function assertEvidenceIsProof(evidence: TurnEvidence, path: ConformancePath): void {
  if (path === 'native') {
    assert.equal(
      evidence.kind,
      'proof',
      `${PATH_FLAG}=native must produce model-turn proof, got ${evidence.kind} (${evidence.source})`
    );
  }
}

// ── Observing a boomerang return ─────────────────────────────────────────────

/**
 * Raised when the fixture could not put the system into the state an arm
 * assumes — most often, the obligating event never reached the recipient at all.
 *
 * It is a distinct type so the control run cannot count it as the failure it
 * was looking for. A control that accepts *any* exception as "the arm went red"
 * would report success when the suite never got as far as testing anything,
 * which is the same substitution of a well-formed signal for an unverified fact
 * that this fixture exists to catch.
 */
export class ConformancePreconditionError extends Error {
  readonly precondition = true;

  constructor(message: string) {
    super(`PRECONDITION FAILED, not an obligation finding: ${message}`);
    this.name = 'ConformancePreconditionError';
  }
}

export interface ObservedReturn {
  /** 1-based ordinal of this return. */
  index: number;
  /** Interval bucket: `round(elapsedSinceObligation / intervalMs)`. */
  bucket: number;
  /** Broker event kind the return was observed on. */
  via: string;
}

function injectionAt(event: BrokerEvent, recipient: string): { body: string; id: string } | null {
  if (event.kind === 'relay_inbound') {
    const inbound = event as { target: string; body: string; event_id: string };
    if (inbound.target !== recipient) return null;
    return { body: inbound.body ?? '', id: inbound.event_id };
  }
  if (event.kind === 'worker_stream') {
    const stream = event as { name: string; chunk: string };
    if (stream.name !== recipient) return null;
    return { body: stream.chunk ?? '', id: '' };
  }
  return null;
}

/**
 * Wait for the obligation to return to its recipient.
 *
 * A return is an injection at the recipient that is not the original delivery:
 * it must reference the obligating event and must carry the knock marker. The
 * spec is explicit that the return "MUST be injected" and that a host does not
 * satisfy it by writing to a store the model reads on its own initiative, which
 * is why this watches the injection stream rather than the message store.
 *
 * The boomerang injection is produced by `crates/broker/src/runtime/maintenance.rs`
 * draining the ObligationStore (see `crates/broker/src/obligation.rs`). The broker
 * emits a `relay_inbound` event when injecting boomerang returns, which this function
 * detects. With RELAY_OBLIGATION_BOOMERANG=0, the injection is suppressed and this
 * function will time out, which is the expected finding on a disabled or unmodified broker.
 */
export async function waitForReturn(
  harness: BrokerHarness,
  recipient: string,
  obligationId: string,
  options: { since: number; timeoutMs: number }
): Promise<{ via: string }> {
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    const hit = harness
      .getEvents()
      .slice(options.since)
      .find((event) => {
        const injection = injectionAt(event, recipient);
        if (!injection) return false;
        if (injection.id === obligationId) return false; // the original delivery
        return injection.body.includes(RETURN_MARKER) && injection.body.includes(obligationId);
      });
    if (hit) return { via: hit.kind };
    await sleep(250);
  }
  throw new Error(
    `no boomerang return for obligation ${obligationId} reached "${recipient}" within ` +
      `${options.timeoutMs}ms — the obligation was delivered, read and left unanswered, and ` +
      `nothing brought it back`
  );
}

/**
 * Wait until the obligating event actually reaches the recipient.
 *
 * This is deliberately separate from `waitForReturn`, and its failure message
 * is deliberately different. "The obligation never came back" and "the message
 * never arrived in the first place" are different findings, and an arm that
 * reported the first when the second happened would be doing exactly what this
 * issue is about: letting a well-formed signal stand in for a fact nobody
 * verified.
 *
 * Delivery is watched across every kind the broker emits for an inbound
 * message, because the shape differs by runtime. A PTY delivery runs
 * `relay_inbound` -> `delivery_queued` -> `delivery_injected` -> `delivery_ack`
 * -> `message_delivery_confirmed` -> `delivery_verified` -> `delivery_read_ack`;
 * a native one is thinner, because the sidecar acks the `deliver_relay` frame
 * directly and never sends the queued/injected/verified frames.
 */
export async function waitForDelivery(
  harness: BrokerHarness,
  recipient: string,
  options: { since: number; timeoutMs: number }
): Promise<string> {
  // `relay_inbound` and `delivery_queued` are pre-injection signals: they fire
  // when the broker receives the message from Relaycast but before it has been
  // injected into the recipient worker. Accepting them here would let the arm
  // proceed to read/reply/signal steps before the message actually reached the
  // recipient, which is the same substitution of a well-formed signal for an
  // unverified fact that this whole issue is about.
  //
  // PTY path: delivery_injected (stdin written) -> delivery_ack -> ...
  // Native path: delivery_ack (sidecar acked deliver_relay frame) only —
  //   the sidecar never sends queued/injected/verified frames.
  const kinds = new Set([
    'delivery_injected',
    'delivery_ack',
    'message_delivery_confirmed',
    'delivery_verified',
    'delivery_read_ack',
  ]);
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    const hit = harness
      .getEvents()
      .slice(options.since)
      .find((event) => {
        if (!kinds.has(event.kind)) return false;
        const named = event as unknown as { name?: string; target?: string };
        return named.name === recipient || named.target === recipient;
      });
    if (hit) return hit.kind;
    await sleep(250);
  }
  throw new ConformancePreconditionError(
    `the obligating event was accepted by the authoritative log but no delivery of it reached ` +
      `"${recipient}" within ${options.timeoutMs}ms. The arm cannot say anything about the ` +
      `obligation lifecycle because the message never arrived. Check that the broker is enrolled ` +
      `as a live delivery node and that the recipient is routable before reading any other ` +
      `result from this run.`
  );
}

/** Assert no return arrives for the whole window. Used by arm B. */
export async function assertNoReturn(
  harness: BrokerHarness,
  recipient: string,
  obligationId: string,
  options: { since: number; windowMs: number }
): Promise<void> {
  await sleep(options.windowMs);
  const hit = harness
    .getEvents()
    .slice(options.since)
    .find((event) => {
      const injection = injectionAt(event, recipient);
      if (!injection) return false;
      if (injection.id === obligationId) return false;
      return injection.body.includes(RETURN_MARKER) && injection.body.includes(obligationId);
    });
  assert.equal(
    hit,
    undefined,
    `obligation ${obligationId} returned to "${recipient}" after its author discharged it`
  );
}

// ── Arm transcripts (arm D) ──────────────────────────────────────────────────

/**
 * A normalised record of what an arm observed, with every volatile field
 * (ids, wall-clock timestamps, agent names) removed, so two runs can be
 * compared byte for byte.
 */
export interface ArmTranscript {
  arm: string;
  /**
   * `bucket` is present only where the arm asserts interval spacing (arm C).
   * A wall-clock-derived number in an arm that does not assert spacing would
   * make arm D's byte-for-byte comparison fail on scheduling jitter instead of
   * on read state.
   */
  returns: Array<{ index: number; via: string; bucket?: number }>;
  turnEvidence: Array<TurnEvidence['kind']>;
  escalations: number;
}

/** Deterministic, key-order-independent serialisation for a byte-for-byte compare. */
export function serializeTranscript(transcript: ArmTranscript): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, entry]) => [key, canonical(entry)])
      );
    }
    return value;
  };
  return JSON.stringify(canonical(transcript));
}

/**
 * Whether the recipient's read receipt is set on the obligating event.
 *
 * Used by arm D to check that its independent variable actually varied. It
 * usually will not: the broker marks the message read on the recipient's
 * behalf as soon as the delivery is acked
 * (crates/broker/src/runtime/worker_events.rs, `delivery_ack` arm ->
 * `mark_delivery_read_ack` -> `mark_read_as_agent`), and that happens on the
 * native runtime as well as the PTY one. Read state is set by infrastructure,
 * not by attention — which is the premise of the whole design, and also the
 * reason arm D cannot be asserted honestly yet.
 */
export async function recipientHasReadReceipt(
  reader: ConformanceIdentity,
  messageId: string,
  recipientName: string
): Promise<boolean> {
  const readers = (await clientFor(reader).readers(messageId)) as Array<Record<string, unknown>>;
  return readers.some(
    (entry) =>
      // readers() returns normalized receipts with agentName (the string name)
      // and agentId (an opaque identifier). Compare by name only.
      entry.agentName === recipientName
  );
}

// ── Fixture context ──────────────────────────────────────────────────────────

export interface ConformanceContext {
  harness: BrokerHarness;
  apiKey: string;
  path: ConformancePath;
  intervalMs: number;
  author: ConformanceIdentity;
  recipient: ConformanceIdentity;
  /** Second recipient, so arm C can observe escalation at a *different* one. */
  escalationTarget: ConformanceIdentity;
  stop(): Promise<void>;
}

/**
 * Boot a broker, register the three identities, and spawn the recipient (and,
 * for arm C, the escalation target) on the selected path.
 *
 * The broker is started with the boomerang and interval flags in its
 * environment. They do nothing today — there is no mechanism to configure — but
 * wiring them now is what makes the control command real rather than a
 * description of one, and it follows the `std::env::var` toggle idiom the
 * broker already uses (for example `RELAY_INJECT_RATE_MS` in
 * crates/broker/src/pty_worker.rs).
 */
export async function startConformanceContext(options: {
  label: string;
  withEscalationTarget?: boolean;
}): Promise<ConformanceContext> {
  const path = conformancePath();
  const intervalMs = returnIntervalMs();
  const apiKey = await ensureApiKey();
  const suffix = uniqueSuffix();

  const harness = new BrokerHarness({
    env: {
      ...process.env,
      [BOOMERANG_FLAG]: boomerangDisabled() ? '0' : '1',
      [INTERVAL_FLAG]: String(intervalMs),
    },
  });
  await harness.start();

  const author = await registerIdentity(apiKey, `obl-author-${options.label}-${suffix}`);
  const recipient = await registerIdentity(apiKey, `obl-recipient-${options.label}-${suffix}`);
  const escalationTarget = await registerIdentity(apiKey, `obl-escalation-${options.label}-${suffix}`);

  const spawn = async (identity: ConformanceIdentity) => {
    if (path === 'pty') {
      await harness.client.spawnPty({
        name: identity.name,
        cli: process.env[CLI_FLAG] ?? 'claude',
        channels: ['general'],
        agentToken: identity.token,
      });
      return;
    }
    if (path === 'native') {
      // Built by the production launch builder rather than hand-rolled here,
      // so the sidecar contract this fixture exercises is the one the CLI
      // ships (`agent spawn <adapter> --runtime native` goes through the same
      // call in packages/cli/src/cli/lib/client-factory.ts).
      const { transport: _transport, ...launch } = createNativeHarnessLaunch(NATIVE_ADAPTER, {
        name: identity.name,
        channels: ['general'],
        model: process.env[MODEL_FLAG],
      });
      await harness.client.spawnHeadless({ ...launch, agentToken: identity.token });
      return;
    }
    // native-fixture: scripted sidecar, wiring validation only.
    const fixture = new URL('../fixtures/native-sidecar.js', import.meta.url).pathname;
    await harness.client.spawnHeadless({
      name: identity.name,
      cli: 'codex',
      channels: ['general'],
      agentToken: identity.token,
      harnessConfig: {
        runtime: 'native',
        command: process.execPath,
        args: [fixture],
        sessionId: `obl-${uniqueSuffix()}`,
        metadata: {
          runtimeKind: 'native',
          nativeHarnessProtocolVersion: 1,
          nativeHarnessCapabilities: { activeInput: true },
        },
      },
    });
  };

  await spawn(recipient);
  if (options.withEscalationTarget) await spawn(escalationTarget);

  // Give the recipient time to come up before the obligating event is sent.
  await sleep(path === 'pty' ? 12_000 : 5_000);

  return {
    harness,
    apiKey,
    path,
    intervalMs,
    author,
    recipient,
    escalationTarget,
    async stop() {
      await harness.stop();
    },
  };
}
