# Trajectory: Add swarm primitives and SDK competitive enhancements

> **Status:** ✅ Completed
> **Confidence:** 85%
> **Started:** January 26, 2026 at 09:13 PM
> **Completed:** January 26, 2026 at 09:13 PM

---

## Summary

Enhanced SDK with swarm primitives and created comprehensive roadmap for new capabilities. Added query operations, consensus support, swarm patterns documentation, and 8 new primitive specifications (Memory, Guardrails, Tracing, HITL, Backpressure, Attachments, Roles, Task Queues). SDK now positioned as flexible primitives framework vs prescriptive competitors.

**Approach:** Standard approach

---

## Key Decisions

### Positioned SDK as primitives-based framework vs prescriptive swarm frameworks
- **Chose:** Positioned SDK as primitives-based framework vs prescriptive swarm frameworks
- **Reasoning:** Competitors like OpenAI Agents, Swarms.ai, and Strands impose specific orchestration patterns. Agent Relay provides flexible communication primitives that let developers build any swarm architecture. This differentiation is sustainable and appeals to power users.

### Added query operations (listAgents, getMetrics, getHealth, getInbox, getStatus) to SDK
- **Chose:** Added query operations (listAgents, getMetrics, getHealth, getInbox, getStatus) to SDK
- **Reasoning:** These were MCP tool features but not in the SDK. Essential for discovery, monitoring, and auto-scaling patterns in swarm orchestration.

### Added consensus primitives (createProposal, vote) for external daemon mode
- **Chose:** Added consensus primitives (createProposal, vote) for external daemon mode
- **Reasoning:** Native consensus is a unique differentiator - no other framework has built-in voting. Disabled in standalone mode due to complexity, but available when running external daemon.

### Prioritized Memory System and Guardrails as P0 new primitives
- **Chose:** Prioritized Memory System and Guardrails as P0 new primitives
- **Reasoning:** Competitive analysis showed all major frameworks (LangGraph, CrewAI, OpenAI Agents) have structured memory. Guardrails essential for production safety. Both are table-stakes for enterprise adoption.

### Designed 8 swarm patterns documentation based on AgentSwarm architecture
- **Chose:** Designed 8 swarm patterns documentation based on AgentSwarm architecture
- **Reasoning:** AgentSwarm is a production orchestrator built on Agent Relay using Conductor/Planner/Workers/Judge pattern. Used this as reference plus competitive research to document patterns: Hierarchical, Fan-out/Fan-in, Handoff/Routing, Pipeline, Consensus, Self-Organizing, Supervisor/Shadow, Map-Reduce.

### Created comprehensive primitives roadmap with 8 new capabilities
- **Chose:** Created comprehensive primitives roadmap with 8 new capabilities
- **Reasoning:** Gap analysis against OpenAI Agents, LangGraph, CrewAI revealed missing primitives: Memory, Guardrails, Tracing, HITL, Backpressure, Attachments, Roles, Task Queues. Spec includes protocol messages, SDK API, database schemas, and usage examples for each.

---

## Chapters

### 1. Work
*Agent: default*

- Positioned SDK as primitives-based framework vs prescriptive swarm frameworks: Positioned SDK as primitives-based framework vs prescriptive swarm frameworks
- Added query operations (listAgents, getMetrics, getHealth, getInbox, getStatus) to SDK: Added query operations (listAgents, getMetrics, getHealth, getInbox, getStatus) to SDK
- Added consensus primitives (createProposal, vote) for external daemon mode: Added consensus primitives (createProposal, vote) for external daemon mode
- Prioritized Memory System and Guardrails as P0 new primitives: Prioritized Memory System and Guardrails as P0 new primitives
- Designed 8 swarm patterns documentation based on AgentSwarm architecture: Designed 8 swarm patterns documentation based on AgentSwarm architecture
- Created comprehensive primitives roadmap with 8 new capabilities: Created comprehensive primitives roadmap with 8 new capabilities
