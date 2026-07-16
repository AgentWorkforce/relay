# Trajectory: Implement Plan 001 AI SDK harness adoption and open a verified PR

> **Status:** ✅ Completed
> **Confidence:** 94%
> **Started:** July 15, 2026 at 11:36 PM
> **Completed:** July 16, 2026 at 02:26 AM

---

## Summary

Implemented Plan 001: Node 22 baseline, experimental AI SDK harness adapters, canonical lifecycle and semantic observability, Relaycast publication, PTY fallback parity, CLI attach rendering, replay, capability reporting, and benchmark/soak coverage; completed three adversarial review rounds and full JS/Rust verification.

**Approach:** Standard approach

---

## Key Decisions

### Adopt exact published AI SDK harness family and Node 22.14 CI baseline
- **Chose:** Adopt exact published AI SDK harness family and Node 22.14 CI baseline
- **Reasoning:** All six official packages resolve to one HarnessV1 1.0.34 family and require Node >=22; 22.14.0 is already the repository's pinned Node 22 CI release.

### Model canonical activity as a pure reducer over the existing AgentSessionEvent envelope
- **Chose:** Model canonical activity as a pure reducer over the existing AgentSessionEvent envelope
- **Reasoning:** Keeping activity separate from durable status and carrying source/fidelity/sequence on canonical session observations lets AI SDK and PTY runtimes share listeners while observer replay remains deduplicated and monotonic.

### Host public HarnessV1 directly and make the semantic sidecar a thin protocol adapter
- **Chose:** Host public HarnessV1 directly and make the semantic sidecar a thin protocol adapter
- **Reasoning:** Retaining HarnessV1PromptControl preserves active input and approvals; the sidecar only translates broker commands/events while RelaySession owns ordering and deduplication.

### Hash runtime-owned session state paths and sanitize work-directory segments
- **Chose:** Hash runtime-owned session state paths and sanitize work-directory segments
- **Reasoning:** Session identifiers cross a protocol boundary and must never become deletion paths or escape the configured workspace.

### Use broker-owned semantic sidecars with versioned framed commands, per-agent monotonic event sequences, and bounded per-agent replay
- **Chose:** Use broker-owned semantic sidecars with versioned framed commands, per-agent monotonic event sequences, and bounded per-agent replay
- **Reasoning:** This keeps PTY behavior unchanged while giving supported harnesses structured lifecycle, input acknowledgements, reconnect reconciliation, and a stable benchmark for adapter parity.

### Use deterministic fake adapters for CI contracts and gate real CLI turns behind RELAY_INTEGRATION_REAL_CLI=1
- **Chose:** Use deterministic fake adapters for CI contracts and gate real CLI turns behind RELAY_INTEGRATION_REAL_CLI=1
- **Reasoning:** Keeps ordinary CI stable and credential-free while preserving an explicit real-adapter verification path with named per-adapter skips.

### Report PTY parity per activity and semantic family
- **Chose:** Report PTY parity per activity and semantic family
- **Reasoning:** AI SDK is the reference profile; exact, inferred, and unavailable signals remain visible without a misleading scalar score.

### Publish canonical lifecycle through Relaycast agent event storage and wire PTY broker evidence into the shared translator
- **Chose:** Publish canonical lifecycle through Relaycast agent event storage and wire PTY broker evidence into the shared translator
- **Reasoning:** Remote applications need durable cross-process observability; AI SDK remains the reference profile while PTY emits only exact/inferred signals it can prove

### Parallelized lazy adapter imports in the registry test and gave the package-load assertion a 15-second ceiling
- **Chose:** Parallelized lazy adapter imports in the registry test and gave the package-load assertion a 15-second ceiling
- **Reasoning:** The assertion validates adapter availability, not sequential import latency; the full-suite 5-second timeout was flaky while all adapters loaded successfully in under one second when independent imports ran concurrently.

---

## Chapters

### 1. Work
*Agent: default*

- Adopt exact published AI SDK harness family and Node 22.14 CI baseline: Adopt exact published AI SDK harness family and Node 22.14 CI baseline
- Model canonical activity as a pure reducer over the existing AgentSessionEvent envelope: Model canonical activity as a pure reducer over the existing AgentSessionEvent envelope
- Host public HarnessV1 directly and make the semantic sidecar a thin protocol adapter: Host public HarnessV1 directly and make the semantic sidecar a thin protocol adapter
- Hash runtime-owned session state paths and sanitize work-directory segments: Hash runtime-owned session state paths and sanitize work-directory segments
- Use broker-owned semantic sidecars with versioned framed commands, per-agent monotonic event sequences, and bounded per-agent replay: Use broker-owned semantic sidecars with versioned framed commands, per-agent monotonic event sequences, and bounded per-agent replay
- Use deterministic fake adapters for CI contracts and gate real CLI turns behind RELAY_INTEGRATION_REAL_CLI=1: Use deterministic fake adapters for CI contracts and gate real CLI turns behind RELAY_INTEGRATION_REAL_CLI=1
- Report PTY parity per activity and semantic family: Report PTY parity per activity and semantic family
- Second fresh-context review rejects Plan 001: semantic events are not wired to Relaycast/AgentRelay listeners; port handoff remains stealable; lexical path checks allow symlink escape; semantic command idempotency accepts conflicting payloads.
- Publish canonical lifecycle through Relaycast agent event storage and wire PTY broker evidence into the shared translator: Publish canonical lifecycle through Relaycast agent event storage and wire PTY broker evidence into the shared translator
- Parallelized lazy adapter imports in the registry test and gave the package-load assertion a 15-second ceiling: Parallelized lazy adapter imports in the registry test and gave the package-load assertion a 15-second ceiling

---

## Artifacts

**Commits:** 06ba42d8d, 8140e0a9e, 057121b50, c008b604b, e33e33c7f, cfb43cad9, c59d3f928, 58aea1da7, dc5776502, 766ff50d2, fc6684762, 825f5958c, cd3739577, c9f24fa71, 7a747d17c, 1653c3194, c5061036d, 53393a706, 53c889dd6, 8ba380201, 8cce01808, 3ef14433d, 98487de98, f35e2010c, 50f311ceb, 2012ac876, 8861b3e85, f8819ed71, b3760e7c5, 2c4a187d8, 642f44414, f2abd67bc, 00bbcaf46, f7db6e700, 64941e94c, e77373eac, b314e6926, 110a78a8f, b99d016af, 390627cd6, f3b967a85, 9af9de32c, 944862e7a, d59da2307, b62d384f8, 820e7cc82, 0d15ae2e4, 4683d6df9, 8841a16f3, 0e3fd9eda, 174bf7c19, c0de5f9c9, 97dcc78e1, 0bf94cab4, 7afc1ec4f, 51fd0bd38, bdd40ccba, b42d50f21, e2668f44f, 10e023eae, 5a688a97e, adae9a021, 0d7841925, 9d238e2f9, ee8a7a065, 65641b415, 0e323d0e7, ff4b2773a, 1f96aa071, fd1f4499b, 180cb8ba0, 93aad7d42, b0959ea2f, fbecb7015, 7327f215a, f1a5c92b2, d71fc621d, 29ffaff26, 21281ebce, 543d5ddf8, 89ea25c0a
**Files changed:** 91
