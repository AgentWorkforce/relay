# Competitive Analysis

Architectural comparisons with alternative multi-agent coordination systems.

## Documents

| File | System | Focus |
|------|--------|-------|
| [OVERVIEW.md](./OVERVIEW.md) | Multiple | General landscape of agent orchestration tools |
| [CLAUDE_CODE_TEAMMATETOOL.md](./CLAUDE_CODE_TEAMMATETOOL.md) | Claude Code TeammateTool | **NEW** - Hidden multi-agent orchestration in Claude Code v2.1.19 |
| [CLAUDE_CODE_AGENTROOMS.md](./CLAUDE_CODE_AGENTROOMS.md) | Claude Code Agentrooms | Third-party hub-and-spoke orchestration |
| [GASTOWN.md](./GASTOWN.md) | Gastown | Deep dive into work-centric orchestration vs Relay's messaging approach |
| [HAPPY_CODER.md](./HAPPY_CODER.md) | Happy Coder | Mobile-first remote control with E2E encryption |
| [MCP_AGENT_MAIL.md](./MCP_AGENT_MAIL.md) | MCP Agent Mail | Analysis of MCP-based agent communication |
| [TMUX_ORCHESTRATOR.md](./TMUX_ORCHESTRATOR.md) | Tmux-Orchestrator | Autonomous 24/7 agents with shell-based coordination |

## Key Differentiators

**Agent Relay's Position**: Communication-first, universal compatibility, multi-agent orchestration

| Feature | Agent Relay | TeammateTool | Gastown | Happy Coder | MCP Agent Mail | Tmux-Orchestrator |
|---------|-------------|--------------|---------|-------------|----------------|-------------------|
| Core model | Real-time messaging | Team operations | Work orchestration | Mobile remote control | MCP tools | Autonomous scheduling |
| Agent compatibility | Any CLI (8+) | Claude Code only | Claude Code only | Claude, Codex, Gemini | MCP-capable | Claude Code |
| Agent scope | Multi-agent | Multi-agent | Multi-agent | Single session | Multi-agent | Multi-agent |
| State persistence | SQLite + cloud | File-based | Git-backed (Beads) | Session-based | Varies | Git commits |
| Encryption | Planned | Unknown | None | E2E (zero-knowledge) | None | None |
| Mobile app | Planned | None | None | React Native + Expo | None | None |
| Injection method | tmux/pty | iTerm2/tmux/in-proc | tmux | Child process spawn | MCP protocol | tmux send-keys |
| Learning curve | Low | Unknown | High | Low | Medium | Low |
| Status | Production | Hidden/Feature-gated | Production | Production | Production | Production |

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
