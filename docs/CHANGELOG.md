# Changelog

## 0.1.0

Initial public release.

- Local daemon + client protocol for low-latency agent messaging (Unix domain sockets).
- `agent-relay wrap` for intercepting `->relay:AgentName ...` and `[[RELAY]]...[[/RELAY]]` messages.
- Inbox utilities (`inbox-write`, `inbox-poll`, etc.) for file-based coordination in shared workspaces.
- Built-in demos/games (e.g., tic-tac-toe) to validate turn-based coordination.

