# Action Errors Cases

Action error cases verify the SDK's typed action errors and error-code mapping for registration, lookup, input validation, and output validation.

## action-errors.duplicate-registration-error

Executor: relay
Kind: regression
Tags: actions, errors, registration
Human Review: false

### Message

Registering the same normalized action name twice should throw ActionRegistrationError.

### Mock

```json
{
  "agents": [{ "name": "builder", "type": "agent" }]
}
```

### Operations

```json
[
  { "op": "register_action", "as": "builder", "name": "echo", "handlerFixture": "echo_text" },
  { "op": "register_action", "as": "builder", "name": " echo ", "handlerFixture": "echo_text" }
]
```

### Deterministic Checks

ok: false
errorCode: action_registration_error
contentIncludes:

- action_registration_error
  must:
- Normalize names before duplicate detection.
- Surface error code `action_registration_error`.
  mustNot:
- Register two actions that differ only by whitespace.

## action-errors.empty-name-registration-error

Executor: relay
Kind: regression
Tags: actions, errors, registration
Human Review: false

### Message

An empty action name should be rejected during registration.

### Mock

```json
{
  "agents": [{ "name": "builder", "type": "agent" }]
}
```

### Operations

```json
[{ "op": "register_action", "as": "builder", "name": "   ", "handlerFixture": "echo_text" }]
```

### Deterministic Checks

ok: false
errorCode: action_registration_error
contentIncludes:

- action_registration_error
  must:
- Trim the action name before checking for presence.
  mustNot:
- Register a blank action descriptor.

## action-errors.execute-missing-action-throws-not-found

Executor: relay
Kind: regression
Tags: actions, errors, not-found
Human Review: false

### Message

Executing a missing action should map to ActionNotFoundError.

### Mock

```json
{
  "agents": [{ "name": "planner", "type": "agent" }],
  "actionInvokeMode": "execute"
}
```

### Operations

```json
[
  {
    "op": "invoke_action",
    "as": "planner",
    "name": "missing",
    "input": { "text": "nope" },
    "mode": "execute"
  }
]
```

### Deterministic Checks

ok: false
errorCode: action_not_found
contentIncludes:

- action_not_found
  must:
- Throw ActionNotFoundError for execute-style lookup failures.
  mustNot:
- Treat a missing action as a successful no-op.

## action-errors.invoke-missing-action-result

Executor: relay
Kind: capability
Tags: actions, errors, result
Human Review: false

### Message

Invoking a missing action through invoke_action should return a structured action_not_found result.

### Mock

```json
{
  "agents": [{ "name": "planner", "type": "agent" }]
}
```

### Operations

```json
[{ "op": "invoke_action", "as": "planner", "name": "missing", "input": { "text": "nope" } }]
```

### Deterministic Checks

ok: true
contentIncludes:

- action_not_found
- Unknown action: missing
  must:
- Return ok false inside the action result without throwing from invoke.
  mustNot:
- Emit action.invoked for an unknown action.

## action-errors.invalid-input-validation-error

Executor: relay
Kind: regression
Tags: actions, errors, validation
Human Review: false

### Message

Execute-style invocation with invalid input should map to ActionValidationError for the input phase.

### Mock

```json
{
  "agents": [
    { "name": "builder", "type": "agent" },
    { "name": "planner", "type": "agent" }
  ]
}
```

### Operations

```json
[
  {
    "op": "register_action",
    "as": "builder",
    "name": "needs-name",
    "handlerFixture": "echo_text",
    "inputSchema": {
      "type": "object",
      "required": ["name"],
      "properties": { "name": { "type": "string" } }
    }
  },
  { "op": "invoke_action", "as": "planner", "name": "needs-name", "input": {}, "mode": "execute" }
]
```

### Deterministic Checks

ok: false
errorCode: action_validation_error
contentIncludes:

- input
- action_validation_error
  must:
- Throw ActionValidationError with phase input.
- Preserve the validation issue path.
  mustNot:
- Call the handler when input validation fails.

## action-errors.invalid-output-validation-error

Executor: relay
Kind: regression
Tags: actions, errors, validation, output
Human Review: false

### Message

Execute-style invocation with invalid output should map to ActionValidationError for the output phase.

### Mock

```json
{
  "agents": [
    { "name": "builder", "type": "agent" },
    { "name": "planner", "type": "agent" }
  ]
}
```

### Operations

```json
[
  {
    "op": "register_action",
    "as": "builder",
    "name": "bad-output",
    "handlerFixture": "invalid_output",
    "outputSchema": {
      "type": "object",
      "required": ["ok"],
      "properties": { "ok": { "type": "boolean" } }
    }
  },
  { "op": "invoke_action", "as": "planner", "name": "bad-output", "input": {}, "mode": "execute" }
]
```

### Deterministic Checks

ok: false
errorCode: action_validation_error
contentIncludes:

- output
- action_validation_error
  must:
- Throw ActionValidationError with phase output.
- Include output validation details.
  mustNot:
- Return invalid handler output as a successful execute result.

## action-errors.validation-message-limits-issues

Executor: relay
Kind: capability
Tags: actions, errors, validation-message
Human Review: false

### Message

ActionValidationError messages should summarize validation issues deterministically.

### Mock

```json
{
  "agents": [
    { "name": "builder", "type": "agent" },
    { "name": "planner", "type": "agent" }
  ]
}
```

### Operations

```json
[
  {
    "op": "register_action",
    "as": "builder",
    "name": "strict",
    "handlerFixture": "echo_text",
    "inputSchema": {
      "type": "object",
      "required": ["a", "b", "c", "d"],
      "additionalProperties": false,
      "properties": {
        "a": { "type": "string" },
        "b": { "type": "string" },
        "c": { "type": "string" },
        "d": { "type": "string" }
      }
    }
  },
  { "op": "invoke_action", "as": "planner", "name": "strict", "input": {}, "mode": "execute" }
]
```

### Deterministic Checks

ok: false
errorCode: action_validation_error
contentIncludes:

- action_validation_error
  must:
- Produce a deterministic ActionValidationError message from validation issues.
- Include at least the first three issue paths.
  mustNot:
- Emit a success event for invalid input.
