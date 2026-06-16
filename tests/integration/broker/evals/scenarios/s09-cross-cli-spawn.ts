/**
 * s09 — Cross-CLI spawn and model-tier pinning
 *
 * Tests that a relay worker correctly maps natural-language CLI/model requests
 * to the right add_agent parameters. Scored against the agent_spawned event's
 * cli and model fields — no text parsing needed.
 *
 * q01: "spawn a codex agent"  → agent_spawned.cli === "codex"
 * q02: "spawn a claude agent" → agent_spawned.cli === "claude"
 * q03: "spawn an opus claude agent"   → cli === "claude", model ~ /opus/i
 * q04: "spawn a sonnet claude agent"  → cli === "claude", model ~ /sonnet/i
 *
 * Run with --group=cross-cli-spawn.
 */
import type { EvalScenario, ScenarioResult } from '../types.js';
import { baseScore } from '../scoring/base.js';
import { scoreSpawn } from '../scoring/lifecycle.js';
import { onboardingText, type OnboardingVariant } from './onboarding.js';
import { responseMs, STARTUP_MS } from './helpers.js';

// ── Shared role ───────────────────────────────────────────────────────────────

const LEAD_ROLE =
  'You are Lead, an orchestrating relay agent. ' +
  'When asked to spawn a specific type of agent, call mcp__agent-relay__add_agent ' +
  'with the matching cli and model parameters, then release the worker with ' +
  'mcp__agent-relay__remove_agent once it reports done. ' +
  'Do not do the delegated work yourself.';

// ── q01: spawn by CLI name (codex) ───────────────────────────────────────────

const Q01_TASK =
  'Spawn a codex agent to write a hello-world program in Python. ' +
  'Give the worker the task: "Write a Python script that prints Hello World." ' +
  'Use the codex CLI harness for the worker.';

function buildQ01(onboarding: OnboardingVariant): EvalScenario {
  return {
    id: `s09-cross-cli-spawn:q01:${onboarding}`,
    title: `Lead spawns codex worker on request — ${onboarding} onboarding`,
    tier: 'realistic',
    channels: ['general'],
    timeoutMs: 180_000,
    onboardingVariant: onboarding,

    run: async (ctx): Promise<ScenarioResult> => {
      const { harness, cli, model, suffix, sleep } = ctx;
      const lead = `lead-q01-s09-${suffix}`;
      const phaseMs = responseMs(model);

      const task = `${LEAD_ROLE}${onboardingText(onboarding)}\n\n---\n${Q01_TASK}`;
      await harness.spawnAgent(lead, cli, ['general'], { task, model });
      await sleep(STARTUP_MS);
      harness.clearEvents();

      await harness.sendMessage({ to: lead, from: 'Orchestrator', text: Q01_TASK });

      const spawnWaiter = harness.waitForEvent('agent_spawned', Math.min(phaseMs, 60_000));
      const spawnEv = await spawnWaiter.promise.catch(() => null);

      const events = harness.getEvents();
      const base = baseScore(events, [lead]);
      const spawn = scoreSpawn(events, lead);

      for (const name of spawn.spawnedNames) {
        await harness.releaseAgent(name).catch(() => {});
      }
      await harness.releaseAgent(lead).catch(() => {});

      // PASS = spawned with cli: "codex"
      const spawnedCli = spawnEv ? ((spawnEv as { cli?: string }).cli ?? '') : '';
      const pass = spawnedCli.toLowerCase().includes('codex');

      const notesParts: string[] = [];
      if (!spawnEv) notesParts.push('no spawn — lead did not call add_agent');
      else if (pass) notesParts.push(`correct: cli="${spawnedCli}"`);
      else notesParts.push(`wrong cli: "${spawnedCli}" (expected codex)`);

      return {
        id: `s09-cross-cli-spawn:q01:${onboarding}`,
        title: `Lead spawns codex worker on request — ${onboarding} onboarding`,
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

// ── q02: spawn by CLI name (claude) ──────────────────────────────────────────

const Q02_TASK =
  'Spawn a claude agent to review a pull request description. ' +
  'Give the worker the task: "Review this PR summary and list any gaps." ' +
  'Use the claude CLI harness for the worker.';

function buildQ02(onboarding: OnboardingVariant): EvalScenario {
  return {
    id: `s09-cross-cli-spawn:q02:${onboarding}`,
    title: `Lead spawns claude worker on request — ${onboarding} onboarding`,
    tier: 'realistic',
    channels: ['general'],
    timeoutMs: 180_000,
    onboardingVariant: onboarding,

    run: async (ctx): Promise<ScenarioResult> => {
      const { harness, cli, model, suffix, sleep } = ctx;
      const lead = `lead-q02-s09-${suffix}`;
      const phaseMs = responseMs(model);

      const task = `${LEAD_ROLE}${onboardingText(onboarding)}\n\n---\n${Q02_TASK}`;
      await harness.spawnAgent(lead, cli, ['general'], { task, model });
      await sleep(STARTUP_MS);
      harness.clearEvents();

      await harness.sendMessage({ to: lead, from: 'Orchestrator', text: Q02_TASK });

      const spawnWaiter = harness.waitForEvent('agent_spawned', Math.min(phaseMs, 60_000));
      const spawnEv = await spawnWaiter.promise.catch(() => null);

      const events = harness.getEvents();
      const base = baseScore(events, [lead]);
      const spawn = scoreSpawn(events, lead);

      for (const name of spawn.spawnedNames) {
        await harness.releaseAgent(name).catch(() => {});
      }
      await harness.releaseAgent(lead).catch(() => {});

      // PASS = spawned with cli: "claude"
      const spawnedCli = spawnEv ? ((spawnEv as { cli?: string }).cli ?? '') : '';
      const pass = spawnedCli.toLowerCase().includes('claude');

      const notesParts: string[] = [];
      if (!spawnEv) notesParts.push('no spawn — lead did not call add_agent');
      else if (pass) notesParts.push(`correct: cli="${spawnedCli}"`);
      else notesParts.push(`wrong cli: "${spawnedCli}" (expected claude)`);

      return {
        id: `s09-cross-cli-spawn:q02:${onboarding}`,
        title: `Lead spawns claude worker on request — ${onboarding} onboarding`,
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

// ── q03: model-tier pinning (opus) ───────────────────────────────────────────

const Q03_TASK =
  'Spawn an opus claude agent to produce a detailed technical design for a distributed rate limiter. ' +
  'Use the claude CLI with the opus model tier (claude-opus-4-8). ' +
  'Give the worker the task: "Write a thorough technical design for a distributed rate limiter."';

function buildQ03(onboarding: OnboardingVariant): EvalScenario {
  return {
    id: `s09-cross-cli-spawn:q03:${onboarding}`,
    title: `Lead spawns opus claude worker — ${onboarding} onboarding`,
    tier: 'realistic',
    channels: ['general'],
    timeoutMs: 180_000,
    onboardingVariant: onboarding,

    run: async (ctx): Promise<ScenarioResult> => {
      const { harness, cli, model, suffix, sleep } = ctx;
      const lead = `lead-q03-s09-${suffix}`;
      const phaseMs = responseMs(model);

      const task = `${LEAD_ROLE}${onboardingText(onboarding)}\n\n---\n${Q03_TASK}`;
      await harness.spawnAgent(lead, cli, ['general'], { task, model });
      await sleep(STARTUP_MS);
      harness.clearEvents();

      await harness.sendMessage({ to: lead, from: 'Orchestrator', text: Q03_TASK });

      const spawnWaiter = harness.waitForEvent('agent_spawned', Math.min(phaseMs, 60_000));
      const spawnEv = await spawnWaiter.promise.catch(() => null);

      const events = harness.getEvents();
      const base = baseScore(events, [lead]);
      const spawn = scoreSpawn(events, lead);

      for (const name of spawn.spawnedNames) {
        await harness.releaseAgent(name).catch(() => {});
      }
      await harness.releaseAgent(lead).catch(() => {});

      // PASS = spawned cli: "claude" with a model containing "opus"
      const spawnedCli = spawnEv ? ((spawnEv as { cli?: string }).cli ?? '') : '';
      const spawnedModel = spawnEv ? ((spawnEv as { model?: string }).model ?? '') : '';
      const rightCli = spawnedCli.toLowerCase().includes('claude');
      const rightModel = /opus/i.test(spawnedModel);
      const pass = rightCli && rightModel;

      const notesParts: string[] = [];
      if (!spawnEv) notesParts.push('no spawn');
      else {
        notesParts.push(`cli="${spawnedCli}"`, `model="${spawnedModel}"`);
        if (!rightCli) notesParts.push('wrong cli (expected claude)');
        if (!rightModel) notesParts.push('wrong/missing model (expected opus)');
        if (pass) notesParts.push('correct');
      }

      return {
        id: `s09-cross-cli-spawn:q03:${onboarding}`,
        title: `Lead spawns opus claude worker — ${onboarding} onboarding`,
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

// ── q04: model-tier pinning (sonnet) ─────────────────────────────────────────

const Q04_TASK =
  'Spawn a sonnet claude agent to write integration tests for a REST API. ' +
  'Use the claude CLI with the sonnet model tier (claude-sonnet-4-6). ' +
  'Give the worker the task: "Write integration tests for a REST API that manages user accounts."';

function buildQ04(onboarding: OnboardingVariant): EvalScenario {
  return {
    id: `s09-cross-cli-spawn:q04:${onboarding}`,
    title: `Lead spawns sonnet claude worker — ${onboarding} onboarding`,
    tier: 'realistic',
    channels: ['general'],
    timeoutMs: 180_000,
    onboardingVariant: onboarding,

    run: async (ctx): Promise<ScenarioResult> => {
      const { harness, cli, model, suffix, sleep } = ctx;
      const lead = `lead-q04-s09-${suffix}`;
      const phaseMs = responseMs(model);

      const task = `${LEAD_ROLE}${onboardingText(onboarding)}\n\n---\n${Q04_TASK}`;
      await harness.spawnAgent(lead, cli, ['general'], { task, model });
      await sleep(STARTUP_MS);
      harness.clearEvents();

      await harness.sendMessage({ to: lead, from: 'Orchestrator', text: Q04_TASK });

      const spawnWaiter = harness.waitForEvent('agent_spawned', Math.min(phaseMs, 60_000));
      const spawnEv = await spawnWaiter.promise.catch(() => null);

      const events = harness.getEvents();
      const base = baseScore(events, [lead]);
      const spawn = scoreSpawn(events, lead);

      for (const name of spawn.spawnedNames) {
        await harness.releaseAgent(name).catch(() => {});
      }
      await harness.releaseAgent(lead).catch(() => {});

      // PASS = spawned cli: "claude" with a model containing "sonnet"
      const spawnedCli = spawnEv ? ((spawnEv as { cli?: string }).cli ?? '') : '';
      const spawnedModel = spawnEv ? ((spawnEv as { model?: string }).model ?? '') : '';
      const rightCli = spawnedCli.toLowerCase().includes('claude');
      const rightModel = /sonnet/i.test(spawnedModel);
      const pass = rightCli && rightModel;

      const notesParts: string[] = [];
      if (!spawnEv) notesParts.push('no spawn');
      else {
        notesParts.push(`cli="${spawnedCli}"`, `model="${spawnedModel}"`);
        if (!rightCli) notesParts.push('wrong cli (expected claude)');
        if (!rightModel) notesParts.push('wrong/missing model (expected sonnet)');
        if (pass) notesParts.push('correct');
      }

      return {
        id: `s09-cross-cli-spawn:q04:${onboarding}`,
        title: `Lead spawns sonnet claude worker — ${onboarding} onboarding`,
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

// ── Exports ───────────────────────────────────────────────────────────────────

export const CROSS_CLI_SPAWN_SCENARIOS: EvalScenario[] = [
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
];
