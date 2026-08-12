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

…and overwrites Capacitor's default app icon with the Splanc logo.

Run automatically as the `ios-config` step of the `bootstrap` chain, right after
`cap add ios`. To re-apply by hand on the host:

```sh
bash web/ios-config/apply.sh
```

## App icon (`AppIcon.svg` + `AppIcon-1024.png`)

`AppIcon.svg` is the PWA's `public/icons/app-icon.svg` with the baked corner
rounding removed (iOS applies its own rounded-corner mask, so the source is a full
square). `AppIcon-1024.png` is that SVG rendered at 1024×1024 — the single
universal size the asset catalog uses — and is what `apply.sh` copies into
`AppIcon.appiconset/AppIcon-512@2x.png`. Regenerate the PNG after editing the SVG:

```sh
npx -y -p @resvg/resvg-js node -e '
  const {Resvg}=require("@resvg/resvg-js"),fs=require("fs");
  const r=new Resvg(fs.readFileSync("web/ios-config/AppIcon.svg"),{fitTo:{mode:"width",value:1024}});
  fs.writeFileSync("web/ios-config/AppIcon-1024.png", r.render().asPng());'
```

App Store review **requires** each requested permission to carry a specific,
truthful usage string — a missing or generic one is a common rejection. Edit the
strings here, not in the generated `Info.plist`.
