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







# Git Workflow Rules

## NEVER Push Directly to Main

**CRITICAL: Agents must NEVER push directly to the main branch.**

- Always work on a feature branch
- Commit and push to the feature branch only
- Let the user decide when to merge to main
- Do not merge to main without explicit user approval

```bash
# CORRECT workflow
git checkout -b feature/my-feature
# ... do work ...
git add .
git commit -m "My changes"
git push origin feature/my-feature
# STOP HERE - let user merge

# WRONG - never do this
git checkout main
git merge feature/my-feature
git push origin main  # NO!
```

This ensures the user maintains control over what goes into the main branch.

<!-- prpm:snippet:start @agent-workforce/trail-snippet@1.0.1 -->
# Trail

Record your work as a trajectory for future agents and humans to follow.

## Usage

If `trail` is installed globally, run commands directly:
```bash
trail start "Task description"
```

If not globally installed, use npx to run from local installation:
```bash
npx trail start "Task description"
```

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
<!-- prpm:snippet:end @agent-workforce/trail-snippet@1.0.1 -->


<!-- prpm:snippet:start @agent-relay/agent-relay-protocol@1.1.0 -->
# Agent Relay Protocol (Internal)

Advanced features for session continuity and trajectory tracking.

## Session Continuity

Save your state for session recovery using file-based format (same as messaging):

```bash
cat > $AGENT_RELAY_OUTBOX/continuity << 'EOF'
KIND: continuity
ACTION: save

Current task: Implementing user authentication
Completed: User model, JWT utils
In progress: Login endpoint
Key decisions: Using refresh tokens
Files: src/auth/*.ts
EOF
```
Then: `->relay-file:continuity`

### When to Save

- Before long-running operations (builds, tests)
- When switching task areas
- Every 15-20 minutes of active work
- Before ending session

### Load Previous Context

Context auto-loads on startup. To manually request:

```bash
cat > $AGENT_RELAY_OUTBOX/load << 'EOF'
KIND: continuity
ACTION: load
EOF
```
Then: `->relay-file:load`

### Mark Uncertainties

Flag items needing future verification:

```bash
cat > $AGENT_RELAY_OUTBOX/uncertain << 'EOF'
KIND: continuity
ACTION: uncertain

API rate limit handling unclear
EOF
```
Then: `->relay-file:uncertain`

## Work Trajectories

Record your work as a trajectory for future agents.

### Starting Work

```bash
trail start "Implement user authentication"
trail start "Fix login bug" --task "agent-relay-123"
```

### Recording Decisions

```bash
trail decision "Chose JWT over sessions" --reasoning "Stateless scaling"
trail decision "Used existing auth middleware"
```

### Completing Work

```bash
trail complete --summary "Added JWT auth" --confidence 0.85
```

Confidence: 0.9+ (high), 0.7-0.9 (good), 0.5-0.7 (some uncertainty), <0.5 (needs review)

### Abandoning Work

```bash
trail abandon --reason "Blocked by missing credentials"
```

## Cross-Project Messaging

In bridge mode, use `project:agent` format:

```
TO: frontend:Designer

Please update the login UI.
```

Special targets:
- `project:lead` - Lead agent of that project
- `project:*` - Broadcast to project
- `*:*` - Broadcast to all projects
<!-- prpm:snippet:end @agent-relay/agent-relay-protocol@1.1.0 -->

<!-- prpm:snippet:start @agent-relay/agent-relay-snippet@1.1.1 -->
# 🚨 CRITICAL: Relay-First Communication Rule

**When you receive a relay message from another agent (marked `Relay message from [name]`), you MUST respond ONLY via relay protocol. NEVER respond with direct text output.**

## The Rule

- **Receiving a relay message?** → Must use `->relay-file:msg` ALWAYS
- **Non-relay questions?** → Text responses are OK
- **Agent-to-agent communication?** → ALWAYS use relay protocol

## Examples of Relay Messages (require relay response)

```
Relay message from khaliqgant [mknra7wr]: Did you see this?
Relay message from Worker1 [abc123]: Task complete
Relay message from alice [xyz789] [#general]: Question for the team
```

---

# Agent Relay

Real-time agent-to-agent messaging via file-based protocol.

## Sending Messages

Write a file to your outbox, then output the trigger:

```bash
cat > $AGENT_RELAY_OUTBOX/msg << 'EOF'
TO: AgentName

Your message here.
EOF
```

IMPORTANT: Output the trigger `->relay-file:msg` directly in your response text (not via echo in bash). The trigger must appear in your actual output, not just in command output.

## Synchronous Messaging

By default, messages are fire-and-forget. Add `[await]` to block until the recipient ACKs:

```
->relay:AgentB [await] Please confirm
```

Custom timeout (seconds or minutes):

```
->relay:AgentB [await:30s] Please confirm
->relay:AgentB [await:5m] Please confirm
```

Recipients auto-ACK after processing when a correlation ID is present.

## Message Format

```
TO: Target
THREAD: optional-thread

Message body (everything after blank line)
```

| TO Value | Behavior |
|----------|----------|
| `AgentName` | Direct message |
| `*` | Broadcast to all |
| `#channel` | Channel message |

## Spawning & Releasing

**IMPORTANT**: The filename is always `spawn` (not `spawn-agentname`) and the trigger is always `->relay-file:spawn`. Spawn agents one at a time sequentially.

```bash
# Spawn
cat > $AGENT_RELAY_OUTBOX/spawn << 'EOF'
KIND: spawn
NAME: WorkerName
CLI: claude

Task description here.
EOF
```
Then: `->relay-file:spawn`

```bash
# Release
cat > $AGENT_RELAY_OUTBOX/release << 'EOF'
KIND: release
NAME: WorkerName
EOF
```
Then: `->relay-file:release`

## Receiving Messages

Messages appear as:
```
Relay message from Alice [abc123]: Content here
```

Channel messages include `[#channel]`:
```
Relay message from Alice [abc123] [#general]: Hello!
```
Reply to the channel shown, not the sender.

## Protocol

- **ACK** when you receive a task: `ACK: Brief description`
- **DONE** when complete: `DONE: What was accomplished`
- Send status to your **lead**, not broadcast

## Headers Reference

| Header | Required | Description |
|--------|----------|-------------|
| TO | Yes (messages) | Target agent/channel |
| KIND | No | `message` (default), `spawn`, `release` |
| NAME | Yes (spawn/release) | Agent name |
| CLI | Yes (spawn) | CLI to use |
| THREAD | No | Thread identifier |
<!-- prpm:snippet:end @agent-relay/agent-relay-snippet@1.1.1 -->
