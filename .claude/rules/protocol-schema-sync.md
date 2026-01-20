---
paths:
  - "relay-pty/src/protocol.rs"
  - "relay-pty/src/parser.rs"
  - "src/protocol/**/*.ts"
  - "docs/schemas/*.json"
---

# Protocol Schema Synchronization

## Critical: Keep All Protocol Definitions In Sync

When modifying relay-pty protocol types, you MUST update ALL corresponding schemas:

| Source of Truth | Must Update |
|-----------------|-------------|
| `relay-pty/src/protocol.rs` | TypeScript schemas + JSON schemas |
| `relay-pty/src/parser.rs` (headers) | All file format schemas |

## Files That Must Stay Synchronized

### 1. Rust Protocol Types (Source of Truth)
- `relay-pty/src/protocol.rs` - `ParsedRelayCommand`, `InjectRequest`, `InjectResponse`, `SyncMeta`
- `relay-pty/src/parser.rs` - Header parsing (`TO:`, `KIND:`, `AWAIT:`, etc.)

### 2. TypeScript Schemas
- `src/protocol/relay-pty-schemas.ts` - TypeScript interfaces matching Rust types

### 3. JSON Schemas (Documentation)
- `docs/schemas/parsed-relay-command.schema.json` - ParsedRelayCommand
- `docs/schemas/relay-file-format.schema.json` - File header format
- `docs/schemas/inject-request.schema.json` - InjectRequest
- `docs/schemas/inject-response.schema.json` - InjectResponse

## When Adding New Fields

1. **Add to Rust first** (`protocol.rs` or `parser.rs`)
2. **Update TypeScript** (`relay-pty-schemas.ts`)
3. **Update JSON schemas** (all relevant files in `docs/schemas/`)
4. **Add tests** for new fields

## Example: Adding a New Header

If adding a new header like `PRIORITY:`:

```rust
// 1. parser.rs - Add to parse_header_format()
"PRIORITY" => msg.priority = value.parse().ok(),

// 2. protocol.rs - Add to RelayMessage and ParsedRelayCommand
pub priority: Option<i32>,
```

```typescript
// 3. relay-pty-schemas.ts - Add to interfaces
PRIORITY?: string;  // RelayFileFormat
priority?: number;  // ParsedRelayCommand
```

```json
// 4. relay-file-format.schema.json
"PRIORITY": {
  "type": "string",
  "description": "Message priority (lower = higher priority)"
}

// 5. parsed-relay-command.schema.json
"priority": {
  "type": "integer",
  "description": "Message priority level"
}
```

## Checklist Before Committing Protocol Changes

- [ ] Rust types updated (`protocol.rs`)
- [ ] Rust parser updated if adding headers (`parser.rs`)
- [ ] TypeScript interfaces updated (`relay-pty-schemas.ts`)
- [ ] JSON schemas updated (`docs/schemas/*.json`)
- [ ] Rust tests added/updated
- [ ] TypeScript tests pass
- [ ] Examples added to JSON schemas
