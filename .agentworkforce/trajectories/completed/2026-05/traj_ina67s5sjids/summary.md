# Trajectory: Extract acp-bridge package to standalone repo

> **Status:** ✅ Completed
> **Confidence:** 80%
> **Started:** May 28, 2026 at 06:40 PM
> **Completed:** May 31, 2026 at 02:54 AM

---

## Summary

Implemented the full README public API across 4 packages: SDK facade (workspace/sendMessage/registerAction/notify + message overloads), listener/predicate DSL (relay.on + event/action/agent predicates), harness create()/new() factories, and restored the cloud CLI group + runtime alias + top-level lifecycle verbs. Added a compile-time README contract test; all suites green.

**Approach:** Standard approach

---

## Key Decisions

### Renamed AgentRelayClient -> RuntimeClient and purged AgentRelay-prefixed names from @agent-relay/runtime (RuntimeClientOptions, RuntimeSpawnOptions, BrokerInitArgs, RuntimeEvents, RuntimeProtocolError, createRuntimeClient)
- **Chose:** Renamed AgentRelayClient -> RuntimeClient and purged AgentRelay-prefixed names from @agent-relay/runtime (RuntimeClientOptions, RuntimeSpawnOptions, BrokerInitArgs, RuntimeEvents, RuntimeProtocolError, createRuntimeClient)
- **Reasoning:** User: AgentRelay branding belongs to the SDK messaging facade; the managed broker client lives in @agent-relay/runtime so it should carry Runtime naming. Left SDK-owned AgentRelay* symbols and the unrelated Swift AgentRelayClient class untouched; could not edit self-modification-protected .claude/rules files

---

## Chapters

### 1. Work
*Agent: default*

- Renamed AgentRelayClient -> RuntimeClient and purged AgentRelay-prefixed names from @agent-relay/runtime (RuntimeClientOptions, RuntimeSpawnOptions, BrokerInitArgs, RuntimeEvents, RuntimeProtocolError, createRuntimeClient): Renamed AgentRelayClient -> RuntimeClient and purged AgentRelay-prefixed names from @agent-relay/runtime (RuntimeClientOptions, RuntimeSpawnOptions, BrokerInitArgs, RuntimeEvents, RuntimeProtocolError, createRuntimeClient)

---

## Artifacts

**Commits:** 42d4251a, 85a35c96, 56e63102, 6b3acf57, 5d0034da, 4d263389, e9cbc783, 3e94cfee, cd65a432, 3b6c5072, a9d11f12, 50bb802b, aff8cc75, cd5fcd23, e1cb6a81, ec3751a1, a2128e08, 47129721, 6e9c8fef, 9857e654, fd36689e, 4415056d, 0a32688a, 25fb5edf, 46c05b47, 71dca30b, 5c87191d, 39907cff, 5fd7d4a3, f918738d, 8d8c2aa6, b1261de5, 8fe7363b, c3e1c563, dcd33f0f, f44c62d9, 9915a244, a2a9c188, 94df6139, 948a312b, facc2264, c803c26a, 9221fabe, fe69561e, e77d53d2, 4481b9d1, 3dd1dc90, 5d8dddfd, a5fdede4, 655f9866, 8d96e2fd, ce8c0c3f, b87428cf
**Files changed:** 311
