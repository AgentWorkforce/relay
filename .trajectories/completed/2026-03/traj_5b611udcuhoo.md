# Trajectory: Fix broker flock conflict causing 'already running' errors on agent-relay up

> **Status:** ✅ Completed
> **Confidence:** 92%
> **Started:** March 9, 2026 at 09:25 PM
> **Completed:** March 9, 2026 at 09:27 PM

---

## Summary

Fixed broker flock conflict by probing ports before spawning (broker-lifecycle.ts), fixing SDK stderr race condition (client.ts), making isPortInUse injectable for testability (core.ts), and using connect-based probes for cross-platform reliability. Verified with unit tests (22/22) and live integration tests from the cloud repo.

**Approach:** Standard approach

---

## Key Decisions

### Root cause: startBrokerWithPortFallback spawned a new --persist broker per port retry attempt. Each spawned broker acquired a flock, and when it failed on port binding the flock/PID files remained stale, causing subsequent retries to hit 'already running' errors.
- **Chose:** Root cause: startBrokerWithPortFallback spawned a new --persist broker per port retry attempt. Each spawned broker acquired a flock, and when it failed on port binding the flock/PID files remained stale, causing subsequent retries to hit 'already running' errors.
- **Reasoning:** Traced through broker-lifecycle.ts spawn-and-retry loop, Rust flock acquisition in main.rs, and SDK exit vs close event race condition

### Probe ports before spawning instead of spawn-and-retry
- **Chose:** Probe ports before spawning instead of spawn-and-retry
- **Reasoning:** Eliminates both root causes at once: only one broker is ever spawned so no flock contention, and no need for retry-based error detection from stderr. User explicitly rejected timeout-based approaches as brittle.

### Use net.createConnection() connect probe instead of net.createServer().listen() bind probe for isPortInUse
- **Chose:** Use net.createConnection() connect probe instead of net.createServer().listen() bind probe for isPortInUse
- **Reasoning:** On macOS, net.createServer().listen() sets SO_REUSEADDR by default, allowing the probe to succeed even when another process holds the port. A connect() probe reliably detects listeners across macOS, Linux, and Windows.

### Make isPortInUse injectable via CoreDependencies
- **Chose:** Make isPortInUse injectable via CoreDependencies
- **Reasoning:** Port probing does real I/O which breaks unit tests (e.g. macOS AirPlay occupies port 5000). Adding it to the DI interface allows tests to mock it as always-free.

### Fix SDK exit vs close event race condition in client.ts
- **Chose:** Fix SDK exit vs close event race condition in client.ts
- **Reasoning:** child.once('exit') fires before stderr is fully consumed, so the 'failed to bind API on port' detail was missing from error messages. Switching to child.once('close') ensures all stdio streams end before building the error. This was a secondary root cause that masked the port conflict from the retry logic.

---

## Chapters

### 1. Work
*Agent: default*

- Root cause: startBrokerWithPortFallback spawned a new --persist broker per port retry attempt. Each spawned broker acquired a flock, and when it failed on port binding the flock/PID files remained stale, causing subsequent retries to hit 'already running' errors.: Root cause: startBrokerWithPortFallback spawned a new --persist broker per port retry attempt. Each spawned broker acquired a flock, and when it failed on port binding the flock/PID files remained stale, causing subsequent retries to hit 'already running' errors.
- Probe ports before spawning instead of spawn-and-retry: Probe ports before spawning instead of spawn-and-retry
- Use net.createConnection() connect probe instead of net.createServer().listen() bind probe for isPortInUse: Use net.createConnection() connect probe instead of net.createServer().listen() bind probe for isPortInUse
- Make isPortInUse injectable via CoreDependencies: Make isPortInUse injectable via CoreDependencies
- Fix SDK exit vs close event race condition in client.ts: Fix SDK exit vs close event race condition in client.ts
