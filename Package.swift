// swift-tools-version: 5.9
import PackageDescription

// Root manifest so consumers can depend on this repo by git URL (git
// dependencies require a `Package.swift` at the repository root). It vends the
// same `AgentRelayBrokerSDK` product as `packages/sdk-swift/Package.swift`,
// pointed at the sources under that subdirectory.
let package = Package(
    name: "agent-relay",
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
            path: "packages/sdk-swift/Sources/AgentRelayBrokerSDK"
        ),
        .testTarget(
            name: "AgentRelayBrokerSDKTests",
            dependencies: ["AgentRelayBrokerSDK"],
            path: "packages/sdk-swift/Tests/AgentRelayBrokerSDKTests"
        )
    ]
)
