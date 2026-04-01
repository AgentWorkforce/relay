/**
 * Workflow 02: main.rs Decomposition Plan
 * 
 * Analyzes the 7023-line main.rs and produces a decomposition plan
 * into focused Rust modules.
 *
 * Wave 1 — runs in parallel with 01-runner-decomposition-plan.ts
 */
import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relay';

async function main() {
  const result = await workflow('main-rs-decomposition-plan')
    .description('Analyze main.rs and produce a Rust module decomposition plan')
    .pattern('dag')
    .channel('wf-main-rs-plan')
    .maxConcurrency(4)
    .timeout(3_600_000)

    .agent('architect', { cli: 'claude', preset: 'lead', role: 'Designs Rust module boundaries for main.rs' })
    .agent('test-strategist', { cli: 'claude', preset: 'worker', role: 'Designs test-first approach for Rust extraction' })
    .agent('reviewer', { cli: 'codex', preset: 'reviewer', role: 'Reviews the Rust decomposition plan' })

    .step('read-main-rs', {
      type: 'deterministic',
      command: `cd ${ROOT} && echo "---LINE-COUNT---" && wc -l src/main.rs && echo "---STRUCTS---" && grep -n "^struct \\|^pub struct \\|^enum \\|^pub enum " src/main.rs && echo "---IMPLS---" && grep -n "^impl " src/main.rs && echo "---FNS---" && grep -n "^fn \\|^pub fn \\|^async fn \\|^pub async fn " src/main.rs && echo "---MODS---" && grep -n "^mod " src/main.rs && echo "---EXISTING-MODULES---" && ls src/*.rs && echo "---TESTS---" && ls tests/*.rs 2>/dev/null || echo "no integration tests dir"`,
      captureOutput: true,
    })

    .step('read-big-modules', {
      type: 'deterministic',
      command: `cd ${ROOT} && echo "---HELPERS-FNS---" && grep -n "^pub fn\\|^fn " src/helpers.rs | head -30 && echo "---SNIPPETS-FNS---" && grep -n "^pub fn\\|^fn " src/snippets.rs | head -30 && echo "---LISTEN-API-FNS---" && grep -n "^pub fn\\|^pub async fn\\|^fn \\|^async fn " src/listen_api.rs | head -30 && echo "---SWARM-FNS---" && grep -n "^pub fn\\|^fn \\|^struct \\|^impl " src/swarm.rs | head -30`,
      captureOutput: true,
    })

    .step('read-cargo', {
      type: 'deterministic',
      command: `cd ${ROOT} && head -40 Cargo.toml && echo "---RUST-TESTS---" && grep -rn "#\\[cfg(test)\\]\\|#\\[test\\]" src/main.rs | head -20 && echo "---TEST-COUNT---" && grep -c "#\\[test\\]" src/main.rs 2>/dev/null || echo "0 tests in main.rs"`,
      captureOutput: true,
    })

    .step('design-plan', {
      agent: 'architect',
      dependsOn: ['read-main-rs', 'read-big-modules', 'read-cargo'],
      task: `You are decomposing a 7023-line main.rs into focused Rust modules.

Current state:
{{steps.read-main-rs.output}}

Other large modules:
{{steps.read-big-modules.output}}

Cargo config:
{{steps.read-cargo.output}}

Design a decomposition plan. main.rs contains:
- CLI arg parsing (clap structs)
- BrokerState struct and impl
- WorkerRegistry struct and impl
- WorkerHandle, PendingDelivery structs
- RelaySession, RelayWorkspace structs
- Message routing and delivery logic
- Thread accumulator logic
- AgentMetrics tracking
- Various helper functions

Proposed new modules:
1. **broker.rs** — BrokerState struct + impl (the core broker orchestration)
2. **worker.rs** — WorkerRegistry, WorkerHandle, WorkerEvent, spawn/despawn logic
3. **delivery.rs** — PendingDelivery, message delivery, ack handling
4. **session.rs** — RelaySession, RelayWorkspace, connect_relay()
5. **threads.rs** — ThreadInfo, ThreadAccumulator, thread management
6. **metrics.rs** — AgentMetrics, timing, cost tracking
7. **cli.rs** — Cli struct, Commands enum, arg parsing
8. **main.rs** (slimmed) — just main() wiring modules together, <300 lines

Also address:
- helpers.rs (1987 lines) — should it be split further?
- snippets.rs (3105 lines) — what's in there and should it split?

For each module specify:
- Structs/enums/fns to move
- pub vs pub(crate) visibility
- Dependencies between modules
- Test strategy

Keep under 80 lines.
End with RUST_DECOMP_PLAN_COMPLETE`,
      verification: { type: 'output_contains', value: 'RUST_DECOMP_PLAN_COMPLETE' },
    })

    .step('design-tests', {
      agent: 'test-strategist',
      dependsOn: ['design-plan'],
      task: `Based on this Rust decomposition plan:
{{steps.design-plan.output}}

Design the test-first strategy. Rust has strong compiler guarantees but we still need:

1. For each new module, list:
   - Unit tests to write BEFORE extraction (characterization tests in main.rs #[cfg(test)])
   - Unit tests for the extracted module
   - Integration test commands (cargo test --lib, cargo test --test)
2. Extraction order (safest first — fewest cross-module dependencies)
3. Compilation gate: after each extraction, \`cargo build\` and \`cargo test\` must pass
4. Any \`pub(crate)\` vs \`pub\` decisions that affect testability

Keep under 50 lines.
End with RUST_TEST_STRATEGY_COMPLETE`,
      verification: { type: 'output_contains', value: 'RUST_TEST_STRATEGY_COMPLETE' },
    })

    .step('review-plan', {
      agent: 'reviewer',
      dependsOn: ['design-plan', 'design-tests'],
      task: `Review the Rust decomposition plan and test strategy:

PLAN:
{{steps.design-plan.output}}

TESTS:
{{steps.design-tests.output}}

Check:
1. Will \`cargo build\` pass after each extraction step?
2. Are visibility modifiers correct (pub vs pub(crate))?
3. Are circular dependencies avoided?
4. Is the extraction order safe?
5. Any lifetime/borrow issues with splitting structs across modules?

Verdict: APPROVED, APPROVED_WITH_CHANGES, or REJECTED.
Keep under 40 lines.
End with REVIEW_COMPLETE`,
      verification: { type: 'output_contains', value: 'REVIEW_COMPLETE' },
    })

    .onError('continue')
    .run({ cwd: ROOT });

  console.log('Workflow status:', result.status);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
