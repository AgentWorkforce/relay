# Agent Relay Swift SDK

Native Swift SDK package with one library product:

- `AgentRelayBrokerSDK` — local broker orchestration client. Talks to the
  broker `/ws` control stream and `/api/*` HTTP endpoints for spawn/release,
  worker streams, delivery events, and broker monitoring.

## Installation

Add the package in Swift Package Manager:

```swift
.package(url: "https://github.com/AgentWorkforce/relay.git", revision: "0a2c878748dc34af8b617c8da5ce70af447dfa37")
```

> Temporary until the SDK is released under a stable tag.

Then depend on `AgentRelayBrokerSDK`:

```swift
import AgentRelayBrokerSDK

let broker = AgentRelayBrokerClient(apiKey: "local")
try await broker.spawnAgent(AgentSpec(name: "worker", runtime: .headless, provider: .claude))
```

## Hosted workspace participation

This package no longer ships the `AgentRelaySDK` product (the hosted
workspace-participant facade). relaycast's official Swift SDK already provides
the full hosted surface natively — channels, threads, inbox, deliveries, file
attachments, agents, nodes, triggers, webhooks, subscriptions, workspace admin,
and a typed per-event listener hub — so the wrapper was pure indirection.

Swift consumers who want to join a hosted Relaycast workspace should depend on
the `Relaycast` product directly:

```swift
.package(url: "https://github.com/AgentWorkforce/relaycast.git", from: "6.0.5")
```

Then use its native API instead of the old `AgentRelaySDK` wrapper types:

```swift
import Relaycast

// Was: AgentRelayClient / AgentRelay(...).registerOrRotate(...).asClient()
let relay = try await RelayCast.createWorkspace(name: "my-team")
let agent = relay.asAgent(token)

// Was: agent.channel("general") / channel.post(...)
let channel = try await agent.channels.create(name: "general")
try await channel.post("Hello from Swift")

// Was: agent.channelHistory / agent.dmHistory
let thread = try await agent.thread(messageId)
let inbox = try await agent.inbox()
```

See relaycast's Swift SDK documentation for the complete surface
(`AgentClient`, `RelayChannelsService`, `RelayAgentsService`,
`RelayNodesService`, `RelayTriggersService`, `RelayWebhooksService`,
`RelaySubscriptionsService`, `RelayWorkspaceService`, and
`RelaycastEventHandlers`).

## API

- `AgentRelayBrokerSDK`
  - `AgentRelayBrokerClient(apiKey:baseURL:)`
  - `channel(_:)`
  - `spawnAgent(_:initialTask:skipRelayPrompt:)`
  - `releaseAgent(name:reason:)`
  - `registerOrRotate(name:)`
  - `brokerEvents`
  - `inboundMessages`
