# Action Schema Cases
Action schema cases verify JSON-schema-lite validation and actionSchemaToJsonSchema descriptor behavior for valid inputs, invalid inputs, coercion-like fixtures, required fields, and additional property boundaries.

## action-schema.valid-object-input
Executor: relay
Kind: regression
Tags: schema, valid, actions
Human Review: false

### Message
A valid object input should satisfy the registered JSON-schema-lite input contract.

### Mock
```json
{
  "agents": [
    { "name": "schema-bot", "type": "agent" },
    { "name": "planner", "type": "agent" }
  ]
}
```

### Operations
```json
[
  {
    "op": "register_action",
    "as": "schema-bot",
    "name": "echo",
    "handlerFixture": "echo_text",
    "inputSchema": {
      "type": "object",
      "required": ["text"],
      "additionalProperties": false,
      "properties": { "text": { "type": "string", "minLength": 1 } }
    }
  },
  { "op": "invoke_action", "as": "planner", "name": "echo", "input": { "text": "schema ok" } }
]
```

### Deterministic Checks
ok: true
contentIncludes:
- schema ok
- echoed
eventEmitted:
- action.completed
must:
- Accept an object containing the required non-empty string field.
mustNot:
- Report invalid_input for valid input.

## action-schema.missing-required-field
Executor: relay
Kind: regression
Tags: schema, required, invalid
Human Review: false

### Message
Missing required input fields should fail validation before the handler runs.

### Mock
```json
{
  "agents": [
    { "name": "schema-bot", "type": "agent" },
    { "name": "planner", "type": "agent" }
  ]
}
```

### Operations
```json
[
  {
    "op": "register_action",
    "as": "schema-bot",
    "name": "needs-text",
    "handlerFixture": "echo_text",
    "inputSchema": {
      "type": "object",
      "required": ["text"],
      "properties": { "text": { "type": "string" } }
    }
  },
  { "op": "invoke_action", "as": "planner", "name": "needs-text", "input": {} }
]
```

### Deterministic Checks
ok: true
contentIncludes:
- invalid_input
- $.text
- required property is missing
eventEmitted:
- action.failed
must:
- Reject missing required fields with an invalid_input result.
- Avoid invoking the handler after input validation fails.
mustNot:
- Return echoed output for invalid input.

## action-schema.additional-properties-rejected
Executor: relay
Kind: regression
Tags: schema, additional-properties, invalid
Human Review: false

### Message
additionalProperties false should reject unknown input keys.

### Mock
```json
{
  "agents": [
    { "name": "schema-bot", "type": "agent" },
    { "name": "planner", "type": "agent" }
  ]
}
```

### Operations
```json
[
  {
    "op": "register_action",
    "as": "schema-bot",
    "name": "strict-echo",
    "handlerFixture": "echo_text",
    "inputSchema": {
      "type": "object",
      "required": ["text"],
      "additionalProperties": false,
      "properties": { "text": { "type": "string" } }
    }
  },
  { "op": "invoke_action", "as": "planner", "name": "strict-echo", "input": { "text": "ok", "extra": true } }
]
```

### Deterministic Checks
ok: true
contentIncludes:
- invalid_input
- $.extra
- additional property is not allowed
eventEmitted:
- action.failed
must:
- Report the unknown property path in validation output.
mustNot:
- Silently strip unknown fields and run the handler.

## action-schema.array-items-and-min-items
Executor: relay
Kind: capability
Tags: schema, array, invalid
Human Review: false

### Message
Array item schemas and minItems constraints should both be enforced.

### Mock
```json
{
  "agents": [
    { "name": "schema-bot", "type": "agent" },
    { "name": "planner", "type": "agent" }
  ]
}
```

### Operations
```json
[
  {
    "op": "register_action",
    "as": "schema-bot",
    "name": "tag-echo",
    "handlerFixture": "echo_text",
    "inputSchema": {
      "type": "object",
      "required": ["text", "tags"],
      "properties": {
        "text": { "type": "string" },
        "tags": { "type": "array", "minItems": 2, "items": { "type": "string" } }
      }
    }
  },
  { "op": "invoke_action", "as": "planner", "name": "tag-echo", "input": { "text": "tags", "tags": ["ok", 3] } }
]
```

### Deterministic Checks
ok: true
contentIncludes:
- invalid_input
- $.tags[1]
- expected string
must:
- Validate every array element against the item schema.
mustNot:
- Accept non-string tag elements.

## action-schema.enum-and-const-valid
Executor: relay
Kind: capability
Tags: schema, enum, const
Human Review: false

### Message
Enum and const constraints should accept matching literal values.

### Mock
```json
{
  "agents": [
    { "name": "schema-bot", "type": "agent" },
    { "name": "planner", "type": "agent" }
  ]
}
```

### Operations
```json
[
  {
    "op": "register_action",
    "as": "schema-bot",
    "name": "literal-echo",
    "handlerFixture": "echo_text",
    "inputSchema": {
      "type": "object",
      "required": ["text", "kind", "state"],
      "properties": {
        "text": { "type": "string" },
        "kind": { "const": "review" },
        "state": { "enum": ["open", "closed"] }
      }
    }
  },
  { "op": "invoke_action", "as": "planner", "name": "literal-echo", "input": { "text": "literal", "kind": "review", "state": "open" } }
]
```

### Deterministic Checks
ok: true
contentIncludes:
- literal
- echoed
must:
- Accept matching const and enum values.
mustNot:
- Treat literal constraints as unsupported schema keywords.

## action-schema.one-of-rejects-zero-matches
Executor: relay
Kind: regression
Tags: schema, oneOf, invalid
Human Review: false

### Message
oneOf should reject values that match none of the supplied schemas.

### Mock
```json
{
  "agents": [
    { "name": "schema-bot", "type": "agent" },
    { "name": "planner", "type": "agent" }
  ]
}
```

### Operations
```json
[
  {
    "op": "register_action",
    "as": "schema-bot",
    "name": "one-of",
    "handlerFixture": "echo_text",
    "inputSchema": {
      "oneOf": [
        {
          "type": "object",
          "required": ["kind", "text"],
          "properties": { "kind": { "const": "ok" }, "text": { "type": "string" } }
        },
        {
          "type": "object",
          "required": ["kind", "text"],
          "properties": { "kind": { "enum": ["error"] }, "text": { "type": "string" } }
        }
      ]
    }
  },
  { "op": "invoke_action", "as": "planner", "name": "one-of", "input": { "kind": "other", "text": "x" } }
]
```

### Deterministic Checks
ok: true
contentIncludes:
- invalid_input
- oneOf
- matched 0
must:
- Report that the value matched zero oneOf schemas.
mustNot:
- Fall through to the handler when oneOf fails.

## action-schema.output-schema-invalid
Executor: relay
Kind: regression
Tags: schema, output, invalid
Human Review: false

### Message
Invalid handler output should be validated and returned as invalid_output.

### Mock
```json
{
  "agents": [
    { "name": "schema-bot", "type": "agent" },
    { "name": "planner", "type": "agent" }
  ]
}
```

### Operations
```json
[
  {
    "op": "register_action",
    "as": "schema-bot",
    "name": "bad-output",
    "handlerFixture": "invalid_output",
    "outputSchema": {
      "type": "object",
      "required": ["ok"],
      "properties": { "ok": { "type": "boolean" } }
    }
  },
  { "op": "invoke_action", "as": "planner", "name": "bad-output", "input": { "text": "ignored" } }
]
```

### Deterministic Checks
ok: true
contentIncludes:
- invalid_output
- $.ok
- required property is missing
eventEmitted:
- action.failed
must:
- Validate handler output against outputSchema.
- Return ok false with invalid_output.
mustNot:
- Emit action.completed for invalid output.

## action-schema.schema-descriptor-passthrough
Executor: relay
Kind: capability
Tags: schema, descriptor, json-schema
Human Review: false

### Message
JSON-schema-lite objects should pass through as action descriptor schemas.

### Mock
```json
{
  "agents": [{ "name": "schema-bot", "type": "agent" }]
}
```

### Operations
```json
[
  {
    "op": "register_action",
    "as": "schema-bot",
    "name": "described",
    "description": "Descriptor schema check",
    "handlerFixture": "echo_text",
    "inputSchema": {
      "type": "object",
      "title": "EchoInput",
      "required": ["text"],
      "properties": { "text": { "type": "string", "description": "Text to echo" } }
    }
  }
]
```

### Deterministic Checks
ok: true
contentIncludes:
- EchoInput
- Text to echo
- described
must:
- Preserve JSON-schema-lite object fields on the registered descriptor.
mustNot:
- Replace an object schema with an empty permissive schema.

## action-schema.zod-like-coercion-fixture
Executor: relay
Kind: capability
Tags: schema, coercion, zod-like
Human Review: false

### Message
A zod-like fixture should parse input before the handler sees it.

### Mock
```json
{
  "agents": [
    { "name": "schema-bot", "type": "agent" },
    { "name": "planner", "type": "agent" }
  ]
}
```

### Operations
```json
[
  {
    "op": "register_action",
    "as": "schema-bot",
    "name": "coerce-count",
    "handlerFixture": "sum_numbers",
    "inputSchemaFixture": "coerce_string_count"
  },
  { "op": "invoke_action", "as": "planner", "name": "coerce-count", "input": { "a": "20", "b": "22" } }
]
```

### Deterministic Checks
ok: true
contentIncludes:
- 42
eventEmitted:
- action.completed
must:
- Pass parsed numeric values to the handler after zod-like safeParse succeeds.
mustNot:
- Validate the raw string values as JSON numbers before coercion.
