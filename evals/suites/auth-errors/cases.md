# Auth Error Cases

These cases pin invalid Relaycast agent-token detection and recovery messaging
so MCP and SDK callers can recover from stale agent credentials deterministically.

## auth-errors.detect-top-level-code

Executor: relay
Kind: capability
Tags: auth, errors
Human Review: false

### Message

Detect an invalid agent token from a top-level typed error code.

### Mock

```json
{}
```

### Operations

```json
[{ "op": "is_invalid_token_error", "error": { "code": "agent_token_invalid", "message": "whatever" } }]
```

### Deterministic Checks

ok: true
contentIncludes:

- true
  toolCallsInclude:
- is_invalid_token_error

### Must

- Prefer the structural typed code when present.

### Must Not

- Require the legacy message when the typed code is available.

## auth-errors.detect-code-case-insensitive

Executor: relay
Kind: regression
Tags: auth, errors
Human Review: false

### Message

Detect the invalid-token typed code regardless of case or surrounding whitespace.

### Mock

```json
{}
```

### Operations

```json
[{ "op": "is_invalid_token_error", "error": { "code": " AGENT_TOKEN_INVALID " } }]
```

### Deterministic Checks

ok: true
contentIncludes:

- true
  must:
- Normalize error codes before comparison.
  mustNot:
- Treat casing as significant.

### Must

- Trim and lowercase the code before matching.

### Must Not

- Miss uppercase agent token invalid codes.

## auth-errors.detect-legacy-status-message

Executor: relay
Kind: regression
Tags: auth, errors, legacy
Human Review: false

### Message

Detect the legacy invalid-token contract from a 401 status and canonical message.

### Mock

```json
{}
```

### Operations

```json
[{ "op": "is_invalid_token_error", "error": { "statusCode": 401, "message": "Invalid agent token" } }]
```

### Deterministic Checks

ok: true
contentIncludes:

- true

### Must

- Continue to recognize the legacy 401 plus canonical message pair.

### Must Not

- Require an error code for legacy Relaycast responses.

## auth-errors.detect-body-error-code

Executor: relay
Kind: capability
Tags: auth, errors, body
Human Review: false

### Message

Detect an invalid-token code nested inside a body.error envelope.

### Mock

```json
{}
```

### Operations

```json
[
  {
    "op": "is_invalid_token_error",
    "error": {
      "status": 401,
      "message": "Unauthorized",
      "body": { "error": { "code": "agent_token_invalid", "message": "ignored" } }
    }
  }
]
```

### Deterministic Checks

ok: true
contentIncludes:

- true

### Must

- Inspect nested `body.error.code` values.

### Must Not

- Depend on the top-level error message when a body code is present.

## auth-errors.detect-cause-chain

Executor: relay
Kind: regression
Tags: auth, errors, cause
Human Review: false

### Message

Detect an invalid token marker nested in an error cause chain.

### Mock

```json
{}
```

### Operations

```json
[
  {
    "op": "is_invalid_token_error",
    "error": {
      "message": "upstream call failed",
      "cause": { "statusCode": 401, "message": "Invalid agent token" }
    }
  }
]
```

### Deterministic Checks

ok: true
contentIncludes:

- true
  must:
- Walk nested cause objects until a marker is found.
  mustNot:
- Stop at the first non-matching wrapper error.

### Must

- Recognize invalid-token errors wrapped by upstream failure errors.

### Must Not

- Treat the wrapper message as authoritative when a cause is available.

## auth-errors.ignore-non-token-unauthorized

Executor: relay
Kind: regression
Tags: auth, errors, false-positive
Human Review: false

### Message

Reject a generic unauthorized error that is not the invalid agent token contract.

### Mock

```json
{}
```

### Operations

```json
[{ "op": "is_invalid_token_error", "error": { "statusCode": 401, "message": "Unauthorized" } }]
```

### Deterministic Checks

ok: true
contentIncludes:

- false
  must:
- Distinguish generic auth failures from stale agent-token failures.
  mustNot:
- Include agent_token_invalid

### Must

- Return false for 401 errors without the canonical invalid-token message or code.

### Must Not

- Clear tokens for unrelated unauthorized errors.

## auth-errors.detect-tool-result-content

Executor: relay
Kind: capability
Tags: auth, tool-results
Human Review: false

### Message

Detect an invalid-token marker inside a tool result content array.

### Mock

```json
{}
```

### Operations

```json
[
  {
    "op": "is_invalid_token_tool_result",
    "result": {
      "content": [
        { "type": "text", "text": "noise" },
        { "type": "text", "text": "Invalid agent token" }
      ]
    }
  }
]
```

### Deterministic Checks

ok: true
contentIncludes:

- true
  toolCallsInclude:
- is_invalid_token_tool_result

### Must

- Search all text entries in a tool result content array.

### Must Not

- Require the tool result to set `isError`.

## auth-errors.ignore-tool-result-without-marker

Executor: relay
Kind: regression
Tags: auth, tool-results, false-positive
Human Review: false

### Message

Reject a tool result whose content does not include the invalid-token marker.

### Mock

```json
{}
```

### Operations

```json
[
  {
    "op": "is_invalid_token_tool_result",
    "result": {
      "content": [{ "type": "text", "text": "all good" }]
    }
  }
]
```

### Deterministic Checks

ok: true
contentIncludes:

- false
  must:
- Return false when no text content equals the canonical marker.
  mustNot:
- Include agent_token_invalid

### Must

- Avoid false positives on ordinary text tool results.

### Must Not

- Treat any text error as an invalid agent token.

## auth-errors.recovery-message-guidance

Executor: relay
Kind: capability
Tags: auth, recovery
Human Review: false

### Message

Build the user-facing recovery message for a stale agent token.

### Mock

```json
{}
```

### Operations

```json
[{ "op": "token_recovery_message" }]
```

### Deterministic Checks

ok: true
contentIncludes:

- agent_token_invalid
- selected Relaycast agent token is no longer valid
- stale token was cleared
- register_agent
  toolCallsInclude:
- token_recovery_message

### Must

- Tell the caller that the stale token was cleared.
- Name the `register_agent` tool as the recovery action.

### Must Not

- Ask the caller to retry with the same stale token.
