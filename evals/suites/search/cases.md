# Search Cases

Search cases cover channel listing, scoped search, and cross-channel search.

## search.finds-channel-message
Executor: relay
Kind: capability
Tags: search, messages
Human Review: false

### Message
Search for a unique term in a channel message.

### Mock
```json
{
  "agents": [
    { "name": "Ada", "type": "agent" }
  ],
  "channels": [
    { "name": "ops", "members": ["Ada"] }
  ],
  "messages": [
    { "id": "msg-search-needle", "channel": "ops", "from": "Ada", "text": "bluebird release marker" },
    { "id": "msg-search-other", "channel": "ops", "from": "Ada", "text": "ordinary deployment note" }
  ]
}
```

### Operations
```json
[
  { "op": "search_messages", "query": "bluebird", "channel": "ops" }
]
```

### Deterministic Checks
ok: true
contentIncludes:
- bluebird release marker
must:
- Return messages matching the query text in the requested channel.
mustNot:
- Return unrelated channel messages as positive search hits.

## search.channel-scope-excludes-other-channels
Executor: relay
Kind: regression
Tags: search, channel-scope
Human Review: false

### Message
Search a single channel when another channel has the same term.

### Mock
```json
{
  "agents": [
    { "name": "Ada", "type": "agent" }
  ],
  "channels": [
    { "name": "ops", "members": ["Ada"] },
    { "name": "random", "members": ["Ada"] }
  ],
  "messages": [
    { "id": "msg-search-ops", "channel": "ops", "from": "Ada", "text": "phoenix status in ops" },
    { "id": "msg-search-random", "channel": "random", "from": "Ada", "text": "phoenix status in random" }
  ]
}
```

### Operations
```json
[
  { "op": "search_messages", "query": "phoenix", "channel": "ops" }
]
```

### Deterministic Checks
ok: true
contentIncludes:
- phoenix status in ops
must:
- Honor the channel scope argument.
mustNot:
- Include random channel results in an ops-scoped search.

## search.cross-channel-finds-all
Executor: relay
Kind: capability
Tags: search, global
Human Review: false

### Message
Search without a channel filter and return matches across channels.

### Mock
```json
{
  "agents": [
    { "name": "Ada", "type": "agent" }
  ],
  "channels": [
    { "name": "ops", "members": ["Ada"] },
    { "name": "planning", "members": ["Ada"] }
  ],
  "messages": [
    { "id": "msg-search-global-ops", "channel": "ops", "from": "Ada", "text": "atlas migration ops note" },
    { "id": "msg-search-global-plan", "channel": "planning", "from": "Ada", "text": "atlas migration planning note" }
  ]
}
```

### Operations
```json
[
  { "op": "search_messages", "query": "atlas migration" }
]
```

### Deterministic Checks
ok: true
contentIncludes:
- atlas migration ops note
- atlas migration planning note
must:
- Search all accessible channels when no channel filter is provided.
mustNot:
- Stop at the first matching channel.

## search.list-messages-respects-limit
Executor: relay
Kind: regression
Tags: search, list-messages, pagination
Human Review: false

### Message
List only the most recent requested number of channel messages.

### Mock
```json
{
  "agents": [
    { "name": "Ada", "type": "agent" }
  ],
  "channels": [
    { "name": "ops", "members": ["Ada"] }
  ],
  "messages": [
    { "id": "msg-list-old", "channel": "ops", "from": "Ada", "text": "old status" },
    { "id": "msg-list-mid", "channel": "ops", "from": "Ada", "text": "middle status" },
    { "id": "msg-list-new", "channel": "ops", "from": "Ada", "text": "new status" }
  ]
}
```

### Operations
```json
[
  { "op": "list_messages", "channel": "ops", "limit": 2 }
]
```

### Deterministic Checks
ok: true
contentIncludes:
- new status
- middle status
must:
- Respect the requested list_messages limit.
mustNot:
- Return older messages beyond the requested limit.

## search.new-message-searchable
Executor: relay
Kind: regression
Tags: search, indexing
Human Review: false

### Message
Post a new channel message and immediately search for it.

### Mock
```json
{
  "agents": [
    { "name": "Ada", "type": "agent" }
  ],
  "channels": [
    { "name": "ops", "members": ["Ada"] }
  ]
}
```

### Operations
```json
[
  { "op": "post_message", "as": "Ada", "channel": "ops", "text": "instant-search-token ready", "id": "msg-search-fresh" },
  { "op": "search_messages", "query": "instant-search-token", "channel": "ops" }
]
```

### Deterministic Checks
ok: true
messageExists:
- {"channel":"ops","text":"instant-search-token ready","from":"Ada"}
contentIncludes:
- instant-search-token ready
toolCallsInclude:
- post_message
- search_messages
must:
- Make newly posted messages searchable in the same run.
mustNot:
- Require a separate indexing or refresh operation.
