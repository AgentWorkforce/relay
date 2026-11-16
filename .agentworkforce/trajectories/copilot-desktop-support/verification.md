# Copilot desktop support — 2026-11-15

GitHub Copilot desktop 1.4.2 uses a GitHub-signed Tauri host and a GitHub-signed cached SDK runtime in server/stdio mode, holding the same native session descriptors as VS Code's Copilot harness. Relay now accepts that verified ancestry while retaining exact chat inode, hook executable, UID and process-incarnation checks. Source-less CLI sessions remain outside the route.

The desktop app reuses the existing Copilot MCP, inbox, final-answer and history paths. Relay Desktop detects the new host; RelayHistory's existing native journal parser captures it. The combined core branch also includes the reviewed stop-hook startup anchor recovery from PR #2198.

Verification: 55 targeted core Copilot tests passed, plus the explicit read-only installed GitHub Copilot desktop runtime proof. Relay Desktop's Copilot suite passed 120 tests before moving the shared core pin. RelayHistory's eight conformance tests passed; private local acquisition retained every native user/assistant message ID across 15 sessions, 187 messages, 63 tool calls and 1,499 markers. No private transcript entered the repository. Installed services were not replaced or stopped. Packaged send/reply/upload verification remains pending a reviewed app build.

Code review, security and secrets checks passed through Veto. Core PR #2199 and RelayHistory PR #589 remain draft; main and releases require the user's approval.
