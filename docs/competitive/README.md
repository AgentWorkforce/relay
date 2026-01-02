# Competitive Analysis

Architectural comparisons with alternative multi-agent coordination systems.

## Documents

| File | System | Focus |
|------|--------|-------|
| [OVERVIEW.md](./OVERVIEW.md) | Multiple | General landscape of agent orchestration tools |
| [GASTOWN.md](./GASTOWN.md) | Gastown | Deep dive into work-centric orchestration vs Relay's messaging approach |
| [MCP_AGENT_MAIL.md](./MCP_AGENT_MAIL.md) | MCP Agent Mail | Analysis of MCP-based agent communication |

## Key Differentiators

**Agent Relay's Position**: Communication-first, universal compatibility

| Feature | Agent Relay | Gastown | MCP Agent Mail |
|---------|-------------|---------|----------------|
| Core model | Real-time messaging | Work orchestration | MCP tools |
| Agent compatibility | Any CLI | Claude Code only | MCP-capable |
| State persistence | Ephemeral + SQLite | Git-backed (Beads) | Varies |
| Injection method | tmux/pty | tmux | MCP protocol |
| Learning curve | Low | High | Medium |

## Takeaways Applied

From these analyses, we've implemented:

1. **Injection hardening** (from Gastown) - Verification + retry in PtyWrapper
2. **Stuck agent detection** (bead: agent-relay-gst1) - Dashboard monitoring
3. **Message delivery visibility** (bead: agent-relay-gst2) - ACK status in UI

See `.beads/issues.jsonl` for implementation tasks.
