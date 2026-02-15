# Rust Conventions

This rule applies to all Rust files in `src/` and `tests/`.

## Error Handling

- Use `anyhow::Result` for application-level errors (CLI, main, tests)
- Use `thiserror` for library-level error types that callers match on
- Never `unwrap()` in production code — use `?` or handle explicitly
- Telemetry and logging must be infallible — silently ignore errors

## Logging

- Use `tracing` macros: `tracing::info!`, `tracing::warn!`, `tracing::error!`
- Use structured fields: `tracing::info!(agent = %name, "spawned")`
- Set log levels via `RUST_LOG` env var (uses `tracing-subscriber` with `env-filter`)

## Async

- All async code uses `tokio` runtime
- Prefer `tokio::select!` for concurrent operations
- Use `tokio::spawn` for background tasks that should not block the main loop
- Cancel safety: document whether async functions are cancel-safe

## Naming

- Modules: snake_case
- Types/Structs/Enums: PascalCase
- Functions/Methods: snake_case
- Constants: UPPER_SNAKE_CASE
- Enum variants: PascalCase

## Module Organization

- `lib.rs` re-exports public modules
- `main.rs` contains CLI entry point and runtime orchestration
- One concern per module (e.g., `auth.rs`, `dedup.rs`, `scheduler.rs`)

## Dependencies

- Minimize new dependencies — prefer what's already in `Cargo.toml`
- Use feature flags to keep binary size small
- Unix-only dependencies go under `[target.'cfg(unix)'.dependencies]`

## Testing

- Unit tests go in `#[cfg(test)] mod tests` within the source file
- Integration tests go in `tests/` directory
- Stress tests use `#[ignore]` attribute and run separately

## Serialization

- Use `serde` derive macros for JSON serialization
- Use `#[serde(rename_all = "snake_case")]` for enum variants
- Protocol types must match the TypeScript SDK definitions in `packages/sdk-ts/src/protocol.ts`
