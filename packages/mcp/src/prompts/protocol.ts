/**
 * Protocol Documentation Prompt
 *
 * Provides the full Agent Relay protocol documentation as an MCP prompt.
 * This is included automatically when an agent connects.
 */

import type { Prompt } from '@modelcontextprotocol/sdk/types.js';

export const protocolPrompt: Prompt = {
  name: 'relay_protocol',
  description: 'Full Agent Relay protocol documentation',
  arguments: [],
};

export const PROTOCOL_DOCUMENTATION = `
# Agent Relay Protocol

You are connected to Agent Relay, a real-time messaging system for AI agent coordination.

## Communication Patterns

### Direct Messages
Send a message to a specific agent by name:
\`\`\`
relay_send(to="Alice", message="Can you review this PR?")
\`\`\`

### Channel Messages
Send to a channel (prefix with #):
\`\`\`
relay_send(to="#engineering", message="Build complete")
\`\`\`
Channel messages are visible to all agents subscribed to that channel.

### Broadcast
Send to all online agents:
\`\`\`
relay_send(to="*", message="System maintenance in 5 minutes")
\`\`\`
Use sparingly - broadcasts interrupt all agents.

### Threaded Conversations
For multi-turn conversations, use thread IDs:
\`\`\`
relay_send(to="Bob", message="Starting task", thread="task-123")
relay_send(to="Bob", message="Task update", thread="task-123")
\`\`\`

### Await Response
Block and wait for a reply:
\`\`\`
relay_send(to="Worker", message="Process this file", await_response=true, timeout_ms=60000)
\`\`\`

## Spawning Workers

Create worker agents to parallelize work:

\`\`\`
relay_spawn(
  name="TestRunner",
  cli="claude",
  task="Run the test suite in src/tests/ and report any failures"
)
\`\`\`

Workers:
- Run in separate processes
- Have their own CLI instance
- Can use relay to communicate back
- Should be released when done

### Worker Lifecycle
1. Spawn worker with task
2. Worker sends ACK when ready
3. Worker sends progress updates
4. Worker sends DONE when complete
5. Lead releases worker

### Release Workers
\`\`\`
relay_release(name="TestRunner", reason="Tests completed")
\`\`\`

## Message Protocol

When you receive messages, they follow this format:
\`\`\`
Relay message from Alice [msg-id-123]: Content here
\`\`\`

Channel messages include the channel:
\`\`\`
Relay message from Alice [msg-id-456] [#general]: Hello team!
\`\`\`

### Optional: ACK/DONE Convention
Some applications use ACK/DONE conventions for task tracking. If your application uses this pattern:
1. Send ACK when starting: "ACK: Starting work on X"
2. Send progress updates as needed
3. Send DONE when complete: "DONE: Completed X with result Y"

Note: This is an application-level convention, not a protocol requirement. Check your application's documentation for expected message formats.

## Best Practices

### For Lead Agents
- Spawn workers for parallelizable tasks
- Keep track of spawned workers
- Release workers when done
- Use channels for team announcements

### For Worker Agents
- Respond promptly when receiving tasks
- Send progress updates for long tasks
- Report results when complete
- Ask clarifying questions if needed

### Message Etiquette
- Keep messages concise
- Include relevant context
- Use threads for related messages
- Don't spam broadcasts

## Checking Messages

Proactively check your inbox:
\`\`\`
relay_inbox()
relay_inbox(from="Lead")
relay_inbox(channel="#urgent")
\`\`\`

## Seeing Who's Online

\`\`\`
relay_who()
\`\`\`

## Error Handling

If relay returns an error:
- "Daemon not running" - The relay daemon needs to be started
- "Agent not found" - Target agent is offline
- "Channel not found" - Channel doesn't exist
- "Timeout" - No response within timeout period

## Multi-Project Communication

In multi-project setups, specify project:
\`\`\`
relay_send(to="frontend:Designer", message="Need UI mockup")
\`\`\`

Special targets:
- \`project:lead\` - Lead agent of that project
- \`project:*\` - Broadcast to project
- \`*:*\` - Broadcast to all projects
`;

export function getProtocolPrompt(): string {
  return PROTOCOL_DOCUMENTATION;
}
