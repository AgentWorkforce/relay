# Agent Relay Protocol (Internal)

Advanced agent-relay features for dashboard integration, session persistence, and trajectory tracking.

## Session Persistence (Required)

Output these blocks to maintain session state. **The system monitors your output for these patterns.**

### Progress Summary (Output Periodically)

When completing significant work, output a summary block:

```
[[SUMMARY]]
{
  "currentTask": "What you're working on now",
  "completedTasks": ["task1", "task2"],
  "context": "Important context for session recovery",
  "files": ["src/file1.ts", "src/file2.ts"]
}
[[/SUMMARY]]
```

**When to output:**
- After completing a major task
- Before long-running operations
- When switching to a different area of work
- Every 10-15 minutes of active work

### Session End (Required on Completion)

When your work session is complete, output:

```
[[SESSION_END]]
{
  "summary": "Brief description of what was accomplished",
  "completedTasks": ["task1", "task2", "task3"]
}
[[/SESSION_END]]
```

Or for a simple close: `[[SESSION_END]]Work complete.[[/SESSION_END]]`

**This enables:**
- Session recovery if connection drops
- Progress tracking in dashboard
- Proper session cleanup in cloud

## Session Continuity (Cross-Session)

Output `->continuity:` patterns to persist state across sessions. This is different from `[[SUMMARY]]` blocks - continuity creates permanent records that survive agent restarts.

### Save Session State

Save your current state to the ledger:

```
->continuity:save <<<
Current task: Implementing user authentication
Completed: User model, JWT utils, Login endpoint
In progress: Logout endpoint, Token refresh
Key decisions: Using refresh tokens for security
Files: src/auth/jwt.ts:10-50, src/models/user.ts>>>
```

To also create a permanent handoff document (recommended before long operations):

```
->continuity:save --handoff <<<
Current task: Implementing auth module
Completed: User model, JWT utils
Next steps: Login endpoint, Session middleware
Key decisions: JWT with refresh tokens, bcrypt for passwords
Files: src/auth/*.ts>>>
```

### Load Previous Context

Request your previous session context (auto-loaded on startup, but can request manually):

```
->continuity:load
```

### Search Past Work

Search across all previous handoffs:

```
->continuity:search "authentication patterns"
->continuity:search "database migration"
```

### Mark Uncertain Items

Flag items that need verification in future sessions:

```
->continuity:uncertain "API rate limit handling unclear"
```

### When to Save

**Always save before:**
- Long-running operations (builds, tests, deployments)
- Context-heavy operations (might trigger compaction)
- Switching to a different task area
- Taking a break or ending session

**Good rhythm:**
- Save progress every 15-20 minutes of active work
- Use `--handoff` flag for major milestones
- Mark uncertainties as you encounter them

## Work Trajectories (Required)

**Trajectory recording is MANDATORY for all agent work sessions.** Use Trail to record your work as a trajectory for future agents and humans to follow.

### Enforcement

Trajectories are enforced via hooks:
- **onSessionStart** → Automatically calls `trail start` with task context
- **onSessionEnd** → Prompts for `trail complete` if trajectory is open

If hooks are not configured, you MUST manually call trail commands. Failure to record trajectories results in lost context for future agents.

### When Starting Work

**REQUIRED: Call `trail start` BEFORE diving into implementation** - this captures your full journey, not just the end result.

Start a trajectory immediately when picking up a task:

```bash
trail start "Implement user authentication"
```

With external task reference (beads ID, ticket number):
```bash
trail start "Fix login bug" --task "agent-relay-123"
```

### Recording Decisions

Record key decisions as you work:

```bash
trail decision "Chose JWT over sessions" \
  --reasoning "Stateless scaling requirements"
```

For minor decisions, reasoning is optional:
```bash
trail decision "Used existing auth middleware"
```

**Record decisions when you:**
- Choose between alternatives
- Make architectural trade-offs
- Decide on an approach after investigation

### Completing Work

**REQUIRED: Always close your trajectory before ending a session.** When done, complete with a retrospective:

```bash
trail complete --summary "Added JWT auth with refresh tokens" --confidence 0.85
```

**Confidence levels:**
- 0.9+ : High confidence, well-tested
- 0.7-0.9 : Good confidence, standard implementation
- 0.5-0.7 : Some uncertainty, edge cases possible
- <0.5 : Significant uncertainty, needs review

### Abandoning Work

If you need to stop without completing:

```bash
trail abandon --reason "Blocked by missing API credentials"
```

### Checking Status

View current trajectory:
```bash
trail status
```

### Why Trail?

Your trajectory helps others understand:
- **What** you built (commits show this)
- **Why** you built it this way (trajectory shows this)
- **What alternatives** you considered
- **What challenges** you faced

Future agents can query past trajectories to learn from your decisions.

## Cross-Project Messaging

When running in bridge mode (multiple projects connected), use `project:agent` format:

```
->relay:frontend:Designer <<<
Please update the login UI for the new auth flow>>>

->relay:backend:lead <<<
API question - should we use REST or GraphQL?>>>

->relay:shared-lib:* <<<
New utility functions available, please pull latest>>>
```

**Format:** `->relay:project-id:agent-name`

**Special targets:**
- `->relay:project:lead` - Message the lead agent of that project
- `->relay:project:*` - Broadcast to all agents in that project
- `->relay:*:*` - Broadcast to ALL agents in ALL projects

**Cross-project threads:**
```
->relay:frontend:Designer [thread:auth-feature] <<<
UI mockups ready for review>>>
```

## Dashboard Integration

The dashboard automatically tracks:
- Agent presence and online status
- Message history and threads
- Session summaries from `[[SUMMARY]]` blocks
- Trajectory status from trail commands
- Coordinator panel for multi-agent orchestration

Agents can view their status at the dashboard URL provided at startup.
