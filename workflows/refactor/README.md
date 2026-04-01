# Relay Codebase Refactoring Workflows

Systematic TDD decomposition of oversized files in the relay repo.

## Targets

| File | Lines | Problem |
|------|-------|---------|
| `packages/sdk/src/workflows/runner.ts` | 6,878 | God class — 15+ concerns in one file |
| `src/main.rs` | 7,023 | Structs, broker, worker, session, routing all in one |
| `src/snippets.rs` | 3,105 | Large utility file |
| `src/listen_api.rs` | 2,191 | API handler monolith |
| `src/helpers.rs` | 1,987 | Grab-bag of helpers |

## Approach

**TDD extraction**: Write characterization tests → extract module → verify green bar → review.

## Wave Plan

### Wave 1: Decomposition Plans (parallel, ~25 min)
- `01-runner-decomposition-plan.ts` — Analyze runner.ts, design module boundaries
- `02-main-rs-decomposition-plan.ts` — Analyze main.rs, design Rust modules

### Wave 2: Small + Medium Extractions (parallel, ~30 min)
- `03-runner-extract-verification.ts` — Extract verification gates (~90 lines, smallest)
- `04-runner-extract-template-channel.ts` — Extract template-resolver + channel-messenger (fan-out)
- `06-main-rs-extract-broker-worker.ts` — Extract BrokerState + WorkerRegistry from Rust

### Wave 3: Large Extraction (~45 min)
- `05-runner-extract-step-executor.ts` — Extract the 3,100-line step execution engine

## Agent Mix

| Role | CLI | Preset | Use |
|------|-----|--------|-----|
| Architect | Claude | lead | Design APIs, write test stubs, guide extraction |
| Implementer | Codex | worker | Extract code, wire imports, make tests pass |
| Reviewer | Claude | reviewer | Check correctness, API cleanliness |
| Self-reflect | Codex | reviewer | Second review — edge cases, Rust-specific issues |

## Usage

```bash
# Preview
npx tsx workflows/refactor/run-refactor.ts --dry-run

# Run all waves sequentially (commits between waves)
npx tsx workflows/refactor/run-refactor.ts

# Run specific wave
npx tsx workflows/refactor/run-refactor.ts --wave 1

# Run individual workflow
agent-relay run workflows/refactor/03-runner-extract-verification.ts
```

## Expected Outcome

After all waves:
- `runner.ts`: 6,878 → ~1,500 lines (orchestration shell)
- `main.rs`: 7,023 → ~300 lines (entry point + wiring)
- 8 new TS modules with dedicated test files
- 2-4 new Rust modules with unit tests
- All existing tests pass
