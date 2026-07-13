// swift-tools-version: 5.9
import PackageDescription

// This package ships a single product, `AgentRelayBrokerSDK`: the local broker
// orchestration client. It talks to the broker's own `/ws` control stream and
// `/api/*` HTTP endpoints and has no external package dependencies.
//
// Hosted-workspace participation is no longer vended from here. Consumers who
// want to join a hosted Relaycast workspace from Swift should depend on
// relaycast's official Swift SDK directly (product `Relaycast`, from
// https://github.com/AgentWorkforce/relaycast.git).
//
let package = Package(
    name: "AgentRelayBrokerSDK",
    platforms: [
        .macOS(.v13),
        .iOS(.v16),
        .watchOS(.v9),
        .tvOS(.v16)
    ],
    products: [
        .library(name: "AgentRelayBrokerSDK", targets: ["AgentRelayBrokerSDK"])
    ],
    targets: [
        .target(
            name: "AgentRelayBrokerSDK",
            path: "Sources/AgentRelayBrokerSDK"
        ),
        .testTarget(
            name: "AgentRelayBrokerSDKTests",
            dependencies: ["AgentRelayBrokerSDK"],
            path: "Tests/AgentRelayBrokerSDKTests"
        )
    ]
)
