# Messaging Cases

Messaging cases cover direct, channel, and group delivery through the relay
message surfaces.

## messaging.channel-post-visible

Executor: relay
Kind: capability
Tags: messaging, channel
Human Review: false

### Message

Post a channel update and list the channel messages.

### Mock

```json
{
  "agents": [
    { "name": "Ada", "type": "agent" },
    { "name": "Ben", "type": "agent" }
  ],
  "channels": [{ "name": "ops", "members": ["Ada", "Ben"] }]
}
```

### Operations

```json
[
  {
    "op": "post_message",
    "as": "Ada",
    "channel": "ops",
    "text": "deploy window opens at 14:00",
    "id": "msg-channel-deploy"
  },
  { "op": "list_messages", "channel": "ops", "limit": 10 }
]
```

### Deterministic Checks

ok: true
messageExists:

- {"channel":"ops","text":"deploy window opens at 14:00","from":"Ada"}
  contentIncludes:
- deploy window opens at 14:00
  toolCallsInclude:
- post_message
- list_messages
  must:
- Preserve the posted channel message text and author.
  mustNot:
- Hide the channel message from list_messages.

## messaging.dm-visible-to-recipient

Executor: relay
Kind: capability
Tags: messaging, dm
Human Review: false

### Message

Send a direct message and let the recipient inspect their inbox.

### Mock

```json
{
  "agents": [
    { "name": "Ada", "type": "agent" },
    { "name": "Ben", "type": "agent" }
  ]
}
```

### Operations

```json
[
  { "op": "send_dm", "as": "Ada", "to": "Ben", "text": "handoff note is ready", "id": "msg-dm-handoff" },
  { "op": "check_inbox", "as": "Ben" }
]
```

### Deterministic Checks

ok: true
messageExists:

- {"kind":"dm","text":"handoff note is ready","from":"Ada"}
  contentIncludes:
- handoff note is ready
  toolCallsInclude:
- send_dm
- check_inbox
  must:
- Deliver the direct message to the named recipient.
  mustNot:
- Require a channel membership for direct delivery.

## messaging.group-dm-members-only

Executor: relay
Kind: regression
Tags: messaging, group-dm
Human Review: false

### Message

Create a named group DM and verify only participants see the message.

### Mock

```json
{
  "agents": [
    { "name": "Ada", "type": "agent" },
    { "name": "Ben", "type": "agent" },
    { "name": "Cy", "type": "agent" }
  ]
}
```

### Operations

```json
[
  {
    "op": "send_group_dm",
    "as": "Ada",
    "participants": ["Ben", "Cy"],
    "name": "handoff-room",
    "text": "triage notes for Ben and Cy",
    "id": "msg-group-triage"
  },
  { "op": "check_inbox", "as": "Ben" },
  { "op": "check_inbox", "as": "Cy" }
]
```

### Deterministic Checks

ok: true
messageExists:

- {"kind":"group_dm","text":"triage notes for Ben and Cy","from":"Ada"}
  contentIncludes:
- triage notes for Ben and Cy
  must:
- Include every named participant in the group DM conversation.
  mustNot:
- Convert a group DM into a public channel post.

## messaging.channel-attachment-preserved

Executor: relay
Kind: regression
Tags: messaging, channel, attachments
Human Review: false

### Message

Post a channel message with an attachment reference and list it back.

### Mock

```json
{
  "agents": [{ "name": "Ada", "type": "agent" }],
  "channels": [{ "name": "design", "members": ["Ada"] }]
}
```

### Operations

```json
[
  {
    "op": "post_message",
    "as": "Ada",
    "channel": "design",
    "text": "wireframe attached",
    "id": "msg-attachment-wireframe",
    "attachments": ["file-wireframe-1"]
  },
  { "op": "list_messages", "channel": "design", "limit": 5 }
]
```

### Deterministic Checks

ok: true
messageExists:

- {"channel":"design","text":"wireframe attached","from":"Ada"}
  contentIncludes:
- file-wireframe-1
  must:
- Preserve attachment identifiers on channel messages.
  mustNot:
- Drop attachments when returning list_messages results.

## messaging.idempotent-channel-post

Executor: relay
Kind: regression
Tags: messaging, idempotency
Human Review: false

### Message

Retry a channel post with the same idempotency key and keep one logical message.

### Mock

```json
{
  "agents": [{ "name": "Ada", "type": "agent" }],
  "channels": [{ "name": "ops", "members": ["Ada"] }]
}
```

### Operations

```json
[
  {
    "op": "post_message",
    "as": "Ada",
    "channel": "ops",
    "text": "same deployment update",
    "id": "msg-idempotent-deploy",
    "idempotencyKey": "deploy-42"
  },
  {
    "op": "post_message",
    "as": "Ada",
    "channel": "ops",
    "text": "same deployment update",
    "id": "msg-idempotent-deploy-retry",
    "idempotencyKey": "deploy-42"
  },
  { "op": "list_messages", "channel": "ops", "limit": 10 }
]
```

### Deterministic Checks

ok: true
messageExists:

- {"channel":"ops","text":"same deployment update","from":"Ada"}
  contentIncludes:
- same deployment update
  must:
- Treat repeated sends with the same idempotency key as one logical delivery.
  mustNot:
- Produce duplicate user-visible channel messages for one idempotency key.
