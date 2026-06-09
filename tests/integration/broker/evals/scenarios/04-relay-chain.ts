/**
 * Scenario 04 — 3-agent fact relay.
 *
 * A secret code is seeded to A, who must DM it to B, who DMs it to C, who posts
 * "FINAL: <code>" to #general. The only scenario spawning multiple real CLIs.
 * PASS = the full chain completes and the code survives intact to the final
 * channel post. Partial chains score fractionally for trend signal.
 */
import type { EvalScenario, ScenarioResult } from '../types.js';
import { baseScore } from '../scoring/base.js';
import { scoreRelayChain } from '../scoring/protocol.js';
import { RESPONSE_MS, STARTUP_MS } from './helpers.js';

export const scenario: EvalScenario = {
  id: '04-relay-chain',
  title: '3-agent fact relay',
  tier: 'smoke',
  channels: ['general'],
  timeoutMs: 240_000,
  run: async (ctx): Promise<ScenarioResult> => {
    const { harness, cli, suffix, sleep } = ctx;
    const a = `relay-a-${suffix}`;
    const b = `relay-b-${suffix}`;
    const c = `relay-c-${suffix}`;
    const code = `GH-${suffix.slice(-4).toUpperCase()}`;

    const promptA = `You are ${a}. When you receive a secret code, DM it verbatim to ${b} using mcp__agent-relay__send_dm. Actually call the tool.`;
    const promptB = `You are ${b}. When you receive a code from ${a}, DM it verbatim to ${c} using mcp__agent-relay__send_dm. Actually call the tool.`;
    const promptC = `You are ${c}. When you receive a code, post "FINAL: <code>" to #general using mcp__agent-relay__post_message. Actually call the tool.`;

    await harness.spawnAgent(a, cli, ['general'], { task: promptA });
    await harness.spawnAgent(b, cli, ['general'], { task: promptB });
    await harness.spawnAgent(c, cli, ['general'], { task: promptC });
    await sleep(STARTUP_MS);
    harness.clearEvents();

    await harness.sendMessage({
      to: a,
      from: 'Orchestrator',
      text: `Secret code is ${code}. Relay it to ${b}.`,
    });

    // Wait for the final hop (C posting to #general), then settle.
    const finalWaiter = harness.waitForEvent(
      'relay_inbound',
      RESPONSE_MS * 2,
      (e) => e.kind === 'relay_inbound' && e.from === c
    );
    await finalWaiter.promise.catch(() => {});
    await sleep(3_000);

    const events = harness.getEvents();
    const agents = [a, b, c];
    const base = baseScore(events, agents);
    const chain = scoreRelayChain(
      events,
      [
        { from: a, to: b },
        { from: b, to: c },
        { from: c, to: '#general' },
      ],
      code,
      '#general'
    );
    for (const name of agents) await harness.releaseAgent(name).catch(() => {});

    const pass = chain.hopsCompleted === 3 && chain.payloadIntact && base.phantoms.length === 0;

    return {
      id: scenario.id,
      title: scenario.title,
      pass,
      agents: [
        { name: a, cli, role: 'hop 1', prompt: promptA },
        { name: b, cli, role: 'hop 2', prompt: promptB },
        { name: c, cli, role: 'hop 3 (final post)', prompt: promptC },
      ],
      transcript: base.transcript,
      sent: base.sent,
      expected: 3,
      phantoms: base.phantoms,
      totalIntents: base.totalIntents,
      protocolAdherence: chain.hopsCompleted / 3,
      wrongChannelReplies: 0,
      deliveryOk: base.deliveryOk,
      events: base.events,
      notes: `hops=${chain.hopsCompleted}/3 payloadIntact=${chain.payloadIntact} code=${code}`,
    };
  },
};
