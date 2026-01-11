# Gastown Competitive Analysis

**Date**: January 11, 2026
**Repository**: https://github.com/steveyegge/gastown
**Stars**: 3,100 | **Forks**: 246 | **Open Issues**: 59

---

## Executive Summary

Gastown is a Go-based multi-agent workspace manager created December 2025 by Steve Yegge. It uses theatrical terminology (Mayor, Rigs, Polecats, Hooks) and focuses on git-backed persistence via its companion project Beads. While popular due to author recognition, it has significant usability issues.

---

## Core Architecture

### Key Components

| Component | Description |
|-----------|-------------|
| **Mayor** | Primary AI coordinator with full workspace context |
| **Town** | Central workspace directory (e.g., `~/gt/`) |
| **Rigs** | Project containers wrapping git repositories |
| **Crew Members** | Personal workspaces for hands-on development |
| **Polecats** | Ephemeral worker agents (spawn → task → terminate) |
| **Hooks** | Git worktree-based persistent storage |
| **Convoys** | Work tracking bundles for multiple issues |
| **Beads** | Git-backed graph issue tracker |

### Technical Requirements

- Go 1.23+
- Git 2.25+ (for worktree support)
- Beads (bd) 0.44.0+
- Tmux 3.0+ (recommended)
- Claude Code CLI or alternatives

### Internal Packages (50+)

**Agent & Automation**: `agent`, `swarm`, `crew`
**Configuration**: `config`, `state`, `session`, `checkpoint`
**Communication**: `connection`, `protocol`, `mail`, `feed`
**Execution**: `runtime`, `shell`, `cmd`, `boot`
**Data**: `beads`, `deps`, `formula`, `refinery`
**Persistence**: `lock`, `witness`, `townlog`
**UI**: `templates`, `tui`, `ui`, `style`, `web`

---

## Beads Integration

Beads is a git-backed graph issue tracker designed for AI agents.

**Key Features**:
- Tasks stored as JSONL in `.beads/` directory
- Hash-based collision-free IDs (`bd-a1b2`)
- SQLite caching with background sync
- "Semantic memory decay" summarizes completed tasks
- Dependency-aware task graphs

**Commands**:
```bash
bd ready          # Show unblocked tasks
bd create "Title" # Create priority task
bd dep add        # Establish dependencies
bd show <id>      # Full task details
```

---

## Gastown Strengths

### 1. Git-Native Persistence
- Work state survives crashes via git worktrees
- No separate database required
- Natural git workflows for developers

### 2. Sophisticated Task Management
- Beads provides dependency graphs
- Formula system for repeatable workflows
- TOML-defined processes in `.beads/formulas/`

### 3. Scale Design
- Claims to handle 20-30 agents comfortably
- Convoy-based work distribution
- Context loss prevention via hooks

### 4. Brand Recognition
- Steve Yegge's significant following
- Well-written, personality-driven documentation

---

## Gastown Weaknesses

### 1. Complex Setup (Major Pain Point)

From open issues:
- **#317**: `gt rig add` fails to create file structure
- **#308**: Setup fails on `gt mayor attach`
- **#323**: Environment variables not set in tmux
- **#318**: Context detection failures during init

### 2. Stability Issues

- **#322**: iTerm causes Mac hangs
- Version mismatch between `gt` and `bd`
- Vim mode causes prompt freezing (#307)
- Difficulty shutting down/stopping properly

### 3. Architectural Coupling

- Encapsulation violations between Gastown and Beads
- Tight dependency on external `bd` tool
- Multiple version requirements (Go, Git, tmux)

### 4. Communication Model

- File-based mailbox system (not real-time)
- Hook injection latency
- No sub-5ms messaging possible

### 5. Limited Coordination

- No built-in consensus mechanism
- No shadow agent capability
- Limited human participation support

---

## Agent Relay vs Gastown

| Aspect | Gastown | Agent Relay |
|--------|---------|-------------|
| **Language** | Go | TypeScript/Node.js |
| **Communication** | File-based mailboxes | Real-time sockets |
| **Message Latency** | ~100ms+ (file I/O) | <5ms |
| **Persistence** | Git worktrees + JSONL | SQLite + Ledger |
| **Agent Lifecycle** | Polecats | Spawn/Release wrapper |
| **Coordination** | Mayor (central) | Distributed + consensus |
| **Setup** | Complex, error-prone | Self-contained |
| **Dashboard** | Basic TUI | Full WebSocket UI |

### Feature Comparison

| Feature | Gastown | Agent Relay |
|---------|:-------:|:-----------:|
| Real-time messaging | - | Yes |
| Consensus voting | - | Yes |
| Shadow agents | - | Yes |
| Git-backed state | Yes | Partial |
| Dependency graphs | Yes | - |
| Formula system | Yes | - |
| Live dashboard | - | Yes |
| Cloud deploy | - | Yes |
| Human participation | Limited | Yes |

---

## Strategic Opportunities

### 1. Capitalize on Stability
Position as "works out of the box" vs Gastown's setup struggles.

### 2. Highlight Real-Time
<5ms messaging is impossible with Gastown's architecture.

### 3. Consensus as Differentiator
Multi-agent voting is unique to Agent Relay.

### 4. Consider Beads Compatibility
Beads dependency tracking is genuinely useful - could be complementary.

### 5. Target Different Use Cases

| Gastown | Agent Relay |
|---------|-------------|
| Long-running git projects | Real-time coordination |
| Complex task dependencies | Live dashboards |
| Git-centric workflows | Cloud deployments |
| Solo developer focus | Team collaboration |

---

## Market Position

**Gastown's Appeal**: Git-native, philosophical approach to workspace management, author's reputation.

**Gastown's Reality**: Significant usability issues, 13+ open bugs related to basic setup, steep learning curve.

**Opportunity**: Gastown's 3.1k stars came largely from Steve Yegge's blog posts. The product itself has growing pains that create space for a more polished alternative.

---

## Recommendations

1. **Messaging**: "Real-time by default" - emphasize <5ms latency
2. **Onboarding**: Streamlined setup as competitive advantage
3. **Features**: Consensus and shadow agents are unique
4. **Integration**: Consider Beads compatibility for task tracking
5. **Positioning**: Team-oriented vs Gastown's solo-developer focus

---

*Analysis conducted January 2026*
