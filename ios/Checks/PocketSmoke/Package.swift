// swift-tools-version: 6.0
import PackageDescription
let package = Package(name: "PocketSmoke", platforms: [.macOS(.v15)], dependencies: [.package(path: "../../.build/FluidAudio")], targets: [.executableTarget(name: "PocketSmoke", dependencies: [.product(name: "FluidAudio", package: "FluidAudio")])])
