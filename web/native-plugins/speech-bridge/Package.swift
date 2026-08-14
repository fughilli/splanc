// swift-tools-version: 5.9
import PackageDescription

// Local Capacitor plugin — Capacitor's `cap sync` discovers it via the
// `capacitor.ios.src` field in package.json (it's a link: dependency of web/)
// and adds this package to the app's CapApp-SPM graph, exactly like
// @splanc/wss-bridge. See docs/design/ios-support.md §4.4.
// The package + product name MUST be Capacitor's PascalCase derivation of the npm
// package name (@splanc/speech-bridge → SplancSpeechBridge): `cap sync` wires
// CapApp-SPM to `.product(name: "SplancSpeechBridge", package: "SplancSpeechBridge")`.
// The target name and the JS plugin name ("SpeechBridge") are independent of this.
let package = Package(
    name: "SplancSpeechBridge",
    platforms: [.iOS(.v15)],
    products: [
        .library(name: "SplancSpeechBridge", targets: ["SplancSpeechBridge"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        .target(
            name: "SplancSpeechBridge",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "ios/Sources/SpeechBridge")
    ]
)
