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
| opus | **67%** | TBD | TBD | TBD | **capable lead** — s03 bare improved to 67% after 120s/phase timeout fix (was 40% at 60s/phase) |

### Key findings
- **Sonnet + one-liner = 100% lifecycle reliability** ✅ — confirmed production lead config
- **Haiku is worker-only** — caps at 60% lifecycle regardless of onboarding
- **Opus s02 bare = 100%** — knows the protocol natively; s03 original 40% cap was a timeout artifact (verbose responses exhausted 60s/phase window), not a capability gap
- **Opus s03 bare = 67% with 120s/phase** — timeout fix confirmed; responseMs() helper returns 120s for opus-class models; further improvement expected with more repeats
- **Skill text heuristic fix: partial improvement** — sonnet s01:skill improved 0%→33% after removing "do it yourself for quick lookups" heuristic. Not fully fixed: root cause is the task uses "worker agent" neutral vocabulary. s05 phrasing eval confirms: neutral-agent=20%, relay-worker=60%. Fix in production: use relay-anchored vocabulary ("relay worker") in Director meta-prompts (already done).
- **Phrasing matters**: s05 (running) measures whether relay-anchored vocabulary improves tool use independent of onboarding. Early haiku data (bare onboarding only): neutral-worker=0%, neutral-agent=20%, relay-worker=60%, relay-agent=20%, arw-worker=TBD, arw-agent=TBD. Confirmed: "relay worker" phrasing significantly outperforms neutral vocabulary even without onboarding text.

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
| Does relay-anchored phrasing ("relay worker") improve bare spawn? | s05 (running) | **yes** — haiku relay-worker=60% vs neutral-worker=0%; worker noun outperforms agent noun |
| What is opus's s03 lifecycle score with timeout fix? | ✅ done | bare=67% (up from 40%); one-liner+ pending |
| Does the Director meta-prompt reliably produce multi-worker spawns? | s06 (built, not yet run) | pending |
| Is the one-liner sufficient for sonnet as lead? | ✅ done | yes — 100% on s03 |
| Does haiku-as-worker with skill injection complete subtasks reliably? | needs worker-quality eval | pending |
| Is opus s03 really timeout-limited? | needs s03 with 300s timeout | pending |

---

## 6. Open questions

1. **Classifier model cost trade-off**: haiku classifier call adds latency and cost. Is there a heuristic (task word count, presence of "and", number of domains) that can route without an LLM call for simple cases?

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
