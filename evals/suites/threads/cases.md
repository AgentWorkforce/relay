# Threads Cases

Thread cases cover replies, thread retrieval, and deterministic reply counts.

## threads.single-reply-counted

Executor: relay
Kind: capability
Tags: threads, replies
Human Review: false

### Message

Reply to a seeded parent message and fetch the thread.

### Mock

```json
{
  "agents": [
    { "name": "Ada", "type": "agent" },
    { "name": "Ben", "type": "agent" }
  ],
  "channels": [{ "name": "ops", "members": ["Ada", "Ben"] }],
  "messages": [{ "id": "msg-parent-rollout", "channel": "ops", "from": "Ada", "text": "rollout checklist" }]
}
```

### Operations

```json
[
  {
    "op": "reply_to_thread",
    "as": "Ben",
    "parent": "msg-parent-rollout",
    "text": "database backup complete",
    "id": "msg-reply-backup"
  },
  { "op": "get_thread", "messageId": "msg-parent-rollout" }
]
```

### Deterministic Checks

ok: true
threadReplyCount:

- {"parent":"msg-parent-rollout","count":1}
  messageExists:
- {"channel":"ops","text":"database backup complete","from":"Ben"}
  contentIncludes:
- rollout checklist
- database backup complete
  must:
- Associate the reply with the parent thread.
  mustNot:
- Count the parent message as its own reply.

## threads.multiple-replies-ordered

Executor: relay
Kind: regression
Tags: threads, ordering
Human Review: false

### Message

Add two replies from different agents and retrieve the full thread.

### Mock

```json
{
  "agents": [
    { "name": "Ada", "type": "agent" },
    { "name": "Ben", "type": "agent" },
    { "name": "Cy", "type": "agent" }
  ],
  "channels": [{ "name": "planning", "members": ["Ada", "Ben", "Cy"] }],
  "messages": [{ "id": "msg-parent-plan", "channel": "planning", "from": "Ada", "text": "plan review" }]
}
```

### Operations

```json
[
  {
    "op": "reply_to_thread",
    "as": "Ben",
    "parent": "msg-parent-plan",
    "text": "risks logged",
    "id": "msg-reply-risks"
  },
  {
    "op": "reply_to_thread",
    "as": "Cy",
    "parent": "msg-parent-plan",
    "text": "owners assigned",
    "id": "msg-reply-owners"
  },
  { "op": "get_thread", "messageId": "msg-parent-plan" }
]
```

### Deterministic Checks

ok: true
threadReplyCount:

- {"parent":"msg-parent-plan","count":2}
  contentIncludes:
- risks logged
- owners assigned
  toolCallsInclude:
- reply_to_thread
- get_thread
  must:
- Return every reply attached to the parent thread.
  mustNot:
- Drop earlier replies when later replies are added.

## threads.parent-alias-supported

Executor: relay
Kind: regression
Tags: threads, aliases
Human Review: false

### Message

Fetch a thread using the get_thread parent alias confirmed by the harness.

### Mock

```json
{
  "agents": [
    { "name": "Ada", "type": "agent" },
    { "name": "Ben", "type": "agent" }
  ],
  "channels": [{ "name": "support", "members": ["Ada", "Ben"] }],
  "messages": [
    { "id": "msg-parent-incident", "channel": "support", "from": "Ada", "text": "incident root cause" },
    {
      "id": "msg-seeded-reply",
      "channel": "support",
      "from": "Ben",
      "text": "cache invalidation confirmed",
      "threadParent": "msg-parent-incident"
    }
  ]
}
```

### Operations

```json
[{ "op": "get_thread", "parent": "msg-parent-incident" }]
```

### Deterministic Checks

ok: true
threadReplyCount:

- {"parent":"msg-parent-incident","count":1}
  contentIncludes:
- incident root cause
- cache invalidation confirmed
  must:
- Accept parent as an alias for get_thread messageId.
  mustNot:
- Require callers to duplicate the parent id under both fields.

## threads.channel-list-excludes-replies

Executor: relay
Kind: regression
Tags: threads, list-messages
Human Review: false

### Message

List a channel after creating a thread reply and keep top-level listing clean.

### Mock

```json
{
  "agents": [
    { "name": "Ada", "type": "agent" },
    { "name": "Ben", "type": "agent" }
  ],
  "channels": [{ "name": "ops", "members": ["Ada", "Ben"] }],
  "messages": [{ "id": "msg-parent-check", "channel": "ops", "from": "Ada", "text": "status check" }]
}
```

### Operations

```json
[
  {
    "op": "reply_to_thread",
    "as": "Ben",
    "parent": "msg-parent-check",
    "text": "thread-only acknowledgement",
    "id": "msg-reply-thread-only"
  },
  { "op": "list_messages", "channel": "ops", "limit": 10 },
  { "op": "get_thread", "messageId": "msg-parent-check" }
]
```

### Deterministic Checks

ok: true
messageExists:

- {"channel":"ops","text":"status check","from":"Ada"}
  threadReplyCount:
- {"parent":"msg-parent-check","count":1}
  contentIncludes:
- thread-only acknowledgement
  must:
- Keep thread replies discoverable through get_thread.
  mustNot:
- Promote thread replies to independent top-level channel messages.
