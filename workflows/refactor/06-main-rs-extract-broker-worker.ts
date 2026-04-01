/**
 * Workflow 06: Extract broker.rs and worker.rs from main.rs
 * 
 * TDD extraction of the two largest Rust modules from main.rs.
 * Wave 2 — depends on Rust decomposition plan (workflow 02).
 */
import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relay';

async function main() {
  const result = await workflow('main-rs-extract-broker-worker')
    .description('TDD extraction of broker and worker modules from main.rs')
    .pattern('dag')
    .channel('wf-extract-broker-worker')
    .maxConcurrency(4)
    .timeout(5_400_000)

    .agent('architect', { cli: 'claude', preset: 'lead', role: 'Designs Rust module APIs and writes test stubs' })
    .agent('broker-impl', { cli: 'codex', preset: 'worker', role: 'Extracts broker module' })
    .agent('worker-impl', { cli: 'codex', preset: 'worker', role: 'Extracts worker module' })
    .agent('reviewer', { cli: 'claude', preset: 'reviewer', role: 'Reviews Rust module extraction' })
    .agent('cargo-check', { cli: 'codex', preset: 'reviewer', role: 'Verifies cargo build + test after extraction' })

    // Read BrokerState and WorkerRegistry
    .step('read-broker', {
      type: 'deterministic',
      command: `cd ${ROOT} && echo "=== BrokerState ===" && grep -n "struct BrokerState\\|impl BrokerState" src/main.rs && echo "=== BrokerState fields ===" && sed -n '/^struct BrokerState/,/^}/p' src/main.rs | head -30 && echo "=== BrokerState methods ===" && sed -n '/^impl BrokerState/,/^impl [^B]/p' src/main.rs | grep "fn " | head -30`,
      captureOutput: true,
    })

    .step('read-worker', {
      type: 'deterministic',
      command: `cd ${ROOT} && echo "=== WorkerRegistry ===" && grep -n "struct WorkerRegistry\\|impl WorkerRegistry\\|struct WorkerHandle\\|enum WorkerEvent" src/main.rs && echo "=== WorkerRegistry fields ===" && sed -n '/struct WorkerRegistry/,/^}/p' src/main.rs | head -20 && echo "=== WorkerHandle ===" && sed -n '/struct WorkerHandle/,/^}/p' src/main.rs | head -20 && echo "=== Worker methods ===" && sed -n '/impl WorkerRegistry/,/^impl [^W]/p' src/main.rs | grep "fn " | head -20`,
      captureOutput: true,
    })

    .step('read-tests', {
      type: 'deterministic',
      command: `cd ${ROOT} && echo "=== Rust tests ===" && grep -c "#\\[test\\]" src/main.rs src/*.rs 2>/dev/null && echo "=== Test modules ===" && grep -n "#\\[cfg(test)\\]" src/main.rs src/*.rs 2>/dev/null | head -10 && echo "=== Cargo test ===" && cargo test --no-run 2>&1 | tail -10`,
      captureOutput: true,
    })

    // Architect designs both modules + test strategy
    .step('design-modules', {
      agent: 'architect',
      dependsOn: ['read-broker', 'read-worker', 'read-tests'],
      task: `Design the broker.rs and worker.rs modules for extraction from main.rs.

BrokerState info:
{{steps.read-broker.output}}

WorkerRegistry info:
{{steps.read-worker.output}}

Test info:
{{steps.read-tests.output}}

For broker.rs:
- Move BrokerState struct and impl
- Public API: BrokerState::new(), methods for session/agent management
- Dependencies: worker.rs (WorkerRegistry), session types
- Visibility: pub(crate) for internal, pub for SDK-facing

For worker.rs:
- Move WorkerRegistry, WorkerHandle, WorkerEvent
- Public API: WorkerRegistry::new(), spawn/despawn, message delivery
- Dependencies: minimal (PTY types, message types)

Write test stubs for both:
1. ${ROOT}/src/broker_tests.rs — BrokerState creation, agent registration
2. ${ROOT}/src/worker_tests.rs — WorkerRegistry spawn/despawn, message routing

Write test files to disk. Keep output under 60 lines.
End with DESIGN_COMPLETE`,
      verification: { type: 'output_contains', value: 'DESIGN_COMPLETE' },
    })

    // Extract broker.rs (parallel with worker)
    .step('extract-broker', {
      agent: 'broker-impl',
      dependsOn: ['design-modules'],
      task: `Extract BrokerState from main.rs into src/broker.rs.

Read:
- ${ROOT}/src/main.rs — find struct BrokerState and impl BrokerState, extract all related code
- ${ROOT}/src/broker_tests.rs — tests to satisfy

Create ${ROOT}/src/broker.rs:
1. Move BrokerState struct + impl block
2. Add \`mod broker;\` to main.rs
3. Update all references in main.rs to use \`broker::BrokerState\`
4. Use \`pub(crate)\` visibility appropriately
5. Add \`use\` statements for required types

Verify: cd ${ROOT} && cargo build 2>&1 | tail -20
End with BROKER_EXTRACTED`,
      verification: { type: 'output_contains', value: 'BROKER_EXTRACTED' },
    })

    // Extract worker.rs (parallel with broker)
    .step('extract-worker', {
      agent: 'worker-impl',
      dependsOn: ['design-modules'],
      task: `Extract WorkerRegistry from main.rs into src/worker.rs.

Note: src/worker.rs might conflict with existing files. Check first:
ls ${ROOT}/src/worker*.rs

Read:
- ${ROOT}/src/main.rs — find WorkerRegistry, WorkerHandle, WorkerEvent
- ${ROOT}/src/worker_tests.rs — tests to satisfy

Create ${ROOT}/src/worker.rs (or worker_registry.rs if worker.rs exists):
1. Move WorkerRegistry struct + impl, WorkerHandle, WorkerEvent
2. Add \`mod worker;\` (or \`mod worker_registry;\`) to main.rs
3. Update references in main.rs and broker.rs
4. Use \`pub(crate)\` visibility

Verify: cd ${ROOT} && cargo build 2>&1 | tail -20
End with WORKER_EXTRACTED`,
      verification: { type: 'output_contains', value: 'WORKER_EXTRACTED' },
    })

    // Cargo build + test gate
    .step('cargo-gate', {
      type: 'deterministic',
      dependsOn: ['extract-broker', 'extract-worker'],
      command: `cd ${ROOT} && echo "=== main.rs size ===" && wc -l src/main.rs && echo "=== New modules ===" && wc -l src/broker.rs src/worker.rs src/worker_registry.rs 2>/dev/null && echo "=== Cargo build ===" && cargo build 2>&1 | tail -15 && echo "=== Cargo test ===" && cargo test 2>&1 | tail -15 && echo "CARGO_GATE_PASSED"`,
      captureOutput: true,
      failOnError: true,
    })

    // Review
    .step('review', {
      agent: 'reviewer',
      dependsOn: ['cargo-gate'],
      task: `Review the Rust module extraction.

Read:
- ${ROOT}/src/broker.rs
- ${ROOT}/src/worker.rs or ${ROOT}/src/worker_registry.rs
- ${ROOT}/src/main.rs (check it's smaller and imports are correct)

Results: {{steps.cargo-gate.output}}

Check:
1. Does main.rs only wire modules together now?
2. Are visibility modifiers correct?
3. No unsafe code introduced?
4. Lifetime annotations preserved correctly?
5. cargo build + cargo test pass?

Keep under 30 lines.
End with REVIEW_COMPLETE`,
      verification: { type: 'output_contains', value: 'REVIEW_COMPLETE' },
    })

    // Second reviewer — Rust-specific edge cases
    .step('cargo-review', {
      agent: 'cargo-check',
      dependsOn: ['review'],
      task: `Rust-specific review of the extraction.

Read:
- ${ROOT}/src/broker.rs
- ${ROOT}/src/worker.rs or ${ROOT}/src/worker_registry.rs

Check:
1. Are Arc/Mutex patterns preserved correctly across module boundaries?
2. Any Send/Sync issues from splitting structs?
3. Are error types properly re-exported?
4. clippy clean? Run: cd ${ROOT} && cargo clippy 2>&1 | tail -20

Keep under 20 lines.
End with CARGO_REVIEW_COMPLETE`,
      verification: { type: 'output_contains', value: 'CARGO_REVIEW_COMPLETE' },
    })

    .onError('continue')
    .run({ cwd: ROOT });

  console.log('Workflow status:', result.status);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
