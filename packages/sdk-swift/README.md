# Agent Relay Swift SDK

Native Swift SDK package with two library products:

- `AgentRelaySDK` — hosted workspace participant client. Registers agent
  identities with Relaycast, posts channel messages, sends DMs, consumes
  `/v1/ws` events, and registers relay-routed actions.
- `AgentRelayBrokerSDK` — local broker orchestration client. Talks to the
  broker `/ws` control stream and `/api/*` HTTP endpoints for spawn/release,
  worker streams, delivery events, and broker monitoring.

## Installation

Add the package in Swift Package Manager:

```swift
.package(url: "https://github.com/AgentWorkforce/relay.git", revision: "0a2c878748dc34af8b617c8da5ce70af447dfa37")
```

> Temporary until the SDK is released under a stable tag.

Then depend on either `AgentRelaySDK` or `AgentRelayBrokerSDK`.

### `AgentRelaySDK` wraps the relaycast engine SDK

`AgentRelaySDK`'s hosted transport is a thin facade over the published relaycast
Swift engine SDK (product `Relaycast`, package `relaycast-swift`, which lives in
the relaycast monorepo under `packages/sdk-swift`). All HTTP and realtime
WebSocket work is delegated to relaycast; `AgentRelaySDK` keeps only the
relay-specific glue (action-dispatch loop, `RelayChannelEvent` shape, and the
`AsyncStream`-based public API).

Because relaycast-swift is not at its repository root, SwiftPM cannot consume it
by git URL directly, and its directory basename (`sdk-swift`) collides with this
package's own identity. The dependency is therefore wired through a committed
symlink (`packages/sdk-swift/.relaycast-swift`) that points at a sibling clone of
the relaycast monorepo:

```
.relaycast-swift -> ../../../relaycast/packages/sdk-swift
```

To use a relaycast checkout in a different location, repoint that symlink:

```sh
ln -sfn /path/to/relaycast/packages/sdk-swift packages/sdk-swift/.relaycast-swift
```

Once a root-level mirror/tag of relaycast-swift is published, replace the path
dependency in `Package.swift` with a git/registry reference, e.g.
`.package(url: "https://github.com/AgentWorkforce/relaycast-swift.git", from: "4.1.6")`
(matching a relaycast monorepo tag such as `v4.1.6`).

## Quick start

```swift
import AgentRelaySDK

let relay = AgentRelayClient(apiKey: "rk_live_...")
let registration = try await relay.registerOrRotate(name: "swift-agent")
let agent = registration.asClient()

let channel = agent.channel("general")
try await channel.subscribe()
try await channel.post("Hello from Swift")

for await event in channel.events {
    print("\(event.from): \(event.body)")
}
```

Broker orchestration tools should import the broker product instead:

```swift
import AgentRelayBrokerSDK

let broker = AgentRelayBrokerClient(apiKey: "local")
try await broker.spawnAgent(AgentSpec(name: "worker", runtime: .headless, provider: .claude))
```

## API

- `AgentRelaySDK`
  - `AgentRelayClient(apiKey:baseURL:)` / `AgentRelay(workspaceKey:baseURL:)`
  - `registerOrRotate(name:type:)`
  - `AgentRegistration.asClient()`
  - `AgentClient.channel(_:)`
  - `AgentClient.post(to:message:)`
  - `AgentClient.dm(to:message:)`
  - `AgentClient.events`
  - `AgentClient.inboundMessages`
  - `AgentClient.registerAction(name:description:inputSchemaJSON:handler:)`
- `AgentRelayBrokerSDK`
  - `AgentRelayBrokerClient(apiKey:baseURL:)`
  - `channel(_:)`
  - `spawnAgent(_:initialTask:skipRelayPrompt:)`
  - `releaseAgent(name:reason:)`
  - `registerOrRotate(name:)`
  - `brokerEvents`
  - `inboundMessages`
