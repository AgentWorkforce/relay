/**
 * Workflow Superiority — Multi-Agent Implementation Campaign
 *
 * A fully specified DAG workflow that orchestrates Claude (lead + reviewer)
 * and Codex workers across five implementation tiers to make the relay
 * broker-sdk workflow system decisively superior to Agno and Swarms AI.
 *
 * Architecture:
 *   - Claude lead: orchestrates each phase, approves trajectories, makes
 *     final architectural decisions
 *   - Codex workers: implement code changes, one per specialization domain
 *   - Claude code-reviewer: independent review after every implementation phase
 *     (separate from lead to avoid confirmation bias)
 *
 * DAG phases:
 *   Phase 0 → Codebase analysis + spec approval
 *   Phase 1 → Type system extension (condition/loop/router/hitl/sub-workflow)
 *   Phase 2 → Execution engine (runner handles new primitives + session)
 *   Phase 3 → Meta-orchestration (parallel with Phase 4)
 *   Phase 4 → Storage backends (parallel with Phase 3)
 *   Phase 5 → Deployment & observability
 *   Phase 6 → Integration validation + final lead sign-off
 *
 * Run:
 *   npx tsx src/examples/workflow-superiority.ts
 *
 * Environment:
 *   RELAY_API_KEY — optional. If absent the runner auto-provisions a
 *   Relaycast workspace and caches the key at ~/.agent-relay/relaycast.json.
 */

import { workflow } from '../workflows/builder.js';
import type { WorkflowEvent } from '../workflows/runner.js';

// ── Spec constants ────────────────────────────────────────────────────────────

const WORKFLOW_ROOT = 'packages/sdk/src/workflows';
const TYPES_FILE    = `${WORKFLOW_ROOT}/types.ts`;
const RUNNER_FILE   = `${WORKFLOW_ROOT}/runner.ts`;
const BUILDER_FILE  = `${WORKFLOW_ROOT}/builder.ts`;
const SCHEMA_FILE   = `${WORKFLOW_ROOT}/schema.json`;
const INDEX_FILE    = `${WORKFLOW_ROOT}/index.ts`;
const MEMORY_DB     = `${WORKFLOW_ROOT}/memory-db.ts`;
const COORDINATOR   = `${WORKFLOW_ROOT}/coordinator.ts`;
const BARRIER_FILE  = `${WORKFLOW_ROOT}/barrier.ts`;
const TEMPLATES     = `${WORKFLOW_ROOT}/templates.ts`;

// NOTE: No withExit() wrapper needed — the WorkflowRunner automatically
// appends self-termination instructions in spawnAndWait() with the agent's
// actual runtime name. Adding a second exit instruction wastes tokens.

// ── Event handler ─────────────────────────────────────────────────────────────

const onEvent = (event: WorkflowEvent): void => {
  const ts = new Date().toISOString();
  switch (event.type) {
    case 'run:started':
      console.log(`[${ts}] 🚀 run started  runId=${event.runId}`);
      break;
    case 'run:completed':
      console.log(`[${ts}] ✅ run complete runId=${event.runId}`);
      break;
    case 'run:failed':
      console.error(`[${ts}] ❌ run failed  runId=${event.runId} error=${event.error}`);
      break;
    case 'step:started':
      console.log(`[${ts}]   → ${event.stepName}`);
      break;
    case 'step:completed':
      console.log(`[${ts}]   ✓ ${event.stepName}`);
      break;
    case 'step:failed':
      console.error(`[${ts}]   ✗ ${event.stepName}: ${event.error}`);
      break;
    case 'step:skipped':
      console.log(`[${ts}]   ⊘ ${event.stepName} (skipped)`);
      break;
    case 'step:retrying':
      console.log(`[${ts}]   ↺ ${event.stepName} attempt=${event.attempt}`);
      break;
  }
};

// ── Workflow definition ───────────────────────────────────────────────────────

const result = await workflow('broker-sdk-superiority')
  .description(
    'Five-phase multi-agent campaign to make relay broker-sdk workflow system ' +
    'decisively superior to Agno and Swarms AI. Claude leads; Codex implements; ' +
    'Claude reviews after every phase.'
  )
  .pattern('dag')
  .channel('wf-broker-sdk-superiority')
  .maxConcurrency(3)
  .timeout(28_800_000) // 8 hours — this is a large implementation campaign

  // ── Agents ────────────────────────────────────────────────────────────────

  .agent('lead', {
    cli: 'claude',
    role: 'Lead architect. Sets direction, reviews each phase output, approves ' +
          'trajectories, and resolves architectural conflicts. Has final say on ' +
          'all design decisions.',
    retries: 2,

  })

  .agent('code-reviewer', {
    cli: 'claude',
    role: 'Independent code reviewer. Reviews implementation quality, correctness, ' +
          'TypeScript type safety, test coverage, and integration coherence after ' +
          'every phase. Catches issues the lead may have missed.',
    retries: 2,

  })

  .agent('spec-analyst', {
    cli: 'codex',
    role: 'Codebase analyst. Reads the existing workflow source files and produces ' +
          'a precise, file-by-file implementation plan for all five improvement tiers.',
    retries: 2,

  })

  .agent('schema-implementer', {
    cli: 'codex',
    role: 'Type system specialist. Extends TypeScript interfaces and JSON Schema ' +
          'definitions to support new workflow primitives.',
    retries: 2,

  })

  .agent('engine-implementer', {
    cli: 'codex',
    role: 'Execution engine specialist. Implements new step-type execution logic ' +
          'inside WorkflowRunner, adds session concept, and expands the event system.',
    retries: 3,

  })

  .agent('meta-implementer', {
    cli: 'codex',
    role: 'Meta-orchestration specialist. Implements sub-workflow composition, ' +
          'AutoWorkflowBuilder, and semantic pattern selection.',
    retries: 2,

  })

  .agent('storage-implementer', {
    cli: 'codex',
    role: 'Storage backend specialist. Implements PostgresWorkflowDb, ' +
          'SqliteWorkflowDb, and RedisWorkflowDb adapters.',
    retries: 2,

  })

  .agent('deploy-implementer', {
    cli: 'codex',
    role: 'Deployment and observability specialist. Implements relay workflow serve ' +
          'HTTP server, OTel tracing integration, and CLI improvements.',
    retries: 2,

  })

  .agent('test-validator', {
    cli: 'codex',
    role: 'Integration test specialist. Validates all phases compile, tests pass, ' +
          'and exports are correct.',
    retries: 2,

  })

  // ── Phase 0: Codebase Analysis ────────────────────────────────────────────

  .step('codebase-analysis', {
    agent: 'spec-analyst',
    task: `
You are the first step in a large improvement campaign for the relay broker-sdk
workflow system. Your job is to read the existing source files and produce a
concrete, file-by-file implementation plan.

READ THESE FILES THOROUGHLY:
  - ${TYPES_FILE}
  - ${RUNNER_FILE}
  - ${BUILDER_FILE}
  - ${SCHEMA_FILE}
  - ${INDEX_FILE}
  - ${MEMORY_DB}
  - ${COORDINATOR}
  - ${BARRIER_FILE}
  - ${TEMPLATES}

PRODUCE A DETAILED PLAN covering the following improvements (in priority order):

TIER 1 — Schema Primitives (new step types in types.ts + schema.json):
  a) condition step: WorkflowStep gains optional "condition" string (CEL expr)
     and optional "type" discriminant. When condition evaluates false → skip.
  b) loop step: new LoopStepGroup interface { type:"loop", name, steps[],
     until?: string (CEL expr on step outputs), maxIterations: number }
  c) router step: new RouterStepGroup interface { type:"router", name,
     selector: string (CEL expr), routes: RouterRoute[], default?: string[] }
     RouterRoute: { match: string, steps: string[] }
  d) parallel step group: new ParallelStepGroup interface { type:"parallel",
     name, barrier?: "all"|"any"|"majority", timeout?: number, steps[] }
  e) hitl step: new HitlStep interface { type:"hitl", name, message: string,
     channel?: string, timeout?: number, onTimeout?: "skip"|"fail" }
  f) flow shorthand: RelayYamlConfig gains optional "flow?: string" field,
     parsed as "A -> B, C -> D" notation generating dependsOn edges
  g) sub-workflow step: new SubWorkflowStep interface { type:"sub-workflow",
     name, workflow: string (path or registry name), vars?: Record<string,string> }
  h) Promote retries + timeoutMs to top-level WorkflowStep fields (they already
     exist — verify they are exported and used correctly in runner.ts)

TIER 2 — Execution Engine (runner.ts):
  a) Condition evaluation: before executing a step, if step.condition is set,
     evaluate the CEL expression; if false, mark step skipped
  b) Loop execution: LoopStepGroup runs its steps[].steps repeatedly until
     until-condition is true or maxIterations reached
  c) Router execution: evaluate selector, match route, execute branch steps
  d) Parallel group: run steps concurrently with barrier semantics
  e) HITL execution: pause run, write hitl-pending file, poll for response file
  f) Sub-workflow: recursively create a WorkflowRunner and execute the referenced
     config, return its output as the step output
  g) Session concept: WorkflowRunner gains optional sessionId param; a session
     groups multiple runs and shares state across them via SessionStore
  h) Input schema validation: RelayYamlConfig gains optional inputSchema field
     (JSON Schema object); validate vars before execution begins
  i) Fallback agent: WorkflowStep gains optional fallbackAgent?: string;
     if primary agent fails all retries, retry once with fallbackAgent
  j) Expanded events: add 15+ new WorkflowEvent union members for loop iterations,
     condition evaluations, router selections, hitl pauses, session updates

TIER 3 — Meta-Orchestration:
  a) AutoWorkflowBuilder: new exported class that takes a task string and
     available CLIs, calls a meta-agent to generate RelayYamlConfig, validates
     it, and returns it (or optionally executes immediately)
  b) Workflow registry: simple JSON file-based registry at
     ~/.agent-relay/workflow-registry.json that maps name→path; CLI commands
     relay workflow list, search, install, publish

TIER 4 — Storage Backends:
  a) PostgresWorkflowDb: implements WorkflowDb interface using node-postgres (pg)
     with schema migration on first connect
  b) SqliteWorkflowDb: implements WorkflowDb using better-sqlite3 (sync API
     wrapped in async interface)
  c) RedisWorkflowDb: implements WorkflowDb using ioredis with JSON serialization
     and optional TTL on run records
  All three: exported from packages/sdk/src/workflows/db/ submodule

TIER 5 — Deployment & Observability:
  a) relay workflow serve: new CLI subcommand that starts an Express/Fastify HTTP
     server exposing POST /run, GET /runs/:id, GET /runs/:id/events (SSE),
     POST /runs/:id/hitl/:step, POST /runs/:id/abort, GET /health
  b) OTel tracing: optional otel?: { exportTo: string, endpoint: string,
     serviceName: string } in RelayYamlConfig; runner creates spans for
     run start/end and each step start/end using @opentelemetry/sdk-node
  c) CLI improvements: relay workflow dry-run, relay workflow inspect,
     relay workflow replay --from <step>

For each tier, specify:
  1. Which existing files change and what lines/sections to modify
  2. Which new files to create and their full path
  3. New TypeScript interface/type definitions (exact syntax)
  4. New function signatures with JSDoc

Output a structured plan with clear section headers.
End your output with: ANALYSIS_COMPLETE
    `,
    retries: 2,
    verification: { type: 'output_contains', value: 'ANALYSIS_COMPLETE' },
  })

  .step('spec-approval', {
    agent: 'lead',
    task: `
Review the codebase analysis produced by the spec-analyst:

{{steps.codebase-analysis.output}}

Your job:
1. Validate that the plan covers all five tiers correctly
2. Identify any architectural risks or conflicts (e.g., breaking changes to
   WorkflowStep that would break existing templates)
3. Clarify the execution order for each tier
4. Approve or amend the plan — note any changes clearly
5. Establish a non-negotiable constraint: ALL existing tests in
   packages/sdk/src/__tests__/ must remain passing after each phase

Key architectural decisions to make explicit:
  - How should WorkflowStep handle the new type discriminant without breaking
    existing YAML that has no "type" field? (answer: type defaults to "agent")
  - Should LoopStepGroup and RouterStepGroup be separate from WorkflowStep in
    the types, or unified via a discriminated union?
  - Is the session concept stored in the same WorkflowDb or a separate SessionDb?
  - For the hitl step, what is the polling mechanism? (file-based, HTTP endpoint,
    or webhook?) Choose the simplest that works without requiring a server.

Output a concise approved plan with your decisions. End with: SPEC_APPROVED
    `,
    dependsOn: ['codebase-analysis'],
    retries: 2,
    verification: { type: 'output_contains', value: 'SPEC_APPROVED' },
  })

  // ── Phase 1: Type System Extension ────────────────────────────────────────

  .step('p1-type-system', {
    agent: 'schema-implementer',
    task: `
Phase 1a: Extend the TypeScript type system for new workflow primitives.

Approved spec context:
{{steps.spec-approval.output}}

YOUR TASK: Modify ${TYPES_FILE} to add all new types.

SPECIFIC CHANGES:

1. Add a StepType discriminant:
   export type StepType = "agent" | "condition" | "loop" | "router" | "parallel" | "hitl" | "sub-workflow";

2. Extend WorkflowStep to include new optional fields:
   - type?: StepType          (default "agent" when absent)
   - condition?: string       (CEL expression; step skipped if evaluates false)
   - fallbackAgent?: string   (agent name to use if primary fails all retries)

3. Add new composite step group interfaces:

   export interface LoopStepGroup {
     type: "loop";
     name: string;
     description?: string;
     steps: WorkflowStep[];
     until?: string;        // CEL expression evaluated after each iteration
     maxIterations: number; // required — prevents runaway loops
     timeoutMs?: number;
   }

   export interface RouterRoute {
     match: string;         // CEL expression or substring match
     steps: string[];       // names of steps to execute for this route
   }

   export interface RouterStepGroup {
     type: "router";
     name: string;
     description?: string;
     selector: string;      // CEL expression producing a string value
     routes: RouterRoute[];
     default?: string[];    // step names to run if no route matches
     timeoutMs?: number;
   }

   export interface ParallelStepGroup {
     type: "parallel";
     name: string;
     description?: string;
     barrier?: "all" | "any" | "majority"; // default "all"
     steps: WorkflowStep[];
     timeoutMs?: number;
   }

   export interface HitlStep {
     type: "hitl";
     name: string;
     description?: string;
     message: string;       // human-readable prompt shown to approver
     channel?: string;      // notification target e.g. "slack:#approvals"
     timeoutMs?: number;    // how long to wait before applying onTimeout
     onTimeout?: "skip" | "fail" | "use-default"; // default "fail"
     defaultResponse?: string; // used when onTimeout is "use-default"
   }

   export interface SubWorkflowStep {
     type: "sub-workflow";
     name: string;
     description?: string;
     workflow: string;      // path to relay.yaml or registry name
     vars?: Record<string, string>; // variable substitutions for the sub-workflow
     timeoutMs?: number;
   }

4. Create a union type for any step or step group:
   export type AnyWorkflowStep =
     | WorkflowStep
     | LoopStepGroup
     | RouterStepGroup
     | ParallelStepGroup
     | HitlStep
     | SubWorkflowStep;

5. Update WorkflowDefinition.steps to use AnyWorkflowStep[]:
   steps: AnyWorkflowStep[];

6. Add session types:
   export interface SessionConfig {
     persist?: boolean;          // default false
     historyRuns?: number;       // how many prior runs to inject as context
     ttlMs?: number;
   }

   export interface SessionRow {
     id: string;
     workflowName: string;
     runIds: string[];
     stateSnapshot: Record<string, unknown>;
     createdAt: string;
     updatedAt: string;
   }

7. Add inputSchema to RelayYamlConfig:
   inputSchema?: Record<string, unknown>; // JSON Schema object

8. Add session to RelayYamlConfig:
   session?: SessionConfig;

9. Expand WorkflowEvent union in runner.ts — ADD to the existing union
   (note: WorkflowEvent is defined in runner.ts, not types.ts, so create a
   comment in types.ts pointing to runner.ts where these will be added):
   // New events will be added to WorkflowEvent in runner.ts:
   // loop:iteration-started, loop:iteration-completed, loop:ended,
   // condition:evaluated, condition:skipped, router:evaluated,
   // parallel:branch-started, parallel:branch-completed,
   // hitl:paused, hitl:responded, hitl:timeout,
   // subworkflow:started, subworkflow:completed,
   // session:state-updated, validation:failed, fallback:agent-switched

10. Export all new types from ${INDEX_FILE}

Make ALL changes. Run: npx tsc --noEmit to verify no type errors.
End your output with: TYPES_COMPLETE
    `,
    dependsOn: ['spec-approval'],
    retries: 2,
    verification: { type: 'output_contains', value: 'TYPES_COMPLETE' },
  })

  .step('p1-json-schema', {
    agent: 'schema-implementer',
    task: `
Phase 1b: Update the JSON Schema to match the new TypeScript types.

Prior type changes:
{{steps.p1-type-system.output}}

YOUR TASK: Update ${SCHEMA_FILE} to add definitions for all new step group types.

Add new $defs entries:
  - StepType enum definition
  - LoopStepGroup object with required: [type, name, steps, maxIterations]
  - RouterRoute object
  - RouterStepGroup object with required: [type, name, selector, routes]
  - ParallelStepGroup object with required: [type, name, steps]
  - HitlStep object with required: [type, name, message]
  - SubWorkflowStep object with required: [type, name, workflow]
  - SessionConfig object
  - AnyWorkflowStep as oneOf the above plus existing WorkflowStep

Update workflow.steps array to use anyOf: [WorkflowStep, AnyWorkflowStep]
Update top-level RelayYamlConfig to include inputSchema and session properties.

Also update packages/sdk/src/workflows/builder.ts:
  - Add a new builder method for sessions:
    session(config: SessionConfig): this
  - Add a new builder method for input schema:
    inputSchema(schema: Record<string, unknown>): this

Verify with: cat ${SCHEMA_FILE} | python3 -m json.tool (or equivalent JSON lint)
End your output with: SCHEMA_COMPLETE
    `,
    dependsOn: ['p1-type-system'],
    retries: 2,
    verification: { type: 'output_contains', value: 'SCHEMA_COMPLETE' },
  })

  .step('p1-lead-review', {
    agent: 'lead',
    task: `
Phase 1 Lead Review: Validate the type system and schema changes.

Type system changes:
{{steps.p1-type-system.output}}

Schema changes:
{{steps.p1-json-schema.output}}

REVIEW CRITERIA:
1. Do the new TypeScript interfaces correctly model the intended semantics?
2. Is the AnyWorkflowStep discriminated union correctly structured? Each variant
   must have a unique "type" literal so TypeScript can narrow the type.
3. Does the WorkflowStep backward compatibility hold? (existing YAML with no
   "type" field should still work — type defaults to "agent")
4. Are the new fields in RelayYamlConfig (inputSchema, session) properly optional?
5. Does the builder extension make sense? Are the new methods ergonomic?
6. Any naming inconsistencies between the TypeScript types and JSON Schema?

If you find issues, describe them specifically with file:line references.
If the phase is acceptable, state what should be fixed in the engine phase.
End with: PHASE_1_APPROVED (even if you request minor fixes — fixes go to
the code-reviewer, who will direct the implementer if needed)
    `,
    dependsOn: ['p1-json-schema'],
    retries: 1,
    verification: { type: 'output_contains', value: 'PHASE_1_APPROVED' },
  })

  .step('p1-code-review', {
    agent: 'code-reviewer',
    task: `
Phase 1 Independent Code Review: TypeScript type system extension.
(Running in parallel with lead review — review the code independently.)

JSON Schema changes:
{{steps.p1-json-schema.output}}

YOUR INDEPENDENT REVIEW of ${TYPES_FILE}, ${SCHEMA_FILE}, ${BUILDER_FILE}:

Check:
1. TypeScript strict-mode compliance — no implicit any, all fields typed
2. JSDoc on every exported interface and type
3. Correct use of discriminated unions (each variant's type field is a
   string literal, not just string)
4. AnyWorkflowStep is correctly exported from ${INDEX_FILE}
5. Builder methods follow existing patterns (return this for chaining)
6. JSON Schema $defs are correctly referenced in anyOf arrays
7. No circular references in the type definitions
8. Run: npx tsc --noEmit from packages/sdk and confirm zero errors

List any issues found. For each: file, line (if known), problem, fix required.
If zero issues: explicitly state "No issues found."
End with: CODE_REVIEW_1_COMPLETE
    `,
    dependsOn: ['p1-json-schema'],
    retries: 1,
    verification: { type: 'output_contains', value: 'CODE_REVIEW_1_COMPLETE' },
  })

  // ── Phase 2: Execution Engine ─────────────────────────────────────────────

  .step('p2-condition-loop', {
    agent: 'engine-implementer',
    task: `
Phase 2a: Implement condition + loop execution in the WorkflowRunner.

Phase 1 review context:
{{steps.p1-code-review.output}}

YOUR TASK: Modify ${RUNNER_FILE} to handle condition and loop step types.

CONDITION STEP EXECUTION:
In the executeStep method (or wherever individual steps are dispatched):
1. Check if step.type === "condition" OR if step.condition is set on a regular step
2. If step.condition exists, evaluate the CEL expression using a lightweight
   evaluator. Use the cel-js npm package (add to package.json if not present)
   OR implement a minimal evaluator that handles:
     - String contains: "X in Y.output"
     - String equality: "steps.X.output == 'VALUE'"
     - Boolean AND/OR
   The expression context object should include:
     { steps: Record<name, { output: string, status: string }>,
       vars: VariableContext }
3. If condition evaluates to false: mark step as "skipped", emit step:skipped event
4. If condition evaluates to true (or no condition): proceed normally

Also add to WorkflowEvent union in runner.ts:
  | { type: "condition:evaluated"; runId: string; stepName: string; result: boolean; expression: string }
  | { type: "condition:skipped"; runId: string; stepName: string }

LOOP STEP GROUP EXECUTION:
Add a new method: private async executeLoopGroup(loop: LoopStepGroup, ...): Promise<string>
1. Run loop.steps sequentially up to loop.maxIterations times
2. After each iteration, evaluate loop.until CEL expression if provided
3. If until evaluates to true, break and return last step output
4. If maxIterations reached without satisfaction, fail with descriptive error
5. Track step outputs by iteration: steps in context include "loop.STEP.output"
   for the current iteration

Add to WorkflowEvent:
  | { type: "loop:iteration-started"; runId: string; loopName: string; iteration: number }
  | { type: "loop:iteration-completed"; runId: string; loopName: string; iteration: number; continuing: boolean }
  | { type: "loop:ended"; runId: string; loopName: string; reason: "condition-met" | "max-iterations" }

In the main execution loop (findReadySteps / executeSteps), detect when a step
is a LoopStepGroup and route it to executeLoopGroup.

Run: npx tsc --noEmit to verify.
End your output with: CONDITION_LOOP_COMPLETE
    `,
    dependsOn: ['p1-code-review'],
    retries: 2,
    verification: { type: 'output_contains', value: 'CONDITION_LOOP_COMPLETE' },
  })

  .step('p2-input-validation', {
    agent: 'schema-implementer',
    task: `
Phase 2b: Implement input schema validation (runs in parallel with p2-condition-loop).

Phase 1 review context:
{{steps.p1-code-review.output}}

YOUR TASK: Add input schema validation to WorkflowRunner before execution starts.

In ${RUNNER_FILE}, in the execute() method, BEFORE the first findReadySteps call:

1. If config.inputSchema is defined:
   a. Import or inline a minimal JSON Schema validator. Use the ajv npm package
      (add to package.json dependencies if not present).
   b. Compile the schema: const validate = ajv.compile(config.inputSchema)
   c. Validate the vars object against the schema
   d. If invalid: emit { type: "validation:failed", runId, errors: AjvError[] }
      and throw WorkflowValidationError with a human-readable message listing
      each field error

2. Add WorkflowValidationError class (extends Error) to runner.ts:
   export class WorkflowValidationError extends Error {
     constructor(public readonly errors: unknown[]) {
       super("Workflow input validation failed: " + JSON.stringify(errors));
       this.name = "WorkflowValidationError";
     }
   }

3. Add to WorkflowEvent:
   | { type: "validation:failed"; runId: string; errors: unknown[] }
   | { type: "validation:passed"; runId: string }

4. Export WorkflowValidationError from ${INDEX_FILE}

5. Update builder.ts: add the inputSchema method to WorkflowBuilder that sets
   config.inputSchema (this was noted in Phase 1 but implement it now if not done)

Run: npx tsc --noEmit to verify.
End your output with: INPUT_VALIDATION_COMPLETE
    `,
    dependsOn: ['p1-code-review'],
    retries: 2,
    verification: { type: 'output_contains', value: 'INPUT_VALIDATION_COMPLETE' },
  })

  .step('p2-router-hitl', {
    agent: 'engine-implementer',
    task: `
Phase 2c: Implement router + HITL step execution.

Condition/loop implementation:
{{steps.p2-condition-loop.output}}

YOUR TASK: Add router and HITL execution to ${RUNNER_FILE}.

ROUTER STEP GROUP EXECUTION:
Add: private async executeRouterGroup(router: RouterStepGroup, context, ...): Promise<string>
1. Evaluate router.selector CEL expression to get a string value
2. Iterate router.routes, find first route where match expression is true
   (match can be substring check: selectorValue.includes(route.match) or
   full CEL evaluation depending on complexity)
3. Collect the branch step names to execute (from route.steps or router.default)
4. Execute those steps (they must exist in the parent workflow's step list)
5. Return concatenated outputs of the executed branch steps

Add to WorkflowEvent:
  | { type: "router:evaluated"; runId: string; routerName: string; selectorValue: string; matchedRoute: string | null }
  | { type: "router:branch-started"; runId: string; routerName: string; stepName: string }

HITL STEP EXECUTION:
Add: private async executeHitlStep(hitl: HitlStep, runId: string, ...): Promise<string>
1. Write a file: {summaryDir}/{runId}/hitl-{hitl.name}-pending.json containing:
   { runId, stepName: hitl.name, message: hitl.message, channel: hitl.channel,
     pendingSince: ISO timestamp, timeoutMs: hitl.timeoutMs }
2. Emit { type: "hitl:paused", runId, stepName, message, channel }
3. Poll every 5 seconds for a response file:
   {summaryDir}/{runId}/hitl-{hitl.name}-response.json
   The response file should contain: { response: string, respondedBy?: string }
4. If timeoutMs elapses without response:
   - If onTimeout === "skip": mark step skipped, emit hitl:timeout, return ""
   - If onTimeout === "use-default": emit hitl:timeout, return hitl.defaultResponse ?? ""
   - Otherwise (default "fail"): throw Error("HITL step timed out")
5. On response: delete pending file, emit hitl:responded, return response.response

Add to WorkflowEvent:
  | { type: "hitl:paused"; runId: string; stepName: string; message: string; channel?: string }
  | { type: "hitl:responded"; runId: string; stepName: string; response: string; respondedBy?: string }
  | { type: "hitl:timeout"; runId: string; stepName: string; action: string }

Run: npx tsc --noEmit
End your output with: ROUTER_HITL_COMPLETE
    `,
    dependsOn: ['p2-condition-loop'],
    retries: 2,
    verification: { type: 'output_contains', value: 'ROUTER_HITL_COMPLETE' },
  })

  .step('p2-session-fallback', {
    agent: 'engine-implementer',
    task: `
Phase 2d: Implement session concept and fallback agent switching.

Router/HITL implementation:
{{steps.p2-router-hitl.output}}

YOUR TASK: Extend WorkflowRunner with session support and fallback agents.

SESSION CONCEPT:
A session groups multiple workflow runs, shares state across them, and can
inject prior run outputs as context into new runs.

1. Extend WorkflowRunnerOptions in runner.ts:
   sessionId?: string;   // if provided, this run joins a named session

2. Add a simple SessionStore (in-memory, backed by WorkflowDb if available):
   - getSession(sessionId): returns { runIds: string[], stateSnapshot: Record }
   - addRunToSession(sessionId, runId): appends runId to session run list
   - getSessionHistory(sessionId, n): returns last n run outputs as context string

3. In execute(), if sessionId is provided:
   a. Load session history (last config.session?.historyRuns ?? 3 runs)
   b. Prepend history context to the first step's task:
      "[Session history - prior runs]\n{history}\n[Current task]\n{task}"
   c. After run completes, call addRunToSession(sessionId, runId)

4. Add to WorkflowEvent:
   | { type: "session:run-added"; sessionId: string; runId: string }
   | { type: "session:history-injected"; sessionId: string; historyRuns: number }

FALLBACK AGENT:
In the step execution method, after all retries on the primary agent are
exhausted:
1. Check if step.fallbackAgent is defined
2. If yes: look up the fallback agent definition by name from config.agents
3. Re-attempt execution once with the fallback agent
4. Emit { type: "fallback:agent-switched"; runId, stepName, fromAgent, toAgent }
5. If fallback also fails: mark step as failed

Add to WorkflowEvent:
  | { type: "fallback:agent-switched"; runId: string; stepName: string; fromAgent: string; toAgent: string }

Also implement the flow shorthand parser (if RelayYamlConfig.flow is set):
  parseFlowString("A -> B, C -> D"): WorkflowStep[]
  - "A -> B" means B.dependsOn = [A]
  - "B, C" means B and C are in parallel (no dependency between them)
  - "A, B -> C" means C.dependsOn = [A, B]
  - Call this in execute() before building the step graph if config.flow is set

Run: npx tsc --noEmit
End your output with: SESSION_FALLBACK_COMPLETE
    `,
    dependsOn: ['p2-router-hitl'],
    retries: 2,
    verification: { type: 'output_contains', value: 'SESSION_FALLBACK_COMPLETE' },
  })

  .step('p2-lead-review', {
    agent: 'lead',
    task: `
Phase 2 Lead Review: Execution engine implementation.

Input validation:
{{steps.p2-input-validation.output}}

Session + fallback:
{{steps.p2-session-fallback.output}}

REVIEW:
1. Is the CEL condition evaluator robust enough? Does it handle the common
   patterns we need (output contains, equality, AND/OR)?
2. Is the loop execution correctly isolated — do step names inside a loop
   conflict with top-level step names in the output context?
3. Is the HITL polling approach acceptable? (file-based polling every 5s)
   Or should it use a simple readline/stdin approach instead?
4. Does the session history injection make sense — will agents be overwhelmed
   by injected context if historyRuns is large?
5. Is the flow string parser correct for all cases:
   "A -> B, C -> D" and "A, B -> C"?
6. Are all new WorkflowEvent variants added to the union consistently?

Note any critical fixes needed before Phase 3 begins.
End with: PHASE_2_APPROVED
    `,
    dependsOn: ['p2-session-fallback', 'p2-input-validation'],
    retries: 1,
    verification: { type: 'output_contains', value: 'PHASE_2_APPROVED' },
  })

  .step('p2-code-review', {
    agent: 'code-reviewer',
    task: `
Phase 2 Independent Code Review: Execution engine.

Lead's review:
{{steps.p2-lead-review.output}}

INDEPENDENT REVIEW of ${RUNNER_FILE}:

1. Correctness: does the condition evaluator correctly handle edge cases
   (undefined step output, empty strings, non-boolean CEL results)?
2. Loop safety: is there a guard against infinite loops if maxIterations is 0?
3. HITL polling: does the polling correctly clean up pending files on both
   success and timeout paths? No file handle leaks?
4. Fallback agent: is the agent definition lookup null-safe? What if
   fallbackAgent name doesn't exist in config.agents?
5. Session history injection: is it correctly skipped when sessionId is absent?
6. Flow parser: does it handle edge cases — empty string, single agent,
   spaces around arrows?
7. TypeScript: run npx tsc --noEmit and report results
8. Existing tests: run npx jest packages/sdk and report pass/fail counts

List all issues with specific fixes. State "No issues" for clean sections.
End with: CODE_REVIEW_2_COMPLETE
    `,
    dependsOn: ['p2-lead-review'],
    retries: 1,
    verification: { type: 'output_contains', value: 'CODE_REVIEW_2_COMPLETE' },
  })

  // ── Phase 3: Meta-Orchestration (parallel with Phase 4) ───────────────────

  .step('p3-sub-workflow', {
    agent: 'meta-implementer',
    task: `
Phase 3a: Implement sub-workflow step execution.

Phase 2 review context:
{{steps.p2-code-review.output}}

YOUR TASK: Add sub-workflow composition to ${RUNNER_FILE}.

SUB-WORKFLOW EXECUTION:
Add: private async executeSubWorkflow(step: SubWorkflowStep, vars, runId, ...): Promise<string>
1. Resolve the workflow reference:
   - If step.workflow starts with "./" or "/": treat as file path
   - Otherwise: look up in the workflow registry at
     ~/.agent-relay/workflow-registry.json (create if absent; plain JSON map)
2. Load and parse the referenced relay.yaml file
3. Merge step.vars with the current run's vars (step.vars take precedence)
4. Create a new WorkflowRunner instance (child runner), share the same DB
5. Execute the sub-workflow config via child runner
6. Return the sub-workflow's run output (join all step outputs)

Add to WorkflowEvent:
  | { type: "subworkflow:started"; runId: string; stepName: string; workflowRef: string }
  | { type: "subworkflow:completed"; runId: string; stepName: string; output: string }
  | { type: "subworkflow:failed"; runId: string; stepName: string; error: string }

WORKFLOW REGISTRY:
Create packages/sdk/src/workflows/registry.ts:

  export interface WorkflowRegistryEntry {
    name: string;
    path: string;
    description?: string;
    tags?: string[];
    installedAt: string;
  }

  export class WorkflowRegistry {
    private readonly registryPath: string;
    // Load registry from ~/.agent-relay/workflow-registry.json
    async list(): Promise<WorkflowRegistryEntry[]>
    async get(name: string): Promise<WorkflowRegistryEntry | null>
    async register(entry: WorkflowRegistryEntry): Promise<void>
    async unregister(name: string): Promise<void>
    async resolvePath(nameOrPath: string): Promise<string>
    // If starts with ./ or / return as-is; else look up in registry
  }

Export WorkflowRegistry from ${INDEX_FILE}.

Run: npx tsc --noEmit
End with: SUB_WORKFLOW_COMPLETE
    `,
    dependsOn: ['p2-code-review'],
    retries: 2,
    verification: { type: 'output_contains', value: 'SUB_WORKFLOW_COMPLETE' },
  })

  .step('p3-auto-builder', {
    agent: 'meta-implementer',
    task: `
Phase 3b: Implement AutoWorkflowBuilder.

Sub-workflow implementation:
{{steps.p3-sub-workflow.output}}

YOUR TASK: Create packages/sdk/src/workflows/auto-builder.ts

The AutoWorkflowBuilder analyzes a task description and uses a meta-agent
to generate a complete RelayYamlConfig automatically.

  export interface AutoBuildOptions {
    availableClis?: AgentCli[];   // defaults to ["claude", "codex"]
    maxAgents?: number;           // defaults to 5
    maxSteps?: number;            // defaults to 10
    preferredPattern?: SwarmPattern;
    dryRun?: boolean;             // if true, return config without executing
    metaCli?: AgentCli;           // CLI to use for the meta-agent (default "claude")
  }

  export interface AutoBuildResult {
    config: RelayYamlConfig;
    yaml: string;
    reasoning: string;  // why the meta-agent chose this structure
    run?: WorkflowRunRow; // present if dryRun is false
  }

  export class AutoWorkflowBuilder {
    constructor(private readonly options: AutoBuildOptions = {}) {}

    async build(task: string): Promise<AutoBuildResult> {
      // 1. Construct a meta-prompt that instructs the meta-agent to:
      //    a. Analyze the task
      //    b. Select the best swarm pattern
      //    c. Define agents (using available CLIs)
      //    d. Define workflow steps with appropriate dependencies
      //    e. Output a valid relay.yaml string (fenced in \`\`\`yaml...\`\`\`)
      //    f. Explain its reasoning
      // 2. Spawn the meta-agent via AgentRelay
      // 3. Extract the YAML from the response (find \`\`\`yaml ... \`\`\` block)
      // 4. Parse and validate the config using WorkflowRunner.parseYamlString
      // 5. If dryRun: return { config, yaml, reasoning }
      // 6. Else: execute via WorkflowRunner and return { config, yaml, reasoning, run }
    }

    // Convenience: build and run immediately
    async run(task: string): Promise<WorkflowRunRow> {
      const result = await this.build(task);
      if (!result.run) throw new Error("Set dryRun: false to execute");
      return result.run;
    }
  }

  // Convenience export
  export async function autoWorkflow(task: string, options?: AutoBuildOptions): Promise<AutoBuildResult> {
    return new AutoWorkflowBuilder(options).build(task);
  }

Export AutoWorkflowBuilder and autoWorkflow from ${INDEX_FILE}.

Also add the meta-workflow type to types.ts if not already done:
  export type MetaWorkflowConfig = RelayYamlConfig & { type: "meta-workflow" };
  (A meta-workflow is a relay.yaml where steps are sub-workflow steps)

Run: npx tsc --noEmit
End with: AUTO_BUILDER_COMPLETE
    `,
    dependsOn: ['p3-sub-workflow'],
    retries: 2,
    verification: { type: 'output_contains', value: 'AUTO_BUILDER_COMPLETE' },
  })

  // ── Phase 4: Storage Backends (parallel with Phase 3) ────────────────────

  .step('p4-db-adapters', {
    agent: 'storage-implementer',
    task: `
Phase 4: Implement production-ready WorkflowDb adapters.
(Runs in parallel with Phase 3 — no dependency between them.)

Phase 2 review context:
{{steps.p2-code-review.output}}

Create a new directory: packages/sdk/src/workflows/db/

Create these files:

1. packages/sdk/src/workflows/db/postgres.ts
   export class PostgresWorkflowDb implements WorkflowDb {
     constructor(options: { connectionString: string; tablePrefix?: string })
     // Creates tables on first connect if they don't exist:
     //   {prefix}workflow_runs, {prefix}workflow_steps
     // Schema mirrors WorkflowRunRow and WorkflowStepRow
     // Uses node-postgres (pg) — add to package.json if absent
     async insertRun(run: WorkflowRunRow): Promise<void>
     async updateRun(id: string, patch: Partial<WorkflowRunRow>): Promise<void>
     async getRun(id: string): Promise<WorkflowRunRow | null>
     async insertStep(step: WorkflowStepRow): Promise<void>
     async updateStep(id: string, patch: Partial<WorkflowStepRow>): Promise<void>
     async getStepsByRunId(runId: string): Promise<WorkflowStepRow[]>
     async close(): Promise<void>
   }

2. packages/sdk/src/workflows/db/sqlite.ts
   export class SqliteWorkflowDb implements WorkflowDb {
     constructor(options: { path: string; tablePrefix?: string })
     // Uses better-sqlite3 — synchronous API wrapped in async methods
     // Same schema as PostgresWorkflowDb
     // Creates tables if they don't exist on construction
   }

3. packages/sdk/src/workflows/db/redis.ts
   export class RedisWorkflowDb implements WorkflowDb {
     constructor(options: {
       url: string;
       keyPrefix?: string;  // default "relay:workflow:"
       runTtlMs?: number;   // optional TTL on run records
     })
     // Uses ioredis — add to package.json if absent
     // Stores runs as JSON strings at key: {prefix}run:{id}
     // Stores step lists at key: {prefix}steps:{runId} (Redis list)
     // Stores individual steps at: {prefix}step:{id}
   }

4. packages/sdk/src/workflows/db/index.ts
   export { PostgresWorkflowDb } from './postgres.js';
   export { SqliteWorkflowDb } from './sqlite.js';
   export { RedisWorkflowDb } from './redis.js';

5. Update packages/sdk/src/workflows/index.ts to export from db/:
   export * from './db/index.js';

IMPORTANT: Add the three packages to package.json as optional peer dependencies
with peerDependenciesMeta markings optional: true, so users only need to install
the adapter they use.

Run: npx tsc --noEmit (adapters will have type errors only if packages are absent;
mark them as type-only imports with // @ts-expect-error if needed with clear comment)
End with: DB_ADAPTERS_COMPLETE
    `,
    dependsOn: ['p2-code-review'],
    retries: 2,
    verification: { type: 'output_contains', value: 'DB_ADAPTERS_COMPLETE' },
  })

  // ── Phase 3+4 Combined Review ─────────────────────────────────────────────

  .step('p34-lead-review', {
    agent: 'lead',
    task: `
Phase 3+4 Lead Review: Meta-orchestration and storage backends.

Phase 3 — AutoBuilder:
{{steps.p3-auto-builder.output}}

Phase 4 — DB adapters:
{{steps.p4-db-adapters.output}}

REVIEW:

META-ORCHESTRATION:
1. Is the sub-workflow execution correctly isolated? (child runner should not
   share the parent runner's event listeners, but should share the DB)
2. Does the WorkflowRegistry file path (~/.agent-relay/) correctly use os.homedir()?
3. Is the AutoWorkflowBuilder meta-prompt clear enough to reliably generate
   valid relay.yaml configs? What guardrails are needed?
4. Does the YAML extraction from meta-agent output handle cases where the
   agent outputs multiple code blocks?

DB ADAPTERS:
5. Are the SQL schemas in PostgresWorkflowDb and SqliteWorkflowDb correct?
   (JSON columns for config/stateSnapshot, TEXT for status, ISO timestamps)
6. Is the Redis adapter correctly handling concurrent updates?
   (Multiple parallel steps updating the same run record — race condition risk)
7. Are optional peer dependencies correctly marked in package.json?
8. Do the adapters correctly handle NULL/missing optional fields?

State fixes needed for the code reviewer to validate.
End with: PHASE_34_APPROVED
    `,
    dependsOn: ['p3-auto-builder', 'p4-db-adapters'],
    retries: 1,
    verification: { type: 'output_contains', value: 'PHASE_34_APPROVED' },
  })

  .step('p34-code-review', {
    agent: 'code-reviewer',
    task: `
Phase 3+4 Independent Code Review.

Lead's notes:
{{steps.p34-lead-review.output}}

REVIEW packages/sdk/src/workflows/registry.ts,
       packages/sdk/src/workflows/auto-builder.ts,
       packages/sdk/src/workflows/db/:

1. Registry: does resolvePath correctly return file paths unchanged and look up
   by name for non-path strings? Is the registry JSON correctly pretty-printed?
2. AutoBuilder: is the meta-prompt templating safe from injection if the task
   string contains special characters or YAML-like content?
3. PostgresWorkflowDb: are SQL queries parameterized? (No string interpolation
   in SQL — security requirement)
4. SqliteWorkflowDb: does the sync API wrap correctly without blocking the event
   loop for extended periods?
5. RedisWorkflowDb: is the JSON serialization of WorkflowRunRow round-trip safe?
   (dates become strings, Record<string,unknown> stays correct)
6. All three adapters: does getStepsByRunId return steps in consistent order?
7. Run npx tsc --noEmit and report results

List issues with specific file + line references.
End with: CODE_REVIEW_34_COMPLETE
    `,
    dependsOn: ['p34-lead-review'],
    retries: 1,
    verification: { type: 'output_contains', value: 'CODE_REVIEW_34_COMPLETE' },
  })

  // ── Phase 5: Deployment and Observability ─────────────────────────────────

  .step('p5-serve-command', {
    agent: 'deploy-implementer',
    task: `
Phase 5a: Implement "relay workflow serve" HTTP server.

Phase 3+4 review context:
{{steps.p34-code-review.output}}

YOUR TASK: Create packages/sdk/src/workflows/server.ts

Implement a lightweight HTTP server (use Node.js built-in http module — no
Express/Fastify dependency) that exposes:

  POST /run
    Body: { workflowPath: string, vars?: VariableContext, sessionId?: string }
    Response: { runId: string, status: "started" }
    Behavior: parse the relay.yaml at workflowPath, start execution (non-blocking),
    return runId immediately

  GET /runs/:runId
    Response: WorkflowRunRow | { error: "not found" }

  GET /runs/:runId/events
    Response: text/event-stream (Server-Sent Events)
    Each WorkflowEvent becomes a SSE data: {json}\n\n line
    Connection stays open until run completes or client disconnects

  POST /runs/:runId/hitl/:stepName/respond
    Body: { response: string, respondedBy?: string }
    Behavior: write {summaryDir}/{runId}/hitl-{stepName}-response.json
    Response: { ok: true }

  POST /runs/:runId/abort
    Behavior: call runner.abort(runId) if supported
    Response: { ok: true }

  GET /health
    Response: { status: "ok", uptime: process.uptime() }

Also create packages/sdk/src/workflows/serve.ts — the CLI entry point:
  export async function serveWorkflows(options: {
    port?: number;     // default 3747
    host?: string;     // default "0.0.0.0"
    db?: WorkflowDb;
  }): Promise<void>

Export serveWorkflows from ${INDEX_FILE}.

The serve command will be integrated into the relay CLI in the next step.

Run: npx tsc --noEmit
End with: SERVE_COMMAND_COMPLETE
    `,
    dependsOn: ['p34-code-review'],
    retries: 2,
    verification: { type: 'output_contains', value: 'SERVE_COMMAND_COMPLETE' },
  })

  .step('p5-otel-tracing', {
    agent: 'deploy-implementer',
    task: `
Phase 5b: Implement OpenTelemetry tracing integration.
(Running in parallel with p5-serve-command — these are independent.)

Phase 3+4 review context:
{{steps.p34-code-review.output}}

YOUR TASK: Add optional OTel tracing to WorkflowRunner.

1. Add otel config to RelayYamlConfig in types.ts (if not already present):
   telemetry?: {
     otel?: boolean;              // enable OTel tracing
     endpoint?: string;           // OTLP endpoint, default "http://localhost:4318"
     serviceName?: string;        // default "relay-workflows"
     exportTo?: "otlp" | "console" | "none";  // default "otlp"
   }

2. Create packages/sdk/src/workflows/tracing.ts:

   export interface TracingOptions {
     enabled: boolean;
     endpoint?: string;
     serviceName?: string;
     exportTo?: "otlp" | "console" | "none";
   }

   export class WorkflowTracer {
     constructor(options: TracingOptions) {}

     // Create root span for workflow run
     startRun(runId: string, workflowName: string, pattern: string): Span

     // Create child span for a step
     startStep(parentSpan: Span, stepName: string, agentName: string): Span

     // Record events on spans
     recordEvent(span: Span, event: WorkflowEvent): void

     // End spans
     endSpan(span: Span, status: "ok" | "error", error?: string): void

     // Shutdown exporter cleanly
     async shutdown(): Promise<void>
   }

Use @opentelemetry/sdk-node and @opentelemetry/api (add as optional peer deps
with peerDependenciesMeta optional: true in package.json).

Guard all OTel imports with a try/catch or dynamic import so the runner works
without OTel installed:
  let tracer: WorkflowTracer | null = null;
  try {
    const { WorkflowTracer } = await import('./tracing.js');
    tracer = new WorkflowTracer(config.telemetry?.otel ? { enabled: true, ...config.telemetry } : { enabled: false });
  } catch {
    // OTel packages not installed — tracing disabled
  }

3. In WorkflowRunner.execute():
   - If tracer enabled: create root run span
   - In executeStep(): create child step span, record start/complete/fail events
   - On run complete: end root span

Export WorkflowTracer from ${INDEX_FILE}.

Run: npx tsc --noEmit
End with: OTEL_TRACING_COMPLETE
    `,
    dependsOn: ['p34-code-review'],
    retries: 2,
    verification: { type: 'output_contains', value: 'OTEL_TRACING_COMPLETE' },
  })

  .step('p5-cli-improvements', {
    agent: 'deploy-implementer',
    task: `
Phase 5c: Implement CLI improvements.

OTel tracing implementation:
{{steps.p5-otel-tracing.output}}

YOUR TASK: Find the CLI entry point for the relay workflow commands and add:

First, locate the CLI code (likely in packages/sdk/src/workflows/cli.ts):
  cat packages/sdk/src/workflows/cli.ts

Add these subcommands to the workflow CLI:

1. relay workflow dry-run <yaml-path> [--var KEY=VALUE...]
   - Parse and validate the YAML (run validateConfig)
   - Resolve variable templates (show substituted values)
   - Show the resolved DAG: step names, dependencies, agent assignments
   - Show which steps can run in parallel
   - Do NOT actually execute — print "DRY RUN: would execute N steps across M agents"

2. relay workflow inspect <yaml-path>
   - Show full config parsed and pretty-printed as JSON
   - Show detected swarm pattern with reason
   - Show agent topology (edges from SwarmCoordinator)
   - Show barrier definitions
   - Show coordination config

3. relay workflow replay <runId> --from <step-name> [--db-path <sqlite-path>]
   - Load existing run record from DB (requires SqliteWorkflowDb)
   - Skip steps that completed successfully before the target step
   - Re-execute from the specified step name onwards
   - Useful for resuming failed runs without restarting from scratch

4. relay workflow serve [--port <N>] [--db sqlite:<path>|postgres:<url>|redis:<url>]
   - Starts the HTTP server from p5-serve-command
   - Accepts DB connection string via --db flag, parses the scheme prefix

Also update the README at packages/sdk/src/workflows/README.md to document
all new CLI commands with usage examples.

Run: npx tsc --noEmit
End with: CLI_IMPROVEMENTS_COMPLETE
    `,
    dependsOn: ['p5-serve-command', 'p5-otel-tracing'],
    retries: 2,
    verification: { type: 'output_contains', value: 'CLI_IMPROVEMENTS_COMPLETE' },
  })

  .step('p5-lead-review', {
    agent: 'lead',
    task: `
Phase 5 Lead Review: Deployment and observability.

Serve command:
{{steps.p5-serve-command.output}}

OTel tracing:
{{steps.p5-otel-tracing.output}}

CLI improvements:
{{steps.p5-cli-improvements.output}}

REVIEW:
1. HTTP server: is SSE implemented correctly? (headers: Content-Type: text/event-stream,
   Cache-Control: no-cache, Connection: keep-alive; proper flushing with res.write)
2. HTTP server: is the HITL respond endpoint correctly writing the response file
   to the same path the runner is polling?
3. OTel: is the dynamic import guard (try/catch) robust? Will it work in CJS builds?
4. OTel: are span hierarchies correct — run span is parent, step spans are children?
5. CLI dry-run: does it show enough information to be useful for debugging?
6. CLI replay: what happens if a replay step depends on a step that was NOT
   completed in the prior run? (Should fail with clear error message.)
7. Is the README updated with accurate examples?

Note critical fixes. End with: PHASE_5_APPROVED
    `,
    dependsOn: ['p5-cli-improvements'],
    retries: 1,
    verification: { type: 'output_contains', value: 'PHASE_5_APPROVED' },
  })

  .step('p5-code-review', {
    agent: 'code-reviewer',
    task: `
Phase 5 Independent Code Review: Deployment and observability.
(Running in parallel with lead review — review the code independently.)

CLI improvements:
{{steps.p5-cli-improvements.output}}

REVIEW packages/sdk/src/workflows/server.ts,
       packages/sdk/src/workflows/tracing.ts,
       packages/sdk/src/workflows/cli.ts:

1. HTTP server: no prototype pollution risk in request body parsing?
   (Validate Content-Type, parse JSON safely with try/catch)
2. SSE endpoint: does it correctly handle client disconnect without leaving
   zombie event listeners on the WorkflowRunner?
3. HITL respond: path traversal risk? (runId and stepName used in file path —
   must sanitize to alphanumeric + hyphen only)
4. OTel: does shutdown() await the exporter flush before process.exit?
5. CLI replay: is the step-skip logic correct? (A skipped-previously-completed
   step should return its stored output for downstream template resolution)
6. Run npx jest packages/sdk and report pass/fail counts
7. Run npx tsc --noEmit and report results

End with: CODE_REVIEW_5_COMPLETE
    `,
    dependsOn: ['p5-cli-improvements'],
    retries: 1,
    verification: { type: 'output_contains', value: 'CODE_REVIEW_5_COMPLETE' },
  })

  // ── Phase 6: Integration Validation + Final Sign-Off ─────────────────────

  .step('integration-validation', {
    agent: 'test-validator',
    task: `
Phase 6: Integration validation across all five tiers.

Phase 5 review:
{{steps.p5-code-review.output}}

YOUR TASK: Run comprehensive validation of the full implementation.

1. TYPE CHECK:
   cd packages/sdk && npx tsc --noEmit
   Report: zero errors or list all errors

2. EXISTING TESTS:
   npx jest packages/sdk/src/__tests__/
   Report: pass count, fail count, any failures

3. BUILD:
   cd packages/sdk && npm run build
   Report: success or errors

4. INTEGRATION SMOKE TESTS — run each of these and report output:

   a. Condition step test:
      Create a temporary relay.yaml with a condition step that checks if
      "SKIP" is in a prior step's output, run it via the WorkflowRunner
      in TypeScript (programmatic, not CLI), verify the step is skipped.

   b. Loop step test:
      Create a temporary relay.yaml with a loop that runs max 3 iterations,
      verify it runs exactly 3 times when until-condition is never met.

   c. Input validation test:
      Create a RelayYamlConfig with inputSchema requiring a "task" field,
      call runner.execute() without "task" in vars, verify WorkflowValidationError
      is thrown.

   d. Flow shorthand test:
      Parse the flow string "planner -> developer, reviewer -> lead" and verify
      that developer.dependsOn = ["planner"], reviewer.dependsOn = ["planner"],
      lead.dependsOn = ["developer", "reviewer"].

   e. SqliteWorkflowDb test:
      Create an in-memory SQLite DB, insert a run, update it, retrieve it,
      verify round-trip fidelity of all fields.

5. EXPORTS CHECK:
   Verify that the following are exported from packages/sdk/src/workflows/index.ts:
   - WorkflowBuilder, workflow
   - WorkflowRunner, WorkflowRunnerOptions, WorkflowEvent, WorkflowEventListener
   - WorkflowValidationError
   - AutoWorkflowBuilder, autoWorkflow
   - WorkflowRegistry
   - SqliteWorkflowDb, PostgresWorkflowDb, RedisWorkflowDb
   - WorkflowTracer
   - All new types: AnyWorkflowStep, LoopStepGroup, RouterStepGroup,
     ParallelStepGroup, HitlStep, SubWorkflowStep, SessionConfig

Report full results. End with: INTEGRATION_VALIDATED
    `,
    dependsOn: ['p5-code-review', 'p5-lead-review'],
    retries: 2,
    verification: { type: 'output_contains', value: 'INTEGRATION_VALIDATED' },
  })

  .step('final-lead-review', {
    agent: 'lead',
    task: `
FINAL LEAD REVIEW: Complete broker-sdk workflow superiority implementation.

Integration validation results:
{{steps.integration-validation.output}}

This is the culmination of a five-phase implementation campaign. Your job:

1. CAPABILITY AUDIT — verify we now have all of these (check integration results):
   □ condition step type (CEL-based conditional execution)
   □ loop step type (iterative with until-condition)
   □ router step type (runtime branch selection)
   □ parallel step group (explicit with any/majority barriers)
   □ HITL step type (human-in-the-loop with file-based pause/resume)
   □ sub-workflow step (workflow composition)
   □ flow shorthand (string notation "A -> B, C")
   □ session concept (multi-run state sharing)
   □ input schema validation (JSON Schema via Ajv)
   □ fallback agent switching
   □ AutoWorkflowBuilder (LLM-generated workflows)
   □ WorkflowRegistry (name-to-path resolution)
   □ PostgresWorkflowDb, SqliteWorkflowDb, RedisWorkflowDb
   □ HTTP serve command with SSE event streaming
   □ OTel tracing (optional, dynamic import)
   □ CLI: dry-run, inspect, replay, serve
   □ 30+ WorkflowEvent types
   □ All exports correct from index.ts

2. COMPETITIVE POSITION — confirm we now surpass:
   AGNO: We have everything Agno has (condition=Condition, loop=Loop,
   router=Router, session, input validation, serve, OTel) PLUS barriers,
   consensus, HITL, polyglot backends, YAML portability, sub-workflow composition.

   SWARMS: We have equivalent patterns PLUS out-of-process PTY isolation,
   YAML portability, true relay protocol, HITL, OTel, sub-workflow composition,
   HTTP serve. Swarms has more built-in swarm types (15+ vs our 10) but we
   cover all critical execution patterns with richer composition primitives.

3. REMAINING GAPS (if any) — list anything that was not fully implemented
   and should be tracked as future work.

4. DOCUMENTATION — confirm README.md in the workflows directory is updated
   with examples for all new features.

Produce a final capability report with the checklist above filled in.
End with: IMPLEMENTATION_COMPLETE
    `,
    dependsOn: ['integration-validation'],
    retries: 1,
    verification: { type: 'output_contains', value: 'IMPLEMENTATION_COMPLETE' },
  })

  .onError('retry', { maxRetries: 2, retryDelayMs: 10_000 })

  .run({
    onEvent,
    vars: {
      // Override these at runtime if needed:
      // workflowRoot: 'packages/sdk/src/workflows',
    },
  });

console.log('\n── Run complete ─────────────────────────────────────────────────');
console.log(`status:      ${result.status}`);
console.log(`runId:       ${result.id}`);
console.log(`workflow:    ${result.workflowName}`);
console.log(`pattern:     ${result.pattern}`);
console.log(`started:     ${result.startedAt}`);
console.log(`completed:   ${result.completedAt ?? '—'}`);
if (result.error) {
  console.error(`error:       ${result.error}`);
}
