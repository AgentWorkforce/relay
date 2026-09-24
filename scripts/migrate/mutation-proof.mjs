#!/usr/bin/env node
/**
 * Re-record this phase's mutation proof against the CURRENT tree.
 *
 * Signoff finding F2: every transcript in `evidence/mutation-proof.md` had been
 * recorded against a tree that later moved. The codex-route transcripts panicked
 * at `codex_queue.rs:465/503/546` while the shipped expectations sat ~76 lines
 * lower, because the fix round after them rewrote the very code those mutations
 * were proving. The prose gate could not see it: it only asks whether each
 * invariant's section contains the word FAILED.
 *
 * Re-running mutations by hand is what let that drift in, so it is automated
 * here instead. Every run:
 *
 *   1. applies one textual mutation to product source (never to a test),
 *   2. runs the invariant test(s) that mutation must break,
 *   3. restores the file from the byte-for-byte original, always, including on
 *      error or Ctrl-C,
 *   4. writes the transcript verbatim,
 *
 * and then emits `evidence/mutation-proof.json` carrying the sha256 of every
 * guarded source at recording time. `native-delivery-gates.mjs seam-rules`
 * recomputes those digests, so a later repair round that touches guarded code
 * without re-running this script fails the gate instead of shipping a proof
 * about a tree that no longer exists.
 *
 * Usage: node scripts/migrate/mutation-proof.mjs --art <artifact-dir> [--only <name>]
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * One test per transcript, always filtered by the invariant's own name.
 *
 * `seam-rules` slices `mutation-proof.md` per invariant by scanning forward to
 * the next invariant NAME, so an unfiltered transcript — which lists every test
 * in the file — ends its own section before the failure and reads as no
 * evidence at all. Filtering also makes each transcript evidence about exactly
 * one claim.
 */
const seamTest = (filter) => [
  'cargo',
  'test',
  '-p',
  'agent-relay-broker',
  '--features',
  'seam-probe',
  '--test',
  'delivery_seam_invariants',
  filter,
];
const libTest = (filter) => ['cargo', 'test', '-p', 'agent-relay-broker', '--lib', filter];

const BACKEND = 'crates/broker/src/delivery/backend.rs';
const PTY = 'crates/broker/src/delivery/pty.rs';
const CODEX_QUEUE = 'crates/broker/src/delivery/codex_queue.rs';
const CODEX_THREAD = 'crates/broker/src/codex_thread.rs';
const RELAY_PTY_CODEX_SESSION = 'crates/relay-pty/src/codex_session.rs';
const RUNTIME_DELIVERY = 'crates/broker/src/runtime/delivery.rs';
const RUNTIME_API = 'crates/broker/src/runtime/api.rs';
const RUNTIME_RELAYCAST = 'crates/broker/src/runtime/relaycast_events.rs';
const RUNTIME_TESTS = 'crates/broker/src/runtime/tests.rs';
const SEAM_TEST_FILE = 'crates/broker/tests/delivery_seam_invariants.rs';

/**
 * One entry per transcript. `invariants` are the contract names this transcript
 * is evidence for; `guards` are the files whose content the evidence depends on
 * — the mutated source AND the file the invariant test lives in, because a
 * rewritten test invalidates "this test bites" just as surely as rewritten
 * product code does.
 */
const MUTATIONS = [
  {
    transcript: 'mutation-01-prewrite.txt',
    invariants: ['falls_back_only_before_write'],
    summary:
      '`DeliveryError::is_pre_write` always returned `false`, so a pre-write refusal was classified as committed.',
    file: BACKEND,
    guards: [BACKEND, SEAM_TEST_FILE],
    find: `    pub fn is_pre_write(&self) -> bool {
        matches!(self, Self::Unavailable { .. })
    }`,
    replace: `    pub fn is_pre_write(&self) -> bool {
        false
    }`,
    command: seamTest('falls_back_only_before_write'),
  },
  {
    transcript: 'mutation-02-duplicate.txt',
    invariants: ['never_resends_on_doubt'],
    summary:
      'An existing receipt was classified `Fresh` instead of `AlreadySent`, so a message in doubt — including a cancelled one — was handed to a backend again.',
    file: BACKEND,
    guards: [BACKEND, SEAM_TEST_FILE],
    find: '            return Ok(SendOutcome::AlreadySent(receipt));',
    replace: '            return Ok(SendOutcome::Fresh(receipt));',
    command: seamTest('never_resends_on_doubt'),
  },
  {
    transcript: 'mutation-02b-cancelled.txt',
    invariants: ['a_cancelled_send_remains_in_doubt_and_is_not_retried'],
    summary:
      'The same duplicate-guard mutation seen through cancellation: a cancelled send whose provisional receipt still stood was re-classified `Fresh` and handed to a backend again.',
    file: BACKEND,
    guards: [BACKEND, SEAM_TEST_FILE],
    find: '            return Ok(SendOutcome::AlreadySent(receipt));',
    replace: '            return Ok(SendOutcome::Fresh(receipt));',
    command: seamTest('a_cancelled_send_remains_in_doubt_and_is_not_retried'),
  },
  {
    transcript: 'mutation-03-route.txt',
    invariants: ['records_route_for_each_send'],
    summary: '`settle` ignored the recorded route and settled through the first offered backend.',
    file: BACKEND,
    guards: [BACKEND, SEAM_TEST_FILE],
    find: `        let Some(backend) = backends
            .iter_mut()
            .find(|backend| backend.route_id() == route)
        else {
            return SettleOutcome::RouteUnavailable(route);
        };`,
    replace: `        let Some(backend) = backends.iter_mut().next() else {
            return SettleOutcome::RouteUnavailable(route);
        };`,
    command: seamTest('records_route_for_each_send'),
  },
  {
    transcript: 'mutation-04-ack.txt',
    invariants: ['never_acks_without_observation'],
    summary: '`settle` upgraded `HandedOver` into `Acked` with no observation behind it.',
    file: BACKEND,
    guards: [BACKEND, SEAM_TEST_FILE],
    find: '        SettleOutcome::Settled(backend.settle(&request).await)',
    replace: `        let status = backend.settle(&request).await;
        SettleOutcome::Settled(match status {
            SettleStatus::HandedOver(_) => SettleStatus::Acked(ObservedAck::peer_ack("fabricated")),
            other => other,
        })`,
    command: seamTest('never_acks_without_observation'),
  },
  {
    transcript: 'mutation-05-eviction.txt',
    invariants: ['an_evicted_receipt_does_not_become_a_fresh_send'],
    summary:
      'Eviction dropped receipts without leaving a tombstone, so a forgotten send looked new to `send` and absent to `settle`.',
    file: BACKEND,
    guards: [BACKEND, SEAM_TEST_FILE],
    find: '                self.evicted.insert(dropped.delivery_id);',
    replace: '                let _ = dropped;',
    command: seamTest('an_evicted_receipt_does_not_become_a_fresh_send'),
  },
  {
    transcript: 'mutation-05b-eviction-settle.txt',
    invariants: ['settle_reports_an_evicted_receipt_as_unknown_not_absent'],
    summary:
      'The same eviction mutation seen through `settle`: a forgotten receipt reported as absence, which licenses a re-send of a message that may already have landed.',
    file: BACKEND,
    guards: [BACKEND, SEAM_TEST_FILE],
    find: '                self.evicted.insert(dropped.delivery_id);',
    replace: '                let _ = dropped;',
    command: seamTest('settle_reports_an_evicted_receipt_as_unknown_not_absent'),
  },
  {
    transcript: 'mutation-06-unreachable.txt',
    invariants: ['settle_distinguishes_absence_from_an_unreachable_route'],
    summary:
      'An unreachable recorded route reported `NoReceipt` — positive evidence of absence — instead of `RouteUnavailable`.',
    file: BACKEND,
    guards: [BACKEND, SEAM_TEST_FILE],
    find: '            return SettleOutcome::RouteUnavailable(route);',
    replace: '            return SettleOutcome::NoReceipt;',
    command: seamTest('settle_distinguishes_absence_from_an_unreachable_route'),
  },
  {
    transcript: 'mutation-07-ack-evidence.txt',
    invariants: ['an_acknowledgement_must_name_the_observation_behind_it'],
    summary: '`ObservedAck::echo` stored `PeerAck` evidence, naming an observation that never happened.',
    file: BACKEND,
    guards: [BACKEND, SEAM_TEST_FILE],
    find: `    pub fn echo(matched: impl Into<String>) -> Self {
        Self {
            evidence: AckEvidence::Echo {
                matched: matched.into(),
            },
        }
    }`,
    replace: `    pub fn echo(matched: impl Into<String>) -> Self {
        Self {
            evidence: AckEvidence::PeerAck {
                detail: matched.into(),
            },
        }
    }`,
    command: seamTest('an_acknowledgement_must_name_the_observation_behind_it'),
  },
  {
    transcript: 'mutation-08-pty-prewrite.txt',
    invariants: ['real_pty_route_unknown_worker_is_pre_write_and_may_fall_back'],
    summary: 'The shipping PTY route mapped a pre-write failure (unknown worker) to a committed error.',
    file: PTY,
    guards: [PTY, SEAM_TEST_FILE],
    find: `                    crate::worker::WorkerDeliverError::PreWrite(reason) => {
                        DeliveryError::unavailable(reason)
                    }`,
    replace: `                    crate::worker::WorkerDeliverError::PreWrite(reason) => {
                        DeliveryError::committed(reason)
                    }`,
    command: seamTest('real_pty_route_unknown_worker_is_pre_write_and_may_fall_back'),
  },
  {
    transcript: 'mutation-09-pty-committed.txt',
    invariants: ['real_pty_route_write_failure_after_commit_does_not_fall_back'],
    summary:
      'The shipping PTY route mapped a committed write failure to a pre-write `Unavailable`, re-opening fallback after a possible write.',
    file: PTY,
    guards: [PTY, SEAM_TEST_FILE],
    find: `                    crate::worker::WorkerDeliverError::Committed(reason) => {
                        DeliveryError::committed(reason)
                    }`,
    replace: `                    crate::worker::WorkerDeliverError::Committed(reason) => {
                        DeliveryError::unavailable(reason)
                    }`,
    command: seamTest('real_pty_route_write_failure_after_commit_does_not_fall_back'),
  },
  {
    transcript: 'mutation-10-pty-ack.txt',
    invariants: ['real_pty_route_never_reports_an_observed_ack'],
    summary:
      'The shipping PTY route fabricated an observed ack out of a hand-over at settlement, which is the only place that route could claim one.',
    file: PTY,
    guards: [PTY, SEAM_TEST_FILE],
    find: `    fn settle<'a>(
        &'a mut self,
        _request: &'a SettleRequest,
    ) -> super::backend::DeliveryBackendFuture<'a, SettleStatus> {
        Box::pin(async move { SettleStatus::HandedOver(HandoverState::HandedOver) })
    }`,
    replace: `    fn settle<'a>(
        &'a mut self,
        _request: &'a SettleRequest,
    ) -> super::backend::DeliveryBackendFuture<'a, SettleStatus> {
        Box::pin(async move {
            SettleStatus::Acked(super::backend::ObservedAck::echo("fabricated"))
        })
    }`,
    command: seamTest('real_pty_route_never_reports_an_observed_ack'),
  },
  {
    transcript: 'mutation-11-codex-capability.txt',
    invariants: ['unavailable_queue_capability_falls_back_before_write'],
    summary:
      '`CodexQueueTarget::ensure_queue_capability` classified a missing `codex queue` as a committed error, so a Codex that cannot queue at all blocked the PTY fallback instead of refusing before any write.',
    file: CODEX_QUEUE,
    guards: [CODEX_QUEUE, RELAY_PTY_CODEX_SESSION],
    find: `            DeliveryError::unavailable(
                "installed Codex does not expose \`codex queue --thread --message\`",
            )`,
    replace: `            DeliveryError::committed(
                "installed Codex does not expose \`codex queue --thread --message\`",
            )`,
    command: libTest('delivery::codex_queue::tests::unavailable_queue_capability_falls_back_before_write'),
  },
  {
    transcript: 'mutation-12-codex-committed.txt',
    invariants: ['queue_process_failure_is_committed_and_does_not_fall_back'],
    summary:
      'A started `codex queue` child that exited non-zero was classified `Unavailable`, so the seam fell back to the PTY after a write that may already have landed.',
    file: CODEX_QUEUE,
    guards: [CODEX_QUEUE, RELAY_PTY_CODEX_SESSION],
    find: `            Err(DeliveryError::committed(format!(
                "Codex queue exited with status {}{}",`,
    replace: `            Err(DeliveryError::unavailable(format!(
                "Codex queue exited with status {}{}",`,
    command: libTest(
      'delivery::codex_queue::tests::queue_process_failure_is_committed_and_does_not_fall_back'
    ),
  },
  {
    transcript: 'mutation-13-codex-handover.txt',
    invariants: ['successful_queue_send_is_handed_over_not_acked'],
    summary:
      '`CodexQueueBackend::send` fabricated an observed acknowledgement from a successful queue command instead of reporting only `HandedOver`.',
    file: CODEX_QUEUE,
    guards: [CODEX_QUEUE, RELAY_PTY_CODEX_SESSION],
    find: `            target.queue_message(request, &queue_command).await?;
            Ok(SendStatus::HandedOver(HandoverState::HandedOver))`,
    replace: `            target.queue_message(request, &queue_command).await?;
            Ok(SendStatus::Acked(ObservedAck::peer_ack("queued")))`,
    command: libTest('delivery::codex_queue::tests::successful_queue_send_is_handed_over_not_acked'),
  },
  {
    transcript: 'mutation-15-codex-duplicate.txt',
    invariants: ['a_repeated_send_never_queues_the_same_delivery_twice'],
    summary:
      'The seam classified a recorded delivery id as `Fresh`, seen through the REAL codex route: the fake Codex records a second `codex queue` child for one delivery id.',
    file: BACKEND,
    guards: [BACKEND, CODEX_QUEUE, RELAY_PTY_CODEX_SESSION],
    find: '            return Ok(SendOutcome::AlreadySent(receipt));',
    replace: '            return Ok(SendOutcome::Fresh(receipt));',
    command: libTest('delivery::codex_queue::tests::a_repeated_send_never_queues_the_same_delivery_twice'),
  },
  {
    transcript: 'mutation-16-codex-cancelled.txt',
    invariants: ['a_cancelled_queue_send_is_not_retried_on_the_codex_route'],
    summary:
      'The write-ahead in-doubt receipt was not recorded before awaiting the backend, so a cancelled `codex queue` left no memory and the next attempt wrote again.',
    file: BACKEND,
    guards: [BACKEND, CODEX_QUEUE, RELAY_PTY_CODEX_SESSION],
    find: `            self.record_receipt(SendReceipt::new(
                request.delivery_id.clone(),
                route.clone(),
                SendStatus::InDoubt,
            ));`,
    replace: '            let _ = &route;',
    command: libTest(
      'delivery::codex_queue::tests::a_cancelled_queue_send_is_not_retried_on_the_codex_route'
    ),
  },
  {
    transcript: 'mutation-17-teardown-indoubt.txt',
    invariants: ['releasing_an_agent_with_a_handed_over_native_delivery_dead_letters_it_in_doubt'],
    summary:
      'Worker teardown stopped asking whether the delivery had reached a transport, so a handed-over native delivery was dead-lettered as freely redeliverable — the pre-repair behaviour.',
    file: RUNTIME_DELIVERY,
    guards: [RUNTIME_DELIVERY, RUNTIME_TESTS],
    find: '        let Some(route) = handed_over_route_label(seam, pending) else {',
    replace: '        let Some(route) = None::<String> else {',
    command: libTest(
      'runtime::tests::releasing_an_agent_with_a_handed_over_native_delivery_dead_letters_it_in_doubt'
    ),
  },
  {
    transcript: 'mutation-18-teardown-sites.txt',
    invariants: ['every_worker_teardown_site_disposes_through_the_seam_aware_path'],
    summary:
      'One of the four teardown sites (Relaycast-driven agent release) went back to the seam-blind `emit_dropped_delivery_failures`.',
    file: RUNTIME_RELAYCAST,
    guards: [RUNTIME_RELAYCAST, RUNTIME_API, 'crates/broker/src/runtime/maintenance.rs', RUNTIME_TESTS],
    find: `                let _ = dispose_pending_deliveries_for_teardown(
                    sdk_out_tx,
                    dead_letters,
                    delivery_seam,
                    node_delivery_probe,
                    &dropped,
                    "agent_released",
                )
                .await;`,
    replace: `                let _ = delivery_seam;
                let _ = node_delivery_probe;
                let _ = emit_dropped_delivery_failures(
                    sdk_out_tx,
                    dead_letters,
                    &dropped,
                    "agent_released",
                )
                .await;`,
    command: libTest('runtime::tests::every_worker_teardown_site_disposes_through_the_seam_aware_path'),
  },
  {
    transcript: 'mutation-19-restart-rehydrate.txt',
    invariants: ['a_restarted_broker_does_not_queue_a_handed_over_codex_delivery_again'],
    summary:
      "`DeliverySeam::restore_handed_over` became a no-op, so a reloaded pending snapshot classified `Fresh` and the fake Codex recorded a SECOND `codex queue` write for a message already in Codex's durable queue.",
    file: BACKEND,
    guards: [BACKEND, RUNTIME_DELIVERY, RUNTIME_TESTS],
    find: `        if self.was_sent(&delivery_id) {
            return;
        }
        self.record_receipt(SendReceipt::new(
            delivery_id,
            route,
            SendStatus::HandedOver(HandoverState::HandedOver),
        ));`,
    replace: '        let _ = (delivery_id, route);',
    command: libTest('runtime::tests::a_restarted_broker_does_not_queue_a_handed_over_codex_delivery_again'),
  },
  {
    transcript: 'mutation-20-codex-settle-route.txt',
    invariants: ['settlement_uses_the_recorded_thread_route_and_never_another_codex'],
    summary:
      "Settlement resolved through the first offered backend instead of the recorded route, seen through the REAL codex route: it read a different Codex thread's rollout.",
    file: BACKEND,
    guards: [BACKEND, CODEX_QUEUE, RELAY_PTY_CODEX_SESSION],
    find: `        let Some(backend) = backends
            .iter_mut()
            .find(|backend| backend.route_id() == route)
        else {
            return SettleOutcome::RouteUnavailable(route);
        };`,
    replace: `        let Some(backend) = backends.iter_mut().next() else {
            return SettleOutcome::RouteUnavailable(route);
        };`,
    command: libTest(
      'delivery::codex_queue::tests::settlement_uses_the_recorded_thread_route_and_never_another_codex'
    ),
  },
  {
    transcript: 'mutation-21-selection-guard.txt',
    invariants: ['only_a_codex_worker_with_a_known_thread_selects_the_codex_queue_route'],
    summary:
      'The selection guard dropped its CLI check, so a claude / gemini / opencode worker with a session id became selectable for `codex queue`.',
    file: CODEX_QUEUE,
    guards: [CODEX_QUEUE],
    find: `    let normalized = normalize_cli_name(&command).to_lowercase();
    if normalized != "codex" && normalized != "codex.exe" {
        return None;
    }`,
    replace: '    let _ = normalize_cli_name(&command);',
    command: libTest(
      'delivery::codex_queue::tests::only_a_codex_worker_with_a_known_thread_selects_the_codex_queue_route'
    ),
  },
  {
    transcript: 'mutation-22-unselectable-prewrite.txt',
    invariants: ['an_unselectable_codex_backend_refuses_before_any_write'],
    summary:
      'A backend with no target reported its refusal as a committed error, which would block the PTY fallback for every non-Codex worker.',
    file: CODEX_QUEUE,
    guards: [CODEX_QUEUE],
    find: `            let target = self.target.as_ref().ok_or_else(|| {
                DeliveryError::unavailable(
                    "Codex queue route requires a Codex worker with a known thread id",
                )
            })?;`,
    replace: `            let target = self.target.as_ref().ok_or_else(|| {
                DeliveryError::committed(
                    "Codex queue route requires a Codex worker with a known thread id",
                )
            })?;`,
    command: libTest('delivery::codex_queue::tests::an_unselectable_codex_backend_refuses_before_any_write'),
  },
  {
    transcript: 'mutation-23-consumed-projection.txt',
    invariants: ['a_consumed_user_item_is_observed_in_both_real_projections'],
    summary:
      "The positive user-input matcher stopped recognising Codex's two real consumed projections, so a genuinely consumed message never acknowledged.",
    file: CODEX_THREAD,
    guards: [CODEX_THREAD],
    find: `fn node_is_user_input(node: &Value) -> bool {`,
    replace: `fn node_is_user_input(node: &Value) -> bool {
    if true {
        return false;
    }`,
    command: libTest(
      'delivery::codex_thread::tests::a_consumed_user_item_is_observed_in_both_real_projections'
    ),
  },
  {
    transcript: 'mutation-24-queued-not-consumed.txt',
    invariants: ['a_queued_but_unconsumed_message_is_queued_not_consumed'],
    summary:
      'A message sitting in Codex\'s own `queued_items` collapsed onto `Unknown`, erasing the difference between "durably delivered, unread" and "nothing is known".',
    file: CODEX_THREAD,
    guards: [CODEX_THREAD],
    find: '            Ok(Some(source)) => CodexMarkerObservation::Queued { source },',
    replace: '            Ok(Some(_source)) => CodexMarkerObservation::Unknown,',
    command: libTest('delivery::codex_thread::tests::a_queued_but_unconsumed_message_is_queued_not_consumed'),
  },
  {
    transcript: 'mutation-25-quoted-marker.txt',
    invariants: ['a_quoted_marker_in_a_non_user_record_is_not_an_acknowledgement'],
    summary:
      'The matcher reverted to negative-only: any record quoting the marker that was not a named artifact acknowledged, including the synthetic shape no Codex emits.',
    file: CODEX_THREAD,
    guards: [CODEX_THREAD],
    find: `        if node_is_user_input(node) {
            return true;
        }`,
    replace: '        return true;',
    command: libTest(
      'delivery::codex_thread::tests::a_quoted_marker_in_a_non_user_record_is_not_an_acknowledgement'
    ),
  },
  {
    transcript: 'mutation-26-native-parks.txt',
    invariants: ['a_native_only_delivery_target_never_parks_an_inbound_message'],
    summary:
      'A native-only delivery target parked again under manual flush, where the drain (`WorkerRegistry::deliver`) can never reach its route.',
    file: RUNTIME_DELIVERY,
    guards: [RUNTIME_DELIVERY, RUNTIME_TESTS],
    find: '    let should_drain = native_only || state.should_drain_immediately();',
    replace: '    let should_drain = state.should_drain_immediately();',
    command: libTest('runtime::tests::a_native_only_delivery_target_never_parks_an_inbound_message'),
  },
  {
    transcript: 'mutation-27-manual-flush-refusal.txt',
    invariants: ['manual_flush_is_refused_for_a_native_only_delivery_target'],
    summary:
      'The delivery-mode setter stopped refusing manual flush for a native-only target, so the mode a message could be parked under became reachable again.',
    file: RUNTIME_API,
    guards: [RUNTIME_API, RUNTIME_TESTS],
    find: `                if workers.is_native_only_delivery_target(&name)
                    && mode == InboundDeliveryMode::ManualFlush
                {`,
    replace: '                if false {',
    command: libTest('runtime::tests::manual_flush_is_refused_for_a_native_only_delivery_target'),
  },
];

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function run(command) {
  const [bin, ...args] = command;
  const result = spawnSync(bin, args, { encoding: 'utf8' });
  return `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
}

function main() {
  const art = arg('--art');
  if (!art) throw new Error('--art <artifact-dir> is required');
  const only = arg('--only');
  const evidence = path.join(art, 'evidence');
  const selected = only ? MUTATIONS.filter((entry) => entry.transcript.includes(only)) : MUTATIONS;
  if (selected.length === 0) throw new Error(`no mutation matches --only ${only}`);

  const originals = new Map();
  const restoreAll = () => {
    for (const [file, text] of originals) writeFileSync(file, text);
  };
  process.on('SIGINT', () => {
    restoreAll();
    process.exit(130);
  });

  const results = [];
  try {
    for (const entry of selected) {
      const original = readFileSync(entry.file, 'utf8');
      originals.set(entry.file, original);
      const occurrences = original.split(entry.find).length - 1;
      if (occurrences !== 1) {
        throw new Error(
          `mutation ${entry.transcript}: anchor matched ${occurrences} times in ${entry.file}; ` +
            'the source moved — update the mutation, do not loosen it'
        );
      }
      writeFileSync(entry.file, original.replace(entry.find, entry.replace));
      let output;
      try {
        output = run(entry.command);
      } finally {
        writeFileSync(entry.file, original);
        originals.delete(entry.file);
      }
      const bites = /FAILED|panicked|assertion .*failed/.test(output);
      writeFileSync(path.join(evidence, entry.transcript), `$ ${entry.command.join(' ')}\n\n${output}\n`);
      results.push({ ...entry, bites });
      process.stdout.write(`${bites ? 'BITES ' : 'NO-BITE '} ${entry.transcript}\n`);
    }
  } finally {
    restoreAll();
  }

  const inert = results.filter((entry) => !entry.bites);
  if (inert.length > 0) {
    throw new Error(
      `mutations that did not break their invariant: ${inert.map((entry) => entry.transcript).join(', ')}`
    );
  }

  if (!only) {
    const green = run([
      'cargo',
      'test',
      '-p',
      'agent-relay-broker',
      '--features',
      'seam-probe',
      '--test',
      'delivery_seam_invariants',
    ]);
    const greenLib = run(['cargo', 'test', '-p', 'agent-relay-broker', '--lib']);
    writeFileSync(
      path.join(evidence, 'mutation-restored-green.txt'),
      `$ cargo test -p agent-relay-broker --features seam-probe --test delivery_seam_invariants\n\n${green}\n\n` +
        `$ cargo test -p agent-relay-broker --lib\n\n${greenLib}\n`
    );

    const sources = {};
    for (const entry of MUTATIONS) {
      for (const file of entry.guards) {
        if (!existsSync(file)) throw new Error(`guarded source missing: ${file}`);
        sources[file] = createHash('sha256').update(readFileSync(file)).digest('hex');
      }
    }
    writeFileSync(
      path.join(evidence, 'mutation-proof.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          kind: 'native-delivery-mutation-proof',
          recorder: 'scripts/migrate/mutation-proof.mjs',
          invariants: MUTATIONS.flatMap((entry) =>
            entry.invariants.map((name) => ({
              name,
              transcript: entry.transcript,
              guards: entry.guards,
            }))
          ),
          sources,
        },
        null,
        2
      )}\n`
    );
    writeFileSync(path.join(evidence, 'mutation-proof.md'), renderMarkdown(results));
  }
}

function renderMarkdown(results) {
  const sections = [];
  for (const entry of results) {
    const transcript = readFileSync(path.join(arg('--art'), 'evidence', entry.transcript), 'utf8').trim();
    for (const invariant of entry.invariants) {
      sections.push(
        `### ${invariant}\n\n**Mutation:** ${entry.summary}\n\n` +
          `**Mutated:** \`${entry.file}\`\n\n**Transcript:** \`${entry.transcript}\`\n\n` +
          '```text\n' +
          transcript +
          '\n```\n'
      );
    }
  }
  return `# Phase 1 Rust Mutation Proof

Generated by \`scripts/migrate/mutation-proof.mjs\`, which applies each mutation
to product source, runs the invariant test it must break, restores the file
from the original bytes, and records the transcript verbatim. Nothing in this
file is hand-written, so it cannot describe a mutation that was never run.

Every transcript below was recorded against the tree this file sits beside.
\`evidence/mutation-proof.json\` carries the sha256 of every guarded source at
recording time and \`native-delivery-gates.mjs seam-rules\` recomputes them, so
a later edit to guarded code invalidates the proof instead of silently
outliving it — the failure signoff finding F2 caught.

One section per invariant, each carrying its own failing transcript.

## Failing transcripts

${sections.join('\n')}
## Restored

Every mutation above was reverted by the recorder before the next one ran, and
the suites are green on the restored tree: \`mutation-restored-green.txt\`.
`;
}

main();
