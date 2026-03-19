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
        .library(name: "AgentRelaySDK", targets: ["AgentRelaySDK"])
    ],
    targets: [
        .target(
            name: "AgentRelaySDK",
            path: "Sources/AgentRelaySDK"
        ),
        .testTarget(
            name: "AgentRelaySDKTests",
            dependencies: ["AgentRelaySDK"],
            path: "Tests/AgentRelaySDKTests"
        )
    ]
)
