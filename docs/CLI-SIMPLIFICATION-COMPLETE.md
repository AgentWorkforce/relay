# CLI Simplification - Complete

## Summary
Reduced CLI from **14 commands** to **4 commands**.

## New CLI Structure

```
relay                  # Start daemon + dashboard (default)
relay --no-dashboard   # Start without dashboard
relay --stop           # Stop daemon
relay --status         # Check status
relay -f               # Foreground mode

relay wrap <cmd>       # Wrap agent CLI with messaging
relay wrap -n Name claude

relay team setup       # Create team from JSON
relay team status      # Show team status
relay team send        # Send message
relay team check       # Check inbox
relay team listen      # Watch for messages
relay team start       # All-in-one start

relay read <id>        # Read full truncated message
```

## Files Changed
- `src/cli/index.ts` - Simplified main CLI (was 1100+ lines, now ~200)
- `src/cli/team.ts` - New team subcommand module
- `docs/AGENTS.md` - Updated documentation

## Beads Tasks Closed
- agent-relay-cli-simplify (main issue)
- agent-relay-85z (dashboard → start)
- agent-relay-4ft (project → status)
- agent-relay-bd0 (team-* → team subcommand)
- agent-relay-f3q (msg-read → read)
- agent-relay-7yo (docs update)

## Remaining
- agent-relay-8z1: Add CLI tests (optional)

## Key Changes
1. Dashboard starts by default (use --no-dashboard to disable)
2. All team commands under `relay team` namespace
3. Removed: project, send, dashboard as separate commands
4. Status/stop are now flags on main command
