// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "KunlunCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "KunlunCore", targets: ["KunlunCore"])],
    targets: [
        .target(name: "KunlunCore", path: "Core"),
        .testTarget(name: "KunlunCoreTests", dependencies: ["KunlunCore"], path: "Tests", resources: [.copy("Fixtures")])
    ]
)
