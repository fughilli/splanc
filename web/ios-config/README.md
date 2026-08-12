# `web/ios-config/` — hand-maintained iOS native config

The Capacitor native project (`web/ios/`) is **generated** by `cap add ios` on the
macOS host and is **not** committed (see `web/.gitignore`). Anything we hand-edit
in the native project would be lost on a regenerate, so the source of truth for
those edits lives here instead and is re-applied to the fresh project.

## `apply.sh`

Idempotently sets the `Info.plist` permission usage strings via `PlistBuddy`:

| Key                                                                           | Why                                                                    |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `NSCameraUsageDescription`                                                    | mapping capture pipeline (`getUserMedia` → WebGL2 detector → solver)   |
| `NSMotionUsageDescription`                                                    | `DeviceMotion`/IMU pose fusion during mapping (`xr/imu.ts`)            |
| `NSBluetoothAlwaysUsageDescription` / `NSBluetoothPeripheralUsageDescription` | native Improv BLE provisioning (`net/capacitorImprov.ts`)              |
| `NSLocalNetworkUsageDescription`                                              | reaching the device's `wss://` control plane on the LAN (iOS 14+ gate) |

Run automatically as the `ios-config` step of the `bootstrap` chain, right after
`cap add ios`. To re-apply by hand on the host:

```sh
bash web/ios-config/apply.sh
```

App Store review **requires** each requested permission to carry a specific,
truthful usage string — a missing or generic one is a common rejection. Edit the
strings here, not in the generated `Info.plist`.
