# Competitive Analysis

Architectural comparisons with alternative multi-agent coordination systems.

## Documents

| File | System | Focus |
|------|--------|-------|
| [OVERVIEW.md](./OVERVIEW.md) | Multiple | General landscape of agent orchestration tools |
| [GASTOWN.md](./GASTOWN.md) | Gastown | Deep dive into work-centric orchestration vs Relay's messaging approach |
| [HAPPY_CODER.md](./HAPPY_CODER.md) | Happy Coder | Mobile-first remote control with E2E encryption |
| [MCP_AGENT_MAIL.md](./MCP_AGENT_MAIL.md) | MCP Agent Mail | Analysis of MCP-based agent communication |
| [TMUX_ORCHESTRATOR.md](./TMUX_ORCHESTRATOR.md) | Tmux-Orchestrator | Autonomous 24/7 agents with shell-based coordination |

## Key Differentiators

**Agent Relay's Position**: Communication-first, universal compatibility, multi-agent orchestration

| Feature | Agent Relay | Gastown | Happy Coder | MCP Agent Mail | Tmux-Orchestrator |
|---------|-------------|---------|-------------|----------------|-------------------|
| Core model | Real-time messaging | Work orchestration | Mobile remote control | MCP tools | Autonomous scheduling |
| Agent compatibility | Any CLI (8+) | Claude Code only | Claude, Codex, Gemini | MCP-capable | Claude Code |
| Agent scope | Multi-agent | Multi-agent | Single session | Multi-agent | Multi-agent |
| State persistence | SQLite + cloud | Git-backed (Beads) | Session-based | Varies | Git commits |
| Encryption | Planned | None | E2E (zero-knowledge) | None | None |
| Mobile app | Planned | None | React Native + Expo | None | None |
| Injection method | tmux/pty | tmux | Child process spawn | MCP protocol | tmux send-keys |
| Learning curve | Low | High | Low | Medium | Low |

## Takeaways Applied

From these analyses, we've implemented:

1. **Injection hardening** (from Gastown) - Verification + retry in PtyWrapper
2. **Stuck agent detection** (bead: agent-relay-gst1) - Dashboard monitoring
3. **Message delivery visibility** (bead: agent-relay-gst2) - ACK status in UI

Planned from Happy Coder analysis:

4. **E2E encryption** (spec: `docs/specs/mobile-e2e-encryption.md`) - Zero-knowledge server
5. **Mobile CLI wrapper** (spec: `docs/specs/mobile-cli-wrapper.md`) - Permission forwarding
6. **Mobile app** (beads: bd-mobile-*) - Multi-agent dashboard on mobile

See `.beads/beads.jsonl` for implementation tasks.
