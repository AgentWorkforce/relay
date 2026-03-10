/**
 * implement-acp-runtime.ts
 *
 * Launcher for the ACP runtime implementation workflow.
 * The canonical workflow is defined in implement-acp-runtime.yaml because it
 * uses deterministic steps (type: 'deterministic') which the builder API
 * doesn't expose. This file runs the YAML via the WorkflowRunner.
 *
 * Implements the ACP runtime spec (docs/adr/acp-runtime-spec.md) across:
 *   1. packages/sdk/src/protocol.ts         — AgentRuntime + ACP protocol types
 *   2. packages/sdk/src/workflows/types.ts   — runtime field on AgentDefinition
 *   3. packages/sdk/src/workflows/builder.ts — runtime field on AgentOptions
 *   4. packages/sdk/src/client.ts            — SpawnAcpInput, spawnAcp() method
 *   5. packages/sdk/src/workflows/runner.ts  — resolveRuntime(), ACP_ADAPTERS, spawnAcp dispatch
 *
 * Architecture (3 phases, 3 parallel tracks):
 *   Phase 1: Deterministic reads (source files + spec)
 *   Phase 2: Parallel implementation
 *     Track A: types-lead + protocol-worker + wf-types-worker
 *     Track B: runner-lead + runner-worker
 *     Track C: client-worker
 *   Phase 3: Verify (tsc) → review → fix → final typecheck gate
 *
 * Usage:
 *   agent-relay run packages/sdk/src/examples/workflows/implement-acp-runtime.yaml
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { WorkflowRunner } from '../../workflows/runner.js';

const yamlPath = path.join(import.meta.dirname!, 'implement-acp-runtime.yaml');
const yamlContent = await readFile(yamlPath, 'utf-8');

const runner = new WorkflowRunner();
const result = await runner.runFromYaml(yamlContent, {
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
