// swift-tools-version: 5.9
import PackageDescription

// Local Capacitor plugin — `cap sync` discovers it via the `capacitor.ios.src`
// field in package.json (a link: dependency of web/) and adds this package to the
// app's CapApp-SPM graph, exactly like @splanc/wss-bridge.
// The package + product name MUST be Capacitor's PascalCase derivation of the npm
// package name (@splanc/camera-bridge → SplancCameraBridge): `cap sync` wires
// CapApp-SPM to `.product(name: "SplancCameraBridge", package: "SplancCameraBridge")`.
// The target name and the JS plugin name ("CameraBridge") are independent of this.
let package = Package(
    name: "SplancCameraBridge",
    platforms: [.iOS(.v15)],
    products: [
        .library(name: "SplancCameraBridge", targets: ["SplancCameraBridge"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        .target(
            name: "SplancCameraBridge",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "ios/Sources/CameraBridge")
    ]
)
