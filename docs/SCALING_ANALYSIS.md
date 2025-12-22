# Scaling Analysis: Is the TUI Dashboard Worth It?

## The Question

The proposed changes add significant complexity:
- TUI dashboard with `blessed` library
- Daemon event streaming
- Activity state reporting from wrappers
- New CLI commands

**Is this the right approach, or is there a simpler path?**

---

## Behavior Comparison

### Current (2-3 Agents)

```bash
# Terminal 1
agent-relay -n Alice claude
# You're IN Alice's tmux, working

# Terminal 2
agent-relay -n Bob claude
# You're IN Bob's tmux

# To switch: Alt+Tab between terminal windows
# To see status: mentally track what each is doing
```

**Works fine because:** You can hold 2-3 contexts in your head.

### Proposed (5-10 Agents)

```bash
# Terminal 1
agent-relay up        # Start daemon
agent-relay watch     # TUI dashboard

┌─ Agent Relay ───────────────────────────────┐
│ ● Alice     active   12↑ 8↓                 │
│ ● Bob       typing   5↑ 14↓                 │
│ ○ Charlie   offline  queued: 3              │
│ ...                                         │
└─────────────────────────────────────────────┘

# Press 'a' → attach to native tmux
# Ctrl+B d → back to TUI
```

**Adds complexity:**
- blessed dependency (~500KB)
- Event stream protocol
- Activity reporting
- More state to track in daemon

---

## Alternative: Just Use tmux Better

tmux already has multi-pane and multi-window support. Why not leverage it?

### Simpler Approach: Native tmux Layout

```bash
# Start all agents in one tmux session with multiple windows
agent-relay team start

# Creates tmux session "relay-team" with:
# - Window 0: Alice (claude)
# - Window 1: Bob (claude)
# - Window 2: Charlie (claude)
# - Window 3: Status pane (tail -f on logs)

# Switch windows: Ctrl+B 0, Ctrl+B 1, Ctrl+B 2...
# Or use: Ctrl+B w (window list)
```

**Implementation (50 lines, not 500):**

```bash
#!/bin/bash
# agent-relay team start

TEAM_SESSION="relay-team"
AGENTS=$(cat teams.json | jq -r '.agents[].name')

tmux new-session -d -s "$TEAM_SESSION"

i=0
for agent in $AGENTS; do
  if [ $i -eq 0 ]; then
    tmux send-keys -t "$TEAM_SESSION" "agent-relay -n $agent claude" Enter
  else
    tmux new-window -t "$TEAM_SESSION"
    tmux send-keys -t "$TEAM_SESSION" "agent-relay -n $agent claude" Enter
  fi
  ((i++))
done

# Add status window
tmux new-window -t "$TEAM_SESSION" -n "status"
tmux send-keys -t "$TEAM_SESSION:status" "watch -n1 agent-relay agents" Enter

tmux attach -t "$TEAM_SESSION"
```

**User experience:**
```
Ctrl+B w  →  Shows window list:
  0: Alice (attached)
  1: Bob
  2: Charlie
  3: status

Ctrl+B 1  →  Jump to Bob
Ctrl+B 3  →  See status (agent-relay agents output)
```

---

## Comparison: TUI vs Native tmux

| Aspect | TUI Dashboard (blessed) | Native tmux Windows |
|--------|------------------------|---------------------|
| **Lines of code** | ~500 | ~50 |
| **Dependencies** | blessed (~500KB) | None (tmux built-in) |
| **Learning curve** | New UI to learn | tmux you already know |
| **Real-time updates** | Yes (event stream) | Yes (watch command) |
| **Quick switch** | Press 'a', select | Ctrl+B {number} |
| **See all at once** | TUI list | Ctrl+B w (window list) |
| **Native experience** | Detach TUI → attach tmux | Already in tmux |
| **Maintenance** | blessed updates, bugs | tmux is stable |

---

## What We Actually Need for Scaling

Let's separate "nice to have" from "essential":

### Essential (for 5-10 agents)

1. **Quick overview of all agents** → `agent-relay agents` (already proposed)
2. **Know who's busy vs idle** → Activity state in agents output
3. **Message history** → `agent-relay history` (already proposed)
4. **Quick attach** → `agent-relay attach Alice`
5. **Group messaging** → `->relay:@backend` (already proposed)

### Nice to Have (but complex)

1. **Real-time TUI dashboard** → Use `watch` instead
2. **Event streaming** → Poll daemon status instead
3. **Typing indicators** → Not critical for coordination

---

## Recommended Simpler Approach

### Phase 5 Revised: Minimal Scaling

```bash
# 1. Better status command (essential)
$ agent-relay agents
NAME       STATUS   MESSAGES   LAST SEEN
Alice      active   12↑ 8↓     now
Bob        idle     5↑ 14↓     30s ago
Charlie    offline  queued: 3  5m ago

# 2. Quick attach (essential)
$ agent-relay attach Alice
# Attaches to relay-Alice-* session

# 3. Team layout (essential)
$ agent-relay team start
# Creates multi-window tmux session
# Use Ctrl+B w to see all, Ctrl+B {n} to switch

# 4. Live status (nice to have, zero code)
$ watch -n2 agent-relay agents
# Updates every 2 seconds

# 5. Message history (essential)
$ agent-relay history --last 20
14:23:01 Alice → Bob: Can you check the API?
14:23:15 Bob → Alice: On it
...
```

### Implementation Effort

| Feature | Complex TUI Approach | Simpler Approach |
|---------|---------------------|------------------|
| TUI dashboard | 2 days + blessed dep | 0 (use `watch`) |
| Event stream | 1 day + protocol change | 0 (poll status) |
| Activity reporting | 1 day | 0.5 day (just in status) |
| Team layout | Already proposed | Same (0.5 day) |
| Better agents cmd | Same | Same (0.5 day) |
| History command | Same | Same (0.5 day) |
| **Total** | **5+ days** | **2 days** |

---

## Verdict: Skip the TUI, Use tmux

The TUI dashboard is over-engineered. tmux already provides:
- Multi-window switching (Ctrl+B w)
- Split panes (Ctrl+B %)
- Session persistence
- Window list

**What we actually need:**

1. **`agent-relay agents`** - Show status with activity state
2. **`agent-relay attach <name>`** - Quick attach helper
3. **`agent-relay team start`** - Multi-window tmux layout
4. **`agent-relay history`** - Query past messages

**What we DON'T need:**

1. ❌ blessed TUI dependency
2. ❌ Event streaming from daemon
3. ❌ Complex activity reporting protocol
4. ❌ Real-time typing indicators

---

## Updated Design Recommendation

### Keep from Phase 5:
- Agent groups (`->relay:@backend`)
- Message priority (`!`, `?`)
- `agent-relay agents` command
- `agent-relay history` command

### Replace TUI with:
```bash
# Multi-window tmux session
agent-relay team start    # Creates relay-team session
agent-relay team attach   # Attach to existing
agent-relay team add Bob  # Add agent to running team

# Quick attach to single agent
agent-relay attach Alice

# Live status (zero code, just docs)
watch -n2 agent-relay agents
```

### Effort Saved:
- No blessed dependency
- No event streaming protocol
- No TUI code maintenance
- 3+ days of implementation saved

---

## Behavior Impact Summary

| Scenario | TUI Approach | Simpler Approach |
|----------|--------------|------------------|
| See all agents | Open TUI, see list | `agent-relay agents` or `Ctrl+B w` |
| Switch to Bob | Press 'a', select Bob | `Ctrl+B 1` or `agent-relay attach Bob` |
| Check if Alice is busy | See "typing..." in TUI | Check status column in agents |
| Send message to group | Same | Same (`->relay:@backend`) |
| View history | Press 'h' in TUI | `agent-relay history` |

**The simpler approach does everything the TUI does, with 80% less code.**

---

## Final Recommendation

1. **Don't build the TUI dashboard** - It's solving a problem tmux already solves
2. **Do add `agent-relay team`** - Leverages tmux's native multi-window
3. **Do improve `agent-relay agents`** - Add activity state, message counts
4. **Do add `agent-relay history`** - Query past messages
5. **Document `watch` trick** - Free live updates

This keeps the simplicity advantage while scaling to 10+ agents.
