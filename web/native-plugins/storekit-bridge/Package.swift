// swift-tools-version: 5.9
import PackageDescription

// Local Capacitor plugin — Capacitor's `cap sync` discovers it via the
// `capacitor.ios.src` field in package.json (it's a link: dependency of web/)
// and adds this package to the app's CapApp-SPM graph, like @splanc/web-auth.
// The package + product name MUST be Capacitor's PascalCase derivation of the npm
// package name (@splanc/storekit-bridge → SplancStorekitBridge). The JS plugin
// name is "StoreKitBridge". See docs/design/ai-billing.md (§Purchases, Apple).
let package = Package(
    name: "SplancStorekitBridge",
    platforms: [.iOS(.v15)],
    products: [
        .library(name: "SplancStorekitBridge", targets: ["SplancStorekitBridge"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        .target(
            name: "SplancStorekitBridge",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "ios/Sources/StoreKitBridge")
    ]
)
