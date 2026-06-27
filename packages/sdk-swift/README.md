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

relaycast's Swift SDK lives in a subdirectory of the relaycast monorepo
(`packages/sdk-swift`), so it cannot be consumed as a plain git-URL SwiftPM
dependency on its own (git dependencies require `Package.swift` at the
repository root). A root-level manifest that vends the `Relaycast` library is
added to the relaycast monorepo (see
[AgentWorkforce/relaycast#208](https://github.com/AgentWorkforce/relaycast/pull/208)),
and this package depends on it via that repository's git URL:

```swift
.package(url: "https://github.com/AgentWorkforce/relaycast.git", from: "4.2.0")
```

The root manifest landed in relaycast#208 and was published as v4.2.0, so this
package depends on it by version.

## Quick start

```swift
import AgentRelaySDK

let relay = AgentRelayClient(apiKey: "rk_live_...", baseURL: URL(string: "https://relay.example.com")!)
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
  - Broker control & observability:
    - `listAgents()`
    - `sendInput(name:data:)`
    - `resizePty(name:rows:cols:)`
    - `flush(name:)`
    - `snapshot(name:format:)`
    - `sendMessage(to:text:from:threadId:workspaceId:workspaceAlias:priority:data:mode:)`
    - `setModel(name:model:timeoutMs:)`
    - `subscribeChannels(name:channels:)`
    - `unsubscribeChannels(name:channels:)`
    - `getStatus()`
    - `getMetrics(agent:)`
    - `getCrashInsights()`
    - `preflight(agents:)`
    - `renewLease()`
