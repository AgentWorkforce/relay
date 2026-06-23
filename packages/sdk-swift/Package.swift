// swift-tools-version: 5.9
import PackageDescription

// The hosted-participant transport (`AgentRelaySDK`) is a thin facade over the
// relaycast Swift engine SDK (product `Relaycast`).
//
// relaycast's Swift SDK lives in a subdirectory of the relaycast monorepo
// (`packages/sdk-swift`), so it cannot be consumed as a plain git-URL SwiftPM
// dependency on its own (git dependencies require `Package.swift` at the
// repository root). A root-level manifest vending the `Relaycast` library was
// added in the relaycast monorepo (AgentWorkforce/relaycast#208) and published
// as v4.2.0; this package depends on it via that repository's git URL.
//
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
    dependencies: [
        .package(
            url: "https://github.com/AgentWorkforce/relaycast.git",
            from: "4.2.0"
        )
    ],
    targets: [
        .target(
            name: "AgentRelaySDK",
            dependencies: [
                .product(name: "Relaycast", package: "relaycast")
            ],
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
