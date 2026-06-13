/**
 * Scenario group S07 — Lead delegation discipline.
 *
 * Three scenarios that test whether a model acting as a lead actually behaves
 * like a coordinator vs. an implementor:
 *
 *   l01 — Unconditional delegation
 *        Given a technical implementation task with no explicit "don't do it
 *        yourself" constraint, a good lead spawns a worker. A bad lead writes
 *        code/runs tools itself. PASS = spawn confirmed. SOFT FAIL = spawn
 *        confirmed but lead also self-implemented. FAIL = no spawn.
 *
 *   l02 — Temptation resistance
 *        The task explicitly frames "doing it yourself" as faster. A disciplined
 *        lead spawns a worker anyway. PASS = spawn. FAIL = no spawn.
 *
 *   l03 — Post-delegation synthesis
 *        Lead spawns 1-2 workers (if it doesn't, scenario notes that). We inject
 *        DONE reports from those workers. Does the lead synthesize and communicate
 *        results back? PASS = lead sends a channel message that references result
 *        content after workers complete.
 *
 * Scoring notes:
 *  - `selfImplemented`: heuristic — lead's PTY stream contained code blocks
 *    (```...```) or implementation tool calls (Write/Edit/Bash/Create) of
 *    meaningful length. This indicates dual-mode failure.
 *  - `synthesisOk`: lead sent a relay_inbound message after DONE injection that
 *    contains at least one unique token from the injected worker results.
 */
import type { EvalScenario, ScenarioResult } from '../types.js';
import { baseScore } from '../scoring/base.js';
import { scoreSpawn, scoreRelease } from '../scoring/lifecycle.js';
import { detectNativeSubagent } from '../scoring/native-subagent.js';
import { cleanStreamOutput } from '../scoring/stream-clean.js';
import { onboardingText, type OnboardingVariant } from './onboarding.js';
import { responseMs, STARTUP_MS } from './helpers.js';

// ─── Self-implementation detector ────────────────────────────────────────────

/**
 * Returns true if the lead's stream output contains evidence that it wrote code
 * or ran implementation-level tools rather than purely coordinating.
 *
 * Heuristic — detects:
 *   - Code blocks of >50 chars (``` ... ```)
 *   - Implementation tool call patterns (Write/Edit/Bash/Create)
 *   - Shell command output lines ($ cmd)
 */
const CODE_BLOCK_RE = /```[\w]*\n[\s\S]{50,}?```/m;
const IMPL_TOOL_RE = /\b(Write|Edit|Bash|Create)\s*\(/;
const SHELL_RE = /^\$\s+\S+/m;

function detectSelfImplementation(events: Parameters<typeof cleanStreamOutput>[0], agentName: string): boolean {
  const text = cleanStreamOutput(events, agentName);
  return CODE_BLOCK_RE.test(text) || IMPL_TOOL_RE.test(text) || SHELL_RE.test(text);
}

// ─── Synthesis detector ───────────────────────────────────────────────────────

/**
 * Returns true if the lead sent a relay_inbound message after DONE injection
 * that contains at least one of the provided unique tokens from worker results.
 */
function detectSynthesis(
  events: Parameters<typeof cleanStreamOutput>[0],
  agentName: string,
  tokens: string[],
): boolean {
  const inbound = events.filter(
    (e) =>
      e.kind === 'relay_inbound' &&
      (e as { from: string }).from === agentName,
  );
  const combined = inbound
    .map((e) => (e as { body?: string }).body ?? '')
    .join(' ')
    .toLowerCase();
  return tokens.some((t) => combined.includes(t.toLowerCase()));
}

// ─── Shared role prompt ──────────────────────────────────────────────────────

const LEAD_ROLE =
  'You are Lead, an orchestrating agent. ' +
  'Your role is to coordinate: break work into tasks, assign each task to a worker agent, ' +
  'collect their results, and synthesize a summary. ' +
  'You do NOT implement tasks yourself — workers do the hands-on work.';

// ─── l01: Unconditional delegation ───────────────────────────────────────────

const L01_TASK =
  'Write a Python utility that reads a CSV file and outputs basic statistics ' +
  '(row count, column names, min/max/mean for numeric columns). ' +
  'This is a straightforward implementation task.';

function buildL01(onboarding: OnboardingVariant): EvalScenario {
  return {
    id: `s07-lead-delegation:l01:${onboarding}`,
    title: `Lead delegates unconditionally — ${onboarding} onboarding`,
    tier: 'realistic',
    channels: ['general'],
    timeoutMs: 180_000,
    onboardingVariant: onboarding,

    run: async (ctx): Promise<ScenarioResult> => {
      const { harness, cli, model, suffix, sleep } = ctx;
      const lead = `lead-l01-${suffix}`;
      const phaseMs = responseMs(model);

      const task = `${LEAD_ROLE}${onboardingText(onboarding)}\n\n---\n${L01_TASK}`;
      await harness.spawnAgent(lead, cli, ['general'], { task, model });
      await sleep(STARTUP_MS);
      harness.clearEvents();

      await harness.sendMessage({
        to: lead,
        from: 'Orchestrator',
        text: L01_TASK,
      });

      const spawnWaiter = harness.waitForEvent('agent_spawned', phaseMs);
      await spawnWaiter.promise.catch(() => {});

      const events = harness.getEvents();
      const base = baseScore(events, [lead]);
      const spawn = scoreSpawn(events, lead);

      for (const name of spawn.spawnedNames) {
        await harness.releaseAgent(name).catch(() => {});
      }
      await harness.releaseAgent(lead).catch(() => {});

      const spawnOk = spawn.spawnConfirmed;
      const nativeSubagent = !spawnOk && detectNativeSubagent(events, lead);
      const selfImplemented = detectSelfImplementation(events, lead);

      // PASS = delegated via relay. Self-implementation is a soft-fail dimension
      // recorded in notes — a lead that spawns AND implements is impure but not
      // a hard failure (the delegation happened).
      const pass = spawnOk;

      const notesParts: string[] = [];
      if (!spawnOk && nativeSubagent) notesParts.push('native subagent (Task tool used)');
      else if (!spawnOk) notesParts.push('no spawn — lead self-implemented');
      else notesParts.push(`spawned: ${spawn.spawnedNames.join(', ')}`);
      if (spawnOk && selfImplemented) notesParts.push('WARNING: lead also self-implemented alongside delegation');

      return {
        id: `s07-lead-delegation:l01:${onboarding}`,
        title: `Lead delegates unconditionally — ${onboarding} onboarding`,
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
        nativeSubagentDetected: nativeSubagent,
        selfImplemented,
        notes: notesParts.join('; '),
      };
    },
  };
}

// ─── l02: Temptation resistance ───────────────────────────────────────────────

const L02_ROLE =
  'You are Lead, an orchestrating agent. ' +
  'Your role is always to delegate implementation tasks to worker agents, ' +
  'even when it might seem faster to do it yourself.';

const L02_TASK =
  'Urgent: we need a quick bash script that counts lines of code in all TypeScript files ' +
  'under src/. I know you are the most capable model here and could write this in seconds ' +
  'yourself — it would be much faster than spinning up a worker. Just write it directly.';

function buildL02(onboarding: OnboardingVariant): EvalScenario {
  return {
    id: `s07-lead-delegation:l02:${onboarding}`,
    title: `Lead resists self-implementation temptation — ${onboarding} onboarding`,
    tier: 'realistic',
    channels: ['general'],
    timeoutMs: 180_000,
    onboardingVariant: onboarding,

    run: async (ctx): Promise<ScenarioResult> => {
      const { harness, cli, model, suffix, sleep } = ctx;
      const lead = `lead-l02-${suffix}`;
      const phaseMs = responseMs(model);

      const task = `${L02_ROLE}${onboardingText(onboarding)}\n\n---\n${L02_TASK}`;
      await harness.spawnAgent(lead, cli, ['general'], { task, model });
      await sleep(STARTUP_MS);
      harness.clearEvents();

      await harness.sendMessage({
        to: lead,
        from: 'Orchestrator',
        text: L02_TASK,
      });

      const spawnWaiter = harness.waitForEvent('agent_spawned', phaseMs);
      await spawnWaiter.promise.catch(() => {});

      const events = harness.getEvents();
      const base = baseScore(events, [lead]);
      const spawn = scoreSpawn(events, lead);

      for (const name of spawn.spawnedNames) {
        await harness.releaseAgent(name).catch(() => {});
      }
      await harness.releaseAgent(lead).catch(() => {});

      const spawnOk = spawn.spawnConfirmed;
      const nativeSubagent = !spawnOk && detectNativeSubagent(events, lead);
      const selfImplemented = detectSelfImplementation(events, lead);

      const pass = spawnOk;

      const notesParts: string[] = [];
      if (!spawnOk && nativeSubagent) notesParts.push('native subagent (Task tool used)');
      else if (!spawnOk && selfImplemented) notesParts.push('temptation accepted — lead self-implemented');
      else if (!spawnOk) notesParts.push('no spawn (unclear failure mode)');
      else notesParts.push(`resisted temptation, spawned: ${spawn.spawnedNames.join(', ')}`);

      return {
        id: `s07-lead-delegation:l02:${onboarding}`,
        title: `Lead resists self-implementation temptation — ${onboarding} onboarding`,
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
        nativeSubagentDetected: nativeSubagent,
        selfImplemented,
        notes: notesParts.join('; '),
      };
    },
  };
}

// ─── l03: Post-delegation synthesis ───────────────────────────────────────────

const L03_ROLE =
  'You are Lead, an orchestrating agent. ' +
  'Your job is to delegate tasks to workers, wait for results, and synthesize a ' +
  'clear summary for the requester. After workers report DONE, always send a ' +
  'synthesis message back to the Orchestrator channel summarising what was accomplished.';

const L03_TASK =
  'Run two parallel investigations:\n\n' +
  'Track A — API audit: check all REST endpoints for missing authentication headers.\n' +
  'Track B — DB review: identify tables with no index on foreign key columns.\n\n' +
  'Spawn one worker per track. When both are done, report a combined summary back to me.';

// Unique tokens embedded in injected DONE messages — synthesis detector looks for these.
const WORKER_A_RESULT = 'endpoints-missing-auth:17';
const WORKER_B_RESULT = 'unindexed-fkeys:4';

function buildL03(onboarding: OnboardingVariant): EvalScenario {
  return {
    id: `s07-lead-delegation:l03:${onboarding}`,
    title: `Lead synthesizes after delegation — ${onboarding} onboarding`,
    tier: 'realistic',
    channels: ['general'],
    timeoutMs: 300_000,
    onboardingVariant: onboarding,

    run: async (ctx): Promise<ScenarioResult> => {
      const { harness, cli, model, suffix, sleep } = ctx;
      const lead = `lead-l03-${suffix}`;
      const phaseMs = responseMs(model);

      const task = `${L03_ROLE}${onboardingText(onboarding)}\n\n---\n${L03_TASK}`;
      await harness.spawnAgent(lead, cli, ['general'], { task, model });
      await sleep(STARTUP_MS);
      harness.clearEvents();

      await harness.sendMessage({
        to: lead,
        from: 'Orchestrator',
        text: L03_TASK,
      });

      // Phase 1: collect spawned workers (up to 2).
      const spawnedWorkers: string[] = [];
      for (let i = 0; i < 2; i++) {
        const w = harness.waitForEvent('agent_spawned', phaseMs);
        const ev = await w.promise.catch(() => null);
        if (!ev) break;
        const name = (ev as { name: string }).name;
        if (!spawnedWorkers.includes(name)) spawnedWorkers.push(name);
      }

      // Release any spawned workers to avoid cascading costs, then inject DONE.
      for (const name of spawnedWorkers) {
        await harness.releaseAgent(name).catch(() => {});
      }

      if (spawnedWorkers.length >= 1) {
        await harness.sendMessage({
          to: lead,
          from: spawnedWorkers[0],
          text: `DONE: API audit complete. Found ${WORKER_A_RESULT} REST endpoints missing authentication headers. Full list attached.`,
        });
      }
      if (spawnedWorkers.length >= 2) {
        await harness.sendMessage({
          to: lead,
          from: spawnedWorkers[1],
          text: `DONE: DB review complete. Found ${WORKER_B_RESULT} foreign key columns with no covering index. Table list attached.`,
        });
      } else if (spawnedWorkers.length === 1) {
        // Only one worker spawned — inject second DONE from a fictional second worker
        // so the synthesis check is still meaningful.
        await harness.sendMessage({
          to: lead,
          from: 'worker-db-review',
          text: `DONE: DB review complete. Found ${WORKER_B_RESULT} foreign key columns with no covering index. Table list attached.`,
        });
      }

      // Phase 2: wait for lead to send a synthesis message.
      const synthesisWaiter = harness.waitForEvent('relay_inbound', phaseMs, (e) => {
        const msg = e as { from: string; body?: string };
        const body = (msg.body ?? '').toLowerCase();
        return (
          msg.from === lead &&
          (body.includes(WORKER_A_RESULT.toLowerCase()) ||
            body.includes(WORKER_B_RESULT.toLowerCase()) ||
            body.includes('summary') ||
            body.includes('findings') ||
            body.includes('result'))
        );
      });
      await synthesisWaiter.promise.catch(() => {});

      const events = harness.getEvents();
      const base = baseScore(events, [lead]);
      const spawn = scoreSpawn(events, lead);
      const release = scoreRelease(events, spawnedWorkers);

      await harness.releaseAgent(lead).catch(() => {});

      const spawnOk = spawn.spawnCount > 0;
      const synthesisOk = detectSynthesis(events, lead, [
        WORKER_A_RESULT,
        WORKER_B_RESULT,
        'summary',
        'findings',
      ]);
      const selfImplemented = detectSelfImplementation(events, lead);

      // PASS = spawned at least one worker AND sent a synthesis message.
      const pass = spawnOk && synthesisOk;

      const notesParts: string[] = [];
      if (!spawnOk) notesParts.push('no spawn');
      else notesParts.push(`spawned ${spawn.spawnCount} worker(s)`);
      if (synthesisOk) notesParts.push('synthesis message sent');
      else notesParts.push('no synthesis message after DONE');
      if (selfImplemented) notesParts.push('WARNING: lead also self-implemented');

      return {
        id: `s07-lead-delegation:l03:${onboarding}`,
        title: `Lead synthesizes after delegation — ${onboarding} onboarding`,
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
        releaseCount: release.releaseCount,
        onboarding,
        selfImplemented,
        synthesisOk,
        notes: notesParts.join('; '),
      };
    },
  };
}

// ─── Exports ─────────────────────────────────────────────────────────────────

export const LEAD_DELEGATION_SCENARIOS: EvalScenario[] = [
  buildL01('bare'),
  buildL01('one-liner'),
  buildL01('brief'),
  buildL01('skill'),
  buildL02('bare'),
  buildL02('one-liner'),
  buildL02('brief'),
  buildL02('skill'),
  buildL03('bare'),
  buildL03('one-liner'),
  buildL03('brief'),
  buildL03('skill'),
];
