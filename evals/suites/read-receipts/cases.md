# Read Receipts Cases

Read receipt cases cover inbox transitions, explicit reads, and reader lookup.

## read-receipts.dm-unread-then-read
Executor: relay
Kind: capability
Tags: read-receipts, inbox, dm
Human Review: false

### Message
Receive a DM, mark it read, and verify the reader list.

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
  { "op": "send_dm", "as": "Ada", "to": "Ben", "text": "please review the handoff", "id": "msg-read-dm" },
  { "op": "check_inbox", "as": "Ben" },
  { "op": "mark_read", "as": "Ben", "messageId": "msg-read-dm" },
  { "op": "get_readers", "messageId": "msg-read-dm" }
]
```

### Deterministic Checks
ok: true
contentIncludes:
- please review the handoff
- Ben
must:
- Show the DM as unread before mark_read and read by Ben after mark_read.
mustNot:
- Mark the message read for unrelated agents.

## read-receipts.channel-message-readers
Executor: relay
Kind: capability
Tags: read-receipts, channel
Human Review: false

### Message
Mark a channel message read by two members and list readers.

### Mock
```json
{
  "agents": [
    { "name": "Ada", "type": "agent" },
    { "name": "Ben", "type": "agent" },
    { "name": "Cy", "type": "agent" }
  ],
  "channels": [
    { "name": "ops", "members": ["Ada", "Ben", "Cy"] }
  ],
  "messages": [
    { "id": "msg-read-channel", "channel": "ops", "from": "Ada", "text": "channel read target" }
  ]
}
```

### Operations
```json
[
  { "op": "mark_read", "as": "Ben", "messageId": "msg-read-channel" },
  { "op": "mark_read", "as": "Cy", "messageId": "msg-read-channel" },
  { "op": "get_readers", "messageId": "msg-read-channel" }
]
```

### Deterministic Checks
ok: true
contentIncludes:
- Ben
- Cy
must:
- Return every agent that explicitly marked the message read.
mustNot:
- Report non-reading members as readers.

## read-receipts.mark-read-idempotent
Executor: relay
Kind: regression
Tags: read-receipts, idempotency
Human Review: false

### Message
Mark the same message read twice and keep one reader entry.

### Mock
```json
{
  "agents": [
    { "name": "Ada", "type": "agent" },
    { "name": "Ben", "type": "agent" }
  ],
  "channels": [
    { "name": "ops", "members": ["Ada", "Ben"] }
  ],
  "messages": [
    { "id": "msg-read-idem", "channel": "ops", "from": "Ada", "text": "read once target" }
  ]
}
```

### Operations
```json
[
  { "op": "mark_read", "as": "Ben", "messageId": "msg-read-idem" },
  { "op": "mark_read", "as": "Ben", "messageId": "msg-read-idem" },
  { "op": "get_readers", "messageId": "msg-read-idem" }
]
```

### Deterministic Checks
ok: true
contentIncludes:
- Ben
must:
- Deduplicate repeated read receipts from the same agent.
mustNot:
- Return duplicate reader entries for one agent.

## read-receipts.inbox-clears-after-read
Executor: relay
Kind: regression
Tags: read-receipts, inbox
Human Review: false

### Message
Check the inbox after marking the only unread message read.

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
  { "op": "send_dm", "as": "Ada", "to": "Ben", "text": "clear this unread item", "id": "msg-inbox-clear" },
  { "op": "mark_read", "as": "Ben", "messageId": "msg-inbox-clear" },
  { "op": "check_inbox", "as": "Ben" }
]
```

### Deterministic Checks
ok: true
contentIncludes:
- msg-inbox-clear
must:
- Reflect that the message has transitioned out of Ben's unread inbox.
mustNot:
- Continue reporting the message as unread after mark_read.
