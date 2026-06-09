# Listeners Cases

These cases pin the listener hub, predicate DSL, selector matching, public event
mapping, and session-event emission surfaces used by agents subscribing to Relay
SDK events.

## listeners.message-created-selector
Executor: relay
Kind: capability
Tags: listeners, messages
Human Review: false

### Message
Subscribe to public message creation events and emit a matching raw message event.

### Mock
```json
{
  "agents": [{ "name": "alice", "type": "agent" }],
  "channels": [{ "name": "ops", "members": ["alice"] }]
}
```

### Operations
```json
[
  { "op": "add_listener", "selector": "message.created" },
  {
    "op": "emit_event",
    "raw": {
      "type": "messageCreated",
      "channel": "ops",
      "message": {
        "id": "m-listen-1",
        "messageId": "m-listen-1",
        "text": "hello ops",
        "from": { "name": "alice" },
        "channel": { "name": "ops" }
      }
    }
  }
]
```

### Deterministic Checks
ok: true
eventEmitted:
- messageCreated
contentIncludes:
- listener message.created
toolCallsInclude:
- add_listener
- emit_event

### Must
- Convert raw `messageCreated` events to public `message.created` events.
- Preserve the message envelope channel.

### Must Not
- Deliver unrelated raw event types to the exact selector.

## listeners.message-predicate-channel-mention
Executor: relay
Kind: regression
Tags: listeners, messages, predicates
Human Review: false

### Message
Use the message-created predicate with channel and mention filters.

### Mock
```json
{
  "agents": [{ "name": "eng", "type": "agent" }],
  "channels": [{ "name": "ops", "members": ["eng"] }]
}
```

### Operations
```json
[
  { "op": "on_predicate", "predicate": "message.created", "channel": "#ops", "mentions": "eng" },
  { "op": "emit_event", "raw": { "type": "messageCreated", "channel": "random", "message": { "id": "wrong-channel", "text": "@eng hi" } } },
  { "op": "emit_event", "raw": { "type": "messageCreated", "channel": "ops", "message": { "id": "no-mention", "text": "hi" } } },
  { "op": "emit_event", "raw": { "type": "messageCreated", "channel": "#ops", "message": { "id": "match", "text": "hey @eng", "mentions": ["eng"] } } }
]
```

### Deterministic Checks
ok: true
eventEmitted:
- messageCreated
contentIncludes:
- predicate messageCreated
must:
- Fire only for the event in the selected channel that mentions the target agent.
mustNot:
- Include wrong-channel
- Include no-mention

### Must
- Strip `#` from channel filters before matching.
- Match mentions from either explicit mention arrays or message text.

### Must Not
- Fire for the right mention in the wrong channel.

## listeners.message-read-public-event
Executor: relay
Kind: capability
Tags: listeners, read-receipts
Human Review: false

### Message
Map a raw message read event to its public event.

### Mock
```json
{}
```

### Operations
```json
[
  { "op": "add_listener", "selector": "message.read" },
  { "op": "emit_event", "raw": { "type": "messageRead", "messageId": "m-read-1", "agentName": "bob", "readAt": "2026-06-09T09:00:00.000Z" } }
]
```

### Deterministic Checks
ok: true
eventEmitted:
- messageRead
contentIncludes:
- listener message.read

### Must
- Preserve the message id, reader name, and read timestamp.

### Must Not
- Represent read receipts as message creation events.

## listeners.reaction-added-removed-public-event
Executor: relay
Kind: regression
Tags: listeners, reactions
Human Review: false

### Message
Map added and removed reaction events to public reaction actions.

### Mock
```json
{}
```

### Operations
```json
[
  { "op": "add_listener", "selector": "message.reacted" },
  { "op": "emit_event", "raw": { "type": "reactionAdded", "messageId": "m-react-1", "emoji": "eyes", "agentName": "bob" } },
  { "op": "emit_event", "raw": { "type": "reactionRemoved", "messageId": "m-react-1", "emoji": "eyes", "agentName": "bob" } }
]
```

### Deterministic Checks
ok: true
eventEmitted:
- {"type":"reactionAdded","messageId":"m-react-1"}
- {"type":"reactionRemoved","messageId":"m-react-1"}
contentIncludes:
- listener message.reacted
minToolCalls: 3

### Must
- Surface both reaction add and remove events through the same public event type.
- Preserve the action discriminator.

### Must Not
- Collapse add and remove into one indistinguishable event.

## listeners.action-predicate-completed-by-caller
Executor: relay
Kind: capability
Tags: listeners, actions, predicates
Human Review: false

### Message
Subscribe to an action predicate for a completed action invoked by a selected caller.

### Mock
```json
{
  "agents": [{ "name": "planner", "type": "agent" }]
}
```

### Operations
```json
[
  { "op": "on_predicate", "predicate": "action", "action": "spawn-claude", "phase": "completed", "calledBy": "planner" },
  { "op": "register_action", "name": "spawn-claude", "handlerFixture": "echo_text" },
  { "op": "invoke_action", "name": "spawn-claude", "as": "other", "input": { "text": "ignored" } },
  { "op": "invoke_action", "name": "spawn-claude", "as": "planner", "input": { "text": "matched" } }
]
```

### Deterministic Checks
ok: true
eventEmitted:
- action.completed
contentIncludes:
- spawn-claude
- predicate action.completed
mustNot:
- Include "\"name\":\"other\""

### Must
- Filter action events by action name, phase, and caller.

### Must Not
- Fire for a matching action completed by a different caller.

## listeners.status-predicate-matches-changed-and-specific
Executor: relay
Kind: regression
Tags: listeners, session, status
Human Review: false

### Message
Subscribe to an agent status predicate and emit both status.changed and status.idle events.

### Mock
```json
{
  "agents": [{ "name": "engineer", "type": "agent", "id": "a-eng" }]
}
```

### Operations
```json
[
  { "op": "on_predicate", "predicate": "status", "agentId": "a-eng", "status": "idle" },
  { "op": "emit_session_event", "agentId": "a-other", "event": { "type": "status.changed", "status": "idle" } },
  { "op": "emit_session_event", "agentId": "a-eng", "event": { "type": "status.changed", "status": "active" } },
  { "op": "emit_session_event", "agentId": "a-eng", "event": { "type": "status.changed", "status": "idle", "reason": "waiting" } },
  { "op": "emit_session_event", "agentId": "a-eng", "event": { "type": "status.idle", "reason": "no work" } }
]
```

### Deterministic Checks
ok: true
eventEmitted:
- status.changed
- status.idle
contentIncludes:
- predicate status.changed
- predicate status.idle
mustNot:
- Include a-other

### Must
- Fire for both `status.changed` with a matching status and the specific status event.

### Must Not
- Fire for events from a different agent id.

## listeners.tool-called-predicate-with-filter
Executor: relay
Kind: capability
Tags: listeners, tools, predicates
Human Review: false

### Message
Subscribe to a tool-called predicate with an input filter.

### Mock
```json
{
  "agents": [{ "name": "engineer", "type": "agent", "id": "a-eng" }]
}
```

### Operations
```json
[
  { "op": "add_listener", "selector": "tool.called" },
  { "op": "emit_session_event", "agentId": "a-eng", "event": { "type": "tool.called", "tool": "bash", "input": { "command": "ls" } } },
  { "op": "emit_session_event", "agentId": "a-eng", "event": { "type": "tool.called", "tool": "bash", "input": { "command": "npm test" } } }
]
```

### Deterministic Checks
ok: true
eventEmitted:
- tool.called
contentIncludes:
- listener tool.called
mustNot:
- Include "\"command\":\"ls\""

### Must
- Filter tool call predicates by tool name and input content.

### Must Not
- Fire for the same tool when the input filter does not match.

## listeners.selector-wildcards
Executor: relay
Kind: regression
Tags: listeners, selectors
Human Review: false

### Message
Match exact, prefix wildcard, and catch-all selectors against public event types.

### Mock
```json
{}
```

### Operations
```json
[
  { "op": "match_selector", "selector": "message.*", "type": "message.read" },
  { "op": "match_selector", "selector": "*", "type": "agent.status.idle" },
  { "op": "match_selector", "selector": "message.created", "type": "message.read" }
]
```

### Deterministic Checks
ok: true
contentIncludes:
- true
- false
toolCallsInclude:
- match_selector
minToolCalls: 3

### Must
- Treat `*` as a catch-all selector.
- Treat `<prefix>.*` as a starts-with selector.
- Require exact equality for non-wildcard selectors.

### Must Not
- Match `message.created` against `message.read`.

## listeners.to-public-thread-reply-envelope
Executor: relay
Kind: capability
Tags: listeners, public-events, threads
Human Review: false

### Message
Convert a raw thread reply event into a public event with parent envelope metadata.

### Mock
```json
{}
```

### Operations
```json
[
  {
    "op": "to_public_event",
    "raw": {
      "type": "threadReply",
      "channel": "ops",
      "message": {
        "id": "reply-1",
        "messageId": "reply-1",
        "parentId": "parent-1",
        "text": "on it",
        "from": { "name": "reviewer" }
      }
    }
  }
]
```

### Deterministic Checks
ok: true
contentIncludes:
- thread.reply
- parent-1
- reviewer
- ops
toolCallsInclude:
- to_public_event

### Must
- Map `threadReply` to `thread.reply`.
- Populate the envelope parent from `message.parentId`.

### Must Not
- Drop channel information when the raw event carries channel context.

## listeners.unsurfaced-event-ignored
Executor: relay
Kind: regression
Tags: listeners, public-events
Human Review: false

### Message
Try to convert a raw event type that is not part of the public listener surface.

### Mock
```json
{}
```

### Operations
```json
[
  { "op": "to_public_event", "raw": { "type": "agentOnline", "agent": { "name": "worker" } } }
]
```

### Deterministic Checks
ok: true
contentIncludes:
- undefined
must:
- Return no public event for unsupported raw event types.
mustNot:
- Emit agentOnline as a public event.

### Must
- Keep unsupported messaging events out of the public listener stream.

### Must Not
- Fabricate a public event name for unknown raw events.
