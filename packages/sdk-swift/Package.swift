// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "AgentRelaySDK",
    platforms: [
        .macOS(.v13),
        .iOS(.v16),
        .watchOS(.v9),
        .tvOS(.v16)
    ],
    products: [
        .library(name: "AgentRelaySDK", targets: ["AgentRelaySDK"]),
        .library(name: "AgentRelayBrokerSDK", targets: ["AgentRelayBrokerSDK"])
    ],
    targets: [
        .target(
            name: "AgentRelaySDK",
            path: "Sources/AgentRelaySDK"
        ),
        .target(
            name: "AgentRelayBrokerSDK",
            path: "Sources/AgentRelayBrokerSDK"
        ),
        .testTarget(
            name: "AgentRelaySDKTests",
            dependencies: ["AgentRelaySDK"],
            path: "Tests/AgentRelaySDKTests"
        ),
        .testTarget(
            name: "AgentRelayBrokerSDKTests",
            dependencies: ["AgentRelayBrokerSDK"],
            path: "Tests/AgentRelayBrokerSDKTests"
        )
    ]
)
