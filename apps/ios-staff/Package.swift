// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "KunlunStaffCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "KunlunStaffCore", targets: ["KunlunStaffCore"])],
    targets: [
        .target(name: "KunlunStaffCore", path: "Core"),
        .testTarget(name: "KunlunStaffCoreTests", dependencies: ["KunlunStaffCore"], path: "Tests")
    ]
)
