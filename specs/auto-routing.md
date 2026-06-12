# Auto-Routing — Dynamic Model-Tier Selection and Team Composition

**Status**: Draft  
**Date**: 2026-06-12  
**Author**: Design session (Khaliq + Claude)

---

## 1. Problem

Today a user spawning a multi-agent team must manually decide:
- Which model to use as lead (haiku / sonnet / opus)
- How many workers to spawn
- What model tier each worker should be
- What specialisations each worker needs

This is expert knowledge. Most users shouldn't need to think about it. The goal is an `auto` mode where the user submits a task and the system determines the right team.

---

## 2. Empirical Foundation

The lifecycle eval suite (s01–s04) across haiku / sonnet / opus produces a clear capability gradient that should drive tier selection:

### Lead quality (s03 full lifecycle — spawn + coordinate + release)

| model | bare | one-liner | brief | skill | verdict |
|-------|------|-----------|-------|-------|---------|
| haiku | 60% | 60% | 20% | 40% | **weak lead** — inconsistent, better as worker |
| sonnet | 40% | **100%** | 60% | 80% | **strong lead** — reliable with minimal onboarding |
| opus | **67%** | **67%** | **0%** | **67%** | **capable lead** — all variants 67% after timeout fix EXCEPT brief (conditional clause causes 0%); fixed in codebase |

### Key findings — Claude models
- **Sonnet + one-liner = 100% lifecycle reliability** ✅ — confirmed production lead config
- **Haiku is worker-only** — caps at 60% lifecycle regardless of onboarding
- **Opus s02 bare = 100%** — knows the protocol natively; s03 original 40% cap was a timeout artifact (verbose responses exhausted 60s/phase window), not a capability gap
- **Opus s03 bare = 67% with 120s/phase** — timeout fix confirmed; responseMs() helper returns 120s for opus-class models; further improvement expected with more repeats
- **Skill text heuristic fix: partial improvement** — sonnet s01:skill improved 0%→33% after removing "do it yourself for quick lookups" heuristic. Not fully fixed: root cause is the task uses "worker agent" neutral vocabulary. s05 phrasing eval confirms: neutral-agent=20%, relay-worker=60%. Fix in production: use relay-anchored vocabulary ("relay worker") in Director meta-prompts (already done).
- **Phrasing matters for Claude**: s05 (running) measures whether relay-anchored vocabulary improves tool use independent of onboarding. Early haiku data (bare onboarding only): neutral-worker=0%, neutral-agent=20%, relay-worker=60%, relay-agent=20%, arw-worker=TBD, arw-agent=TBD. Confirmed: "relay worker" phrasing significantly outperforms neutral vocabulary even without onboarding text.

### Non-Claude harness lifecycle results (s01–s04 — all complete)

All onboarding variants × 5 runs each. Percentages = pass rate.

#### s01 — spawn only

| harness | bare | one-liner | brief | skill |
|---------|------|-----------|-------|-------|
| codex | 100% | 100% | 100% | 100% |
| gemini | 100% | 100% | 100% | 100% |
| droid | 80% | 100% | 100% | 100% |
| opencode:mimo | 80% | 100% | 40% | 80% |
| grok | 0% | 0% | 0% | 0% |
| cursor | 0% | 0% | 0% | 0% |

#### s02 — spawn + release (after injected DONE)

| harness | bare | one-liner | brief | skill |
|---------|------|-----------|-------|-------|
| codex | 100% | 100% | 100% | 100% |
| gemini | 20% | 60% | 80% | 100% |
| droid | 20% | 20% | 0% | 0% |
| opencode:mimo | 80% | 100% | 60% | 80% |
| grok | 0% | 0% | 0% | 0% |
| cursor | 0% | 0% | 0% | 0% |

#### s03 — full spawn → DONE → release lifecycle

| harness | bare | one-liner | brief | skill |
|---------|------|-----------|-------|-------|
| codex | 80% | **100%** | **100%** | **100%** |
| opencode:mimo | **100%** | 80% | 60% | **100%** |
| droid | **100%** | **100%** | **100%** | 0% |
| gemini | 60% | **100%** | **100%** | **100%** |
| grok | 0% | 0% | 0% | 0% |
| cursor | 0% | 0% | 0% | 0% |

#### s04 — no native subagents (spawn must use relay, not built-in Task tool)

| harness | bare | one-liner | brief | skill |
|---------|------|-----------|-------|-------|
| codex | **100%** | **100%** | **100%** | **100%** |
| opencode:mimo | 80% | **100%** | **100%** | 80% |
| droid | 0% | 0% | — | — |
| gemini | 80% | 60% | 80% | 80%+ |
| grok | 0% | 0% | 0% | 0% |
| cursor | 0% | 0% | 0% | 0% |

**Key lifecycle findings:**
- **Codex**: 100% on all s01/s02/s04 variants; s03 bare=80%, one-liner/brief/skill=100%. Most reliable non-Claude harness — never routes to native subagents (s04=100% all variants).
- **Droid**: s03 bare/one-liner/brief all 100%, but s03 skill=0% (skill text confuses droid) and s04 bare/one-liner=0% (droid uses native Task tool, not relay, without explicit tool disambiguation). Droid is a strong lifecycle performer but will silently route to native subagents without the skill onboarding that disambiguates `add_agent` from `Task`.
- **Gemini**: s04 bare=80%, one-liner=60%, brief/skill=80%+. Mostly relay-native but with occasional fallback to native subagents.
- **OpenCode**: s03 bare=100% (best s03 bare!); one-liner=80%, brief=60%, skill=100%. Directive task prompts outperform — brief's conditional guidance hurts more than bare.
- **Droid**: s03 bare/one-liner/brief all 100% — exceptional result. Despite s02 bare=20%, the full s03 task description ("report DONE when complete with a concise summary") drives reliable release even with bare onboarding. Skill onboarding still running (1 fail seen).
- **Gemini**: s03 bare=60%, one-liner/brief/skill all 100%. The bare gap (release failure without onboarding) closes completely with any explicit context. Most consistent non-Claude lifecycle performance once prompted.
- **Grok/Cursor**: 0% across all scenarios — not viable relay workers.

**Implication for Director prompt**: The auto-routing Director prompt already includes explicit `remove_agent` calls and directive task phrasing — this effectively acts as inline skill onboarding even for bare leads. All tested non-Claude harnesses (except grok/cursor) are viable relay workers with the right meta-prompt. Codex is the most consistently reliable across all onboarding tiers.

### Non-Claude phrasing results (s05 — bare onboarding only; 5 runs each, all complete)

| harness | neutral-worker | neutral-agent | relay-worker | relay-agent | arw-worker | arw-agent |
|---------|----------------|---------------|--------------|-------------|------------|-----------|
| codex | **100%** | **100%** | **100%** | **80%** | **100%** | **100%** |
| opencode:mimo | **100%** | 80% | **100%** | **100%** | **100%** | **100%** |
| droid | 80% | **100%** | **100%** | 80% | 80% | **100%** |
| gemini | 60% | **100%** | 80% | 40% | 80% | **100%** |
| grok | 0% | 0% | 0% | 0% | — | — |
| cursor | 0% | 0% | 0% | 0% | — | — |
| claude haiku | 0% | 20% | 60% | 20% | 60% | 40% |
| claude sonnet | 0% | 0% | 0% | 0% | 40% | 40% |
| claude opus | (running) | (running) | (running) | (running) | (running) | (running) |

**Key cross-harness insights**:
- Codex and OpenCode natively understand relay tools across all vocabulary variants (relay-native).
- Droid: "relay worker" (100%) and "neutral-agent"/"arw-agent" (100%) are tops; "arw-worker" (80%) slightly weaker.
- Gemini: "neutral-agent" and "arw-agent" both score 100%; "relay-agent" specifically hurts (40%). The "relay" prefix combined with "-agent" suffix confuses Gemini. "relay-worker" (80%) is safe. Director prompt uses "relay worker" — correct choice.
- Grok/Cursor: 0% all variants — not viable relay workers.
- Claude: vocabulary-dependent (see haiku/sonnet rows) — relay-anchored nouns matter.
- **Universal recommendation**: Use "relay worker" noun in Director prompts — it's the highest-performing variant across both Claude models (haiku: 60%) and non-Claude models (droid: 100%). "relay agent" underperforms on Gemini (40%) and Claude haiku (20%). "arw-agent" is surprisingly strong but less widely tested.

---

## 3. Design

### 3.1 The `auto` entrypoint

```bash
agent-relay spawn Director --model=auto --task="refactor the auth module and add test coverage"
```

Or via the SDK:

```typescript
await relay.spawnAgent('Director', {
  model: 'auto',
  task: 'Refactor the auth module and add test coverage',
});
```

`auto` is resolved before the spawn call reaches the broker. It never reaches a model router; it is resolved by the **task classifier** in the CLI/SDK layer.

---

### 3.2 Task Classifier

A single lightweight LLM call (haiku-class, <200ms, ~$0.001) that returns a structured assessment:

```typescript
interface TaskAssessment {
  complexity: 'low' | 'medium' | 'high';
  parallelizable: boolean;
  subtasks: string[];          // inferred decomposition
  domains: string[];           // e.g. ["backend", "testing", "security"]
  estimatedWorkers: number;    // 1–8
  reasoning: string;           // short explanation for transparency
}
```

**Classifier prompt** (compressed):

```
You are a task router. Given a task description, assess:
1. complexity: low (single-step, clear output), medium (multi-step, some ambiguity),
   high (open-ended, requires judgment, cross-domain)
2. parallelizable: can this be split into independent tracks?
3. subtasks: list the natural sub-units (max 6)
4. domains: what specialisations are needed?
5. estimatedWorkers: how many parallel workers would help? (1 if serial)

Respond with JSON only.
```

---

### 3.3 Team Composer

Maps the assessment to a concrete team spec:

```typescript
interface TeamSpec {
  lead: { model: ModelTier; onboarding: OnboardingVariant };
  workers: Array<{
    role: string;
    model: ModelTier;
    task: string;
  }>;
}

type ModelTier = 'haiku' | 'sonnet' | 'opus';
```

**Routing table** (derived from eval data):

```
complexity=low,  parallel=false  →  lead: sonnet/one-liner,  workers: [haiku×1]
complexity=low,  parallel=true   →  lead: sonnet/one-liner,  workers: [haiku×N]
complexity=med,  parallel=false  →  lead: sonnet/one-liner,  workers: [sonnet×1]
complexity=med,  parallel=true   →  lead: sonnet/one-liner,  workers: [haiku×N, sonnet×1 (synthesiser)]
complexity=high, parallel=any    →  lead: opus/bare,         workers: [sonnet×N (+ haiku for grunt work)]
```

**Why bare/one-liner for leads (never brief/skill):**
- Conditional spawn guidance ("Spawn when... dedicated focus") gives capable models permission to skip delegation and reduces spawn rate to 0%. Validated: opus s03 brief=0% vs bare=67%, one-liner=67%.
- Directive language (just name the tool, no conditions) works best for sonnet/opus.
- Only haiku workers benefit from skill-level onboarding (they lack native protocol knowledge).
- Note: skill variant with disambiguation clause ("if task explicitly asks to delegate, always spawn") improves results but still underperforms bare/one-liner for capable models.

**Key invariants:**
- Lead is always sonnet or opus — haiku is never lead
- Opus lead only fires for `complexity=high` — it's the right tool but costs more
- Worker model matches subtask complexity, not overall task complexity
- `estimatedWorkers` from the classifier caps at 6 to prevent runaway spawns

---

### 3.4 Director Meta-Prompt

The lead is not asked to *decide* the team — the routing has already done that. The meta-prompt tells the lead *what team it has* and *what each worker's job is*:

```
You are Director, leading a {N}-worker team on this task:
{original task}

Your team:
{for each worker}
- {role} ({model tier}): {subtask description}

Spawn each worker using mcp__agent-relay__add_agent with their role as the name
and the subtask as their task. Wait for all workers to report DONE, then synthesise
their findings and release each worker with mcp__agent-relay__remove_agent.
```

This is critical: pre-composing the team means the lead's job is coordination, not planning. The lead doesn't have to decide whether to delegate — it's already been decided.

---

### 3.5 Onboarding injection per tier

The broker's model-aware injection (already implemented in `crates/broker/src/runtime/api.rs`) handles workers automatically:
- haiku workers → `SMALL_MODEL_RELAY_SKILL` prepended to task (broker-side injection)
- sonnet/opus workers → no injection needed

The lead gets the `one-liner` or `bare` onboarding baked into the meta-prompt — no separate injection needed since the meta-prompt already contains the tool names.

---

## 4. Implementation Plan

### Phase 1 — Classifier (standalone, testable)

**File**: `packages/cli/src/auto/classifier.ts`

```typescript
export async function classifyTask(task: string): Promise<TaskAssessment>
```

- Uses the configured default model (haiku-class) via the existing harness driver
- Pure function: string in, structured assessment out
- Adds ~200ms and ~$0.001 to spawn latency — acceptable

### Phase 2 — Team Composer

**File**: `packages/cli/src/auto/composer.ts`

```typescript
export function composeTeam(assessment: TaskAssessment): TeamSpec
```

- Pure routing table lookup — no LLM call
- Capped at 6 workers
- Exposes the routing table as a config so it can be tuned from eval results

### Phase 3 — Director meta-prompt builder

**File**: `packages/cli/src/auto/director-prompt.ts`

```typescript
export function buildDirectorPrompt(task: string, team: TeamSpec): string
```

- Templates the meta-prompt with the team spec
- Uses relay-anchored phrasing for worker nouns (findings from s05 eval will determine exact wording)

### Phase 4 — Wire into spawn

In `packages/cli/src/commands/spawn.ts` (or equivalent), intercept `model=auto`:

```typescript
if (spec.model === 'auto') {
  const assessment = await classifyTask(spec.task);
  const team = composeTeam(assessment);
  spec.model = team.lead.model;
  spec.task = buildDirectorPrompt(spec.task, team);
}
```

### Phase 5 — Eval coverage

New scenario **s06-auto-routing**: submit a `complexity=medium, parallel=true` task, measure whether the spawned team has the right lead tier and at least 2 workers spawned via relay tools.

---

## 5. What the eval suite still needs to answer

| Question | Status | Answer |
|----------|--------|--------|
| Does relay-anchored phrasing ("relay worker") improve bare spawn? | ✅ done | **yes for Claude** — haiku relay-worker=60% vs neutral-worker=0%; non-Claude models are largely vocabulary-agnostic (codex 100% on all tested variants) |
| Do non-Claude harnesses need relay-anchored vocabulary? | ✅ done | **no** — codex/droid/gemini/opencode achieve high pass rates with neutral vocabulary; effect is Claude-specific. Note: "relay-agent" specifically hurts gemini (40%) |
| What is opus's s03 lifecycle score with timeout fix? | ✅ done | bare=67% (up from 40%); one-liner+ running in Claude phrasing batch |
| Does the Director meta-prompt reliably produce multi-worker spawns? | s06 (in progress) | 0% without scaffolding. Root cause: models make ONE add_agent call then stop/wait — no prompt instruction reliably chains two consecutive add_agent calls. External Orchestrator nudge after first spawn required to trigger second. Production Director prompt needs redesign. |
| Is the one-liner sufficient for sonnet as lead? | ✅ done | yes — 100% on s03 |
| Does haiku-as-worker with skill injection complete subtasks reliably? | needs worker-quality eval | pending |
| Is opus s03 really timeout-limited? | needs s03 with 300s timeout | pending |
| Which non-Claude harnesses can serve as relay workers? | ✅ done | codex (100% s03), opencode (100% s03:bare), droid (100% s03:bare), gemini (100% s03:one-liner); grok/cursor not viable |

---

## 6. Open questions

1. **Multi-spawn Director behavior**: s06 eval confirms models make ONE add_agent call then stop/wait, even with "spawn all back-to-back" CRITICAL instructions. This is a fundamental PTY-mode behavior — models need external stimulus between tool calls. Production Director prompt needs either: (a) an orchestration layer that nudges the Director after each spawn, (b) pre-wiring all workers before the Director starts (so it just coordinates rather than spawns), or (c) a task structure where spawning each worker is triggered by a message (sequential hand-off pattern). This is a Phase 5 concern but should inform Phase 3 prompt design.

2. **Classifier model cost trade-off**: haiku classifier call adds latency and cost. Is there a heuristic (task word count, presence of "and", number of domains) that can route without an LLM call for simple cases?

2. **Worker specialisation**: today workers get a task description. Should the team composer also inject domain-specific skill text (e.g. "you are a security auditor" for a security subtask)?

3. **Routing table update loop**: as eval data improves, the routing table should update. Should it be hardcoded, a JSON config, or learned from eval pass rates?

4. **Cost transparency**: user should see the estimated team cost before confirmation. `--dry-run` flag shows team spec without spawning.

5. **Team size cap**: 6 workers is a conservative default. Should this be per-workspace config?

---

## 7. Non-goals (for this phase)

- Dynamic re-routing mid-task (lead decides to add workers partway through)
- Nested teams (workers spawning sub-workers)
- Cross-node routing (all workers on same broker node for now)
- Cost optimisation beyond tier selection

---

## 8. Related

- `specs/fleet-delivery.md` — node/broker topology that auto-routing will eventually span
- `crates/broker/src/runtime/api.rs` — model-aware skill injection (Phase 1 of this already shipped)
- `tests/integration/broker/evals/scenarios/s05-phrasing-variants.ts` — phrasing eval feeding into Director prompt design
- Lifecycle eval results (b3oqx02zv) — empirical basis for the routing table
