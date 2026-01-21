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




# 🚨 CRITICAL: Relay-First Communication

**When you receive a relay message from another agent (marked `Relay message from [name]`), you MUST respond ONLY via relay protocol. NEVER respond with direct text output.**

## The Rule

- **Receiving a relay message?** → Respond via relay protocol (`->relay-file:msg`)
- **NOT receiving a relay message?** → You may respond with text
- **Always use relay for agent-to-agent communication** (responses to agents, status updates, delegation)

## Why This Matters

Relay protocol enables:
- Multi-agent coordination without breaking context
- Persistent message history for continuity
- Dashboard visibility into agent communication
- Proper ACK/DONE tracking for task completion

## What Looks Like a Relay Message

```
Relay message from khaliqgant [mknra7wr]: Did you see this?
Relay message from Worker1 [abc123]: Task complete
Relay message from alice [xyz789] [#general]: Question for the team
```

**All of these require relay protocol response.**

## Example: WRONG ❌

```
You: "Thanks for the message! Here's your answer..."
```

## Example: CORRECT ✅

```bash
cat > /tmp/relay-outbox/Lead/msg << 'EOF'
TO: khaliqgant

Thanks for the message! Here's your answer...
