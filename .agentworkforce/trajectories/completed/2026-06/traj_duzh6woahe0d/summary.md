# Trajectory: Phase 1: SDK client model reshape (register/create return live client, reconnect, messageId, to-routing)

> **Status:** ✅ Completed
> **Confidence:** 75%
> **Started:** June 3, 2026 at 12:22 AM
> **Completed:** June 3, 2026 at 01:32 AM

---

## Summary

Wired registerAction onto relaycast 2.3.0 fire-and-forget actions: SDK registers descriptor, subscribes handler agent to action.invoked, runs local registry, posts completion. MCP invoke is now fire-and-forget with local fallback.

**Approach:** Standard approach

---

## Chapters

### 1. Work
*Agent: default*

- Phase 1a: workspace.register/reconnect return a live RelayAgentClient (identity+status+reply/react); added messageId, agents.me(), injectable agent-messaging factory; migrated openclaw to relaycast 2.3.0 unified messageReacted event: Phase 1a: workspace.register/reconnect return a live RelayAgentClient (identity+status+reply/react); added messageId, agents.me(), injectable agent-messaging factory; migrated openclaw to relaycast 2.3.0 unified messageReacted event
- Phase 1b/1c: removed as()/asAgent() (migrated CLI createAgentRelay to new AgentRelay({agentToken})); sendMessage to: string|string[] routes @handle arrays to group DMs: Phase 1b/1c: removed as()/asAgent() (migrated CLI createAgentRelay to new AgentRelay({agentToken})); sendMessage to: string|string[] routes @handle arrays to group DMs
- Phase 2a: added relay.addListener(name|wildcard|predicate, handler) over a discriminated RelayEvent union with rich envelope; maps camelCase raw events to dotted public names across messaging/action/session sources: Phase 2a: added relay.addListener(name|wildcard|predicate, handler) over a discriminated RelayEvent union with rich envelope; maps camelCase raw events to dotted public names across messaging/action/session sources
- Phase 2b (partial): removed relay.on/relay.notify (zero prod callers); migrated listener tests to addListener. Deferred relay.actions getter removal pending MCP/harness-driver tracing.: Phase 2b (partial): removed relay.on/relay.notify (zero prod callers); migrated listener tests to addListener. Deferred relay.actions getter removal pending MCP/harness-driver tracing.
- Removed two deferred surfaces via subagents: public relay.actions namespace and top-level relay.sendMessage (interface split — agent clients keep sendMessage, workspace does not): Removed two deferred surfaces via subagents: public relay.actions namespace and top-level relay.sendMessage (interface split — agent clients keep sendMessage, workspace does not)
- Phase 3b: AgentSession.release optional + lifecycle.release:boolean. Strict compile-time 'iff' rejected — discriminated union fights the README's const-capabilities pattern (literals widen to boolean); documented the pairing convention instead.: Phase 3b: AgentSession.release optional + lifecycle.release:boolean. Strict compile-time 'iff' rejected — discriminated union fights the README's const-capabilities pattern (literals widen to boolean); documented the pairing convention instead.

---

## Artifacts

**Commits:** 8320d18b, 08c26413, e9611420, af9dff75, 2c95c094, 866fa3f6, 71883acf, 2f53ef38, 9c6fb458
**Files changed:** 22
