# Reactions Cases

Reaction cases cover add/remove behavior, counts, and repeated operations.

## reactions.add-increments-count

Executor: relay
Kind: capability
Tags: reactions, counts
Human Review: false

### Message

Add one reaction to a channel message.

### Mock

```json
{
  "agents": [
    { "name": "Ada", "type": "agent" },
    { "name": "Ben", "type": "agent" }
  ],
  "channels": [{ "name": "ops", "members": ["Ada", "Ben"] }],
  "messages": [{ "id": "msg-react-target", "channel": "ops", "from": "Ada", "text": "ready for review" }]
}
```

### Operations

```json
[
  { "op": "add_reaction", "as": "Ben", "messageId": "msg-react-target", "emoji": "thumbsup" },
  { "op": "list_messages", "channel": "ops", "limit": 5 }
]
```

### Deterministic Checks

ok: true
reactionCount:

- {"messageId":"msg-react-target","emoji":"thumbsup","count":1}
  contentIncludes:
- thumbsup
  toolCallsInclude:
- add_reaction
  must:
- Record the reacting identity once for the emoji.
  mustNot:
- Require message authorship to add a reaction.

## reactions.add-is-idempotent-per-agent

Executor: relay
Kind: regression
Tags: reactions, idempotency
Human Review: false

### Message

Add the same reaction twice from one agent and keep the count stable.

### Mock

```json
{
  "agents": [
    { "name": "Ada", "type": "agent" },
    { "name": "Ben", "type": "agent" }
  ],
  "channels": [{ "name": "ops", "members": ["Ada", "Ben"] }],
  "messages": [{ "id": "msg-react-idem", "channel": "ops", "from": "Ada", "text": "ship candidate" }]
}
```

### Operations

```json
[
  { "op": "add_reaction", "as": "Ben", "messageId": "msg-react-idem", "emoji": "eyes" },
  { "op": "add_reaction", "as": "Ben", "messageId": "msg-react-idem", "emoji": "eyes" },
  { "op": "list_messages", "channel": "ops", "limit": 5 }
]
```

### Deterministic Checks

ok: true
reactionCount:

- {"messageId":"msg-react-idem","emoji":"eyes","count":1}
  must:
- Treat duplicate reactions by the same agent as idempotent.
  mustNot:
- Double-count one agent for the same emoji on the same message.

## reactions.multiple-agents-counted

Executor: relay
Kind: capability
Tags: reactions, counts
Human Review: false

### Message

Add the same emoji from two agents and count both identities.

### Mock

```json
{
  "agents": [
    { "name": "Ada", "type": "agent" },
    { "name": "Ben", "type": "agent" },
    { "name": "Cy", "type": "agent" }
  ],
  "channels": [{ "name": "planning", "members": ["Ada", "Ben", "Cy"] }],
  "messages": [{ "id": "msg-react-multi", "channel": "planning", "from": "Ada", "text": "proposal ready" }]
}
```

### Operations

```json
[
  { "op": "add_reaction", "as": "Ben", "messageId": "msg-react-multi", "emoji": "white_check_mark" },
  { "op": "add_reaction", "as": "Cy", "messageId": "msg-react-multi", "emoji": "white_check_mark" },
  { "op": "list_messages", "channel": "planning", "limit": 5 }
]
```

### Deterministic Checks

ok: true
reactionCount:

- {"messageId":"msg-react-multi","emoji":"white_check_mark","count":2}
  contentIncludes:
- white_check_mark
  must:
- Count distinct reacting agents for the same emoji.
  mustNot:
- Collapse reactions from different agents into one count.

## reactions.remove-decrements-count

Executor: relay
Kind: regression
Tags: reactions, remove
Human Review: false

### Message

Remove an existing reaction and verify the count is updated.

### Mock

```json
{
  "agents": [
    { "name": "Ada", "type": "agent" },
    { "name": "Ben", "type": "agent" }
  ],
  "channels": [{ "name": "ops", "members": ["Ada", "Ben"] }],
  "messages": [
    {
      "id": "msg-react-remove",
      "channel": "ops",
      "from": "Ada",
      "text": "remove stale reaction",
      "reactions": { "eyes": ["Ben"] }
    }
  ]
}
```

### Operations

```json
[
  { "op": "remove_reaction", "as": "Ben", "messageId": "msg-react-remove", "emoji": "eyes" },
  { "op": "list_messages", "channel": "ops", "limit": 5 }
]
```

### Deterministic Checks

ok: true
reactionCount:

- {"messageId":"msg-react-remove","emoji":"eyes","count":0}
  toolCallsInclude:
- remove_reaction
  must:
- Remove the actor from the emoji reaction set.
  mustNot:
- Leave an empty reaction as a positive count.

## reactions.remove-missing-is-idempotent

Executor: relay
Kind: regression
Tags: reactions, idempotency, remove
Human Review: false

### Message

Remove a reaction that is already absent without failing the run.

### Mock

```json
{
  "agents": [
    { "name": "Ada", "type": "agent" },
    { "name": "Ben", "type": "agent" }
  ],
  "channels": [{ "name": "ops", "members": ["Ada", "Ben"] }],
  "messages": [{ "id": "msg-react-absent", "channel": "ops", "from": "Ada", "text": "no reaction yet" }]
}
```

### Operations

```json
[
  { "op": "remove_reaction", "as": "Ben", "messageId": "msg-react-absent", "emoji": "eyes" },
  { "op": "list_messages", "channel": "ops", "limit": 5 }
]
```

### Deterministic Checks

ok: true
reactionCount:

- {"messageId":"msg-react-absent","emoji":"eyes","count":0}
  must:
- Allow repeated remove operations without throwing.
  mustNot:
- Create a negative or placeholder reaction count.
