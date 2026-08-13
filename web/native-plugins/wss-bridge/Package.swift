// swift-tools-version: 5.9
import PackageDescription

// Local Capacitor plugin — Capacitor's `cap sync` discovers it via the
// `capacitor.ios.src` field in package.json (it's a file: dependency of web/)
// and adds this package to the app's CapApp-SPM graph, exactly like the
// community BLE plugin. See docs/design/ios-support.md §4.3.
// The package + product name MUST be Capacitor's PascalCase derivation of the npm
// package name (@splanc/wss-bridge → SplancWssBridge): `cap sync` wires CapApp-SPM
// to `.product(name: "SplancWssBridge", package: "SplancWssBridge")`. The target
// name and the JS plugin name ("WssBridge") are independent of this.
let package = Package(
    name: "SplancWssBridge",
    platforms: [.iOS(.v15)],
    products: [
        .library(name: "SplancWssBridge", targets: ["SplancWssBridge"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        .target(
            name: "SplancWssBridge",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "ios/Sources/WssBridge")
    ]
)
