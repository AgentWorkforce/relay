// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "agent-relay",
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
    dependencies: [
        // Must mirror packages/sdk-swift/Package.swift: AgentRelaySDK imports
        // Relaycast, and consumers that depend on this repo by git URL resolve
        // THIS manifest, so the dependency has to be declared here too.
        .package(
            url: "https://github.com/AgentWorkforce/relaycast.git",
            from: "6.0.5"
        )
    ],
    targets: [
        .target(
            name: "AgentRelaySDK",
            dependencies: [
                .product(name: "Relaycast", package: "relaycast")
            ],
            path: "packages/sdk-swift/Sources/AgentRelaySDK"
        ),
        .target(
            name: "AgentRelayBrokerSDK",
            path: "packages/sdk-swift/Sources/AgentRelayBrokerSDK"
        ),
        .testTarget(
            name: "AgentRelaySDKTests",
            dependencies: ["AgentRelaySDK"],
            path: "packages/sdk-swift/Tests/AgentRelaySDKTests"
        ),
        .testTarget(
            name: "AgentRelayBrokerSDKTests",
            dependencies: ["AgentRelayBrokerSDK"],
            path: "packages/sdk-swift/Tests/AgentRelayBrokerSDKTests"
        )
    ]
)
