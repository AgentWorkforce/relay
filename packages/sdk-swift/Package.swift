// swift-tools-version: 5.9
import PackageDescription

// The hosted-participant transport (`AgentRelaySDK`) is a thin facade over the
// relaycast Swift engine SDK (product `Relaycast`).
//
// relaycast's Swift SDK lives in a subdirectory of the relaycast monorepo
// (`packages/sdk-swift`), so it cannot be consumed as a plain git-URL SwiftPM
// dependency on its own (git dependencies require `Package.swift` at the
// repository root). A root-level manifest that vends the `Relaycast` library is
// added in the relaycast monorepo (see AgentWorkforce/relaycast#208); this
// package depends on it via that repository's git URL.
//
// The dependency is pinned to a specific revision of the `swift-root-package`
// branch until that PR is merged and the monorepo is re-tagged. Once a tag that
// includes the root manifest is published, replace `revision:` with
// `from: "x.y.z"`:
//
//     .package(url: "https://github.com/AgentWorkforce/relaycast.git", from: "4.1.7")
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
            revision: "24c9140824518bf371a6c09f8be1f2a298efaf56"
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
