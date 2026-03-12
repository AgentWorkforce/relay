/**
 * Ralph Loop — Claude + Codex pair-programming through a PRD.
 *
 * Each iteration spawns TWO agents that work together simultaneously:
 *   - Claude (PTY) — the architect. Plans, guides, and reviews.
 *   - Codex (PTY, --full-auto) — the builder. Implements the code.
 *
 * Both agents join #general and communicate in real-time:
 *   1. Claude receives the story and posts an implementation plan
 *   2. Codex receives the story + sees Claude's plan on #general
 *   3. As Codex works, Claude can course-correct via the channel
 *   4. When Codex finishes, Claude reviews and posts REVIEW:PASS/FAIL
 *   5. Quality checks run, story marked done or retried with feedback
 *
 * Why two agents instead of one?
 *   - Claude reasons about architecture, Codex executes rapidly
 *   - They see each other's messages in real-time (not just handoffs)
 *   - Fresh eyes on review catch mistakes a single agent misses
 *   - Each iteration is doubly effective — thinking + doing in parallel
 *
 * Run:
 *   npx tsc && npm run ralph
 *
 * References:
 *   https://github.com/snarktank/ralph
 *   https://ghuntley.com/ralph/
 */
import fs from "node:fs";
import { execSync } from "node:child_process";
import { AgentRelay, type Agent, type Message } from "../relay.js";

// ── Types ───────────────────────────────────────────────────────────────────

interface Story {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  passes: boolean;
}

interface Prd {
  branchName: string;
  userStories: Story[];
}

// ── Configuration ───────────────────────────────────────────────────────────

const PRD_PATH = process.env.PRD_PATH ?? "prd.json";
const PROGRESS_PATH = process.env.PROGRESS_PATH ?? "progress.txt";
const MAX_ITERATIONS = Number(process.env.MAX_ITERATIONS ?? 10);
const MAX_REVIEW_ROUNDS = Number(process.env.MAX_REVIEW_ROUNDS ?? 2);
const QUALITY_CMD = process.env.QUALITY_CMD ?? "npm run check";
/** Max time (ms) to wait for both agents per round before releasing them. */
const ROUND_TIMEOUT_MS = Number(process.env.ROUND_TIMEOUT_MS ?? 5 * 60 * 1000);

// ── Helpers ─────────────────────────────────────────────────────────────────

function loadPrd(): Prd {
  return JSON.parse(fs.readFileSync(PRD_PATH, "utf-8"));
}

function savePrd(prd: Prd): void {
  fs.writeFileSync(PRD_PATH, JSON.stringify(prd, null, 2) + "\n");
}

function appendProgress(entry: string): void {
  const line = `[${new Date().toISOString()}] ${entry}\n`;
  fs.appendFileSync(PROGRESS_PATH, line);
}

function readProgress(): string {
  return fs.existsSync(PROGRESS_PATH)
    ? fs.readFileSync(PROGRESS_PATH, "utf-8")
    : "";
}

function nextStory(prd: Prd): Story | undefined {
  return prd.userStories.find((s) => !s.passes);
}

function runQualityChecks(): { passed: boolean; output: string } {
  try {
    const output = execSync(QUALITY_CMD, { encoding: "utf-8", stdio: "pipe" });
    return { passed: true, output };
  } catch (err: unknown) {
    const output = (err as { stdout?: string }).stdout ?? String(err);
    return { passed: false, output };
  }
}

// ── Prompt builders ─────────────────────────────────────────────────────────

function architectPrompt(story: Story, progress: string): string {
  const criteria = story.acceptanceCriteria.map((c) => `  - ${c}`).join("\n");
  return [
    `## Architect: ${story.title}`,
    ``,
    `You are the architect. A Codex agent ("Builder") is working alongside you.`,
    `You are both on the #general channel and can communicate freely.`,
    ``,
    `### How to communicate`,
    `Use the Relaycast MCP tools to post messages to #general:`,
    `1. Call workspace.set_key with your RELAY_API_KEY env var`,
    `2. Call agent.register with your name`,
    `3. Use message.post to send to the #general channel`,
    ``,
    story.description,
    ``,
    `### Acceptance Criteria`,
    criteria,
    ``,
    `### Previous Learnings`,
    progress || "(first story)",
    ``,
    `### Your job`,
    `1. Post a concise implementation plan to #general (files, changes, edge cases)`,
    `2. Monitor the Builder's progress messages on the channel`,
    `3. Provide guidance if the Builder asks questions or goes off track`,
    `4. When the Builder says it's done, review the git diff`,
    `5. Post exactly "REVIEW:PASS" to #general if all criteria are met`,
    `6. Post exactly "REVIEW:FAIL" followed by feedback to #general if issues remain`,
    ``,
    `IMPORTANT: You MUST use Relaycast MCP tools to post messages. This is how`,
    `the orchestrator knows you're done. Post your plan first, then your verdict.`,
  ].join("\n");
}

function builderPrompt(story: Story, progress: string, reviewFeedback?: string): string {
  const criteria = story.acceptanceCriteria.map((c) => `  - ${c}`).join("\n");
  const sections = [
    `## Builder: ${story.title}`,
    ``,
    `You are the builder. A Claude agent ("Architect") is guiding you on #general.`,
    `Read the Architect's plan from the channel and implement it.`,
    ``,
    `### How to communicate`,
    `Use the Relaycast MCP tools to post messages to #general:`,
    `1. Call workspace.set_key with your RELAY_API_KEY env var`,
    `2. Call agent.register with your name`,
    `3. Use message.post to send to the #general channel`,
    ``,
    story.description,
    ``,
    `### Acceptance Criteria`,
    criteria,
  ];

  if (reviewFeedback) {
    sections.push(
      ``,
      `### Review Feedback (fix these issues first)`,
      reviewFeedback,
    );
  }

  sections.push(
    ``,
    `### Previous Learnings`,
    progress || "(first story)",
    ``,
    `### Your job`,
    `1. Read the Architect's plan from #general`,
    `2. Implement the changes`,
    `3. Post progress updates to #general as you work`,
    `4. When done, post exactly "IMPLEMENTATION COMPLETE" to #general`,
    ``,
    `IMPORTANT: You MUST use Relaycast MCP tools to post messages. This is how`,
    `the orchestrator knows you're done.`,
  );

  return sections.join("\n");
}

// ── Main loop ───────────────────────────────────────────────────────────────

const relay = new AgentRelay({ env: process.env });

const channelLog: Message[] = [];

relay.onMessageReceived = (msg) => {
  channelLog.push(msg);
  console.log(`  💬 ${msg.from}: "${msg.text.slice(0, 80)}…"`);
};

relay.onAgentSpawned = (agent) => console.log(`  🟢 ${agent.name} spawned (${agent.runtime})`);
relay.onAgentReleased = (agent) => console.log(`  🔴 ${agent.name} released`);
relay.onAgentExited = (agent) => console.log(`  ⚪ ${agent.name} exited`);
relay.onMessageSent = (msg) => console.log(`  📤 → ${msg.to}: "${msg.text.slice(0, 60)}…"`);

const prd = loadPrd();
const orchestrator = relay.human({ name: "Ralph" });

console.log(`\n══ Ralph Loop (Claude + Codex) ══`);
console.log(`  branch: ${prd.branchName}`);
console.log(`  stories: ${prd.userStories.length}`);
console.log(`  remaining: ${prd.userStories.filter((s) => !s.passes).length}`);
console.log(`  max iterations: ${MAX_ITERATIONS}`);
console.log(`  max review rounds: ${MAX_REVIEW_ROUNDS}\n`);

let iteration = 0;

while (iteration < MAX_ITERATIONS) {
  const story = nextStory(prd);
  if (!story) break;

  iteration++;
  console.log(`\n── Story ${story.id}: ${story.title} (iteration ${iteration}) ──\n`);

  let reviewFeedback: string | undefined;
  let storyPassed = false;

  for (let round = 0; round < MAX_REVIEW_ROUNDS; round++) {
    const roundLabel = round === 0 ? "initial" : `fix-${round}`;
    const progress = readProgress();

    // ── Spawn both agents concurrently ──────────────────────────────────
    console.log(`  ⚡ Spawning Claude (architect) + Codex (builder) — round: ${roundLabel}`);

    const [architect, builder] = await Promise.all([
      relay.claude.spawn({
        name: `Architect-${story.id}-${roundLabel}`,
        channels: ["general"],
      }),
      relay.codex.spawn({
        name: `Builder-${story.id}-${roundLabel}`,
        args: ["--full-auto"],
        channels: ["general"],
      }),
    ]);

    // ── Inject tasks via relay ──────────────────────────────────────────
    // Claude gets the architect prompt first so it can post the plan
    await orchestrator.sendMessage({
      to: architect.name,
      text: architectPrompt(story, progress),
    });

    // Small delay so Claude's plan arrives before Codex starts reading
    await new Promise((r) => setTimeout(r, 2000));

    await orchestrator.sendMessage({
      to: builder.name,
      text: builderPrompt(story, progress, reviewFeedback),
    });

    // ── Wait for agents to finish or detect completion ────────────────────
    // Interactive agents don't exit on their own, so we poll channel
    // messages for completion signals and release them when done.
    console.log(`  ⏳ Claude + Codex working together on #general…`);

    const startLen = channelLog.length;
    const deadline = Date.now() + ROUND_TIMEOUT_MS;
    let verdict: string | undefined;

    // Poll every 5s for completion signals in channel messages
    while (Date.now() < deadline) {
      const recent = channelLog.slice(startLen);

      // Check if Claude posted a review verdict
      const review = recent.find(
        (m) => m.text.includes("REVIEW:PASS") || m.text.includes("REVIEW:FAIL"),
      );
      if (review) {
        verdict = review.text;
        console.log(`  📋 Claude posted verdict`);
        break;
      }

      // Check if Codex signaled completion (Claude may still be reviewing)
      const implDone = recent.find((m) => m.text.includes("IMPLEMENTATION COMPLETE"));
      if (implDone) {
        console.log(`  📋 Codex finished, waiting for Claude's review…`);
        // Give Claude up to 60s more to post a verdict
        const reviewDeadline = Date.now() + 60_000;
        while (Date.now() < reviewDeadline) {
          await new Promise((r) => setTimeout(r, 3000));
          const afterImpl = channelLog.slice(startLen);
          const rv = afterImpl.find(
            (m) => m.text.includes("REVIEW:PASS") || m.text.includes("REVIEW:FAIL"),
          );
          if (rv) { verdict = rv.text; break; }
        }
        break;
      }

      // Check if either agent exited on its own
      const archResult = await architect.waitForExit(0);
      const buildResult = await builder.waitForExit(0);
      if (archResult !== "timeout" && buildResult !== "timeout") break;

      await new Promise((r) => setTimeout(r, 5000));
    }

    // Release both agents (they're interactive so won't exit on their own)
    const cleanup = async (agent: Agent) => {
      try { await agent.release(); } catch { /* already exited */ }
    };
    await Promise.all([cleanup(architect), cleanup(builder)]);

    // ── Quality gate ────────────────────────────────────────────────────
    console.log(`  🔍 running quality checks…`);
    const quality = runQualityChecks();

    if (!quality.passed) {
      appendProgress(`❌ ${story.id} round=${roundLabel} — quality checks failed`);
      reviewFeedback = `Quality checks failed:\n${quality.output.slice(0, 500)}`;
      console.log(`  ❌ quality checks failed\n`);
      continue;
    }

    // ── Check verdict ─────────────────────────────────────────────────────
    if (verdict?.includes("REVIEW:PASS")) {
      storyPassed = true;
      appendProgress(`✅ ${story.id} — ${story.title} — PASSED (round=${roundLabel})`);
      console.log(`  ✅ story passed!\n`);
      break;
    } else if (verdict?.includes("REVIEW:FAIL")) {
      const failText = verdict.replace("REVIEW:FAIL", "").trim();
      reviewFeedback = failText;
      appendProgress(
        `🔄 ${story.id} round=${roundLabel} — review failed: ${reviewFeedback.slice(0, 200)}`,
      );
      console.log(`  🔄 review failed, starting new round\n`);
    } else {
      // No verdict from Claude — quality passed so accept it
      storyPassed = true;
      appendProgress(`✅ ${story.id} — ${story.title} — PASSED (quality only, round=${roundLabel})`);
      console.log(`  ✅ quality passed (no explicit review verdict)\n`);
      break;
    }
  }

  if (storyPassed) {
    story.passes = true;
    savePrd(prd);
  } else {
    appendProgress(`⚠️ ${story.id} — exhausted review rounds, moving on`);
    console.log(`  ⚠️ exhausted ${MAX_REVIEW_ROUNDS} review rounds for ${story.id}\n`);
  }
}

// ── Summary ─────────────────────────────────────────────────────────────────

const remaining = prd.userStories.filter((s) => !s.passes);
if (remaining.length === 0) {
  console.log(`\n🎉 COMPLETE — all stories pass.`);
} else {
  console.log(`\n⚠️ ${remaining.length} stories remain after ${iteration} iterations.`);
}

await relay.shutdown();
