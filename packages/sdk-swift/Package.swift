// swift-tools-version: 5.9
import PackageDescription
import Foundation

// The hosted-participant transport (`AgentRelaySDK`) is a thin facade over the
// published relaycast Swift engine SDK (product `Relaycast`, package
// `relaycast-swift`).
//
// relaycast-swift lives in a subdirectory of the relaycast monorepo
// (`packages/sdk-swift`), so SwiftPM cannot consume it directly via a git URL
// (git dependencies require `Package.swift` at the repository root). Until a
// root-level mirror/tag is published, this package references relaycast-swift by
// a local checkout. To build against a published version instead, replace the
// `.package(...)` entry below with a git/registry reference whose root is the
// relaycast Swift package, e.g.:
//
//     .package(url: "https://github.com/AgentWorkforce/relaycast-swift.git", from: "4.1.6")
//
// (matching one of the relaycast monorepo tags, e.g. v4.1.6).
//
// Local-checkout details:
//   * The relaycast Swift package directory is named `sdk-swift` — the same
//     basename as THIS package. SwiftPM derives a path dependency's identity
//     from that basename, so referencing it directly collides with this
//     package's own identity. To avoid the collision we depend on the relaycast
//     package through the uniquely named symlink committed alongside this
//     manifest: `.relaycast-swift`. It points (relative) at a sibling clone of
//     the relaycast monorepo:
//         .relaycast-swift -> ../../../relaycast/packages/sdk-swift
//   * To point at a checkout in a different location, repoint that symlink, e.g.
//         ln -sfn /path/to/relaycast/packages/sdk-swift \
//             packages/sdk-swift/.relaycast-swift
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
        .package(name: "relaycast-swift", path: ".relaycast-swift")
    ],
    targets: [
        .target(
            name: "AgentRelaySDK",
            dependencies: [
                .product(name: "Relaycast", package: "relaycast-swift")
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
