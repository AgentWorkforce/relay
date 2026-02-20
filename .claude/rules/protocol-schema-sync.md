---
paths:
  - 'relay-pty/src/protocol.rs'
  - 'relay-pty/src/parser.rs'
  - 'packages/sdk/src/protocol.ts'
---

# Protocol Schema Synchronization

## Critical: Keep Rust and TypeScript Protocol Definitions In Sync

When modifying relay-pty protocol types, you MUST update the corresponding TypeScript types.

| Source of Truth                     | Must Update                    |
| ----------------------------------- | ------------------------------ |
| `relay-pty/src/protocol.rs`         | `packages/sdk/src/protocol.ts` |
| `relay-pty/src/parser.rs` (headers) | SDK protocol types             |

## Files That Must Stay Synchronized

### 1. Rust Protocol Types (Source of Truth)

- `relay-pty/src/protocol.rs` - `ParsedRelayCommand`, `InjectRequest`, `InjectResponse`, `SyncMeta`
- `relay-pty/src/parser.rs` - Header parsing (`TO:`, `KIND:`, `AWAIT:`, etc.)

### 2. TypeScript SDK Protocol

- `packages/sdk/src/protocol.ts` - TypeScript interfaces matching Rust types

## When Adding New Fields

1. **Add to Rust first** (`protocol.rs` or `parser.rs`)
2. **Update TypeScript SDK** (`packages/sdk/src/protocol.ts`)
3. **Add tests** for new fields in both languages

## Checklist Before Committing Protocol Changes

- [ ] Rust types updated (`protocol.rs`)
- [ ] Rust parser updated if adding headers (`parser.rs`)
- [ ] TypeScript SDK protocol updated (`packages/sdk/src/protocol.ts`)
- [ ] Rust tests added/updated
- [ ] TypeScript tests pass
