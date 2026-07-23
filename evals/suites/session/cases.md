# Session Cases

These cases pin the SDK session harness helpers that let agents define reusable
in-process harnesses, normalize identities, read baseline capabilities, and
resume continuity without a live broker.

## session.define-harness-registerable-agent

Executor: relay
Kind: capability
Tags: session, harness
Human Review: false

### Message

Define a review harness and create a registerable session agent with explicit input.

### Mock

```json
{
  "agents": []
}
```

### Operations

```json
[{ "op": "define_harness", "name": "review-bot", "version": "1.0.0", "input": { "name": "reviewer" } }]
```

### Deterministic Checks

ok: true
contentIncludes:

- "kind": "session"
- "name": "reviewer"
- "harness:review-bot:reviewer"
  toolCallsInclude:
- define_harness
  minToolCalls: 1

### Must

- Produce a session-kind agent handle without requiring a driver or broker.
- Preserve the harness config and the caller-provided input.

### Must Not

- Drop listener predicate builders from the created agent handle.

## session.next-harness-name-increments

Executor: relay
Kind: regression
Tags: session, harness, naming
Human Review: false

### Message

Generate default harness names repeatedly from the same base.

### Mock

```json
{}
```

### Operations

```json
[
  { "op": "next_harness_name", "base": "task-bot" },
  { "op": "next_harness_name", "base": "task-bot" },
  { "op": "next_harness_name", "base": "task-bot" }
]
```

### Deterministic Checks

ok: true
contentIncludes:

- task-bot
- task-bot-2
- task-bot-3
  toolCallsInclude:
- next_harness_name
  minToolCalls: 3

### Must

- Keep the first generated name equal to the base.
- Add numeric suffixes for later names from the same base.

### Must Not

- Reuse the same default name within one run.

## session.explicit-harness-name-wins

Executor: relay
Kind: regression
Tags: session, harness, naming
Human Review: false

### Message

Generate a harness name with an explicit override.

### Mock

```json
{}
```

### Operations

```json
[{ "op": "next_harness_name", "base": "task-bot", "explicit": "named-reviewer" }]
```

### Deterministic Checks

ok: true
contentIncludes:

- named-reviewer
  must:
- Return the explicit name unchanged.
  mustNot:
- Append a numeric suffix when an explicit name is provided.

### Must

- Treat explicit harness input names as authoritative.

### Must Not

- Mutate the explicit string.

## session.normalize-identity-default-handle

Executor: relay
Kind: capability
Tags: session, identity
Human Review: false

### Message

Normalize an identity with spaces and metadata but no explicit handle.

### Mock

```json
{}
```

### Operations

```json
[
  {
    "op": "normalize_identity",
    "input": {
      "name": "Review Bot",
      "displayName": "Review Bot",
      "description": "reviews code",
      "metadata": { "team": "evals" }
    }
  }
]
```

### Deterministic Checks

ok: true
contentIncludes:

- "@Review-Bot"
- "displayName": "Review Bot"
- "team": "evals"
  toolCallsInclude:
- normalize_identity

### Must

- Derive a sigiled handle from the name when no handle is provided.
- Preserve optional display name, description, and metadata fields.

### Must Not

- Emit an empty id or handle.

## session.normalize-identity-preserves-explicit-handle

Executor: relay
Kind: regression
Tags: session, identity
Human Review: false

### Message

Normalize an identity that already has an id and handle.

### Mock

```json
{}
```

### Operations

```json
[
  {
    "op": "normalize_identity",
    "input": {
      "id": "agent_reviewer",
      "name": "reviewer",
      "handle": "@reviewer"
    }
  }
]
```

### Deterministic Checks

ok: true
contentIncludes:

- "id": "agent_reviewer"
- "handle": "@reviewer"
  must:
- Preserve the explicit id and handle.
  mustNot:
- Reformat a valid explicit handle.

### Must

- Prefer provided identity fields over generated defaults.

### Must Not

- Strip the `@` sigil from an explicit handle.

## session.format-handle-trims-and-sigils

Executor: relay
Kind: regression
Tags: session, identity, handle
Human Review: false

### Message

Format handles from plain names, already-sigiled names, and whitespace-only names.

### Mock

```json
{}
```

### Operations

```json
[
  { "op": "format_handle", "name": " qa bot " },
  { "op": "format_handle", "name": "@ready" },
  { "op": "format_handle", "name": "   " }
]
```

### Deterministic Checks

ok: true
contentIncludes:

- "@qa-bot"
- "@ready"
- "@agent"
  toolCallsInclude:
- format_handle
  minToolCalls: 3

### Must

- Replace internal whitespace with hyphens.
- Leave already-sigiled handles unchanged.
- Fall back to `@agent` for blank input.

### Must Not

- Return a handle without an `@` sigil.

## session.read-minimal-capabilities

Executor: relay
Kind: capability
Tags: session, capabilities
Human Review: false

### Message

Read the SDK minimal session capabilities contract.

### Mock

```json
{}
```

### Operations

```json
[{ "op": "read_capabilities" }]
```

### Deterministic Checks

ok: true
contentIncludes:

- "receive": true
- "modes": [
- "immediate"
- "emits": [
- "status.changed"
- "release": true
  toolCallsInclude:
- read_capabilities

### Must

- Expose the baseline receive, immediate delivery, status event, and release lifecycle capabilities.

### Must Not

- Claim unsupported lifecycle capabilities such as pause or fork in the minimal profile.

## session.resume-session-emits-continuity

Executor: relay
Kind: capability
Tags: session, resume, continuity
Human Review: false

### Message

Resume a previously known session and surface the continuity event.

### Mock

```json
{
  "agents": [{ "name": "reviewer", "type": "agent", "id": "agent_reviewer", "status": "offline" }]
}
```

### Operations

```json
[
  {
    "op": "resume_session",
    "agent": { "id": "agent_reviewer", "name": "reviewer", "handle": "@reviewer" },
    "reason": "executor restart",
    "capabilities": { "lifecycle": { "resume": true } }
  }
]
```

### Deterministic Checks

ok: true
eventEmitted:

- session.resumed
  contentIncludes:
- agent_reviewer
- executor restart
  toolCallsInclude:
- resume_session

### Must

- Preserve the resumed agent identity.
- Emit a `session.resumed` event with the supplied reason.

### Must Not

- Treat resume as a fresh unnamed session.
