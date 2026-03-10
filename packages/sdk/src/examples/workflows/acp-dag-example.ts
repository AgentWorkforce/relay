/**
 * ACP DAG Workflow Example
 *
 * Demonstrates what a DAG workflow looks like once the ACP runtime is
 * implemented. A claude lead coordinates ACP workers (claude + goose) and a
 * headless codex worker through planning, parallel implementation, security
 * review, and finalization phases.
 *
 * NOTE: This file requires the ACP runtime changes from the spec
 * (docs/adr/acp-runtime-spec.md) to be implemented first. Specifically,
 * `AgentOptions` needs `runtime` and `preset` fields wired through the
 * builder. Until then, use the YAML version (acp-dag-example.yaml) which
 * the runner parses directly.
 *
 * Key ACP features shown:
 *  - Auto-selected ACP runtime for interactive agents (DAG pattern)
 *  - Structured tool call visibility via acp_turn_update events
 *  - Turn-boundary delivery: relay messages queued until turn ends
 *  - Relaycast MCP server auto-injected into ACP sessions
 *  - relay_checkpoint for crash recovery (replaces KIND: continuity)
 *  - Permission handling via session/request_permission (no auto-approval hacks)
 *
 * Usage:
 *   agent-relay run packages/sdk/src/examples/workflows/acp-dag-example.yaml
 */

import { workflow } from '../../workflows/builder.js';

const task = process.argv[2] ?? 'Add user authentication with JWT tokens';

const result = await workflow('acp-dag-example')
  .description(
    'DAG workflow with ACP runtime. Lead + ACP workers + headless codex. ' +
    'Structured tool calls, clean permissions, turn-boundary delivery.'
  )
  .pattern('dag')
  .channel('wf-acp-dag')
  .maxConcurrency(4)
  .timeout(3_600_000)
  .idleNudge({ nudgeAfterMs: 180_000, escalateAfterMs: 120_000, maxNudges: 1 })

  // ── Agents ──────────────────────────────────────────────────────────────

  // Lead: ACP auto-selected (DAG pattern, interactive, adapter available)
  .agent('lead', {
    cli: 'claude',
    role: 'Architect. Decomposes task, assigns to workers, reviews output.',
    model: 'sonnet',
    channels: ['wf-acp-dag', 'planning'],
    // runtime: 'acp' ← omitted, auto-selected
  })

  // Interactive ACP worker: will auto-select ACP once runtime changes land
  // Post-ACP: .agent('claude-worker', { cli: 'claude', ..., runtime: 'acp' })
  .agent('claude-worker', {
    cli: 'claude',
    role: 'Implements backend changes as directed by lead.',
    model: 'sonnet',
  })

  // Goose: native ACP support (no adapter binary needed)
  // Post-ACP: .agent('goose-reviewer', { cli: 'goose', ..., runtime: 'acp' })
  .agent('goose-reviewer', {
    cli: 'goose',
    role: 'Reviews implementation for security and correctness.',
  })

  // Headless codex: non-interactive subprocess (unchanged behavior)
  .agent('codex-worker', {
    cli: 'codex',
    role: 'Implements frontend changes.',
    interactive: false,
  })

  // ── Steps ───────────────────────────────────────────────────────────────

  // Phase 1: Planning
  .step('plan', {
    agent: 'lead',
    task:
      `You are the lead architect for this task: {{task}}\n\n` +
      `Produce a plan with exactly two implementation tracks:\n` +
      `1. Backend changes (for claude-worker on #wf-acp-dag)\n` +
      `2. Frontend changes (for codex-worker, non-interactive)\n\n` +
      `For each track, specify exact file paths and what to implement.\n` +
      `Save your plan using relay_checkpoint for crash recovery.\n\n` +
      `End with: PLAN_COMPLETE`,
    verification: { type: 'output_contains', value: 'PLAN_COMPLETE' },
    retries: 1,
  })

  // Phase 2: Parallel implementation
  .step('backend-impl', {
    agent: 'claude-worker',
    dependsOn: ['plan'],
    task:
      `Join #wf-acp-dag. The lead has posted a plan.\n\n` +
      `Implement the backend track from the plan:\n` +
      `{{steps.plan.output}}\n\n` +
      `Write all files to disk. When complete, post to #wf-acp-dag:\n` +
      `"BACKEND_DONE: <summary of changes>"\n\n` +
      `End with: BACKEND_DONE`,
    verification: { type: 'output_contains', value: 'BACKEND_DONE' },
  })

  .step('frontend-impl', {
    agent: 'codex-worker',
    dependsOn: ['plan'],
    task:
      `Implement the frontend track from this plan:\n` +
      `{{steps.plan.output}}\n\n` +
      `IMPORTANT: Write files to disk using your file-writing tools.\n` +
      `Do NOT just output code to stdout.`,
    verification: { type: 'exit_code', value: '' },
  })

  // Phase 3: Security review (ACP goose)
  .step('security-review', {
    agent: 'goose-reviewer',
    dependsOn: ['backend-impl', 'frontend-impl'],
    task:
      `Review the implementation for security issues.\n\n` +
      `Backend output:\n{{steps.backend-impl.output}}\n\n` +
      `Frontend output:\n{{steps.frontend-impl.output}}\n\n` +
      `Check for: input validation, injection vulnerabilities, secrets in source,\n` +
      `insecure defaults. Produce a verdict: PASS, WARN, or FAIL with details.\n\n` +
      `End with: REVIEW_COMPLETE`,
    verification: { type: 'output_contains', value: 'REVIEW_COMPLETE' },
  })

  // Phase 4: Lead synthesizes and commits
  .step('finalize', {
    agent: 'lead',
    dependsOn: ['security-review'],
    task:
      `Review the security review results:\n` +
      `{{steps.security-review.output}}\n\n` +
      `If PASS or WARN: commit the changes with a descriptive message.\n` +
      `If FAIL: fix the issues identified, then commit.\n\n` +
      `End with: WORKFLOW_COMPLETE`,
    verification: { type: 'output_contains', value: 'WORKFLOW_COMPLETE' },
  })

  // ── Error handling ──────────────────────────────────────────────────────

  .onError('retry', { maxRetries: 2, retryDelayMs: 10_000 })

  // ── Run ─────────────────────────────────────────────────────────────────

  .run({
    vars: { task },
    onEvent: (event) => {
      const ts = new Date().toISOString().slice(11, 19);
      switch (event.type) {
        case 'step:started':
          console.log(`[${ts}] ▶ ${event.stepName} started`);
          break;
        case 'step:completed':
          console.log(`[${ts}] ✓ ${event.stepName} completed`);
          break;
        case 'step:failed':
          console.log(`[${ts}] ✗ ${event.stepName} failed: ${event.error}`);
          break;
        case 'step:retrying':
          console.log(`[${ts}] ↻ ${event.stepName} retrying (attempt ${event.attempt})`);
          break;
        case 'run:completed':
          console.log(`[${ts}] ◉ Workflow completed`);
          break;
        case 'run:failed':
          console.log(`[${ts}] ◉ Workflow failed: ${event.error}`);
          break;
      }
    },
  });

console.log('\nWorkflow result:', result.status);
