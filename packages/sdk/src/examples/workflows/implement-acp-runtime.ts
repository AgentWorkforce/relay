/**
 * implement-acp-runtime.ts
 *
 * Launcher for the ACP runtime implementation workflow.
 * The canonical workflow is defined in implement-acp-runtime.yaml because it
 * uses deterministic steps (type: 'deterministic') which the builder API
 * doesn't expose. This file runs the YAML via runWorkflow().
 *
 * Implements the ACP runtime spec (docs/adr/acp-runtime-spec.md) across:
 *   1. packages/sdk/src/protocol.ts         — AgentRuntime + ACP protocol types
 *   2. packages/sdk/src/workflows/types.ts   — runtime field on AgentDefinition
 *   3. packages/sdk/src/workflows/builder.ts — runtime field on AgentOptions
 *   4. packages/sdk/src/client.ts            — SpawnAcpInput, spawnAcp() method
 *   5. packages/sdk/src/workflows/runner.ts  — resolveRuntime(), ACP_ADAPTERS, spawnAcp dispatch
 *
 * Architecture (3 phases, 2 waves):
 *   Phase 1: Deterministic reads (source files + spec)
 *   Phase 2: Implementation
 *     Wave A: protocol-worker + wf-types-worker (parallel)
 *     Wave B: runner-worker + client-worker (parallel, after types verified)
 *   Phase 3: Verify (tsc) → review → fix → final typecheck gate
 *
 * Usage:
 *   agent-relay run packages/sdk/src/examples/workflows/implement-acp-runtime.yaml
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWorkflow } from '../../workflows/run.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const yamlPath = path.join(__dirname, 'implement-acp-runtime.yaml');

const result = await runWorkflow(yamlPath, {
  cwd: process.cwd(),
  onEvent: (event) => {
    const ts = new Date().toISOString().slice(11, 19);
    switch (event.type) {
      case 'step:started':
        console.log(`[${ts}] ▶ ${event.stepName}`);
        break;
      case 'step:completed':
        console.log(`[${ts}] ✓ ${event.stepName}`);
        break;
      case 'step:failed':
        console.log(`[${ts}] ✗ ${event.stepName}: ${event.error}`);
        break;
      case 'step:retrying':
        console.log(`[${ts}] ↻ ${event.stepName} (attempt ${event.attempt})`);
        break;
      case 'run:completed':
        console.log(`[${ts}] ◉ ACP runtime implementation complete`);
        break;
      case 'run:failed':
        console.log(`[${ts}] ◉ Workflow failed: ${event.error}`);
        break;
    }
  },
});

console.log('\nResult:', result.status);
