# Verification Traceback Pattern — Design Document

## Problem

When a verification check fails and the runner retries a step, the retry prompt currently includes:
1. The raw error message
2. The last 2000 characters of the previous agent's output
3. For custom verification: the command and its output

This is a blunt instrument. The failing agent receives a wall of text and must self-diagnose what went wrong. For complex verification failures (e.g., `npx nango compile` producing 50 lines of TypeScript errors), the agent often wastes its retry attempt misinterpreting the error or fixing the wrong file.

**Marcin's insight**: "It's a DAG, so technically no loops." The review-loop template (`builtin-templates/review-loop.yaml`) achieves review via a DAG topology — separate steps for implement, review, consolidate, address. But diagnostic traceback is fundamentally different: it must happen *within* the retry loop, not as a separate DAG step.

**Solution**: Spawn an ephemeral diagnostic agent inside the runner's retry flow. This agent analyzes the failure and produces targeted guidance that gets injected into the retry prompt — replacing the raw 2000-char truncation with intelligent analysis.

---

## 1. New `VerificationCheck` Field: `diagnosticAgent`

### Type Change

```typescript
// packages/sdk/src/workflows/types.ts
export interface VerificationCheck {
  type: 'output_contains' | 'exit_code' | 'file_exists' | 'custom';
  value: string;
  description?: string;
  timeoutMs?: number;
  /** Name of an agent defined in the workflow's agents list.
   *  When set, and verification fails with retries remaining,
   *  this agent is spawned to analyze the failure before retry. */
  diagnosticAgent?: string;
}
```

The field is optional. When omitted, existing retry behavior is preserved exactly.

### Schema Change

In `schema.json`, add to the `VerificationCheck` definition:

```json
"diagnosticAgent": {
  "type": "string",
  "description": "Agent name to spawn for failure diagnosis before retry"
}
```

### Validation

During preflight/dry-run, if `diagnosticAgent` is set:
- The named agent **must** exist in the workflow's `agents` list
- Warning if the step has `retries: 0` or no `retries` (diagnostic agent would never run)

---

## 2. Runner Integration

### Where It Hooks In

The traceback logic lives in `executeAgentStep()` in `runner.ts`, specifically in the retry prompt construction block (currently lines ~4203-4219).

Current flow:
```
attempt loop start
  → resolve task with step output variables
  → if attempt > 0: prepend [RETRY] context (raw error + last 2000 chars)
  → spawn agent
  → collect output
  → run verification
  → if verification fails: throw WorkflowCompletionError
  → catch block: lastError = error, continue loop
attempt loop end
```

New flow:
```
attempt loop start
  → resolve task with step output variables
  → if attempt > 0: prepend [RETRY] context (see below)
  → spawn agent
  → collect output
  → run verification
  → if verification fails AND diagnosticAgent is set AND retries remain:
      a. spawn diagnostic agent (ephemeral, non-interactive)
      b. collect diagnostic output
      c. store diagnostic output for next iteration's retry prompt
  → throw WorkflowCompletionError (unchanged)
  → catch block: lastError = error, continue loop
attempt loop end
```

### Diagnostic Agent Prompt

When verification fails and `diagnosticAgent` is configured, the runner spawns the diagnostic agent with this prompt:

```
The following verification failed after step "<step-name>".

Verification command: <check.value>
Verification output:
<verification error output>

Step task was:
<original resolved task (without retry prefix)>

Step output (last 2000 chars):
<agent output, truncated>

Analyze what went wrong. Your response will be injected into the retry prompt
for the original agent. Be specific about:
- Which file(s) have issues
- What the exact error is (line numbers, error codes)
- What the agent should do differently on the next attempt

Do NOT fix the code yourself — just diagnose.
```

### Modified Retry Prompt

When diagnostic output is available, the retry prompt changes from:

```
[RETRY — Attempt 2/3]
Previous attempt failed: <error>
[VERIFICATION FAILED] Your code did not pass the verification check.
Command: npx nango compile
Output:
<raw compiler output>

Fix the issues above before proceeding.
Previous output (last 2000 chars):
<raw output>
---
<original task>
```

To:

```
[RETRY — Attempt 2/3]
Verification failed. A diagnostic agent analyzed the failure:

--- Diagnostic Analysis ---
<diagnostic agent output>
--- End Analysis ---

Original verification error:
Command: npx nango compile
Output (last 500 chars):
<truncated raw output>

---
<original task>
```

The raw verification output is kept but truncated more aggressively (500 chars instead of 2000) since the diagnostic analysis is the primary guidance.

### Implementation Location

New private method on `WorkflowRunner`:

```typescript
private async runDiagnosticAgent(
  step: WorkflowStep,
  verificationError: string,
  agentOutput: string,
  originalTask: string,
  agentMap: Map<string, AgentDefinition>,
  timeoutMs?: number
): Promise<string | null>
```

Returns the diagnostic output, or `null` if:
- The diagnostic agent is not configured
- The diagnostic agent timed out
- The diagnostic agent failed to spawn

New instance field to store diagnostic output between retry iterations:

```typescript
private lastDiagnosticOutput = new Map<string, string>();
```

---

## 3. Builder API

### Step Configuration

```typescript
const workflow = new WorkflowBuilder('nango-sync')
  .agent('generator', { cli: 'claude', role: 'Code generator' })
  .agent('reviewer', { cli: 'claude', role: 'Diagnostic reviewer', interactive: false })
  .step('generate', {
    agent: 'generator',
    task: 'Implement the Nango sync integration for ...',
    verification: {
      type: 'custom',
      value: 'cd nango-integrations && npx nango compile',
      diagnosticAgent: 'reviewer',
    },
    retries: 2,
  })
  .build();
```

### YAML Configuration

```yaml
agents:
  - name: generator
    cli: claude
    role: Code generator

  - name: reviewer
    cli: claude
    role: Diagnostic reviewer
    interactive: false
    constraints:
      maxTokens: 4000
      timeoutMs: 60000

workflows:
  - name: nango-sync
    steps:
      - name: generate
        agent: generator
        task: |
          Implement the Nango sync integration for ...
        verification:
          type: custom
          value: cd nango-integrations && npx nango compile
          diagnosticAgent: reviewer
        retries: 2
```

---

## 4. Diagnostic Agent Lifecycle

### Ephemeral Spawning

The diagnostic agent:
- Is defined in the workflow's `agents` list (same as any other agent)
- Uses the same agent definition (CLI, model, permissions, cwd)
- Is spawned **ephemerally** by the runner — it does NOT appear as a step in the DAG
- Does NOT get registered with relay messaging (no PTY, no channel)
- Runs as `interactive: false` regardless of the agent definition's setting
- Is spawned via the same `executor.executeAgentStep()` path used for non-interactive workers

### Not a DAG Step

The diagnostic agent invocation:
- Has no `WorkflowStepRow` in the database
- Has no entry in `stepStates`
- Does not appear in dry-run reports
- Does not participate in barriers or coordination
- Is invisible to the DAG topology

It is an implementation detail of the retry mechanism, similar to how the runner already injects retry context strings.

### Evidence Recording

The diagnostic invocation IS recorded in the step's completion evidence:

```typescript
this.recordStepToolSideEffect(step.name, {
  type: 'diagnostic_agent',
  detail: `Diagnostic agent "${diagnosticAgentName}" analyzed verification failure (attempt ${attempt})`,
  raw: {
    diagnosticAgent: diagnosticAgentName,
    attempt,
    outputLength: diagnosticOutput.length,
  },
});
```

This requires adding `'diagnostic_agent'` to the `CompletionEvidenceToolSideEffectType` union.

---

## 5. Timeout Handling

### Sub-Timeout

The diagnostic agent runs with a dedicated sub-timeout:

| Source | Timeout |
|--------|---------|
| Diagnostic agent's own `constraints.timeoutMs` | Used if set |
| Default | 60,000 ms (60 seconds) |
| Step's remaining time | Capped to avoid exceeding step timeout |

```typescript
const diagnosticTimeout = Math.min(
  diagnosticAgentDef.constraints?.timeoutMs ?? 60_000,
  remainingStepTimeMs ?? Infinity
);
```

### Fallback on Timeout

If the diagnostic agent times out or errors:
1. Log a warning: `[step-name] Diagnostic agent timed out, falling back to raw retry`
2. Fall back to the existing retry behavior (raw error + 2000 chars)
3. The retry still happens — diagnostic failure does NOT consume a retry attempt

---

## 6. Budget Interaction

### Token Accounting

When budget enforcement is enabled (`swarm.tokenBudget`):
- Diagnostic agent token usage counts toward the **workflow's total budget**
- Diagnostic token usage is attributed to the step being retried
- If the workflow budget is exhausted, the diagnostic agent is NOT spawned (fall back to raw retry)

### Budget Check Before Spawning

```typescript
if (this.budgetTracker && !this.budgetTracker.canSpend(estimatedDiagnosticTokens)) {
  this.log(`[${step.name}] Skipping diagnostic agent — budget exhausted`);
  return null;  // fall back to raw retry
}
```

The `estimatedDiagnosticTokens` is a conservative estimate (default: 2000 tokens) to avoid spawning a diagnostic agent that would immediately be killed by budget enforcement.

---

## 7. How This Differs from Existing Retry

| Aspect | Current Retry | Traceback Retry |
|--------|--------------|-----------------|
| Error context | Raw error string | Diagnostic agent analysis |
| Output context | Last 2000 chars (blind truncation) | Agent-analyzed output (targeted) |
| Root cause | Agent must self-diagnose | Diagnostic agent identifies root cause |
| Fix guidance | None | Specific files, errors, and suggested approach |
| Cost | Free (string ops) | 1 additional agent invocation per retry |
| Latency | None | 10-60s per diagnostic invocation |
| Fallback | N/A | Falls back to current behavior on timeout/error |

### When to Use Traceback vs Plain Retry

- **Plain retry** (no `diagnosticAgent`): Simple verification (output_contains, file_exists), or when the error message is self-explanatory
- **Traceback**: Complex verification (compilation, test suites, linting) where the raw output needs interpretation

---

## 8. Sequence Diagram

```
Step Attempt 1:
  Runner → spawn generator agent
  Generator → produces code
  Runner → run verification (npx nango compile)
  Verification → FAILS (compile errors)

  Runner → diagnosticAgent is set, retries remain
  Runner → spawn reviewer agent (ephemeral)
    Prompt: "Verification failed. Here's the error output and
             the agent's work. Diagnose what went wrong."
  Reviewer → "The generator created fetchUsers.ts but imported
              from 'nango' instead of '@nangohq/node'. Line 12
              has a type error: UserResponse is not exported
              from the schema file. The agent should fix the
              import path and use the correct type name."
  Runner → store diagnostic output

Step Attempt 2:
  Runner → spawn generator agent
    Prompt: "[RETRY — Attempt 2/3]
             Verification failed. Diagnostic analysis:
             --- The generator created fetchUsers.ts but imported
             from 'nango' instead of '@nangohq/node'. Line 12 ...
             ---
             Original task: Implement the Nango sync integration..."
  Generator → fixes the specific issues identified
  Runner → run verification (npx nango compile)
  Verification → PASSES
  Step → completed_verified
```

---

## 9. Edge Cases

1. **Diagnostic agent is the same as the step agent**: Allowed. The diagnostic agent is a separate invocation with a diagnosis-specific prompt.

2. **Multiple verification checks on a step**: Not currently supported (VerificationCheck is singular). If added later, diagnostic agent runs once for the first failing check.

3. **Owner-supervised steps**: Diagnostic agent runs AFTER the owner/specialist flow but BEFORE the retry. It supplements, not replaces, the owner decision flow.

4. **Non-custom verification with diagnosticAgent**: Supported but less useful. For `file_exists`, the diagnostic prompt would include "file X does not exist" — still potentially valuable for the diagnostic agent to suggest why.

5. **Diagnostic agent itself fails verification**: N/A — the diagnostic agent has no verification check. Its raw output is used as-is.

---

## 10. Implementation Checklist

1. **types.ts**: Add `diagnosticAgent?: string` to `VerificationCheck` interface
2. **types.ts**: Add `'diagnostic_agent'` to `CompletionEvidenceToolSideEffectType` union
3. **schema.json**: Add `diagnosticAgent` to verification check schema
4. **runner.ts**: Add `runDiagnosticAgent()` private method
5. **runner.ts**: Add `lastDiagnosticOutput` map field
6. **runner.ts**: Modify retry prompt construction in `executeAgentStep()` to use diagnostic output when available
7. **runner.ts**: Call `runDiagnosticAgent()` when verification fails with retries remaining
8. **builder.ts**: Allow `diagnosticAgent` in step verification config (pass-through, no builder changes needed beyond type)
9. **Validation**: Add preflight check that `diagnosticAgent` references a valid agent
10. **Tests**: Unit tests for diagnostic prompt construction, timeout fallback, budget skip
