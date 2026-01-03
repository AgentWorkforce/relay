<!-- PRPM_MANIFEST_START -->

<skills_system priority="1">
<usage>
When users ask you to perform tasks, check if any of the available skills below can help complete the task more effectively. Skills provide specialized capabilities and domain knowledge.

How to use skills (loaded into main context):
- Use the <path> from the skill entry below
- Invoke: Bash("cat <path>")
- The skill content will load into your current context
- Example: Bash("cat .openskills/backend-architect/SKILL.md")

Usage notes:
- Skills share your context window
- Do not invoke a skill that is already loaded in your context
</usage>

<available_skills>

<skill activation="lazy">
<name>frontend-design</name>
<description>Design and build modern frontend interfaces with best practices and user experience principles. Create beautiful, accessible, and performant web interfaces.</description>
<path>.openskills/frontend-design/SKILL.md</path>
</skill>

</available_skills>
</skills_system>

<!-- PRPM_MANIFEST_END -->


<!-- prpm:snippet:start @agent-workforce/trail-snippet@1.0.0 -->
# Trail

Record your work as a trajectory for future agents and humans to follow.

## When Starting Work

Start a trajectory when beginning a task:

```bash
trail start "Implement user authentication"
```

With external task reference:
```bash
trail start "Fix login bug" --task "ENG-123"
```

## Recording Decisions

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

## Completing Work

When done, complete with a retrospective:

```bash
trail complete --summary "Added JWT auth with refresh tokens" --confidence 0.85
```

**Confidence levels:**
- 0.9+ : High confidence, well-tested
- 0.7-0.9 : Good confidence, standard implementation
- 0.5-0.7 : Some uncertainty, edge cases possible
- <0.5 : Significant uncertainty, needs review

## Abandoning Work

If you need to stop without completing:

```bash
trail abandon --reason "Blocked by missing API credentials"
```

## Checking Status

View current trajectory:
```bash
trail status
```

## Why Trail?

Your trajectory helps others understand:
- **What** you built (commits show this)
- **Why** you built it this way (trajectory shows this)
- **What alternatives** you considered
- **What challenges** you faced

Future agents can query past trajectories to learn from your decisions.
<!-- prpm:snippet:end @agent-workforce/trail-snippet@1.0.0 -->



<!-- prpm:snippet:start @agent-relay/agent-relay-snippet@1.0.5 -->
# Agent Relay

Real-time agent-to-agent messaging. Output `->relay:` patterns to communicate.

## Sending Messages

**Always use the fenced format** for reliable message delivery:

```
->relay:AgentName <<<
Your message here.>>>
```

```
->relay:* <<<
Broadcast to all agents.>>>
```

**CRITICAL:** Always close multi-line messages with `>>>` after the very last character.

**WARNING:** Do NOT put blank lines before `>>>` - it must immediately follow your content:

```
# CORRECT - >>> immediately after content
->relay:Agent <<<Your message here.>>>

# WRONG - blank line before >>> breaks parsing
->relay:Agent <<<
Your message here.

>>>
```

## Communication Protocol

**ACK immediately** - When you receive a task, acknowledge it before starting work:

```
->relay:Sender <<<
ACK: Brief description of task received>>>
```

**Report completion** - When done, send a completion message:

```
->relay:Sender <<<
DONE: Brief summary of what was completed>>>
```

## Receiving Messages

Messages appear as:
```
Relay message from Alice [abc123]: Message content here
```

### Channel Routing (Important!)

Messages from #general (broadcast channel) include a `[#general]` indicator:
```
Relay message from Alice [abc123] [#general]: Hello everyone!
```

**When you see `[#general]`**: Reply to `*` (broadcast), NOT to the sender directly.

```
# Correct - responds to #general channel
->relay:* <<<
Response to the group message.>>>

# Wrong - sends as DM to sender instead of to the channel
->relay:Alice <<<
Response to the group message.>>>
```

If truncated, read full message:
```bash
agent-relay read abc123
```

## Spawning Agents

Spawn workers to delegate tasks:

```
# Short tasks - single line with quotes
->relay:spawn WorkerName claude "short task description"

# Long tasks - use fenced format (recommended)
->relay:spawn WorkerName claude <<<
Implement the authentication module.
Requirements:
- JWT tokens with refresh
- Password hashing with bcrypt
- Rate limiting on login endpoint>>>

# Release when done
->relay:release WorkerName
```

**Use fenced format for tasks longer than ~50 characters** to avoid truncation from terminal line wrapping.

## Threads

Use threads to group related messages together:

```
->relay:AgentName [thread:topic-name] <<<
Your message here.>>>
```

**When to use threads:**
- Working on a specific issue (e.g., `[thread:agent-relay-299]`)
- Back-and-forth discussions with another agent
- Code review conversations

## Status Updates

**Send status updates to your lead, NOT broadcast:**

```
# Correct - status to lead only
->relay:Lead <<<
STATUS: Working on auth module>>>

# Wrong - don't broadcast status to everyone
->relay:* <<<
STATUS: Working on auth module>>>
```

## Common Patterns

```
->relay:Lead <<<
ACK: Starting /api/register implementation>>>

->relay:Lead <<<
STATUS: Working on auth module>>>

->relay:Lead <<<
DONE: Auth module complete>>>

->relay:Developer <<<
TASK: Implement /api/register>>>

->relay:Reviewer [thread:code-review-auth] <<<
REVIEW: Please check src/auth/*.ts>>>

->relay:Architect <<<
QUESTION: JWT or sessions?>>>
```

## Rules

- Pattern must be at line start (whitespace OK)
- Escape with `\->relay:` to output literally
- Check daemon status: `agent-relay status`

## Writing Examples (For Documentation)

When showing examples of relay syntax in documentation or explanations, **escape the markers** so they don't get interpreted as actual messages:

```
# Escape the opening marker
\->relay:AgentName \<<<
Example content here.\>>>
```

**What to escape:**
- `\->relay:` - Prevents the pattern from being detected as a real message
- `\<<<` - Prevents the fenced block from being parsed
- `\>>>` - Prevents the block from being closed

This ensures your examples are displayed literally rather than sent as messages.
<!-- prpm:snippet:end @agent-relay/agent-relay-snippet@1.0.5 -->

<!-- prpm:snippet:start @agent-relay/agent-relay-protocol@1.0.1 -->
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
<!-- prpm:snippet:end @agent-relay/agent-relay-protocol@1.0.1 -->
