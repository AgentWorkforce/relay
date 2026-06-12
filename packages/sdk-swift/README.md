# AgentRelaySDK

Native Swift SDK for `agent-relay-broker`. Talks to the broker over its `/ws`
event stream and `/api/*` HTTP endpoints.

## Installation

Add the package in Swift Package Manager:

```swift
.package(url: "https://github.com/AgentWorkforce/relay.git", revision: "0a2c878748dc34af8b617c8da5ce70af447dfa37")
```

> Temporary until the SDK is released under a stable tag.

Then depend on `AgentRelaySDK`.

## Quick start

```swift
import AgentRelaySDK

// Point at a local broker started with `agent-relay up` (defaults to
// http://localhost:3889) or pass `baseURL:` for a remote broker.
let client = AgentRelayClient(apiKey: "rk_live_...")
let channel = client.channel("wf-my-workflow")
try await channel.subscribe()
try await channel.post("Hello from Swift")

for await event in channel.events {
    print("\(event.from): \(event.body)")
}
```

## API

- `AgentRelayClient(apiKey:baseURL:)` — broker client
- `channel(_:) -> Channel`
- `spawnAgent(_:initialTask:skipRelayPrompt:)`
- `releaseAgent(name:reason:)`
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
- `registerOrRotate(name:)`
- `AgentRegistration.asClient()`
- `AgentClient.post(to:message:)`
- `AgentClient.dm(to:message:)`
