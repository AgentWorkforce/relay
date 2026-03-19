# AgentRelaySDK

Native Swift SDK for the Agent Relay broker.

## Installation

Add the package in Swift Package Manager:

```swift
.package(url: "https://github.com/AgentWorkforce/relay.git", branch: "feature/swift-sdk")
```

Then depend on `AgentRelaySDK`.

## Quick start

```swift
import AgentRelaySDK

let relay = RelayCast(apiKey: "rk_live_...")
let channel = relay.channel("wf-my-workflow")
try await channel.subscribe()
try await channel.post("Hello from Swift")

for await event in channel.events {
    print("\(event.from): \(event.body)")
}
```

## API

- `RelayCast(apiKey:baseURL:)`
- `channel(_:) -> Channel`
- `registerOrRotate(name:)`
- `AgentRegistration.asClient()`
- `AgentClient.post(to:message:)`
- `AgentClient.dm(to:message:)`
