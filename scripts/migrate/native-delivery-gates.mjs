#!/usr/bin/env node
/**
 * Deterministic gates for the native-delivery migration
 * (`docs/native-delivery-migration.md`).
 *
 * This file is the campaign's single source of truth. `PHASES` below states,
 * per phase, exactly which paths may change, which sources must exist, which
 * feature-manifest rows must be registered, which invariant tests must be
 * named, and which suites must be green. `flows/migrate/native-delivery.spec.ts`
 * imports `PHASES` and compiles it into a Relayflows v2 spec, so the flow and
 * the gates cannot drift apart.
 *
 * Every verdict here is computed from recorded evidence, never from an agent's
 * word. `record` runs a command, captures exit code and output tail, and writes
 * `evidence/<name>.json`; `require-green` reads those files back. An agent that
 * wants a green gate has to make the command pass.
 *
 *   node scripts/migrate/native-delivery-gates.mjs <action> --phase <n> \
 *     --artifact <dir> --run-id <id> [action options]
 *
 * Actions: preflight, contract, record, require-green, require-artifacts,
 * edit-gate, manifest-gate, targeted-gate, seam-rules, unlaunched-gate,
 * seal, accept, commit-if-green.
 */

import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

const MANIFEST = '.agentworkforce/features/manifest.yaml';
const MATRIX = 'tests/relayflows/cleanroom/relay.matrix.json';
const PLANNER = 'scripts/verify-features/targeted-pr-plan.mjs';

/**
 * The five suites the migration doc names as the readiness gate. They assert
 * PTY behaviour today; the whole point is that the same assertions pass with
 * the backend swapped, so every phase reruns all five.
 */
export const PARITY = {
  'parity-orch-to-worker': 'npx tsx tests/parity/orch-to-worker.ts',
  'parity-multi-worker': 'npx tsx tests/parity/multi-worker.ts',
  'parity-broadcast': 'npx tsx tests/parity/broadcast.ts',
  'parity-continuity-handoff': 'npx tsx tests/parity/continuity-handoff.ts',
  'parity-stability-soak': 'npx tsx tests/parity/stability-soak.ts',
};

/**
 * The phase's unlaunched-session scenario, as a command.
 *
 * It lives here rather than in the flow for the same reason `PARITY` does:
 * `contractCommands()` below compares recorded evidence against the command
 * the contract names, and a command the contract does not know cannot be
 * compared. The flow imports this instead of restating it.
 */
export function unlaunchedCommand(cli) {
  return [
    'npm run build:core',
    'cargo build -p agent-relay-broker --bin agent-relay-broker',
    `npx vitest run --config tests/e2e/vitest.unlaunched.config.ts tests/e2e/unlaunched/unlaunched-${cli}-delivery.test.ts`,
  ].join(' && ');
}

/**
 * Every evidence name whose command this contract owns, mapped to that exact
 * command.
 *
 * Earned by codex-review-1 F2. `eval-codex` was tightened from `--harness=codex`
 * to `--harness=codex --min-scenarios=1 --min-delivery-rate=1`, and the run
 * carried forward an `evidence/eval-codex.json` recorded under the OLD, weaker
 * command — a file whose own tail reads `sent=25% scenarios=1/8`, marked green.
 * `require-green` and `accept` validated identity, run id and verdict and never
 * asked what command produced the verdict, so a green recorded under a command
 * the contract no longer names satisfied the contract. Tightening a gate then
 * has no effect until someone notices the evidence is stale, which is the
 * failure mode this campaign exists to prevent.
 *
 * Names the contract does NOT own (`rust-*`, `ts-typecheck`, `unit-tests`, the
 * recorded structural gates) are absent from this map and are not
 * command-checked; their commands live in the flow.
 */
export function contractCommands(config) {
  const commands = {};
  for (const name of config.parity ?? []) {
    if (PARITY[name]) commands[name] = PARITY[name];
  }
  for (const [name, command] of Object.entries(config.evals ?? {})) commands[name] = command;
  for (const [name, command] of Object.entries(config.e2e ?? {})) commands[name] = command;
  if (Array.isArray(config.unlaunched)) {
    for (const cli of config.unlaunched) {
      commands[`unlaunched-${cli}-delivery`] = unlaunchedCommand(cli);
    }
  }
  return commands;
}

/**
 * `null` when the evidence was produced by the command the contract names, or
 * when the contract does not name one. A string describing the drift otherwise.
 */
function commandDrift(config, name, evidence) {
  const expected = contractCommands(config)[name];
  if (expected === undefined) return null;
  if (evidence.command === expected) return null;
  return (
    `${name}: evidence was recorded under a command the contract no longer names\n` +
    `      recorded: ${evidence.command ?? '(none)'}\n` +
    `      contract: ${expected}`
  );
}

/**
 * The recorded structural gates: gates whose verdict is written to
 * `evidence/<name>.json` by `record` and read back later by `require-green`
 * and `accept`, rather than decided in-line.
 */
const STRUCTURAL_GATE_ACTIONS = [
  'edit-gate',
  'manifest-gate',
  'targeted-gate',
  'seam-rules',
  'unlaunched-gate',
];

/**
 * Exactly which parts of the phase contract a structural gate reads.
 *
 * Earned by codex-review-2 F1. `commandDrift` closed the hole where evidence
 * was recorded under a command the contract no longer names — but the
 * structural gates take no contract text on their command line at all. Their
 * command is `... seam-rules --phase 1 --artifact ... --run-id ...` whatever
 * the contract says, so the command string is IDENTICAL before and after the
 * contract tightens. When phase 1 grew the three Codex queue invariants
 * (12 → 15), `evidence/seam-rules-final.json` still carried the green from the
 * 12-invariant run, its own tail reading `invariants=12`, and `accept()`
 * validated existence, run id and the green bit and never asked what contract
 * the green covered. A tightened gate then has no effect until someone reads
 * the tail by eye.
 *
 * So each structural gate stamps a digest of the contract inputs it actually
 * consumed into its pass line, `record` parses that into `gateFacts.coverage`,
 * and `require-green`/`accept` recompute the digest from the CURRENT contract
 * and refuse a mismatch. Adding an invariant, a required source, a feature row
 * or a wiring rule changes the digest, which makes every gate verdict recorded
 * before that change fail closed instead of silently carrying forward.
 *
 * `null` for an action that reads no contract text, which is not checked.
 */
export function gateCoverage(config, action) {
  switch (action) {
    case 'edit-gate':
      return {
        scope: [...(config.scope ?? [])].sort(),
        tsScope: [...(config.tsScope ?? [])].sort(),
        requiredSources: [...(config.requiredSources ?? [])].sort(),
        requiredArtifacts: [...(config.requiredArtifacts ?? [])].sort(),
        allowed: [...allowedPaths(config)].sort(),
      };
    // Both gates are driven by the same declared feature rows: manifest-gate
    // checks they are registered with the required category/tier/location, and
    // targeted-gate checks the selector picked them up.
    case 'manifest-gate':
    case 'targeted-gate':
      return {
        features: (config.features ?? [])
          .map((feature) => [feature.id, feature.category, feature.verify_tier, feature.location].join('|'))
          .sort(),
      };
    case 'seam-rules':
      return {
        invariants: [...(config.invariants ?? [])].sort(),
        invariantTestFiles: [...invariantTestFiles(config)].sort(),
        wiring: (config.wiring ?? [])
          .map((rule) => `${rule.symbol}|${rule.from ?? ''}|${rule.outside ?? ''}`)
          .sort(),
        forbidden: (config.forbidden ?? [])
          .map((rule) => `${rule.where}|${rule.pattern}|${rule.unless}`)
          .sort(),
        untouched: [...(config.untouched ?? [])].sort(),
      };
    case 'unlaunched-gate':
      return {
        unlaunched: Array.isArray(config.unlaunched) ? [...config.unlaunched].sort() : false,
      };
    default:
      return null;
  }
}

/** The stamp a structural gate writes into its pass line. `null` when unchecked. */
export function coverageDigest(config, action) {
  const coverage = gateCoverage(config, action);
  if (coverage === null) return null;
  return createHash('sha256').update(JSON.stringify(coverage)).digest('hex').slice(0, 16);
}

/**
 * `edit-gate-final` → `edit-gate`. `null` for a name this contract does not
 * recognise as a structural gate, which is left unchecked rather than guessed
 * at (`post-codex-review-1-edit` is a repair probe, not an acceptance gate).
 */
function structuralAction(name) {
  const base = name.endsWith('-final') ? name.slice(0, -'-final'.length) : name;
  return STRUCTURAL_GATE_ACTIONS.includes(base) ? base : null;
}

/**
 * `null` when the recorded verdict covers the contract as it stands now.
 * A string describing the drift otherwise.
 *
 * Absent `gateFacts.coverage` is drift, not an exemption: evidence with no
 * stamp was produced by a gate that did not know what contract it was proving,
 * and that is precisely the stale file this check exists to reject.
 */
function coverageDrift(config, name, evidence) {
  const action = structuralAction(name);
  if (action === null) return null;
  const expected = coverageDigest(config, action);
  if (expected === null) return null;
  const recorded = evidence.gateFacts?.coverage;
  if (recorded === undefined) {
    return (
      `${name}: evidence carries no contract-coverage stamp, so it predates the current gate — ` +
      `re-record it (expected coverage ${expected})`
    );
  }
  if (recorded !== expected) {
    const summary = Object.entries(gateCoverage(config, action))
      .map(([key, value]) => `${key}=${Array.isArray(value) ? value.length : value}`)
      .join(' ');
    return (
      `${name}: the recorded verdict covers a different contract than this phase declares\n` +
      `      recorded coverage: ${recorded}\n` +
      `      contract coverage: ${expected} (${summary})`
    );
  }
  return null;
}

/**
 * The seam contract tests that must exist, pass, and carry mutation evidence.
 * This includes the original four scripted-backend tests, every invariant
 * added by adversarial review, and the three tests against the shipping PTY
 * route. Leaving later tests out made the gate certify evidence it never read.
 */
const SEAM_INVARIANTS = [
  'falls_back_only_before_write',
  'never_resends_on_doubt',
  'a_cancelled_send_remains_in_doubt_and_is_not_retried',
  'records_route_for_each_send',
  'never_acks_without_observation',
  'an_evicted_receipt_does_not_become_a_fresh_send',
  'settle_distinguishes_absence_from_an_unreachable_route',
  'settle_reports_an_evicted_receipt_as_unknown_not_absent',
  'an_acknowledgement_must_name_the_observation_behind_it',
  'unavailable_queue_capability_falls_back_before_write',
  'queue_process_failure_is_committed_and_does_not_fall_back',
  'successful_queue_send_is_handed_over_not_acked',
  'real_pty_route_unknown_worker_is_pre_write_and_may_fall_back',
  'real_pty_route_write_failure_after_commit_does_not_fall_back',
  'real_pty_route_never_reports_an_observed_ack',
];

const INVARIANT_TEST_FILE = 'crates/broker/tests/delivery_seam_invariants.rs';
const INVARIANT_TEST_FILES = [
  INVARIANT_TEST_FILE,
  'crates/broker/src/delivery/pty.rs',
  'crates/broker/src/delivery/codex_queue.rs',
];

/**
 * Phase 1's own invariants, on top of the seam's.
 *
 * Phase 0's lesson 2 is that a scripted backend proves nothing about a real
 * one, so each phase has to drive the four rules through ITS transport. The
 * seam list covers rules 1 and 4 for the codex route; these cover rule 2's
 * duplicate, cancellation, teardown and restart shapes, rule 3's
 * settle-by-the-recorded-route, the selection guard the whole parity answer
 * rests on, and the queued-versus-consumed acknowledgement boundary.
 *
 * Deliberately NOT appended to `SEAM_INVARIANTS`: phases 2-5 share that list
 * and have no codex route to prove these against.
 */
const PHASE_1_NATIVE_ROUTE_INVARIANTS = [
  // Rule 2, on the real transport.
  'a_repeated_send_never_queues_the_same_delivery_twice',
  'a_cancelled_queue_send_is_not_retried_on_the_codex_route',
  // Rule 2, across the two dispositions that outlive a send: worker teardown
  // and broker restart. A native route survives both, so both can duplicate.
  'releasing_an_agent_with_a_handed_over_native_delivery_dead_letters_it_in_doubt',
  'every_worker_teardown_site_disposes_through_the_seam_aware_path',
  'a_restarted_broker_does_not_queue_a_handed_over_codex_delivery_again',
  // Rule 3, on the real transport.
  'settlement_uses_the_recorded_thread_route_and_never_another_codex',
  // The selection guard: only codex, only with a known thread.
  'only_a_codex_worker_with_a_known_thread_selects_the_codex_queue_route',
  'an_unselectable_codex_backend_refuses_before_any_write',
  // Rule 4: what a codex acknowledgement is allowed to mean (decision D4).
  'a_consumed_user_item_is_observed_in_both_real_projections',
  'a_queued_but_unconsumed_message_is_queued_not_consumed',
  'a_quoted_marker_in_a_non_user_record_is_not_an_acknowledgement',
  // Manual flush must not accumulate messages the flush path cannot deliver.
  'a_native_only_delivery_target_never_parks_an_inbound_message',
  'manual_flush_is_refused_for_a_native_only_delivery_target',
];

const PHASE_1_INVARIANT_TEST_FILES = [
  ...INVARIANT_TEST_FILES,
  'crates/broker/src/codex_thread.rs',
  'crates/broker/src/runtime/tests.rs',
];

/**
 * Where a phase's invariant tests live. `invariantTestFile` (singular) is the
 * legacy override for a phase with exactly one file; `invariantTestFiles`
 * declares the set. Both feed the coverage digest, so widening the set is
 * visible in every structural gate's pass line rather than silent.
 */
function invariantTestFiles(config) {
  if (config.invariantTestFiles) return [...config.invariantTestFiles];
  if (config.invariantTestFile) return [config.invariantTestFile];
  return [...INVARIANT_TEST_FILES];
}

/** Phases, ordered as the doc orders them. Phase 6 is independent. */
export const PHASES = {
  0: {
    slug: 'seam',
    title: 'Delivery-backend seam beside the PTY injector',
    /**
     * The lane, widened four times — each time because a gate this campaign
     * owns demanded an edit the lane forbade.
     *
     * `node_control.rs` and `worker.rs` are the last two, and they are not
     * scope creep: R2-1's repair needs the fleet ACK cursor to express
     * "never confirmable" (`abandon_unconfirmed_delivery`), and R2-2's needs a
     * real write-commit boundary in the PTY worker. Both were identified by
     * adversarial review as REQUIRED to satisfy the seam rules, so a lane that
     * excluded them made the phase unsatisfiable by construction.
     */
    scope: [
      'crates/broker/src/delivery/',
      'crates/broker/src/broker/',
      'crates/broker/src/lib.rs',
      'crates/broker/tests/',
      'crates/broker/src/runtime/',
      'crates/broker/src/pty_worker.rs',
      'crates/broker/src/node_control.rs',
      'crates/broker/src/node_delivery_probe.rs',
      'crates/broker/src/worker.rs',
    ],
    tsScope: [
      'tests/',
      '.agentworkforce/features/manifest.yaml',
      'packages/contracts/fixtures/event-fixtures.json',
      'packages/harness-driver/src/protocol.ts',
      'packages/sdk-py/src/agent_relay/protocol.py',
    ],
    requiredSources: [
      'crates/broker/src/delivery/mod.rs',
      'crates/broker/src/delivery/backend.rs',
      'crates/broker/src/delivery/pty.rs',
      INVARIANT_TEST_FILE,
    ],
    features: [
      {
        id: 'delivery-backend-seam',
        category: 'broker',
        location: 'crates/broker/src/delivery/',
        verify_tier: 6,
      },
    ],
    /**
     * The exit criterion is "the PTY injector becomes ONE IMPLEMENTATION", not
     * "a trait exists". The first run produced a trait, a coordinator and four
     * passing invariant tests with nothing behind them: no code path called the
     * seam and the PTY backend wrote nothing. `edit-gate` passed it — files
     * changed, required sources present — and the shadow reviewer caught what
     * the gate could not, that a green parity suite on that tree cannot
     * distinguish "seam works" from "seam absent".
     *
     * A signal that an artifact EXISTS never proves anything ACTS on it. So the
     * consumer is named here, by file.
     */
    wiring: [{ symbol: 'DeliveryBackend', from: 'crates/broker/src/runtime/delivery.rs' }],
    invariants: SEAM_INVARIANTS,
    parity: Object.keys(PARITY),
    rust: true,
    evals: {
      'observation-ledger-unit':
        'npx vitest run tests/integration/broker/evals/delivery/observation-ledger.unit.test.ts',
    },
    e2e: {},
    unlaunched: false,
    exit: 'The parity suite is green, unchanged, with the PTY backend behind the new trait.',
  },
  1: {
    slug: 'codex-queue',
    title: 'Codex native delivery over `codex queue`',
    /**
     * `wrap.rs` is the fifth widening, and it is the same shape as phase 0's:
     * a lane that excludes an edit the phase's own repair requires makes the
     * phase unsatisfiable. The PTY verification structs live in the in-scope
     * `delivery_verification.rs`, but `wrap.rs` constructs them for the legacy
     * wrap route. Leaving it out is not merely a stray:
     * `commit-if-green` stages `git add -- <scope>`, so the commit would carry
     * the new field without the caller that populates it and the committed
     * tree would not compile.
     */
    scope: [
      'crates/broker/src/delivery/',
      'crates/broker/src/codex_thread.rs',
      'crates/broker/src/broker/delivery_verification.rs',
      'crates/broker/tests/',
      'crates/broker/src/worker.rs',
      'crates/broker/src/listen_api.rs',
      'crates/broker/src/runtime/',
      'crates/broker/src/pty_worker.rs',
      'crates/broker/src/wrap.rs',
      'crates/broker/Cargo.toml',
      // The sixth widening, same shape as the five above. Worker teardown now
      // dead-letters a delivery that already reached a native transport as IN
      // DOUBT, and the withheld fleet ack that dies with it has to be recorded
      // somewhere an operator can see rather than dropped with a log line. The
      // probe owns every other `DeliverDisposition`, so the new
      // `DroppedInDoubt` belongs beside them; leaving the file out would make
      // the repair the signoff demanded unreachable.
      'crates/broker/src/node_delivery_probe.rs',
      'crates/relay-pty/src/codex_session.rs',
    ],
    tsScope: ['tests/', 'packages/cli/', '.agentworkforce/features/manifest.yaml', MATRIX],
    requiredSources: [
      'crates/broker/src/delivery/codex_queue.rs',
      'crates/broker/src/codex_thread.rs',
      INVARIANT_TEST_FILE,
    ],
    requiredArtifacts: [
      'decisions/D1-codex-thread-id.md',
      'decisions/D2-codex-eval-floor.md',
      'decisions/D3-codex-steer-route.md',
      'decisions/D4-codex-read-receipt-standard.md',
    ],
    features: [
      {
        id: 'codex-queue-delivery',
        category: 'broker',
        location:
          'crates/broker/src/delivery/codex_queue.rs, crates/broker/src/codex_thread.rs, crates/broker/src/listen_api.rs, packages/cli/src/cli/agent-relay-mcp.ts',
        verify_tier: 4,
      },
    ],
    wiring: [{ symbol: 'CodexQueueBackend', outside: 'crates/broker/src/delivery/codex_queue.rs' }],
    invariants: [...SEAM_INVARIANTS, ...PHASE_1_NATIVE_ROUTE_INVARIANTS],
    invariantTestFiles: PHASE_1_INVARIANT_TEST_FILES,
    parity: Object.keys(PARITY),
    rust: true,
    evals: {
      'eval-codex':
        'npm run eval:build && cd tests/integration/broker && RELAY_INTEGRATION_REAL_CLI=1 node dist/evals/runner.js --harness=codex --min-scenarios=1 --min-delivery-rate=1',
    },
    e2e: {},
    unlaunched: ['codex'],
    exit: 'Parity plus `eval:matrix` for codex, plus a delivery into a codex session relay did not launch.',
  },
  2: {
    slug: 'claude-native',
    title: 'Claude terminal inbox socket and `--cloud` delivery',
    scope: [
      'crates/broker/src/delivery/',
      'crates/broker/src/claude_registry.rs',
      'crates/broker/tests/',
      'crates/broker/src/runtime/',
      'crates/broker/src/pty_worker.rs',
    ],
    tsScope: ['tests/', '.agentworkforce/features/manifest.yaml', MATRIX],
    requiredSources: [
      'crates/broker/src/delivery/claude_socket.rs',
      'crates/broker/src/delivery/claude_cloud.rs',
      'crates/broker/src/claude_registry.rs',
      INVARIANT_TEST_FILE,
    ],
    features: [
      {
        id: 'claude-socket-delivery',
        category: 'broker',
        location: 'crates/broker/src/delivery/claude_socket.rs, crates/broker/src/claude_registry.rs',
        verify_tier: 4,
      },
      {
        id: 'claude-cloud-delivery',
        category: 'broker',
        location: 'crates/broker/src/delivery/claude_cloud.rs',
        verify_tier: 5,
      },
    ],
    wiring: [
      { symbol: 'ClaudeSocketBackend', outside: 'crates/broker/src/delivery/claude_socket.rs' },
      { symbol: 'ClaudeCloudBackend', outside: 'crates/broker/src/delivery/claude_cloud.rs' },
    ],
    invariants: SEAM_INVARIANTS,
    parity: Object.keys(PARITY),
    rust: true,
    evals: {
      'eval-claude':
        'npm run eval:build && cd tests/integration/broker && RELAY_INTEGRATION_REAL_CLI=1 node dist/evals/runner.js --harness=claude --min-scenarios=1 --min-delivery-rate=1',
    },
    e2e: {},
    unlaunched: ['claude'],
    exit: 'Parity plus `eval:claude`, plus a delivery into a claude session relay did not launch.',
  },
  3: {
    slug: 'acp',
    title: 'One ACP backend for grok, opencode and devin',
    scope: [
      'crates/broker/src/delivery/',
      'crates/broker/tests/',
      'crates/broker/src/runtime/',
      'crates/broker/src/pty_worker.rs',
    ],
    tsScope: ['tests/', '.agentworkforce/features/manifest.yaml'],
    requiredSources: ['crates/broker/src/delivery/acp.rs', INVARIANT_TEST_FILE],
    features: [
      {
        id: 'acp-delivery',
        category: 'harnesses',
        location: 'crates/broker/src/delivery/acp.rs',
        verify_tier: 4,
      },
    ],
    wiring: [{ symbol: 'AcpBackend', outside: 'crates/broker/src/delivery/acp.rs' }],
    invariants: SEAM_INVARIANTS,
    parity: Object.keys(PARITY),
    rust: true,
    evals: {
      'eval-acp-harnesses':
        'npm run eval:build && cd tests/integration/broker && RELAY_INTEGRATION_REAL_CLI=1 node dist/evals/runner.js --harness=grok,opencode,devin --min-scenarios=1 --min-delivery-rate=1',
    },
    e2e: {},
    unlaunched: false,
    exit: '`eval:matrix` per ACP harness, with the PTY still green for everything else.',
  },
  4: {
    slug: 'pty-retained',
    title: 'What stays on the PTY: muse and cursor-agent',
    scope: [
      'crates/broker/src/delivery/',
      'crates/broker/tests/',
      'crates/broker/src/runtime/',
      'crates/broker/src/pty_worker.rs',
    ],
    tsScope: ['tests/', '.agentworkforce/features/manifest.yaml'],
    requiredSources: ['crates/broker/src/delivery/routing.rs', INVARIANT_TEST_FILE],
    features: [
      {
        id: 'delivery-route-selection',
        category: 'broker',
        location: 'crates/broker/src/delivery/routing.rs',
        verify_tier: 2,
      },
    ],
    wiring: [{ symbol: 'select_route', outside: 'crates/broker/src/delivery/routing.rs' }],
    invariants: [...SEAM_INVARIANTS, 'muse_and_cursor_select_pty'],
    /**
     * `muse session-message` refuses outsiders with `sender_unverified`. The
     * doc calls that a security boundary, not an obstacle, so any attempt to
     * spoof past it fails this phase outright.
     */
    forbidden: [{ pattern: 'sender_unverified', where: 'crates/broker/src/delivery/', unless: 'refuse' }],
    parity: Object.keys(PARITY),
    rust: true,
    evals: {},
    e2e: {},
    unlaunched: false,
    exit: 'Route selection provably picks the PTY for muse and cursor-agent, and the muse ancestry check is untouched.',
  },
  5: {
    slug: 'detached-spawn',
    title: 'Decouple spawning from wrapping',
    scope: [
      'crates/broker/src/spawner.rs',
      'crates/broker/src/delivery/',
      'crates/broker/tests/',
      'crates/broker/src/runtime/',
      'crates/broker/src/pty_worker.rs',
    ],
    tsScope: ['tests/', 'packages/', '.agentworkforce/features/manifest.yaml'],
    requiredSources: ['crates/broker/src/spawner.rs', INVARIANT_TEST_FILE],
    features: [
      {
        id: 'detached-agent-spawn',
        category: 'local-agents',
        location: 'crates/broker/src/spawner.rs',
        verify_tier: 4,
      },
    ],
    /** The four things the doc says must survive detachment. */
    wiring: [{ symbol: 'DeliveryBackend', from: 'crates/broker/src/spawner.rs' }],
    invariants: [
      ...SEAM_INVARIANTS,
      'detached_spawn_keeps_parent_lineage',
      'detached_spawn_emits_agent_spawned',
      'detached_spawn_records_spawn_source',
      'detached_spawn_keeps_workforce_metadata',
    ],
    parity: Object.keys(PARITY),
    rust: true,
    evals: {},
    e2e: {
      'e2e-fleet': 'npx vitest run --config vitest.e2e.config.ts tests/e2e/fleet',
    },
    unlaunched: false,
    exit: 'The two-node fleet matrix and the stability soak pass with detached, natively-delivered agents.',
  },
  6: {
    slug: 'config-hygiene',
    title: 'Stop writing into user config for grok, opencode and cursor',
    scope: ['crates/broker/src/snippets.rs', 'crates/broker/src/cli_mcp_args.rs', 'crates/broker/tests/'],
    tsScope: ['tests/', '.agentworkforce/features/manifest.yaml'],
    requiredSources: ['crates/broker/src/cli_mcp_args.rs', 'crates/broker/tests/config_isolation.rs'],
    features: [
      {
        id: 'cli-config-isolation',
        category: 'harnesses',
        location: 'crates/broker/src/cli_mcp_args.rs, crates/broker/src/snippets.rs',
        verify_tier: 1,
      },
    ],
    invariants: [
      'grok_uses_isolated_config_home',
      'opencode_does_not_write_workspace_config',
      'cursor_does_not_write_workspace_config',
      'gemini_and_droid_are_untouched',
    ],
    invariantTestFile: 'crates/broker/tests/config_isolation.rs',
    /**
     * Out of scope per the doc. A diff here means the phase overreached.
     */
    untouched: ['configure_gemini_droid_mcp'],
    parity: Object.keys(PARITY),
    rust: true,
    evals: {},
    e2e: {},
    unlaunched: false,
    exit: 'No grok, opencode or cursor launch mutates a file the user owns, and gemini/droid are byte-identical.',
  },
};

/**
 * Tests already failing on this tree before the campaign touched it.
 *
 * A regression gate asks "did I break anything", not "is the repo perfect".
 * Demanding a wholly green suite makes the gate unsatisfiable for reasons that
 * have nothing to do with the change, and the usual escape — deleting or
 * skipping the test — is exactly the weakening this campaign forbids.
 *
 * Every entry is justified, and the justification is that the change cannot
 * reach it: `git status --porcelain -- <subject>` reports zero changed files
 * for each subject below. Re-derive that before adding a row. A row is a
 * standing claim that a failure is someone else's, so it must be cheap to
 * disprove.
 */
const KNOWN_FAILURES = [
  {
    match: "reports the child's pid the moment it is spawned",
    why: 'packages/harness-driver unchanged; the test spawns a stub shell script, never the broker binary, so no Rust change can reach it. Fails on a 200ms startup budget under load.',
  },
  {
    match: 'reaps the broker child when startup never reports an API port',
    why: 'Same file, same stub-script fixture, same 200ms budget.',
  },
  {
    match: 'derives the current-main command surface without conflating it',
    why: 'packages/cli/src/cli/commands unchanged; asserts a CLI command-surface inventory count (expects 36, tree has 35).',
  },
];

function classifyRegressionEvidence(evidence) {
  if (evidence.exitCode === 0) {
    return {
      failing: [],
      unexplained: [],
      malformed: evidence.verdict === 'green' ? null : 'command exited 0 but its evidence verdict is red',
    };
  }
  if (!Array.isArray(evidence.failingTests)) {
    return {
      failing: [],
      unexplained: [],
      malformed: `command exited ${evidence.exitCode} without structured failure data`,
    };
  }
  const failing = [...new Set(evidence.failingTests.map((line) => line.replace(/^\s*FAIL\s+/, '').trim()))];
  if (failing.length === 0) {
    return {
      failing,
      unexplained: [],
      malformed: `command exited ${evidence.exitCode} but reported no failing tests`,
    };
  }
  return {
    failing,
    unexplained: failing.filter((entry) => !KNOWN_FAILURES.some((known) => entry.includes(known.match))),
    malformed: null,
  };
}

/**
 * Pass when every failing test is a declared known failure. New failures are
 * the regression this gate exists to catch; a known failure that has started
 * passing is reported but not fatal.
 */
function regressionGate() {
  const art = artifactRoot();
  const name = option('--name', 'unit-tests');
  const file = path.join(art, 'evidence', `${name}.json`);
  if (!existsSync(file)) {
    fail(`regression-gate: ${name} never ran`);
    return;
  }
  const evidence = readJson(file);
  const { failing, unexplained, malformed } = classifyRegressionEvidence(evidence);
  if (malformed) {
    fail(`regression-gate ${name}: ${malformed}`);
    return;
  }
  if (unexplained.length > 0) {
    fail(
      `regression-gate ${name}: ${unexplained.length} failure(s) not in the known-failure baseline\n  ` +
        unexplained.join('\n  ')
    );
    return;
  }
  const fixed = KNOWN_FAILURES.filter((known) => !failing.some((entry) => entry.includes(known.match)));
  pass(
    `regression-gate ${name} failing=${failing.length} all-known` +
      (fixed.length > 0
        ? ` (${fixed.length} baseline entr${fixed.length === 1 ? 'y' : 'ies'} now passing — prune it)`
        : '')
  );
}

// ───────────────────────────── plumbing ─────────────────────────────

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : fallback;
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
}

function list(name) {
  const raw = option(name, '');
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function phaseConfig() {
  const phase = option('--phase');
  const config = PHASES[phase];
  if (!config) throw new Error(`unknown phase ${phase}; known: ${Object.keys(PHASES).join(', ')}`);
  return { phase, config };
}

function artifactRoot() {
  const dir = option('--artifact');
  mkdirSync(path.join(dir, 'evidence'), { recursive: true });
  mkdirSync(path.join(dir, 'reviews'), { recursive: true });
  mkdirSync(path.join(dir, 'decisions'), { recursive: true });
  return dir;
}

/**
 * Every verdict is also appended to `<artifact>/gate-log.txt`.
 *
 * Not belt-and-braces: a gate invoked as a Relayflows `subprocess_gate` runs
 * under `stdio: 'inherit'`, and the daemon's stdio is captured nowhere — the
 * journal records `exit=1` with empty stdout and stderr tails, and
 * `relayflowd.log` stays empty too (AgentWorkforce/flows#511). Writing the
 * verdict to a file is the only way such a failure stays diagnosable.
 */
function journal(line) {
  const index = process.argv.indexOf('--artifact');
  if (index < 0) return;
  const dir = process.argv[index + 1];
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, 'gate-log.txt'), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // A gate must never fail because its own audit line could not be written.
  }
}

function fail(message) {
  process.stderr.write(`GATE_FAILED ${message}\n`);
  journal(`GATE_FAILED ${message.replace(/\n\s*/g, ' | ')}`);
  process.exitCode = 1;
}

function pass(message) {
  process.stdout.write(`GATE_PASSED ${message}\n`);
  journal(`GATE_PASSED ${message}`);
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Files this campaign has touched, relative to the repo root.
 *
 * Working-tree status ALONE is wrong: it goes blind the moment the work is
 * committed, and `edit-gate` then reports NO_CHANGES for a branch full of
 * changes. So the campaign's recorded base (context.json `baseSha`, or
 * `--base`) is diffed as well, and the two sets are merged — uncommitted work
 * counts before the commit, committed work counts after it.
 */
function changedFiles() {
  const committed = (() => {
    const explicit = process.argv.indexOf('--base');
    let base = explicit >= 0 ? process.argv[explicit + 1] : undefined;
    if (!base) {
      const index = process.argv.indexOf('--artifact');
      const contextPath = index >= 0 ? path.join(process.argv[index + 1] ?? '', 'context.json') : '';
      if (contextPath && existsSync(contextPath)) base = readJson(contextPath).baseSha;
    }
    if (!base) return [];
    try {
      // `main` rather than the recorded sha when the sha is an ancestor of the
      // campaign's own tooling commits: the merge-base is what the PR diffs.
      const mergeBase = execFileSync('git', ['merge-base', 'HEAD', base], { encoding: 'utf8' }).trim();
      return execFileSync('git', ['diff', '--name-only', mergeBase], { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean);
    } catch {
      return [];
    }
  })();
  return [...new Set([...committed, ...workingTreeChanges()])].sort();
}

/** Uncommitted changes, tracked or not. */
function workingTreeChanges() {
  const porcelain = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    encoding: 'utf8',
  });
  const out = new Set();
  const entries = porcelain.split('\0').filter(Boolean);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const status = entry.slice(0, 2);
    const file = entry.slice(3);
    // A rename carries its source in the following NUL-separated field.
    if (status.includes('R')) index += 1;
    if (file) out.add(file);
  }
  return [...out].sort();
}

function withinScope(file, scope) {
  return scope.some((entry) => (entry.endsWith('/') ? file.startsWith(entry) : file === entry));
}

/**
 * Every path this phase is permitted to change: the declared product lane plus
 * the campaign's own output.
 *
 * `edit-gate` rejects anything outside this set, and `commit-if-green` stages
 * exactly what this set admits. Those two used to disagree — the gate allowed
 * `package.json`, `CHANGELOG.md`, `.gitignore` and the `scripts/migrate/` +
 * `flows/migrate/` harness, while the commit staged only `scope` + `tsScope`.
 * So a phase could pass every gate and commit a tree missing the very files
 * the gate had approved: the `test:e2e:unlaunched` script repointed at the new
 * vitest config, the changelog entry CLAUDE.md requires, and the gate edits
 * `accept` prints `HARNESS_MODIFIED` about precisely so a reviewer can read
 * them in the diff.
 */
function allowedPaths(config) {
  return [
    ...config.scope,
    ...(config.tsScope ?? []),
    '.workflow-artifacts/',
    'scripts/migrate/',
    'flows/migrate/',
    'flows/audit/',
    // The harness adapter and the e2e wiring the phase needed: campaign
    // tooling, not product, and so not manifest-routable either.
    'scripts/flows/',
    'package.json',
    'vitest.e2e.config.ts',
    '.gitignore',
    // Trail writes these as agents work; CLAUDE.md requires them tracked, so
    // they are legitimate output of a run rather than scope creep. The bare
    // `.trajectories/` path is the same tool's older location, which `trail
    // compact` migrates out of mid-run.
    '.agentworkforce/trajectories/',
    '.trajectories/',
    '.review-out/',
    'CHANGELOG.md',
    'docs/',
  ];
}

// ───────────────────────────── actions ─────────────────────────────

/**
 * Establish that the run can produce a mergeable result at all: a real repo,
 * a phase branch rather than main, a toolchain, and no pre-existing block.
 * Everything here is an external blocker in the 80-to-100 sense — the flow
 * cannot repair a missing cargo, so it refuses up front rather than failing
 * halfway through.
 */
function preflight() {
  const { phase, config } = phaseConfig();
  const art = artifactRoot();
  const runId = option('--run-id');
  const problems = [];

  let branch = '';
  try {
    branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  } catch {
    problems.push('not a git repository');
  }
  const wanted = `feat/native-delivery-phase-${phase}-${config.slug}`;
  if (branch === 'main' || branch === 'master') {
    // CLAUDE.md: never work on main. Branching is the one mutation preflight
    // performs, because the alternative is a run that cannot be merged safely.
    git(['checkout', '-b', wanted]);
    branch = wanted;
  }

  for (const [tool, args] of [
    ['git', ['--version']],
    ['node', ['--version']],
    ['npx', ['--version']],
  ]) {
    try {
      execFileSync(tool, args, { stdio: 'ignore' });
    } catch {
      problems.push(`missing required tool: ${tool}`);
    }
  }
  if (config.rust) {
    const cargo = process.env.CARGO ?? `${process.env.HOME}/.cargo/bin/cargo`;
    if (!existsSync(cargo)) {
      try {
        execFileSync('cargo', ['--version'], { stdio: 'ignore' });
      } catch {
        problems.push('phase needs a Rust toolchain and cargo is not on PATH');
      }
    }
  }
  for (const file of [MANIFEST, MATRIX, PLANNER, 'docs/native-delivery-migration.md']) {
    if (!existsSync(file)) problems.push(`missing campaign input: ${file}`);
  }
  if (existsSync(path.join(art, 'BLOCKED_NO_COMMIT.md'))) {
    problems.push('a previous run left BLOCKED_NO_COMMIT.md; resolve and clear it before rerunning');
  }

  const baseSha = git(['rev-parse', 'HEAD']);
  writeJson(path.join(art, 'context.json'), {
    schemaVersion: 1,
    kind: 'native-delivery-context',
    runId,
    phase: Number(phase),
    slug: config.slug,
    title: config.title,
    exit: config.exit,
    branch,
    baseSha,
    startedAt: new Date().toISOString(),
  });

  if (problems.length > 0) {
    writeFileSync(
      path.join(art, 'BLOCKED_NO_COMMIT.md'),
      `# Blocked before implementation\n\nrun: ${runId}\nphase: ${phase} (${config.slug})\n\n` +
        problems.map((problem) => `- ${problem}`).join('\n') +
        '\n'
    );
    fail(`preflight: ${problems.join('; ')}`);
    return;
  }
  pass(`preflight phase=${phase} slug=${config.slug} branch=${branch} base=${baseSha}`);
}

/**
 * Write the phase contract agents read. Nothing here is negotiable by an
 * agent: it is `PHASES` rendered to disk so a prompt can point at a file
 * instead of restating rules that would then drift.
 */
function contract() {
  const { phase, config } = phaseConfig();
  const art = artifactRoot();
  writeJson(path.join(art, 'phase-contract.json'), {
    schemaVersion: 1,
    kind: 'native-delivery-phase-contract',
    phase: Number(phase),
    ...config,
    parityCommands: Object.fromEntries((config.parity ?? []).map((name) => [name, PARITY[name]])),
    // The exact command each contract-owned evidence file must be recorded
    // under. `require-green` and `accept` compare against this, so a recorder
    // invoked by hand has the string to copy rather than to approximate.
    contractCommands: contractCommands(config),
    seamRules: [
      'Fall back to another transport only on a strictly pre-write error.',
      'Never re-send on doubt.',
      'Record which route each send took, and settle by that route’s rules.',
      'Never claim an acknowledgement you did not observe.',
    ],
  });
  pass(`contract phase=${phase}`);
}

/** Run one command through /bin/bash, collecting combined output. */
function runOnce(command, chunks) {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: '/bin/bash', env: process.env });
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => chunks.push(chunk));
    child.on('error', (error) => {
      chunks.push(Buffer.from(`spawn error: ${error.message}\n`));
      resolve(127);
    });
    child.on('close', (code, signal) => resolve(signal ? 128 : (code ?? 1)));
  });
}

/**
 * Run a command and journal its real result. The step that calls this always
 * exits 0 so a red command becomes repair work rather than a dead run; the
 * truth lives in the evidence file that `require-green` and `accept` read.
 */
async function record() {
  const art = artifactRoot();
  const name = option('--name');
  // Commands carry `&&`, pipes and quotes. Base64 has nothing for the calling
  // shell to reinterpret, so the command the flow wrote is the command that
  // runs. `-- <argv>` stays available for hand-invocation.
  const encoded = process.argv.indexOf('--command-base64');
  const separator = process.argv.indexOf('--');
  const command =
    encoded >= 0
      ? Buffer.from(process.argv[encoded + 1] ?? '', 'base64').toString('utf8')
      : separator >= 0
        ? process.argv.slice(separator + 1).join(' ')
        : '';
  if (!command.trim()) throw new Error('record needs `--command-base64 <b64>` or `-- <command>`');
  const expect = list('--expect');
  const forbid = list('--forbid');

  /**
   * Re-run a red command this many times before recording the result.
   *
   * This does NOT weaken the gate: the command must still pass, and the
   * recorded verdict is the final attempt's. It only stops a transient
   * failure from being treated as a regression.
   *
   * Earned: the five parity suites run back to back, and that contention makes
   * `broadcast` report `Verified: 2/3, Failed: 0` — one verification arriving
   * outside the window, nothing actually failing. It passes 3/3 on three
   * consecutive standalone runs. Without a retry, that flake killed a run 35
   * steps deep whose real regression had just been fixed.
   */
  const retries = Number(option('--retry-on-red', '0'));
  const startedAt = Date.now();
  let chunks = [];
  let exitCode = 0;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    chunks = [];
    exitCode = await runOnce(command, chunks);
    if (exitCode === 0) {
      if (attempt > 0) chunks.push(Buffer.from(`\n[record] passed on attempt ${attempt + 1}\n`));
      break;
    }
    if (attempt < retries) {
      process.stdout.write(`RETRY ${name} attempt ${attempt + 1} exited ${exitCode}; re-running\n`);
    }
  }
  const output = Buffer.concat(chunks).toString('utf8');
  const missing = expect.filter((marker) => !output.includes(marker));
  const present = forbid.filter((marker) => output.includes(marker));
  const verdict = exitCode === 0 && missing.length === 0 && present.length === 0 ? 'green' : 'red';

  writeJson(path.join(art, 'evidence', `${name}.json`), {
    schemaVersion: 1,
    kind: 'native-delivery-evidence',
    name,
    /**
     * The run that produced this. A `record` step always exits 0 so a red
     * command becomes repair work, which also makes every recorder step
     * REUSABLE by `flows run --reuse-from` — the step succeeded even though the
     * command it wrapped did not. Reuse then carries the old evidence file
     * forward untouched, and a later gate reads a verdict from a tree that no
     * longer exists. Observed: run g reused `ts-typecheck` from run f and kept
     * its exit=2, recorded before the missing workspace link that caused it was
     * repaired.
     *
     * Stamping lets a gate say so. `final-evidence` re-records everything
     * before acceptance, so the flow already self-heals; this makes a stale
     * read visible instead of silent.
     */
    runId: option('--run-id', 'unknown'),
    command,
    /**
     * A stable digest of the command, so the seal and a reviewer can compare
     * two evidence files without diffing shell strings by eye. The comparison
     * gates use `command` itself; this is the audit handle.
     */
    commandSha256: createHash('sha256').update(command).digest('hex'),
    /**
     * The `key=value` facts the wrapped gate stamped into its own pass line,
     * chiefly `coverage` — the digest of the contract text that gate read.
     *
     * Structural gates take no contract text on their command line, so
     * `commandSha256` is identical before and after the contract tightens and
     * cannot tell a stale verdict from a current one. This can: `accept` and
     * `require-green` recompute the digest from the contract and refuse a
     * mismatch. `null` when the wrapped command is not a gate, or when it
     * failed and therefore printed no pass line.
     */
    gateFacts: parseGateFacts(output),
    exitCode,
    verdict,
    missingExpected: missing,
    forbiddenPresent: present,
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    // Preserve every failing test name independently of the bounded output
    // tail. Regression classification must not turn green because the first
    // failure scrolled past 20,000 characters.
    failingTests: output.match(/^\s*FAIL\s+.+$/gm) ?? [],
    // Enough context to diagnose, bounded so a soak log cannot fill the disk.
    tail: output.slice(-20_000),
  });
  process.stdout.write(`EVIDENCE ${name} verdict=${verdict} exit=${exitCode}\n`);
  process.stdout.write(`${output.slice(-4_000)}\n`);
}

/**
 * The `key=value` pairs on the LAST `GATE_PASSED` line of a recorded run.
 *
 * Last, not first: a recorder may wrap a `&&` chain of several gates, and it is
 * the final verdict that the evidence file's exit code belongs to. Tokens that
 * are not `key=value` (the gate's own action name, the parenthetical prose
 * `targeted-gate` appends) are dropped rather than guessed at.
 */
function parseGateFacts(output) {
  const lines = output.match(/^GATE_PASSED .*$/gm);
  if (!lines || lines.length === 0) return null;
  const facts = {};
  for (const token of lines[lines.length - 1].split(/\s+/).slice(1)) {
    const match = /^([a-z][\w-]*)=(.*)$/.exec(token);
    if (match) facts[match[1]] = match[2];
  }
  return Object.keys(facts).length > 0 ? facts : null;
}

/** Read recorded evidence back. This is the only thing that says "green". */
function requireGreen() {
  const { config } = phaseConfig();
  const art = artifactRoot();
  const names = list('--names');
  if (names.length === 0) throw new Error('--names is required');
  const problems = [];
  for (const name of names) {
    const file = path.join(art, 'evidence', `${name}.json`);
    if (!existsSync(file)) {
      problems.push(`${name}: never ran`);
      continue;
    }
    let evidence;
    try {
      evidence = readJson(file);
    } catch (error) {
      problems.push(`${name}: unreadable evidence (${error.message})`);
      continue;
    }
    if (evidence.kind !== 'native-delivery-evidence' || evidence.name !== name) {
      problems.push(`${name}: evidence identity does not match`);
      continue;
    }
    const runId = option('--run-id', 'unknown');
    if (evidence.runId !== undefined && evidence.runId !== runId) {
      problems.push(`${name}: stale evidence from run "${evidence.runId}" (current "${runId}")`);
      continue;
    }
    const drift = commandDrift(config, name, evidence);
    if (drift) {
      problems.push(drift);
      continue;
    }
    // Structural gates carry no contract text on their command line, so
    // `commandDrift` cannot see a contract that tightened under a stable
    // command. The coverage stamp can. Checked before the verdict, because the
    // verdict is exactly what the older, narrower contract produced.
    const coverage = coverageDrift(config, name, evidence);
    if (coverage) {
      problems.push(coverage);
      continue;
    }
    if (evidence.verdict !== 'green') {
      const detail = [
        `exit=${evidence.exitCode}`,
        evidence.missingExpected?.length ? `missing=${evidence.missingExpected.join('|')}` : '',
        evidence.forbiddenPresent?.length ? `forbidden=${evidence.forbiddenPresent.join('|')}` : '',
      ]
        .filter(Boolean)
        .join(' ');
      problems.push(`${name}: ${detail}`);
    }
  }
  if (problems.length > 0) {
    fail(`require-green\n  ${problems.join('\n  ')}`);
    return;
  }
  pass(`require-green ${names.join(',')}`);
}

/** Named artifacts must exist and carry real content, not a placeholder. */
function requireArtifacts() {
  const art = artifactRoot();
  const names = list('--names');
  const problems = [];
  for (const name of names) {
    const file = path.join(art, name);
    if (!existsSync(file)) {
      problems.push(`${name}: missing`);
      continue;
    }
    const text = readFileSync(file, 'utf8');
    if (text.trim().length < 200) problems.push(`${name}: too short to be a real artifact`);
    if (text.includes('native-delivery-permission-placeholder'))
      problems.push(`${name}: still a placeholder`);
  }
  if (problems.length > 0) {
    fail(`require-artifacts\n  ${problems.join('\n  ')}`);
    return;
  }
  pass(`require-artifacts ${names.join(',')}`);
}

/**
 * Did the implementation actually land, and did it stay inside its lane?
 * `git status --short` rather than `git diff --quiet`, because a new backend
 * module is an untracked file and `git diff` cannot see it.
 */
function editGate() {
  const { phase, config } = phaseConfig();
  const art = artifactRoot();
  const which = option('--scope', 'all');
  const scope =
    which === 'rust'
      ? config.scope
      : which === 'ts'
        ? (config.tsScope ?? [])
        : [...config.scope, ...(config.tsScope ?? [])];
  const files = changedFiles();
  const inScope = files.filter((file) => withinScope(file, scope));
  const problems = [];

  if (inScope.length === 0) problems.push(`NO_CHANGES under ${scope.join(', ')}`);

  if (which !== 'rust') {
    for (const source of config.requiredSources ?? []) {
      if (!existsSync(source)) problems.push(`required source missing: ${source}`);
    }
    for (const artifact of config.requiredArtifacts ?? []) {
      if (!existsSync(path.join(art, artifact))) problems.push(`required artifact missing: ${artifact}`);
    }
    // Anything outside the declared lane is scope creep, and scope creep in a
    // delivery migration is how double-delivery ships.
    const strays = files.filter((file) => !withinScope(file, allowedPaths(config)));
    if (strays.length > 0) problems.push(`out-of-scope changes: ${strays.slice(0, 20).join(', ')}`);
  }

  writeJson(path.join(art, 'changed-files.json'), files);
  if (problems.length > 0) {
    fail(`edit-gate phase=${phase} scope=${which}\n  ${problems.join('\n  ')}`);
    return;
  }
  pass(
    `edit-gate phase=${phase} scope=${which} files=${inScope.length} ` +
      `coverage=${coverageDigest(config, 'edit-gate')}`
  );
}

/**
 * #1812's selector fails closed: an unmapped runtime path drops the PR into
 * the complete smoke profile. So every new backend file has to be routed by a
 * manifest `location:` in the same change that introduces it, and the phase's
 * declared feature rows have to exist with the criticality the doc requires.
 */
function manifestGate() {
  const { phase, config } = phaseConfig();
  const art = artifactRoot();
  const manifest = parseYaml(readFileSync(MANIFEST, 'utf8'));
  const categories = manifest?.categories ?? {};
  const problems = [];

  const byId = new Map();
  const locations = [];
  for (const [category, value] of Object.entries(categories)) {
    for (const feature of value?.features ?? []) {
      byId.set(feature.id, { ...feature, category, criticality: value.criticality });
      for (const location of String(feature.location ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)) {
        locations.push(location);
      }
    }
  }

  for (const declared of config.features ?? []) {
    const feature = byId.get(declared.id);
    if (!feature) {
      problems.push(`feature not registered: ${declared.id} (expected in category ${declared.category})`);
      continue;
    }
    if (feature.category !== declared.category)
      problems.push(`${declared.id}: category ${feature.category}, expected ${declared.category}`);
    // "Delivery is critical" — the doc's words, enforced.
    if (feature.criticality !== 'critical' && declared.category === 'broker')
      problems.push(
        `${declared.id}: category ${feature.category} is ${feature.criticality}, delivery must be critical`
      );
    if (Number(feature.verify_tier) < Number(declared.verify_tier))
      problems.push(
        `${declared.id}: verify_tier ${feature.verify_tier} is below the required ${declared.verify_tier}`
      );
    for (const wanted of String(declared.location)
      .split(',')
      .map((entry) => entry.trim())) {
      if (!String(feature.location ?? '').includes(wanted))
        problems.push(`${declared.id}: location does not route ${wanted}`);
    }
  }

  // Every changed runtime file in this phase's lane must be routed by some
  // location, or the selector will fall back to the full smoke profile.
  const runtime = changedFiles().filter(
    (file) =>
      withinScope(file, config.scope) || (file.startsWith('packages/') && /\.(ts|tsx|mjs|js)$/.test(file))
  );
  const unrouted = runtime.filter(
    (file) =>
      !locations.some((location) => (location.endsWith('/') ? file.startsWith(location) : location === file))
  );
  if (unrouted.length > 0) problems.push(`unrouted runtime files: ${unrouted.join(', ')}`);

  writeJson(path.join(art, 'manifest-gate.json'), { phase: Number(phase), unrouted, problems });
  if (problems.length > 0) {
    fail(`manifest-gate phase=${phase}\n  ${problems.join('\n  ')}`);
    return;
  }
  pass(
    `manifest-gate phase=${phase} features=${(config.features ?? []).length} ` +
      `coverage=${coverageDigest(config, 'manifest-gate')}`
  );
}

/**
 * Run the real selector over this phase's changed files.
 *
 * The verdict is NOT "mode must be targeted". A PR that registers a new feature
 * must edit `manifest.yaml`, and editing it trips the selector's own self-check
 * (`targeted-pr-plan.mjs:242-259`, `selfCheckChanged`), which forces
 * `full-smoke` unconditionally. Requiring `targeted` would therefore be
 * unsatisfiable for exactly the changes this campaign produces — the first run
 * to reach this gate proved it, with `unmatchedRuntimeFiles: []` and the
 * phase's feature correctly selected.
 *
 * What actually matters is the hazard the migration doc names: an UNMAPPED
 * runtime path. So the gate reads the plan's own fields rather than its mode.
 */
function targetedGate() {
  const { phase, config } = phaseConfig();
  const art = artifactRoot();
  const filesJson = path.join(art, 'changed-files.json');
  const planPath = path.join(art, 'targeted-plan.json');
  writeJson(filesJson, changedFiles());
  try {
    execFileSync('node', [PLANNER, 'plan', '--files-json', filesJson, '--output', planPath], {
      stdio: 'inherit',
    });
  } catch (error) {
    fail(`targeted-gate: planner refused (${error.message})`);
    return;
  }
  const plan = readJson(planPath);
  const problems = [];

  /**
   * The doc's actual requirement: every new PRODUCT runtime file is routed.
   *
   * The campaign's own harness is not a product feature and has no manifest
   * row to earn — registering it would be inventing a feature to silence a
   * check. It is excluded here by the same paths `edit-gate` allows, and
   * nowhere else, so a stray product file still fails.
   */
  // Same set edit-gate allows: campaign tooling is not a product feature and
  // has no manifest row to earn.
  const HARNESS = [
    'scripts/migrate/',
    'flows/migrate/',
    'flows/audit/',
    'scripts/flows/',
    '.review-out/',
    'package.json',
    'vitest.e2e.config.ts',
    '.gitignore',
    // Trail records, for the same reason `edit-gate` allows them: run output,
    // not a product runtime path, and so with no manifest row to earn.
    '.agentworkforce/trajectories/',
    '.trajectories/',
  ];
  const unmatched = (plan.unmatchedRuntimeFiles ?? []).filter(
    (file) => !HARNESS.some((prefix) => file.startsWith(prefix))
  );
  if (unmatched.length > 0) {
    problems.push(`unmapped runtime paths, so every migration PR runs a full smoke: ${unmatched.join(', ')}`);
  }

  // The phase's declared features must be the ones the selector picked up.
  const selected = new Set(plan.selectedFeatures ?? []);
  for (const feature of config.features ?? []) {
    if (!selected.has(feature.id)) problems.push(`selector did not select ${feature.id}`);
  }

  // A full-smoke for any reason OTHER than the manifest self-check is real.
  if (plan.mode === 'full-smoke' && plan.fallbackReason) {
    problems.push(`selector fell back to full-smoke: ${plan.fallbackReason}`);
  }
  if (plan.mode === 'skip') {
    problems.push('selector found nothing to verify, which cannot be right for a delivery change');
  }

  if (problems.length > 0) {
    fail(`targeted-gate phase=${phase}\n  ${problems.join('\n  ')}`);
    return;
  }
  pass(
    `targeted-gate phase=${phase} mode=${plan.mode} features=${[...selected].join(',')} ` +
      `unmapped=0 scenarios=${plan.scenarios.length} coverage=${coverageDigest(config, 'targeted-gate')}` +
      (plan.mode === 'full-smoke' ? ' (full-smoke from the manifest self-check, which is expected)' : '')
  );
}

function seamRules() {
  const { phase, config } = phaseConfig();
  const art = artifactRoot();
  const problems = [];
  const testFiles = invariantTestFiles(config);
  const existingTestFiles = testFiles.filter(existsSync);
  for (const testFile of testFiles) {
    if (!existsSync(testFile)) problems.push(`invariant test file missing: ${testFile}`);
  }
  const invariantSources = existingTestFiles.map((file) => readFileSync(file, 'utf8'));
  for (const invariant of config.invariants ?? []) {
    if (!invariantSources.some((source) => new RegExp(`fn\\s+${invariant}\\s*\\(`).test(source))) {
      problems.push(`invariant test not defined: ${invariant}`);
    }
  }

  for (const rule of config.forbidden ?? []) {
    const dir = rule.where;
    if (!existsSync(dir)) continue;
    for (const file of walk(dir)) {
      const text = readFileSync(file, 'utf8');
      if (text.includes(rule.pattern) && !text.includes(rule.unless))
        problems.push(`${file} touches ${rule.pattern} without ${rule.unless}`);
    }
  }

  for (const symbol of config.untouched ?? []) {
    const diff = execFileSync('git', ['diff', 'HEAD', '--unified=0', '--', 'crates/broker/src/snippets.rs'], {
      encoding: 'utf8',
    });
    if (diff.includes(symbol)) problems.push(`${symbol} is declared out of scope but appears in the diff`);
  }

  /**
   * Wiring: the seam has to be reachable from the real path, not merely
   * compiled. Grep is crude and it is exactly the right crudeness here — the
   * question is "does any file outside this module name the symbol", and a
   * false pass needs someone to write the name somewhere it does nothing.
   */
  for (const rule of config.wiring ?? []) {
    if (rule.from) {
      if (!existsSync(rule.from)) {
        problems.push(`wiring target missing: ${rule.from} must reference ${rule.symbol}`);
      } else if (!readFileSync(rule.from, 'utf8').includes(rule.symbol)) {
        problems.push(
          `${rule.symbol} is never referenced from ${rule.from}: the seam compiles but nothing routes through it`
        );
      }
      continue;
    }
    const callers = walk('crates/broker/src')
      .concat(existsSync('crates/broker/tests') ? walk('crates/broker/tests') : [])
      .filter((file) => file !== rule.outside && file.endsWith('.rs'))
      .filter((file) => readFileSync(file, 'utf8').includes(rule.symbol));
    if (callers.length === 0) {
      problems.push(`${rule.symbol} is defined in ${rule.outside} and referenced nowhere else`);
    }
  }

  /**
   * Mutation scaffolding must not survive the proof that used it.
   *
   * This gate exists because it already happened. The campaign requires a
   * mutation transcript — mutate the guarded code, watch the test fail, restore
   * it — and an implementation did the first two steps and skipped the third,
   * leaving this on a LIVE delivery path in shipping code:
   *
   *   // MUTATION: drop the addressee and truncate the body.
   *   if std::env::var("RELAY_MUTATION_LOSSY_FORMAT").is_ok() {
   *       return format!("Relay message from {}:\n\n{}", delivery.from, &delivery.body[..1]);
   *   }
   *
   * `&body[..1]` panics on a multi-byte first character. Every deterministic
   * gate in this campaign passed it; only the adversarial reviewer caught it
   * (claude-review-1, F1).
   *
   * A requirement that induces a hazard has to gate the hazard too.
   */
  const mutationResidue = [];
  for (const dir of ['crates/broker/src', 'crates/relay-pty/src']) {
    if (!existsSync(dir)) continue;
    for (const file of walk(dir).filter((entry) => entry.endsWith('.rs'))) {
      const text = readFileSync(file, 'utf8');
      for (const [index, line] of text.split('\n').entries()) {
        if (/RELAY_MUTATION|^\s*\/\/\s*MUTATION\b/.test(line)) {
          mutationResidue.push(`${file}:${index + 1}: ${line.trim().slice(0, 90)}`);
        }
      }
    }
  }
  if (mutationResidue.length > 0) {
    problems.push(
      `mutation scaffolding left in product source — restore the code after proving the test bites:\n    ` +
        mutationResidue.join('\n    ')
    );
  }

  // The standing order in this repo: a test that cannot fail is not evidence.
  const mutation = path.join(art, 'evidence', 'mutation-proof.md');
  if (!existsSync(mutation)) {
    problems.push(
      'evidence/mutation-proof.md missing: mutate the guarded code and paste the failing transcript'
    );
  } else {
    const text = readFileSync(mutation, 'utf8');
    for (const invariant of config.invariants ?? []) {
      const index = text.indexOf(invariant);
      if (index === -1) {
        problems.push(`mutation-proof.md does not name invariant: ${invariant}`);
        continue;
      }
      const nextIndex = (config.invariants ?? [])
        .filter((candidate) => candidate !== invariant)
        .map((candidate) => text.indexOf(candidate, index + invariant.length))
        .filter((candidateIndex) => candidateIndex !== -1)
        .sort((a, b) => a - b)[0];
      const section = text.slice(index, nextIndex ?? text.length);
      if (!/FAILED|panicked|assertion .*failed|test result: FAILED/.test(section)) {
        problems.push(`mutation-proof.md has no failing transcript for invariant: ${invariant}`);
      }
    }
  }
  problems.push(...mutationFreshnessProblems(config, art));

  if (problems.length > 0) {
    fail(`seam-rules phase=${phase}\n  ${problems.join('\n  ')}`);
    return;
  }
  pass(
    `seam-rules phase=${phase} invariants=${(config.invariants ?? []).length} ` +
      `coverage=${coverageDigest(config, 'seam-rules')}`
  );
}

/**
 * A mutation transcript is only evidence about the tree it was recorded
 * against.
 *
 * The prose check above asks whether each invariant has a transcript that
 * FAILED. It cannot ask WHEN, so a transcript recorded before a later repair
 * round rewrote the very code the invariant guards still satisfies it. That
 * happened in phase 1: the codex-route transcripts panicked at
 * `codex_queue.rs:465/503/546` while the shipped expectations sat ~76 lines
 * lower, because the fix round after them changed queue capability resolution,
 * the probe's argv and the PTY fallback predicate. Every deterministic gate
 * passed anyway, which is exactly the failure mode `coverageDrift` already
 * guards for the structural gates.
 *
 * So the proof has to carry a digest of what it proved. `mutation-proof.json`
 * declares, per invariant, the source files that invariant guards and the
 * sha256 each of those files had when the transcript was recorded. This gate
 * recomputes them. A guarded file that has changed since invalidates its
 * transcripts and the mutation must be re-run — a content digest, not a
 * timestamp, so it survives a checkout and cannot be satisfied by `touch`.
 */
function mutationFreshnessProblems(config, art) {
  const problems = [];
  const manifestPath = path.join(art, 'evidence', 'mutation-proof.json');
  if (!existsSync(manifestPath)) {
    return [
      'evidence/mutation-proof.json missing: the mutation proof must declare, per invariant, ' +
        'which sources it guards and their sha256 at recording time',
    ];
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    return [`evidence/mutation-proof.json is not valid JSON: ${error.message}`];
  }
  const entries = new Map(
    (manifest.invariants ?? []).map((entry) => [entry.name, entry])
  );
  const digests = manifest.sources ?? {};
  const actual = new Map();
  const digestOf = (file) => {
    if (!actual.has(file)) {
      actual.set(
        file,
        existsSync(file)
          ? createHash('sha256').update(readFileSync(file)).digest('hex')
          : null
      );
    }
    return actual.get(file);
  };

  for (const invariant of config.invariants ?? []) {
    const entry = entries.get(invariant);
    if (!entry) {
      problems.push(`mutation-proof.json does not cover invariant: ${invariant}`);
      continue;
    }
    const guards = entry.guards ?? [];
    if (guards.length === 0) {
      problems.push(`mutation-proof.json declares no guarded source for invariant: ${invariant}`);
    }
    const transcript = path.join(art, 'evidence', entry.transcript ?? '');
    if (!entry.transcript || !existsSync(transcript)) {
      problems.push(`mutation transcript missing for invariant ${invariant}: ${entry.transcript}`);
    } else if (
      !/FAILED|panicked|assertion .*failed/.test(readFileSync(transcript, 'utf8'))
    ) {
      problems.push(
        `mutation transcript for ${invariant} records no failure: ${entry.transcript}`
      );
    }
    for (const file of guards) {
      const recorded = digests[file];
      if (!recorded) {
        problems.push(
          `mutation-proof.json records no digest for ${file}, guarded by ${invariant}`
        );
        continue;
      }
      const current = digestOf(file);
      if (current === null) {
        problems.push(`guarded source missing: ${file} (declared by ${invariant})`);
      } else if (current !== recorded) {
        problems.push(
          `mutation evidence is stale: ${file} changed since the transcript for ${invariant} ` +
            `was recorded (recorded ${recorded.slice(0, 12)}, now ${current.slice(0, 12)}) — re-run the mutation`
        );
      }
    }
  }
  return problems;
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/**
 * The gate the doc says does not exist yet: a scenario that delivers into a
 * session relay did not launch. Without it there is no proof of the thing the
 * migration is for, so it is a first-class gate rather than a nice-to-have.
 */
/**
 * Typecheck the unlaunched suite whether or not this phase has to RUN it.
 *
 * The suite was authored after the phase's `ts-typecheck` had already run, is
 * excluded from `vitest.e2e.config.ts` (so `npm run test:e2e` never loads it),
 * and sits outside the root tsconfig's empty `include`. Nothing compiled it,
 * and it did not compile: `session-host.ts` cast a child spawned with
 * `stdio: ['ignore', ...]` to `ChildProcessWithoutNullStreams`, which promises
 * a writable stdin it does not have.
 *
 * A phase that declares `unlaunched: false` still ships these files, so the
 * gate checks that they are valid TypeScript even when it does not require
 * them to execute. Otherwise "not-required" silently means "unchecked", and
 * the suite rots until the phase that needs it discovers it never built.
 */
function typecheckUnlaunchedSuite() {
  const dir = path.join('tests', 'e2e', 'unlaunched');
  if (!existsSync(dir)) return null;
  const files = walk(dir).filter((file) => file.endsWith('.ts'));
  if (files.length === 0) return null;
  try {
    execFileSync(
      'npx',
      [
        'tsc',
        '--noEmit',
        '--skipLibCheck',
        '--strict',
        '--module',
        'esnext',
        '--target',
        'es2022',
        '--moduleResolution',
        'bundler',
        ...files,
      ],
      { encoding: 'utf8', stdio: 'pipe' }
    );
    return { ok: true, files: files.length };
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim();
    return { ok: false, files: files.length, output };
  }
}

function unlaunchedGate() {
  const { phase, config } = phaseConfig();
  const typecheck = typecheckUnlaunchedSuite();
  if (typecheck && !typecheck.ok) {
    fail(
      `unlaunched-gate phase=${phase} the unlaunched suite does not typecheck\n  ${typecheck.output
        .split('\n')
        .slice(0, 12)
        .join('\n  ')}`
    );
    return;
  }
  const checked = typecheck ? ` typechecked=${typecheck.files}` : '';
  if (!config.unlaunched) {
    pass(
      `unlaunched-gate phase=${phase} not-required${checked} ` +
        `coverage=${coverageDigest(config, 'unlaunched-gate')}`
    );
    return;
  }
  const matrix = readJson(MATRIX);
  const problems = [];
  const smokeLanes = new Set(matrix.profiles?.smoke?.lanes ?? []);
  for (const cli of config.unlaunched) {
    const id = `unlaunched-${cli}-delivery`;
    const lane = (matrix.lanes ?? []).find((candidate) =>
      (candidate.scenarios ?? []).some((scenario) => scenario.id === id)
    );
    if (!lane) {
      problems.push(`scenario missing from ${MATRIX}: ${id}`);
      continue;
    }
    const scenario = lane.scenarios.find((candidate) => candidate.id === id);
    if (!smokeLanes.has(lane.id))
      problems.push(`${id} sits in lane ${lane.id}, which is not in the smoke profile`);
    if (scenario.kind === 'coverage-gap')
      problems.push(`${id} is still declared a coverage-gap, not an executable scenario`);
    if (scenario.evidence !== 'integration')
      problems.push(`${id} evidence is ${scenario.evidence}, must be integration`);
    if (!Array.isArray(scenario.command) || scenario.command.length === 0)
      problems.push(`${id} has no command`);
    const forbidden = new Set(scenario.forbidOutput ?? []);
    for (const marker of ['# SKIP', 'skipped', 'SKIP', 'no tests']) {
      if (!forbidden.has(marker))
        problems.push(`${id} must forbid "${marker}" so a skipped or empty test run cannot read as a pass`);
    }
  }
  if (problems.length > 0) {
    fail(`unlaunched-gate phase=${phase}\n  ${problems.join('\n  ')}`);
    return;
  }
  pass(
    `unlaunched-gate phase=${phase} clis=${config.unlaunched.join(',')}${checked} ` +
      `coverage=${coverageDigest(config, 'unlaunched-gate')}`
  );
}

/** Hash every artifact so a reviewer reviews a fixed set, not a moving one. */
function seal() {
  const { phase } = phaseConfig();
  const art = artifactRoot();
  const label = option('--label', 'final');
  const files = walk(art)
    .filter((file) => !file.endsWith(`seal-${label}.json`))
    .sort();
  const entries = files.map((file) => {
    const contents = readFileSync(file);
    return {
      path: path.relative(art, file),
      bytes: contents.byteLength,
      sha256: createHash('sha256').update(contents).digest('hex'),
    };
  });
  /**
   * Hash the PRODUCT tree too, not just the evidence directory.
   *
   * Sealing only the artifacts means a reviewer signs off on a digest of
   * evidence FILES, while the source those files describe can change
   * afterwards without disturbing the digest. Raised as a valid finding
   * against this harness by codex-fix-1 (F7/F2): "the seal implementation
   * still hashes artifact files rather than recomputing and hashing every
   * changed product path immediately before acceptance."
   *
   * Computed at seal time from the live tree, so `artifactSetSha256` now
   * changes if either the evidence or the code moves.
   */
  const sourceEntries = changedFiles().flatMap((file) => {
    try {
      const contents = readFileSync(file);
      return [
        {
          path: file,
          bytes: contents.byteLength,
          sha256: createHash('sha256').update(contents).digest('hex'),
        },
      ];
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'EISDIR')) {
        return [];
      }
      throw error;
    }
  });
  const setDigest = createHash('sha256')
    .update([...entries, ...sourceEntries].map((entry) => `${entry.path}:${entry.sha256}`).join('\n'))
    .digest('hex');
  writeJson(path.join(art, `seal-${label}.json`), {
    schemaVersion: 1,
    kind: 'native-delivery-seal',
    phase: Number(phase),
    label,
    sealedAt: new Date().toISOString(),
    headSha: git(['rev-parse', 'HEAD']),
    artifactSetSha256: setDigest,
    entries,
    sourceEntries,
  });
  pass(`seal label=${label} digest=${setDigest} artifacts=${entries.length} source=${sourceEntries.length}`);
}

/**
 * Final acceptance. Recomputed from evidence and signoffs, never from a
 * summary. This is the step that decides whether a commit is allowed.
 */
function accept() {
  const { phase, config } = phaseConfig();
  const art = artifactRoot();
  const problems = [];

  if (existsSync(path.join(art, 'BLOCKED_NO_COMMIT.md'))) problems.push('BLOCKED_NO_COMMIT.md is present');

  /**
   * Say so, loudly, when the campaign's own harness changed during the run.
   *
   * `scripts/migrate/` is in edit-gate's allowed set because it IS campaign
   * tooling, and that has already paid off once: an agent found that the
   * mutation-proof check accepted a single failing transcript for any one
   * invariant and tightened it to require one per invariant. A real hole,
   * correctly closed.
   *
   * The same door lets a gate be WEAKENED to pass, which would be far worse and
   * would look identical from inside the run. This does not forbid the edit —
   * forbidding it would have cost the fix above — it records it, so a harness
   * change reaches the acceptance record and the signoff reviewers instead of
   * passing silently. The seal already hashes these files; this names them.
   */
  const harnessChanged = changedFiles().filter(
    (file) => file.startsWith('scripts/migrate/') || file.startsWith('flows/migrate/')
  );
  if (harnessChanged.length > 0) {
    process.stdout.write(
      `HARNESS_MODIFIED during this campaign: ${harnessChanged.join(', ')}\n` +
        '  Review these as carefully as product code: a gate edited to pass is indistinguishable\n' +
        '  from a gate edited to be correct, from inside the run.\n'
    );
  }

  const required = [
    'rust-fmt',
    'rust-clippy',
    'rust-build',
    'invariant-tests',
    'ts-typecheck',
    'unit-tests',
    ...(config.parity ?? []),
    ...Object.keys(config.evals ?? {}),
    ...Object.keys(config.e2e ?? {}),
    ...(Array.isArray(config.unlaunched) ? config.unlaunched.map((cli) => `unlaunched-${cli}-delivery`) : []),
  ].filter((name) => (config.rust ? true : !name.startsWith('rust-')));
  const runId = option('--run-id', 'unknown');

  for (const name of required) {
    const file = path.join(art, 'evidence', `${name}.json`);
    if (!existsSync(file)) {
      problems.push(`evidence missing: ${name}`);
      continue;
    }
    const evidence = readJson(file);
    if (evidence.runId !== undefined && evidence.runId !== runId)
      problems.push(`${name}: stale evidence from run "${evidence.runId}" (current "${runId}")`);
    // A green recorded under a command the contract no longer names is not
    // evidence for this contract. Checked before the verdict, because the
    // verdict is exactly the thing the weaker command produced.
    const drift = commandDrift(config, name, evidence);
    if (drift) {
      problems.push(drift);
      continue;
    }
    const coverage = coverageDrift(config, name, evidence);
    if (coverage) {
      problems.push(coverage);
      continue;
    }
    if (name === 'unit-tests') {
      // The workflow deliberately accepts the repo's declared, unreachable
      // baseline through `regression-gate`; acceptance must apply the same
      // policy or every otherwise-valid run becomes unshippable at the last
      // step solely because the evidence JSON truthfully remains red.
      const { unexplained, malformed } = classifyRegressionEvidence(evidence);
      if (malformed) problems.push(`${name}: ${malformed}`);
      else if (unexplained.length > 0)
        problems.push(`${name}: ${unexplained.length} failure(s) outside the known-failure baseline`);
    } else if (evidence.verdict !== 'green') {
      problems.push(`evidence red: ${name} (exit ${evidence.exitCode})`);
    }
  }

  /**
   * The final structural gates, validated against the contract AS IT STANDS
   * NOW rather than on the green bit alone.
   *
   * Earned by codex-review-2 F1. Acceptance used to check existence, run id
   * and `verdict === 'green'`, none of which move when the contract tightens
   * under an unchanged command line — so `seam-rules-final.json` carried a
   * green whose own tail read `invariants=12` while the contract declared 15,
   * and acceptance took it. `coverageDrift` recomputes the digest of the
   * contract text each gate reads and rejects a verdict recorded against a
   * different one; the missing `commandSha256` is the same staleness by an
   * older shape, since `record` has stamped one on every file it writes since
   * codex-review-1 F2.
   */
  for (const action of STRUCTURAL_GATE_ACTIONS) {
    const name = `${action}-final`;
    const file = path.join(art, 'evidence', `${name}.json`);
    if (!existsSync(file)) {
      problems.push(`final gate never ran: ${action}`);
      continue;
    }
    const evidence = readJson(file);
    if (evidence.runId !== undefined && evidence.runId !== runId)
      problems.push(`${action}: stale final evidence from run "${evidence.runId}" (current "${runId}")`);
    if (typeof evidence.commandSha256 !== 'string')
      problems.push(`${action}: final evidence predates the command digest — re-record it`);
    const coverage = coverageDrift(config, name, evidence);
    if (coverage) problems.push(coverage);
    if (evidence.verdict !== 'green') problems.push(`final gate red: ${action}`);
  }

  for (const provider of ['claude', 'codex']) {
    const file = path.join(art, 'reviews', `signoff-${provider}.json`);
    if (!existsSync(file)) {
      problems.push(`missing adversarial signoff: ${provider}`);
      continue;
    }
    let signoff;
    try {
      signoff = readJson(file);
    } catch (error) {
      problems.push(`${provider} signoff is not valid JSON (${error.message})`);
      continue;
    }
    if (signoff.kind !== 'native-delivery-signoff') problems.push(`${provider} signoff identity is wrong`);
    if (signoff.verdict !== 'pass') problems.push(`${provider} signoff verdict is ${signoff.verdict}`);
    if (Array.isArray(signoff.findings) && signoff.findings.length > 0)
      problems.push(`${provider} signoff passes while carrying ${signoff.findings.length} findings`);
    // The reviewer must have reviewed the sealed set, not an earlier one.
    const sealFile = path.join(art, 'seal-final.json');
    if (existsSync(sealFile) && signoff.artifactSetSha256 !== readJson(sealFile).artifactSetSha256)
      problems.push(`${provider} signoff cites a different artifact set than seal-final.json`);
  }

  writeJson(path.join(art, 'acceptance.json'), {
    schemaVersion: 1,
    kind: 'native-delivery-acceptance',
    phase: Number(phase),
    verdict: problems.length === 0 ? 'pass' : 'blocked',
    problems,
    decidedAt: new Date().toISOString(),
  });
  if (problems.length > 0) {
    fail(`accept phase=${phase}\n  ${problems.join('\n  ')}`);
    return;
  }
  pass(`accept phase=${phase}`);
}

/**
 * Commit only on recomputed green. A red acceptance writes BLOCKED_NO_COMMIT.md
 * and exits 0: a handled blocked state, not a crashed workflow.
 *
 * Push and PR are opt-in (`NATIVE_DELIVERY_PUSH=1`) and never target main.
 */
function commitIfGreen() {
  const { phase, config } = phaseConfig();
  const art = artifactRoot();
  accept();
  const acceptance = readJson(path.join(art, 'acceptance.json'));
  if (acceptance.verdict !== 'pass') {
    writeFileSync(
      path.join(art, 'BLOCKED_NO_COMMIT.md'),
      `# Blocked, no commit\n\nphase: ${phase} (${config.slug})\n\n` +
        acceptance.problems.map((problem) => `- ${problem}`).join('\n') +
        '\n'
    );
    process.exitCode = 0;
    process.stdout.write(`BLOCKED_NO_COMMIT phase=${phase} problems=${acceptance.problems.length}\n`);
    return;
  }
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch === 'main' || branch === 'master') {
    fail('refusing to commit on main');
    return;
  }
  /**
   * Stage what `edit-gate` approved, not a narrower list. The declared lane
   * goes in as path prefixes (they exist whether or not anything under them
   * changed); everything else is named file by file from the change set, so no
   * pathspec can fail to match. `.workflow-artifacts/` is evidence, not source,
   * and stays out of the commit.
   */
  const lane = [...config.scope, ...(config.tsScope ?? [])];
  const alsoAllowed = changedFiles().filter(
    (file) =>
      !withinScope(file, lane) &&
      !file.startsWith('.workflow-artifacts/') &&
      withinScope(file, allowedPaths(config))
  );
  execFileSync('git', ['add', '--', ...lane, ...alsoAllowed], { stdio: 'inherit' });
  const subject = `feat(delivery): phase ${phase} — ${config.title}`;
  execFileSync(
    'git',
    [
      'commit',
      '-m',
      subject,
      '-m',
      `Exit criterion: ${config.exit}\n\nEvidence: ${path.relative(process.cwd(), art)}`,
      '-m',
      'Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>',
    ],
    { stdio: 'inherit' }
  );
  if (process.env.NATIVE_DELIVERY_PUSH === '1') {
    execFileSync('git', ['push', '-u', 'origin', branch], { stdio: 'inherit' });
  }
  pass(`commit-if-green phase=${phase} branch=${branch} pushed=${process.env.NATIVE_DELIVERY_PUSH === '1'}`);
}

const ACTIONS = {
  preflight,
  contract,
  record,
  'require-green': requireGreen,
  'regression-gate': regressionGate,
  'require-artifacts': requireArtifacts,
  'edit-gate': editGate,
  'manifest-gate': manifestGate,
  'targeted-gate': targetedGate,
  'seam-rules': seamRules,
  'unlaunched-gate': unlaunchedGate,
  seal,
  accept,
  'commit-if-green': commitIfGreen,
};

async function main() {
  const action = process.argv[2];
  const handler = ACTIONS[action];
  if (!handler) throw new Error(`usage: native-delivery-gates.mjs <${Object.keys(ACTIONS).join('|')}>`);
  await handler();
}

if (process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`) {
  main().catch((error) => {
    process.stderr.write(`GATE_ERROR ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 2;
  });
}
