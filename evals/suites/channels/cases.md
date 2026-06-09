# Channels Cases
Channels cases pin channel lifecycle behavior for the Relay SDK eval harness, including membership changes, topic updates, archive visibility, and duplicate-name errors.

## channels.create-with-topic
Executor: relay
Kind: capability
Tags: channels, create, topic
Human Review: false

### Message
Create a planning channel with an initial topic and verify it appears in channel listings.

### Mock
```json
{
  "agents": [
    { "name": "Lead", "type": "human" }
  ]
}
```

### Operations
```json
[
  { "op": "create_channel", "as": "Lead", "name": "launch-room", "topic": "Launch coordination" },
  { "op": "list_channels", "as": "Lead" }
]
```

### Deterministic Checks
ok: true
contentIncludes:
- launch-room
- Launch coordination
toolCallsInclude:
- create_channel
- list_channels
minToolCalls: 2

### Must
- Persist the created channel with its requested topic.
- Return the channel from an ordinary channel listing.

### Must Not
- Drop the topic during create normalization.

## channels.create-duplicate-name-rejected
Executor: relay
Kind: regression
Tags: channels, create, errors
Human Review: false

### Message
Creating a channel with an existing name should fail without changing existing membership.

### Mock
```json
{
  "agents": [
    { "name": "Lead", "type": "human" },
    { "name": "WorkerA", "type": "agent" }
  ],
  "channels": [
    { "name": "general", "topic": "Default room", "members": ["Lead", "WorkerA"] }
  ]
}
```

### Operations
```json
[
  { "op": "create_channel", "as": "Lead", "name": "general", "topic": "Duplicate room" }
]
```

### Deterministic Checks
ok: false
errorCode: channel_already_exists
channelMembers:
- {"channel":"general","members":["Lead","WorkerA"]}
must:
- Reject duplicate channel names deterministically.
mustNot:
- Replace the existing channel topic or membership.

## channels.join-existing-channel
Executor: relay
Kind: capability
Tags: channels, membership, join
Human Review: false

### Message
A registered worker joins an existing project channel.

### Mock
```json
{
  "agents": [
    { "name": "Lead", "type": "human" },
    { "name": "WorkerA", "type": "agent" }
  ],
  "channels": [
    { "name": "project-alpha", "topic": "Alpha work", "members": ["Lead"] }
  ]
}
```

### Operations
```json
[
  { "op": "join_channel", "as": "WorkerA", "channel": "project-alpha" },
  { "op": "list_channels", "as": "WorkerA" }
]
```

### Deterministic Checks
ok: true
contentIncludes:
- project-alpha
- WorkerA
channelMembers:
- {"channel":"project-alpha","members":["Lead","WorkerA"]}
toolCallsInclude:
- join_channel

### Must
- Add the joining agent to the channel membership set.
- Keep pre-existing members in the channel.

### Must Not
- Create a duplicate membership row for the joining agent.

## channels.join-idempotent-for-member
Executor: relay
Kind: regression
Tags: channels, membership, idempotency
Human Review: false

### Message
Joining a channel twice should leave membership stable.

### Mock
```json
{
  "agents": [
    { "name": "WorkerA", "type": "agent" }
  ],
  "channels": [
    { "name": "standup", "topic": "Daily updates", "members": ["WorkerA"] }
  ]
}
```

### Operations
```json
[
  { "op": "join_channel", "as": "WorkerA", "channel": "standup" },
  { "op": "join_channel", "as": "WorkerA", "channel": "standup" },
  { "op": "list_channels", "as": "WorkerA" }
]
```

### Deterministic Checks
ok: true
contentIncludes:
- standup
channelMembers:
- {"channel":"standup","members":["WorkerA"]}
minToolCalls: 3

### Must
- Treat repeated joins by the same agent as idempotent.

### Must Not
- Add duplicate copies of the same agent to the member list.

## channels.leave-removes-membership
Executor: relay
Kind: capability
Tags: channels, membership, leave
Human Review: false

### Message
A worker leaves a channel and should no longer appear as a member.

### Mock
```json
{
  "agents": [
    { "name": "Lead", "type": "human" },
    { "name": "WorkerA", "type": "agent" }
  ],
  "channels": [
    { "name": "handoff", "topic": "Handoff queue", "members": ["Lead", "WorkerA"] }
  ]
}
```

### Operations
```json
[
  { "op": "leave_channel", "as": "WorkerA", "channel": "handoff" },
  { "op": "list_channels", "as": "Lead" }
]
```

### Deterministic Checks
ok: true
contentIncludes:
- handoff
forbidPhrases:
- WorkerA
channelMembers:
- {"channel":"handoff","members":["Lead"]}

### Must
- Remove only the leaving agent from the channel.
- Preserve the channel and its remaining members.

### Must Not
- Delete the channel when one member leaves.

## channels.invite-adds-target-member
Executor: relay
Kind: capability
Tags: channels, membership, invite
Human Review: false

### Message
An existing channel member invites another registered agent into the channel.

### Mock
```json
{
  "agents": [
    { "name": "Lead", "type": "human" },
    { "name": "WorkerA", "type": "agent" },
    { "name": "WorkerB", "type": "agent" }
  ],
  "channels": [
    { "name": "triage", "topic": "Incoming work", "members": ["Lead", "WorkerA"] }
  ]
}
```

### Operations
```json
[
  { "op": "invite_to_channel", "as": "Lead", "channel": "triage", "agent": "WorkerB" },
  { "op": "list_channels", "as": "WorkerB" }
]
```

### Deterministic Checks
ok: true
contentIncludes:
- Invited WorkerB
- triage
channelMembers:
- {"channel":"triage","members":["Lead","WorkerA","WorkerB"]}

### Must
- Add the invited agent to the channel members.
- Keep the inviter and existing members in place.

### Must Not
- Require the invited agent to call join before membership is visible.

## channels.invite-unknown-agent-rejected
Executor: relay
Kind: regression
Tags: channels, membership, errors
Human Review: false

### Message
Inviting an agent name that is not registered should fail without changing channel members.

### Mock
```json
{
  "agents": [
    { "name": "Lead", "type": "human" }
  ],
  "channels": [
    { "name": "ops", "topic": "Operations", "members": ["Lead"] }
  ]
}
```

### Operations
```json
[
  { "op": "invite_to_channel", "as": "Lead", "channel": "ops", "agent": "MissingWorker" }
]
```

### Deterministic Checks
ok: false
errorCode: agent_not_found
forbidPhrases:
- MissingWorker
channelMembers:
- {"channel":"ops","members":["Lead"]}

### Must
- Return a deterministic not-found error for unknown invite targets.

### Must Not
- Create placeholder agent records as a side effect of invite.

## channels.set-topic-updates-state
Executor: relay
Kind: capability
Tags: channels, topic
Human Review: false

### Message
Update a channel topic and verify the new topic appears in channel listings.

### Mock
```json
{
  "agents": [
    { "name": "Lead", "type": "human" }
  ],
  "channels": [
    { "name": "planning", "topic": "Old topic", "members": ["Lead"] }
  ]
}
```

### Operations
```json
[
  { "op": "set_topic", "as": "Lead", "channel": "planning", "topic": "Release readiness" },
  { "op": "list_channels", "as": "Lead" }
]
```

### Deterministic Checks
ok: true
contentIncludes:
- planning
- Release readiness
forbidPhrases:
- Old topic
toolCallsInclude:
- set_topic

### Must
- Persist the exact replacement topic on the channel.

### Must Not
- Append the new topic to the old topic text.

## channels.archive-hides-from-default-list
Executor: relay
Kind: regression
Tags: channels, archive
Human Review: false

### Message
Archiving a channel should remove it from the default channel listing.

### Mock
```json
{
  "agents": [
    { "name": "Lead", "type": "human" }
  ],
  "channels": [
    { "name": "old-room", "topic": "Past work", "members": ["Lead"] },
    { "name": "active-room", "topic": "Current work", "members": ["Lead"] }
  ]
}
```

### Operations
```json
[
  { "op": "archive_channel", "as": "Lead", "channel": "old-room" },
  { "op": "list_channels", "as": "Lead" }
]
```

### Deterministic Checks
ok: true
contentIncludes:
- active-room
forbidPhrases:
- old-room
toolCallsInclude:
- archive_channel

### Must
- Hide archived channels from default listings.
- Keep unrelated active channels visible.

### Must Not
- Delete or hide unrelated channels when one channel is archived.

## channels.archive-visible-when-included
Executor: relay
Kind: capability
Tags: channels, archive, list
Human Review: false

### Message
Archived channels should be visible when the caller explicitly includes archived channels.

### Mock
```json
{
  "agents": [
    { "name": "Lead", "type": "human" }
  ],
  "channels": [
    { "name": "old-room", "topic": "Past work", "members": ["Lead"] },
    { "name": "active-room", "topic": "Current work", "members": ["Lead"] }
  ]
}
```

### Operations
```json
[
  { "op": "archive_channel", "as": "Lead", "channel": "old-room" },
  { "op": "list_channels", "as": "Lead", "includeArchived": true }
]
```

### Deterministic Checks
ok: true
contentIncludes:
- old-room
- active-room
- archived
channelMembers:
- {"channel":"old-room","members":["Lead"]}

### Must
- Retain archived channel state for include-archived listings.
- Preserve archived channel membership for auditability.

### Must Not
- Permanently delete the archived channel record.

## channels.join-archived-channel-rejected
Executor: relay
Kind: regression
Tags: channels, archive, membership, errors
Human Review: false

### Message
A worker should not be able to join an archived channel.

### Mock
```json
{
  "agents": [
    { "name": "Lead", "type": "human" },
    { "name": "WorkerA", "type": "agent" }
  ],
  "channels": [
    { "name": "closed-room", "topic": "Done", "members": ["Lead"], "archived": true }
  ]
}
```

### Operations
```json
[
  { "op": "join_channel", "as": "WorkerA", "channel": "closed-room" }
]
```

### Deterministic Checks
ok: false
errorCode: channel_archived
forbidPhrases:
- WorkerA
channelMembers:
- {"channel":"closed-room","members":["Lead"]}

### Must
- Reject membership changes on archived channels.

### Must Not
- Reopen archived channels as a side effect of join.
