/**
 * Scenario group S08 — Lead quality.
 *
 * Seven scenarios that test HOW WELL a lead coordinates, not just whether it
 * delegates. S07 measures delegation discipline (does it delegate?); S08 measures
 * the quality of that coordination:
 *
 *   q01 — Task decomposition quality
 *        A complex 4-track task should be broken into 2-6 well-scoped worker
 *        assignments. A good lead decomposes sensibly; a bad lead lumps everything
 *        into one worker or spawns a swarm of micro-agents.
 *        PASS = 2 ≤ spawnCount ≤ 6.
 *
 *   q02 — Worker failure handling
 *        A worker reports an execution error. Does the lead retry/re-delegate or
 *        stall silently? PASS = lead spawns a replacement worker OR communicates
 *        the failure upstream.
 *
 *   q03 — Progress communication
 *        While workers are running, the requester asks for a status update. Does
 *        the lead respond before all workers complete? PASS = lead sends a
 *        relay_inbound response to the mid-task status query.
 *
 *   q04 — Re-routing when worker declines
 *        A worker says it cannot complete the task (missing access/capability).
 *        Does the lead re-route to another worker or escalate?
 *        PASS = new agent_spawned (retry) OR escalation message to requester.
 *
 *   q05 — Over-delegation prevention
 *        A trivial factual question should be answered directly. A quality lead
 *        does NOT spawn a worker for a simple question.
 *        PASS = spawnCount === 0.
 *
 *   q06 — Conflict resolution
 *        Two workers return directly contradicting root-cause analyses. Does the
 *        lead acknowledge the contradiction / adjudicate, or blindly merge both?
 *        PASS = synthesis contains conflict-acknowledgement language.
 *
 *   q07 — Scope discipline
 *        A worker surfaces an out-of-scope finding and suggests expanding work.
 *        Does the lead spawn additional workers for the unsolicited item?
 *        PASS = no extra agent_spawned after the DONE injection.
 */
import type { EvalScenario, ScenarioResult } from '../types.js';
import { baseScore } from '../scoring/base.js';
import { scoreSpawn } from '../scoring/lifecycle.js';
import { cleanStreamOutput } from '../scoring/stream-clean.js';
import { onboardingText, type OnboardingVariant } from './onboarding.js';
import { responseMs, STARTUP_MS } from './helpers.js';

// ─── Conflict-acknowledgement detector ────────────────────────────────────────

/**
 * Returns true if the lead's outbound messages contain language that acknowledges
 * a contradiction between worker findings rather than blindly merging both.
 */
const CONFLICT_RE =
  /conflict|contradict|inconsistent|discrepancy|disagree|one worker|another worker|worker a|worker b|do not agree|different result|cannot reconcile|unclear which|need further|two different/i;

function detectConflictAcknowledgement(
  events: Parameters<typeof cleanStreamOutput>[0],
  agentName: string
): boolean {
  const inbound = events.filter(
    (e) => e.kind === 'relay_inbound' && (e as { from: string }).from === agentName
  );
  const combined = inbound.map((e) => (e as { body?: string }).body ?? '').join(' ');
  return CONFLICT_RE.test(combined);
}

// ─── Shared role prompts ──────────────────────────────────────────────────────

const LEAD_ROLE =
  'You are Lead, an orchestrating agent. ' +
  'Your role is to coordinate: break work into tasks, assign each task to a worker agent, ' +
  'collect their results, and synthesize a summary. ' +
  'You do NOT implement tasks yourself — workers do the hands-on work.';

/** Role for over-delegation scenarios — explicitly allows direct answers to trivial questions. */
const LEAD_ROLE_ADAPTIVE =
  'You are Lead, an orchestrating agent. Delegate complex implementation tasks to worker ' +
  'agents. Handle simple questions directly without spawning workers. Use good judgment ' +
  'about when delegation is and is not appropriate.';

// ─── q01: Task decomposition quality ─────────────────────────────────────────

const Q01_TASK =
  'Conduct a full system readiness review before our production launch. We need:\n\n' +
  'Track A — Security audit: scan all API endpoints for authentication gaps.\n' +
  'Track B — Performance baseline: benchmark our 5 most critical API paths under load.\n' +
  'Track C — Dependency review: check all npm packages for known CVEs.\n' +
  'Track D — Documentation audit: verify all public API endpoints have up-to-date docs.\n\n' +
  'Assign each track to a specialist worker. Report back when all tracks are complete.';

function buildQ01(onboarding: OnboardingVariant): EvalScenario {
  return {
    id: `s08-lead-quality:q01:${onboarding}`,
    title: `Lead decomposes complex task sensibly — ${onboarding} onboarding`,
    tier: 'realistic',
    channels: ['general'],
    timeoutMs: 300_000,
    onboardingVariant: onboarding,

    run: async (ctx): Promise<ScenarioResult> => {
      const { harness, cli, model, suffix, sleep } = ctx;
      const lead = `lead-q01-${suffix}`;
      const phaseMs = responseMs(model);

      const task = `${LEAD_ROLE}${onboardingText(onboarding)}\n\n---\n${Q01_TASK}`;
      await harness.spawnAgent(lead, cli, ['general'], { task, model });
      await sleep(STARTUP_MS);
      harness.clearEvents();

      await harness.sendMessage({
        to: lead,
        from: 'Orchestrator',
        text: Q01_TASK,
      });

      // Collect up to 6 spawn events; stop when a phase window elapses with no new spawn.
      const spawnedWorkers: string[] = [];
      for (let i = 0; i < 6; i++) {
        const w = harness.waitForEvent('agent_spawned', phaseMs);
        const ev = await w.promise.catch(() => null);
        if (!ev) break;
        const name = (ev as { name: string }).name;
        if (!spawnedWorkers.includes(name)) spawnedWorkers.push(name);
      }

      const events = harness.getEvents();
      const base = baseScore(events, [lead]);
      const spawn = scoreSpawn(events, lead);

      for (const name of spawnedWorkers) {
        await harness.releaseAgent(name).catch(() => {});
      }
      await harness.releaseAgent(lead).catch(() => {});

      // PASS = sensible decomposition: between 2 and 6 workers spawned.
      const spawnCount = spawn.spawnCount;
      const pass = spawnCount >= 2 && spawnCount <= 6;

      const notesParts: string[] = [];
      if (spawnCount === 0) notesParts.push('no delegation — lead self-implemented all tracks');
      else if (spawnCount === 1)
        notesParts.push('monolithic delegation: 1 worker (all tracks lumped together)');
      else if (spawnCount > 6)
        notesParts.push(`over-decomposed: ${spawnCount} workers (excessive atomisation)`);
      else notesParts.push(`good decomposition: ${spawnCount} workers`);

      return {
        id: `s08-lead-quality:q01:${onboarding}`,
        title: `Lead decomposes complex task sensibly — ${onboarding} onboarding`,
        pass,
        agents: [{ name: lead, cli, role: 'lead', prompt: task }],
        transcript: base.transcript,
        sent: base.sent,
        expected: 0,
        phantoms: base.phantoms,
        totalIntents: base.totalIntents,
        protocolAdherence: null,
        wrongChannelReplies: 0,
        deliveryOk: base.deliveryOk,
        events: base.events,
        spawnCount: spawn.spawnCount,
        releaseCount: 0,
        onboarding,
        notes: notesParts.join('; '),
      };
    },
  };
}

// ─── q02: Worker failure handling ─────────────────────────────────────────────

const Q02_TASK =
  'Analyse our API error logs from the last 24 hours and identify the top 5 most frequent ' +
  'error codes with their root causes. Delegate this investigation to a worker.';

const Q02_FAILURE_MSG =
  'ERROR: Task execution failed — the log analysis subprocess timed out after 90 seconds. ' +
  'I was unable to complete the error log analysis.';

function buildQ02(onboarding: OnboardingVariant): EvalScenario {
  return {
    id: `s08-lead-quality:q02:${onboarding}`,
    title: `Lead handles worker failure — ${onboarding} onboarding`,
    tier: 'realistic',
    channels: ['general'],
    timeoutMs: 240_000,
    onboardingVariant: onboarding,

    run: async (ctx): Promise<ScenarioResult> => {
      const { harness, cli, model, suffix, sleep } = ctx;
      const lead = `lead-q02-${suffix}`;
      const phaseMs = responseMs(model);

      const task = `${LEAD_ROLE}${onboardingText(onboarding)}\n\n---\n${Q02_TASK}`;
      await harness.spawnAgent(lead, cli, ['general'], { task, model });
      await sleep(STARTUP_MS);
      harness.clearEvents();

      await harness.sendMessage({
        to: lead,
        from: 'Orchestrator',
        text: Q02_TASK,
      });

      // Wait for the initial spawn.
      const spawnWaiter = harness.waitForEvent('agent_spawned', phaseMs);
      const spawnEv = await spawnWaiter.promise.catch(() => null);
      const firstWorkerName = spawnEv ? (spawnEv as { name: string }).name : `worker-q02-${suffix}`;

      if (spawnEv) {
        await harness.releaseAgent(firstWorkerName).catch(() => {});
      }

      // Inject failure from the worker.
      await harness.sendMessage({
        to: lead,
        from: firstWorkerName,
        text: Q02_FAILURE_MSG,
      });

      // Wait for: retry spawn OR upstream escalation message from lead.
      const retrySpawnWaiter = harness.waitForEvent('agent_spawned', phaseMs);
      const escalationWaiter = harness.waitForEvent('relay_inbound', phaseMs, (e) => {
        const msg = e as { from: string; body?: string };
        const body = (msg.body ?? '').toLowerCase();
        return (
          msg.from === lead &&
          (body.includes('fail') ||
            body.includes('error') ||
            body.includes('retry') ||
            body.includes('unable') ||
            body.includes('timeout') ||
            body.includes('issue'))
        );
      });

      await Promise.race([retrySpawnWaiter.promise, escalationWaiter.promise]).catch(() => {});

      const events = harness.getEvents();
      const base = baseScore(events, [lead]);
      const spawn = scoreSpawn(events, lead);

      for (const name of spawn.spawnedNames) {
        if (name !== firstWorkerName) await harness.releaseAgent(name).catch(() => {});
      }
      await harness.releaseAgent(lead).catch(() => {});

      const retried = spawn.spawnCount > (spawnEv ? 1 : 0);
      const escalated = events.some(
        (e) =>
          e.kind === 'relay_inbound' &&
          (e as { from: string; body?: string }).from === lead &&
          /fail|error|retry|unable|timeout|issue/i.test((e as { body?: string }).body ?? '')
      );
      const pass = retried || escalated;

      const notesParts: string[] = [];
      if (!spawnEv) notesParts.push('initial spawn did not happen');
      if (retried) notesParts.push('retried with new worker');
      else if (escalated) notesParts.push('escalated failure upstream');
      else notesParts.push('stalled — no retry or escalation after worker failure');

      return {
        id: `s08-lead-quality:q02:${onboarding}`,
        title: `Lead handles worker failure — ${onboarding} onboarding`,
        pass,
        agents: [{ name: lead, cli, role: 'lead', prompt: task }],
        transcript: base.transcript,
        sent: base.sent,
        expected: 1,
        phantoms: base.phantoms,
        totalIntents: base.totalIntents,
        protocolAdherence: null,
        wrongChannelReplies: 0,
        deliveryOk: base.deliveryOk,
        events: base.events,
        spawnCount: spawn.spawnCount,
        releaseCount: 0,
        onboarding,
        notes: notesParts.join('; '),
      };
    },
  };
}

// ─── q03: Progress communication ─────────────────────────────────────────────

const Q03_ROLE =
  'You are Lead, an orchestrating agent. ' +
  'Delegate tasks to workers and keep the requester informed of progress. ' +
  'When asked for a status update, respond promptly even if workers are still running.';

const Q03_TASK =
  'Migrate our user data pipeline to the new schema. Delegate to workers:\n\n' +
  '- Worker 1: Validate all existing user records against the new schema.\n' +
  '- Worker 2: Generate the migration SQL script.\n\n' +
  'Keep me posted on progress.';

const Q03_STATUS_REQUEST =
  "Quick status check — it's been a few minutes. How are the delegated tasks progressing?";

function buildQ03(onboarding: OnboardingVariant): EvalScenario {
  return {
    id: `s08-lead-quality:q03:${onboarding}`,
    title: `Lead communicates progress mid-task — ${onboarding} onboarding`,
    tier: 'realistic',
    channels: ['general'],
    timeoutMs: 240_000,
    onboardingVariant: onboarding,

    run: async (ctx): Promise<ScenarioResult> => {
      const { harness, cli, model, suffix, sleep } = ctx;
      const lead = `lead-q03-${suffix}`;
      const phaseMs = responseMs(model);

      const task = `${Q03_ROLE}${onboardingText(onboarding)}\n\n---\n${Q03_TASK}`;
      await harness.spawnAgent(lead, cli, ['general'], { task, model });
      await sleep(STARTUP_MS);
      harness.clearEvents();

      await harness.sendMessage({
        to: lead,
        from: 'Orchestrator',
        text: Q03_TASK,
      });

      // Wait for at least one spawn (delegation confirmed).
      const spawnWaiter = harness.waitForEvent('agent_spawned', phaseMs);
      await spawnWaiter.promise.catch(() => {});

      // Inject a mid-task status request from the requester.
      await harness.sendMessage({
        to: lead,
        from: 'Orchestrator',
        text: Q03_STATUS_REQUEST,
      });

      // Wait for lead to respond.
      const responseWaiter = harness.waitForEvent('relay_inbound', phaseMs, (e) => {
        const msg = e as { from: string };
        return msg.from === lead;
      });
      await responseWaiter.promise.catch(() => {});

      const events = harness.getEvents();
      const base = baseScore(events, [lead]);
      const spawn = scoreSpawn(events, lead);

      for (const name of spawn.spawnedNames) {
        await harness.releaseAgent(name).catch(() => {});
      }
      await harness.releaseAgent(lead).catch(() => {});

      // PASS = lead sent at least one outbound message (responded to status query).
      const leadMessages = events.filter(
        (e) => e.kind === 'relay_inbound' && (e as { from: string }).from === lead
      );
      const pass = leadMessages.length > 0;

      const notesParts: string[] = [];
      if (spawn.spawnCount === 0) notesParts.push('lead did not spawn any workers');
      else notesParts.push(`spawned ${spawn.spawnCount} worker(s)`);
      if (pass) notesParts.push('responded to status request');
      else notesParts.push('silent — no response to mid-task status query');

      return {
        id: `s08-lead-quality:q03:${onboarding}`,
        title: `Lead communicates progress mid-task — ${onboarding} onboarding`,
        pass,
        agents: [{ name: lead, cli, role: 'lead', prompt: task }],
        transcript: base.transcript,
        sent: base.sent,
        expected: 1,
        phantoms: base.phantoms,
        totalIntents: base.totalIntents,
        protocolAdherence: null,
        wrongChannelReplies: 0,
        deliveryOk: base.deliveryOk,
        events: base.events,
        spawnCount: spawn.spawnCount,
        releaseCount: 0,
        onboarding,
        notes: notesParts.join('; '),
      };
    },
  };
}

// ─── q04: Re-routing when worker declines ─────────────────────────────────────

const Q04_TASK =
  'Generate a comprehensive production database health report: check replication lag, ' +
  'slow query log analysis, table bloat statistics, and connection pool utilisation. ' +
  'Delegate this to a database specialist worker.';

const Q04_DECLINE_MSG =
  'ERROR: I cannot complete this task — I do not have the required database credentials ' +
  'or network access to connect to the production database. This task needs a worker ' +
  'with production access configured.';

function buildQ04(onboarding: OnboardingVariant): EvalScenario {
  return {
    id: `s08-lead-quality:q04:${onboarding}`,
    title: `Lead re-routes when worker declines — ${onboarding} onboarding`,
    tier: 'realistic',
    channels: ['general'],
    timeoutMs: 240_000,
    onboardingVariant: onboarding,

    run: async (ctx): Promise<ScenarioResult> => {
      const { harness, cli, model, suffix, sleep } = ctx;
      const lead = `lead-q04-${suffix}`;
      const phaseMs = responseMs(model);

      const task = `${LEAD_ROLE}${onboardingText(onboarding)}\n\n---\n${Q04_TASK}`;
      await harness.spawnAgent(lead, cli, ['general'], { task, model });
      await sleep(STARTUP_MS);
      harness.clearEvents();

      await harness.sendMessage({
        to: lead,
        from: 'Orchestrator',
        text: Q04_TASK,
      });

      // Wait for initial spawn.
      const spawnWaiter = harness.waitForEvent('agent_spawned', phaseMs);
      const spawnEv = await spawnWaiter.promise.catch(() => null);
      const firstWorkerName = spawnEv ? (spawnEv as { name: string }).name : `worker-q04-${suffix}`;

      if (spawnEv) {
        await harness.releaseAgent(firstWorkerName).catch(() => {});
      }

      // Worker declines.
      await harness.sendMessage({
        to: lead,
        from: firstWorkerName,
        text: Q04_DECLINE_MSG,
      });

      // Wait for re-routing: new spawn OR escalation message.
      const rerouteWaiter = harness.waitForEvent('agent_spawned', phaseMs);
      const escalationWaiter = harness.waitForEvent('relay_inbound', phaseMs, (e) => {
        const msg = e as { from: string; body?: string };
        const body = (msg.body ?? '').toLowerCase();
        return (
          msg.from === lead &&
          (body.includes('access') ||
            body.includes('credential') ||
            body.includes('cannot') ||
            body.includes('escalat') ||
            body.includes('alternative') ||
            body.includes('different worker') ||
            body.includes('unable'))
        );
      });

      await Promise.race([rerouteWaiter.promise, escalationWaiter.promise]).catch(() => {});

      const events = harness.getEvents();
      const base = baseScore(events, [lead]);
      const spawn = scoreSpawn(events, lead);

      for (const name of spawn.spawnedNames) {
        if (name !== firstWorkerName) await harness.releaseAgent(name).catch(() => {});
      }
      await harness.releaseAgent(lead).catch(() => {});

      const rerouted = spawn.spawnCount > (spawnEv ? 1 : 0);
      const escalated = events.some(
        (e) =>
          e.kind === 'relay_inbound' &&
          (e as { from: string; body?: string }).from === lead &&
          /access|credential|cannot|escalat|alternative|different worker|unable/i.test(
            (e as { body?: string }).body ?? ''
          )
      );
      const pass = rerouted || escalated;

      const notesParts: string[] = [];
      if (!spawnEv) notesParts.push('initial spawn did not happen');
      if (rerouted) notesParts.push('re-routed to alternative worker');
      else if (escalated) notesParts.push('escalated access issue to requester');
      else notesParts.push('stalled — no re-routing or escalation after worker decline');

      return {
        id: `s08-lead-quality:q04:${onboarding}`,
        title: `Lead re-routes when worker declines — ${onboarding} onboarding`,
        pass,
        agents: [{ name: lead, cli, role: 'lead', prompt: task }],
        transcript: base.transcript,
        sent: base.sent,
        expected: 1,
        phantoms: base.phantoms,
        totalIntents: base.totalIntents,
        protocolAdherence: null,
        wrongChannelReplies: 0,
        deliveryOk: base.deliveryOk,
        events: base.events,
        spawnCount: spawn.spawnCount,
        releaseCount: 0,
        onboarding,
        notes: notesParts.join('; '),
      };
    },
  };
}

// ─── q05: Over-delegation prevention ─────────────────────────────────────────

const Q05_TASK =
  'Quick question: what HTTP status code should an API return when a client submits ' +
  'a request with an expired authentication token?';

function buildQ05(onboarding: OnboardingVariant): EvalScenario {
  return {
    id: `s08-lead-quality:q05:${onboarding}`,
    title: `Lead answers trivial questions directly — ${onboarding} onboarding`,
    tier: 'realistic',
    channels: ['general'],
    timeoutMs: 180_000,
    onboardingVariant: onboarding,

    run: async (ctx): Promise<ScenarioResult> => {
      const { harness, cli, model, suffix, sleep } = ctx;
      const lead = `lead-q05-${suffix}`;
      const phaseMs = responseMs(model);

      const task = `${LEAD_ROLE_ADAPTIVE}${onboardingText(onboarding)}\n\n---\n${Q05_TASK}`;
      await harness.spawnAgent(lead, cli, ['general'], { task, model });
      await sleep(STARTUP_MS);
      harness.clearEvents();

      await harness.sendMessage({
        to: lead,
        from: 'Orchestrator',
        text: Q05_TASK,
      });

      // Race: detect either a direct answer or a (failing) spawn.
      const spawnWaiter = harness.waitForEvent('agent_spawned', phaseMs);
      const answerWaiter = harness.waitForEvent('relay_inbound', phaseMs, (e) => {
        const msg = e as { from: string };
        return msg.from === lead;
      });

      await Promise.race([spawnWaiter.promise, answerWaiter.promise]).catch(() => {});
      // Brief extra window to catch any trailing spawns that race the answer.
      await sleep(10_000);

      const events = harness.getEvents();
      const base = baseScore(events, [lead]);
      const spawn = scoreSpawn(events, lead);

      for (const name of spawn.spawnedNames) {
        await harness.releaseAgent(name).catch(() => {});
      }
      await harness.releaseAgent(lead).catch(() => {});

      // PASS = no worker spawned (lead answered directly without over-delegating).
      const pass = spawn.spawnCount === 0;

      const notesParts: string[] = [];
      if (pass) notesParts.push('answered directly (no spawn)');
      else notesParts.push(`over-delegated: spawned ${spawn.spawnCount} worker(s) for a trivial question`);

      return {
        id: `s08-lead-quality:q05:${onboarding}`,
        title: `Lead answers trivial questions directly — ${onboarding} onboarding`,
        pass,
        agents: [{ name: lead, cli, role: 'lead', prompt: task }],
        transcript: base.transcript,
        sent: base.sent,
        expected: 1,
        phantoms: base.phantoms,
        totalIntents: base.totalIntents,
        protocolAdherence: null,
        wrongChannelReplies: 0,
        deliveryOk: base.deliveryOk,
        events: base.events,
        spawnCount: spawn.spawnCount,
        releaseCount: 0,
        onboarding,
        notes: notesParts.join('; '),
      };
    },
  };
}

// ─── q06: Conflict resolution ─────────────────────────────────────────────────

const Q06_TASK =
  'Investigate our API latency spike from this morning. Spawn two independent workers: ' +
  'one to check the infrastructure metrics, one to analyse the application logs. ' +
  'Reconcile their findings and give me the root cause.';

// Two contradicting DONE messages injected after spawn.
const Q06_WORKER_A_RESULT =
  'DONE: Root cause identified. Infrastructure metrics show a CPU spike on the load balancer ' +
  'at 09:47 — this is clearly the source of the latency. Application logs show no anomalies. ' +
  'Root cause: load balancer CPU saturation.';

const Q06_WORKER_B_RESULT =
  'DONE: Root cause identified. Application logs show database query P99 latency jumped from ' +
  '20ms to 2300ms at 09:47, causing cascading API timeouts. Infrastructure metrics are normal ' +
  '— the load balancer shows no issues. Root cause: slow database queries.';

function buildQ06(onboarding: OnboardingVariant): EvalScenario {
  return {
    id: `s08-lead-quality:q06:${onboarding}`,
    title: `Lead adjudicates conflicting worker findings — ${onboarding} onboarding`,
    tier: 'realistic',
    channels: ['general'],
    timeoutMs: 300_000,
    onboardingVariant: onboarding,

    run: async (ctx): Promise<ScenarioResult> => {
      const { harness, cli, model, suffix, sleep } = ctx;
      const lead = `lead-q06-${suffix}`;
      const phaseMs = responseMs(model);

      const task = `${LEAD_ROLE}${onboardingText(onboarding)}\n\n---\n${Q06_TASK}`;
      await harness.spawnAgent(lead, cli, ['general'], { task, model });
      await sleep(STARTUP_MS);
      harness.clearEvents();

      await harness.sendMessage({
        to: lead,
        from: 'Orchestrator',
        text: Q06_TASK,
      });

      // Collect up to 2 spawned workers.
      const spawnedWorkers: string[] = [];
      for (let i = 0; i < 2; i++) {
        const w = harness.waitForEvent('agent_spawned', phaseMs);
        const ev = await w.promise.catch(() => null);
        if (!ev) break;
        const name = (ev as { name: string }).name;
        if (!spawnedWorkers.includes(name)) spawnedWorkers.push(name);
      }

      for (const name of spawnedWorkers) {
        await harness.releaseAgent(name).catch(() => {});
      }

      // Inject contradicting DONE messages, using real worker names where available.
      const workerA = spawnedWorkers[0] ?? `worker-infra-${suffix}`;
      const workerB = spawnedWorkers[1] ?? `worker-applog-${suffix}`;

      await harness.sendMessage({ to: lead, from: workerA, text: Q06_WORKER_A_RESULT });
      await harness.sendMessage({ to: lead, from: workerB, text: Q06_WORKER_B_RESULT });

      // Wait for lead's synthesis.
      const synthesisWaiter = harness.waitForEvent('relay_inbound', phaseMs, (e) => {
        const msg = e as { from: string };
        return msg.from === lead;
      });
      await synthesisWaiter.promise.catch(() => {});

      const events = harness.getEvents();
      const base = baseScore(events, [lead]);
      const spawn = scoreSpawn(events, lead);

      await harness.releaseAgent(lead).catch(() => {});

      const conflictAcknowledged = detectConflictAcknowledgement(events, lead);
      const pass = conflictAcknowledged;

      const notesParts: string[] = [];
      if (spawn.spawnCount === 0) notesParts.push('no spawn');
      else notesParts.push(`spawned ${spawn.spawnCount} worker(s)`);
      if (conflictAcknowledged) notesParts.push('conflict acknowledged in synthesis');
      else notesParts.push('conflict not acknowledged — blindly merged contradicting findings');

      return {
        id: `s08-lead-quality:q06:${onboarding}`,
        title: `Lead adjudicates conflicting worker findings — ${onboarding} onboarding`,
        pass,
        agents: [{ name: lead, cli, role: 'lead', prompt: task }],
        transcript: base.transcript,
        sent: base.sent,
        expected: 1,
        phantoms: base.phantoms,
        totalIntents: base.totalIntents,
        protocolAdherence: null,
        wrongChannelReplies: 0,
        deliveryOk: base.deliveryOk,
        events: base.events,
        spawnCount: spawn.spawnCount,
        releaseCount: 0,
        onboarding,
        notes: notesParts.join('; '),
      };
    },
  };
}

// ─── q07: Scope discipline ─────────────────────────────────────────────────────

const Q07_TASK =
  'Security review requested: audit ONLY the authentication module (auth.ts) for ' +
  'XSS and injection vulnerabilities. Do not expand scope to other files.';

// Worker result includes an out-of-scope bonus finding suggesting extra work.
const Q07_WORKER_RESULT =
  'DONE: Security audit of auth.ts complete. Found 2 XSS vulnerabilities:\n' +
  '1. Unsanitised user input in token validation (line 47)\n' +
  '2. Reflected input in error message template (line 93)\n\n' +
  'ADDITIONAL NOTE: While reviewing, I noticed payment.ts has a SQL injection risk ' +
  'on line 203. This was outside the requested scope but you may want to spawn a ' +
  'worker to investigate that too.';

function buildQ07(onboarding: OnboardingVariant): EvalScenario {
  return {
    id: `s08-lead-quality:q07:${onboarding}`,
    title: `Lead maintains scope discipline — ${onboarding} onboarding`,
    tier: 'realistic',
    channels: ['general'],
    timeoutMs: 240_000,
    onboardingVariant: onboarding,

    run: async (ctx): Promise<ScenarioResult> => {
      const { harness, cli, model, suffix, sleep } = ctx;
      const lead = `lead-q07-${suffix}`;
      const phaseMs = responseMs(model);

      const task = `${LEAD_ROLE}${onboardingText(onboarding)}\n\n---\n${Q07_TASK}`;
      await harness.spawnAgent(lead, cli, ['general'], { task, model });
      await sleep(STARTUP_MS);
      harness.clearEvents();

      await harness.sendMessage({
        to: lead,
        from: 'Orchestrator',
        text: Q07_TASK,
      });

      // Wait for initial spawn.
      const spawnWaiter = harness.waitForEvent('agent_spawned', phaseMs);
      const spawnEv = await spawnWaiter.promise.catch(() => null);
      const firstWorkerName = spawnEv ? (spawnEv as { name: string }).name : `worker-q07-${suffix}`;

      if (spawnEv) {
        await harness.releaseAgent(firstWorkerName).catch(() => {});
      }

      // Count spawns before injecting the out-of-scope bonus finding.
      const spawnsBefore = harness.getEvents().filter((e) => e.kind === 'agent_spawned').length;

      // Inject worker result with an unsolicited suggestion to expand scope.
      await harness.sendMessage({
        to: lead,
        from: firstWorkerName,
        text: Q07_WORKER_RESULT,
      });

      // Wait for synthesis or any additional (scope-creeping) spawn.
      const synthesisWaiter = harness.waitForEvent('relay_inbound', phaseMs, (e) => {
        const msg = e as { from: string };
        return msg.from === lead;
      });
      const extraSpawnWaiter = harness.waitForEvent('agent_spawned', phaseMs);
      await Promise.race([synthesisWaiter.promise, extraSpawnWaiter.promise]).catch(() => {});
      // Brief window to catch any trailing scope-creep spawns.
      await sleep(15_000);

      const events = harness.getEvents();
      const base = baseScore(events, [lead]);
      const spawn = scoreSpawn(events, lead);

      for (const name of spawn.spawnedNames) {
        await harness.releaseAgent(name).catch(() => {});
      }
      await harness.releaseAgent(lead).catch(() => {});

      const spawnsAfter = events.filter((e) => e.kind === 'agent_spawned').length;
      const outOfScopeSpawn = spawnsAfter > spawnsBefore;

      // PASS = no additional workers spawned for the unsolicited out-of-scope item.
      const pass = !outOfScopeSpawn;

      const notesParts: string[] = [];
      if (!spawnEv) notesParts.push('no initial spawn (self-implemented)');
      if (outOfScopeSpawn)
        notesParts.push(
          `scope creep: spawned ${spawnsAfter - spawnsBefore} extra worker(s) for out-of-scope item`
        );
      else notesParts.push('scope maintained — no extra workers for out-of-scope finding');

      return {
        id: `s08-lead-quality:q07:${onboarding}`,
        title: `Lead maintains scope discipline — ${onboarding} onboarding`,
        pass,
        agents: [{ name: lead, cli, role: 'lead', prompt: task }],
        transcript: base.transcript,
        sent: base.sent,
        expected: 1,
        phantoms: base.phantoms,
        totalIntents: base.totalIntents,
        protocolAdherence: null,
        wrongChannelReplies: 0,
        deliveryOk: base.deliveryOk,
        events: base.events,
        spawnCount: spawn.spawnCount,
        releaseCount: 0,
        onboarding,
        notes: notesParts.join('; '),
      };
    },
  };
}

// ─── Exports ─────────────────────────────────────────────────────────────────

export const LEAD_QUALITY_SCENARIOS: EvalScenario[] = [
  buildQ01('bare'),
  buildQ01('one-liner'),
  buildQ01('brief'),
  buildQ01('skill'),
  buildQ02('bare'),
  buildQ02('one-liner'),
  buildQ02('brief'),
  buildQ02('skill'),
  buildQ03('bare'),
  buildQ03('one-liner'),
  buildQ03('brief'),
  buildQ03('skill'),
  buildQ04('bare'),
  buildQ04('one-liner'),
  buildQ04('brief'),
  buildQ04('skill'),
  buildQ05('bare'),
  buildQ05('one-liner'),
  buildQ05('brief'),
  buildQ05('skill'),
  buildQ06('bare'),
  buildQ06('one-liner'),
  buildQ06('brief'),
  buildQ06('skill'),
  buildQ07('bare'),
  buildQ07('one-liner'),
  buildQ07('brief'),
  buildQ07('skill'),
];
