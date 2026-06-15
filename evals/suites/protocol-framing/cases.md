# Protocol Framing Cases

These reference cases prove the Relay eval harness can compile markdown cases,
execute SDK-shaped operations in memory, and assert protocol-visible state.

## protocol-framing.channel-envelope

Executor: relay
Kind: capability
Tags: protocol, framing, messaging
Human Review: false

### Message

Post a channel message and verify the public envelope preserves sender, channel, and content.

### Mock

```json
{
  "agents": [{ "name": "Lead", "type": "human" }],
  "channels": [{ "name": "general", "members": ["Lead"] }]
}
```

### Operations

```json
[
  { "op": "post_message", "as": "Lead", "channel": "general", "text": "Protocol hello", "id": "proto_msg_1" },
  { "op": "list_messages", "channel": "general" }
]
```

### Deterministic Checks

ok: true
contentIncludes:

- proto_msg_1
- Protocol hello
  messageExists:
- {"channel":"general","text":"Protocol hello","from":"Lead"}
  eventEmitted:
- messageCreated
  toolCallsInclude:
- post_message
- list_messages

### Must

- Preserve the message id, sender, channel, and text in the observed envelope.

### Must Not

- Require a live broker to frame a channel message.

## protocol-framing.thread-envelope

Executor: relay
Kind: regression
Tags: protocol, framing, threads
Human Review: false

### Message

Reply to a seeded message and verify the thread reply is counted against the parent.

### Mock

```json
{
  "agents": [
    { "name": "Lead", "type": "human" },
    { "name": "Worker", "type": "agent" }
  ],
  "channels": [{ "name": "general", "members": ["Lead", "Worker"] }],
  "messages": [{ "id": "proto_parent", "channel": "general", "from": "Lead", "text": "Parent" }]
}
```

### Operations

```json
[
  {
    "op": "reply_to_thread",
    "as": "Worker",
    "parent": "proto_parent",
    "text": "Reply frame",
    "id": "proto_reply"
  },
  { "op": "get_thread", "parent": "proto_parent" }
]
```

### Deterministic Checks

ok: true
contentIncludes:

- proto_reply
- Reply frame
  threadReplyCount:
- {"parent":"proto_parent","count":1}
  eventEmitted:
- threadReply
  toolCallsInclude:
- reply_to_thread
- get_thread

### Must

- Preserve the parent id and expose the reply through thread retrieval.

### Must Not

- Count the parent message as its own reply.

## protocol-framing.action-event

Executor: relay
Kind: capability
Tags: protocol, framing, actions
Human Review: false

### Message

Invoke an in-memory action and verify action completion is emitted in the observed protocol event stream.

### Mock

```json
{
  "agents": [
    { "name": "planner", "type": "agent" },
    { "name": "handler", "type": "agent" }
  ]
}
```

### Operations

```json
[
  { "op": "register_action", "as": "handler", "name": "echo", "handlerFixture": "echo_text" },
  { "op": "invoke_action", "as": "planner", "name": "echo", "input": { "text": "action frame" } }
]
```

### Deterministic Checks

ok: true
contentIncludes:

- action frame
- echoed
  eventEmitted:
- action.completed
  toolCallsInclude:
- register_action
- invoke_action

### Must

- Surface action completion through the observed event contract.

### Must Not

- Treat action invocation as a broker-only capability.
