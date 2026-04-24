# @agent-relay/broker-linux-x64

Prebuilt `agent-relay-broker` binary for **Linux x86_64**. The broker is
compiled with `musl` static linking so it works on both glibc and musl hosts.

This package is installed automatically as an optional dependency of
[`@agent-relay/sdk`](https://www.npmjs.com/package/@agent-relay/sdk). You do
not need to depend on it directly. The SDK resolves the correct platform
binary at runtime via `require.resolve`.

See the [agent-relay repository](https://github.com/AgentWorkforce/relay) for
source and build tooling.
