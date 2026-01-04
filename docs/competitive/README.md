# Competitive Analysis

Architectural comparisons with alternative multi-agent coordination systems.

## Documents

| File | System | Focus |
|------|--------|-------|
| [OVERVIEW.md](./OVERVIEW.md) | Multiple | General landscape of agent orchestration tools |
| [GASTOWN.md](./GASTOWN.md) | Gastown | Deep dive into work-centric orchestration vs Relay's messaging approach |
| [MCP_AGENT_MAIL.md](./MCP_AGENT_MAIL.md) | MCP Agent Mail | Analysis of MCP-based agent communication |
| [TMUX_ORCHESTRATOR.md](./TMUX_ORCHESTRATOR.md) | Tmux-Orchestrator | Autonomous 24/7 agents with shell-based coordination |

## Key Differentiators

**Agent Relay's Position**: Communication-first, universal compatibility

| Feature | Agent Relay | Gastown | MCP Agent Mail | Tmux-Orchestrator |
|---------|-------------|---------|----------------|-------------------|
| Core model | Real-time messaging | Work orchestration | MCP tools | Autonomous scheduling |
| Agent compatibility | Any CLI | Claude Code only | MCP-capable | Claude Code |
| State persistence | Ephemeral + SQLite | Git-backed (Beads) | Varies | Git commits |
| Injection method | tmux/pty | tmux | MCP protocol | tmux send-keys |
| Learning curve | Low | High | Medium | Low |

## Takeaways Applied

From these analyses, we've implemented:

1. **Injection hardening** (from Gastown) - Verification + retry in PtyWrapper
2. **Stuck agent detection** (bead: agent-relay-gst1) - Dashboard monitoring
3. **Message delivery visibility** (bead: agent-relay-gst2) - ACK status in UI

See `.beads/issues.jsonl` for implementation tasks.
