// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "RelaySessionOverview",
    platforms: [.iOS(.v17), .macOS(.v13)],
    products: [.library(name: "RelaySessionOverview", targets: ["RelaySessionOverview"])],
    targets: [
        .target(name: "RelaySessionOverview"),
        .testTarget(name: "RelaySessionOverviewTests", dependencies: ["RelaySessionOverview"])
    ]
)
