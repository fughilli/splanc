# Building & running Splanc on iOS

This is the _how-to_ for the iOS wrapper scaffolded under FUG-92. For the _why_
(what iOS can/can't do, Tier 0 PWA vs. Tier 1 Capacitor, non-goals) see
[`docs/design/ios-support.md`](design/ios-support.md).

## The shape of it

Splanc's iOS app is a **Capacitor** WKWebView wrapper around the existing
`web/dist` bundle — the same code the PWA ships. The only native pieces are the
capabilities WebKit lacks; the first one built is **BLE Improv provisioning**
(`net/capacitorImprov.ts`).

Xcode, CocoaPods and the iOS Simulator run **only on the macOS host** — the dev
container can't touch them. So, exactly like `tools/flash_server.py` for
firmware, a small host-side server runs the Xcode/Capacitor steps and the
container drives it over HTTP.

```text
  ┌─────────────── container ───────────────┐        ┌────────── macOS host ──────────┐
  │ edit web/src, capacitor.config.ts, …     │        │ python3 tools/ios_build_server │
  │ tools/iosctl rebuild  ───────────────────┼──HTTP──▶ pnpm build → cap sync →        │
  │ (curl host.docker.internal:8099)         │        │   xcodebuild / simulator       │
  └──────────────────────────────────────────┘        └────────────────────────────────┘
```

Both sides share the one repo checkout (the container's `/workspace` is the same
directory the host builds in), so a file edited in the container is what the host
compiles.

## One-time host setup

On the **Mac** (needs Node + pnpm, Xcode, and CocoaPods — `sudo gem install
cocoapods` or `brew install cocoapods`):

```sh
# in the repo checkout, on the host:
python3 tools/ios_build_server.py            # binds 0.0.0.0:8099
#   or:  bazel run //tools:ios_build_server
```

Leave it running. It only ever runs a fixed allowlist of tasks against this repo
(see `/tasks`), never an arbitrary command.

> If `pnpm install` reports ignored build scripts, run `pnpm approve-builds`
> once on the host (the build tasks themselves skip pnpm's pre-run deps check).

## Driving it from the container

`tools/iosctl` is a thin curl wrapper. It reads `IOS_BUILD_SERVER` (default
`host.docker.internal:8099`) and, if the server was started with `--token`,
`IOS_BUILD_TOKEN`.

```sh
tools/iosctl doctor                 # what's installed on the host + project state
tools/iosctl bootstrap              # ONE-TIME: deps + generate the native project
tools/iosctl rebuild                # web build → cap sync → xcodebuild (simulator)
tools/iosctl launch --sim "iPhone 15"   # build + boot it in the Simulator
tools/iosctl open                   # open the project in Xcode on the host
tools/iosctl run cap-sync,ios-build      # run specific task(s), in order
```

### Deploy to a paired iPhone in one command

When you just want the app compiled and running on your phone, skip `iosctl` and
use the single Bazel target (it auto-detects the paired device):

```sh
bazel run //tools:ios_deploy              # compile → install → launch
bazel run //tools:ios_deploy -- --log     # …and stream the device console (Ctrl-C to detach)
```

**On the Mac this is fully self-contained** — if no build server is running, it
starts `tools/ios_build_server.py` as a **sidecar**, drives it, and shuts it down
when it's done. You don't need the separate "leave the server running" step above.

**From the container** it stays a thin client and talks to the build server on
`host.docker.internal:8099` (start `bazel run //tools:ios_build_server` on the
Mac first, as usual) — the container never starts a sidecar, since it has no
Xcode toolchain.

Which path it takes is auto-detected; override with `--sidecar auto|always|never`.
Setting `$IOS_BUILD_SERVER` points it at a specific running server and skips the
sidecar. With no `--target`, it picks the single connected/Wi-Fi-paired iPhone
(`xcrun xctrace list devices`); pass `--target <UDID>` or set `$IOS_DEPLOY_TARGET`
when more than one device is attached. `--log` swaps the final launch for a
console-attached relaunch so the app's stdout/stderr + forwarded JS console
stream back live. The iPhone must be awake + unlocked during install.

Everything streams the underlying tool's output live (`curl -N`), and a non-zero
exit stops a chain.

### Ship to TestFlight in one command

Same client/server split, one more Bazel target — it builds the app, archives an
App-Store-signed build, exports the `.ipa`, and uploads it to App Store Connect /
TestFlight:

```sh
bazel run //tools:ios_testflight                    # build → archive → export → upload
bazel run //tools:ios_testflight -- --build-number 231
```

On the **Mac** (or a macOS CI runner) it starts the build server as a sidecar and
tears it down after; **from the container** it drives a server running on the Mac,
exactly like `ios_deploy`. It runs the `testflight-prebuilt` chain (`cap-sync →
tf-build-number → tf-signing-prep → tf-archive → tf-export → tf-upload`).

**Credentials** are read from the **build server's environment** — never passed in
the request, so no secret is ever in a URL or the streamed log. Set them where the
server runs (your shell/launchd on the Mac; the GitHub Actions `env:` in CI). They
are the **same names** the TestFlight job in
[`.github/workflows/macos.yaml`](../.github/workflows/macos.yaml) uses, so one set
of secrets serves both the local target and the CI action:

| Env var                           | What                                                                                                            |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `APP_STORE_CONNECT_KEY_ID`        | App Store Connect API key — Key ID                                                                              |
| `APP_STORE_CONNECT_ISSUER_ID`     | …its Issuer ID                                                                                                  |
| `APP_STORE_CONNECT_KEY_P8_BASE64` | base64 of the `AuthKey_<KeyID>.p8` (or `…_PATH`, or leave it in `~/.private_keys/`)                             |
| `APPLE_TEAM_ID`                   | 10-char Developer Team ID (else `SPLANC_IOS_TEAM` / the `ios-config` default)                                   |
| `APPLE_DIST_CERT_P12_BASE64`      | base64 "Apple Distribution" `.p12` — **optional**, only where the keychain has no dist cert (a fresh CI runner) |
| `APPLE_DIST_CERT_PASSWORD`        | …the `.p12` export password                                                                                     |
| `IOS_BUILD_NUMBER`                | `CFBundleVersion` for the upload (unique + increasing per build); default = epoch seconds                       |

A dev Mac that already ships device builds has a distribution cert in its login
keychain, so the two `APPLE_DIST_CERT_*` vars are only needed on a clean machine.
One-time Apple-side setup (membership, register the `dev.splanc.app` App ID, create
the App Store Connect app record, mint the API key) is described in the workflow
header. The container/`iosctl` path uses the same tasks via the `testflight` chain
(with `web-build`): `tools/iosctl run testflight`.

### The tasks (`/tasks`)

| Task              | Runs                                                              |
| ----------------- | ----------------------------------------------------------------- |
| `install`         | `pnpm install` — pull the Capacitor deps                          |
| `web-build`       | `pnpm --dir web build` → `web/dist` (the WKWebView payload)       |
| `cap-add-ios`     | `cap add ios` — **one-time**, generates `web/ios/App`             |
| `ios-config`      | apply `web/ios-config/apply.sh` (Info.plist usage strings)        |
| `cap-sync`        | `cap sync ios` — copy `web/dist` + install plugin pods            |
| `pod-install`     | `pod install` in `web/ios/App`                                    |
| `ios-build`       | `xcodebuild build` for the simulator                              |
| `ios-run`         | `cap run ios` — build + launch on a simulator/device              |
| `open-xcode`      | `cap open ios` — open in Xcode                                    |
| `list-sims`       | list bootable simulators                                          |
| `tf-build-number` | stamp `CFBundleVersion` (`$IOS_BUILD_NUMBER`, else epoch)         |
| `tf-signing-prep` | place the ASC API key (+ optional dist `.p12`) for signing/upload |
| `tf-archive`      | `xcodebuild archive` — App-Store-signed (automatic signing)       |
| `tf-export`       | `xcodebuild -exportArchive` → `build/export/*.ipa`                |
| `tf-upload`       | `xcrun altool --upload-app` → App Store Connect / TestFlight      |

Chains: `bootstrap` = install → web-build → cap-add-ios → ios-config → cap-sync →
pod-install; `rebuild` = web-build → cap-sync → ios-build; `launch` = web-build →
cap-sync → ios-run; `testflight` = web-build → cap-sync → tf-build-number →
tf-signing-prep → tf-archive → tf-export → tf-upload (`testflight-prebuilt` drops
`web-build`, for `bazel run //tools:ios_testflight`).

Params: `--sim NAME`, `--configuration Debug|Release`, `--scheme App`.

## What's committed vs. generated

- **Committed:** `web/capacitor.config.ts`, `web/ios-config/` (the hand-maintained
  native config, re-applied by `ios-config`), the TS seams
  (`net/native.ts`, `net/capacitorImprov.ts`), the build server + `iosctl`.
- **Generated, gitignored (`web/ios/`):** the whole native Xcode project. Recreate
  it any time with `tools/iosctl bootstrap`. Never hand-edit it — put durable
  native changes in `web/ios-config/` so they survive a regenerate.

## Verifying the BLE seam without a Mac

The pure Improv codec and the `provisionViaBle` state machine are unit-tested and
transport-agnostic (`bazel test //web:improv_test //web:improv_provision_test`).
`net/capacitorImprov.ts` only adapts the Capacitor BLE plugin to that seam, so the
web build and tests stay green with no native toolchain — the plugin is loaded via
a lazy dynamic import that only fires inside the native wrapper
(`isNativePlatform()`).

## Not yet built (follow-ups from the design doc)

- **Native cert-pinning WebSocket bridge** (§4.3) — removes the manual
  self-signed-cert accept; drops in behind `SocketFactory` in `net/client.ts`.
- **OTA firmware update** (§4.3 / firmware track) — the only "program the device
  from an iPhone" path, since USB flashing is impossible on iOS (§3.1).
- **Android wrapper** (§4.5). _(TestFlight distribution is built — `bazel run
//tools:ios_testflight` and the `testflight` job in `.github/workflows/macos.yaml`.)_
