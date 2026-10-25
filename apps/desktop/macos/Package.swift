// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "RelayDesktop",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(name: "RelayDesktop", targets: ["RelayDesktop"]),
        .library(name: "RelayDesktopCore", targets: ["RelayDesktopCore"])
    ],
    dependencies: [.package(path: "../shared/RelaySessionOverview")],
    targets: [
        .target(
            name: "RelayDesktopCore",
            path: "Sources/RelayDesktopCore"
        ),
        .executableTarget(
            name: "RelayDesktop",
            dependencies: ["RelayDesktopCore", .product(name: "RelaySessionOverview", package: "RelaySessionOverview")],
            path: "Sources/RelayDesktop",
            resources: [.process("Resources")]
        ),
        .testTarget(
            name: "RelayDesktopTests",
            dependencies: ["RelayDesktopCore", "RelayDesktop"],
            path: "Tests/RelayDesktopTests"
        )
    ]
)
