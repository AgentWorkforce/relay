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
        .library(name: "AgentRelaySDK", targets: ["AgentRelaySDK"])
    ],
    targets: [
        .target(
            name: "AgentRelaySDK",
            path: "packages/sdk-swift/Sources/AgentRelaySDK"
        ),
        .testTarget(
            name: "AgentRelaySDKTests",
            dependencies: ["AgentRelaySDK"],
            path: "packages/sdk-swift/Tests/AgentRelaySDKTests"
        )
    ]
)
