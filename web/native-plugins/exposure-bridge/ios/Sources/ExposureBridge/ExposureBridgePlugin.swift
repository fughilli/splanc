import AVFoundation
import Capacitor
import Foundation

// print() lands on the process stdout, which `devicectl process launch --console`
// streams back to the build server (tools/iosctl device-log), so these show up
// live while investigating exposure behaviour on a real device.
private func elog(_ s: String) {
    print("[exposure-bridge] \(s)")
}

/// Native camera-exposure bridge (docs/design/ios-support.md §4.6).
///
/// The capture path is `getUserMedia` + `MediaStreamTrack.applyConstraints`
/// (`web/src/xr/mediaStreamCapture.ts`). WebKit does NOT implement the
/// MediaStream Image-Capture exposure extensions (`exposureMode` /
/// `exposureTime` / `exposureCompensation` / `iso`), so on iOS the track reports
/// no exposure capabilities and the exposure slider + servo are no-ops — the
/// camera stays on continuous auto-exposure, which blows the LEDs out in the
/// dark (the very thing `exposureControl.ts` locks exposure DOWN to avoid).
///
/// The lever WebKit doesn't expose but AVFoundation does: exposure is a property
/// of the physical `AVCaptureDevice`, not of a capture session. WebKit's
/// `getUserMedia` opens the back **wide-angle** camera
/// (`AVCaptureDevice.default(.builtInWideAngleCamera, .video, .back)` — the only
/// device type its `AVVideoCaptureSource` uses), which is the same shared device
/// singleton this plugin configures. So locking exposure here with
/// `setExposureModeCustom(duration:iso:)` applies to the frames the WebView is
/// already rendering — no second capture session, no ownership of WebKit's.
///
/// Semantics mirror the web `planExposure`: `target` in [0,1] maps 0 = shortest
/// exposure (darkest, least LED bloom) → 1 = longest, ISO is pinned to the
/// sensor minimum to hold gain down, and `maxExposureMs` (the caller's Nyquist /
/// manual ceiling) caps the longest exposure so it can't integrate across a
/// pattern-frame hue transition. `net/../xr/nativeExposure.ts` binds it and
/// `MediaStreamCaptureSource.setExposure` routes here on iOS.
@objc(ExposureBridge)
public class ExposureBridge: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ExposureBridge"
    public let jsName = "ExposureBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "capabilities", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setExposure", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearExposure", returnType: CAPPluginReturnPromise)
    ]

    // Serialize device (re)configuration off the WebView's main thread; the
    // exposure servo/slider can retune several times a second.
    private let queue = DispatchQueue(label: "dev.splanc.exposure-bridge")

    /// The back wide-angle camera — the device WebKit's getUserMedia uses. Same
    /// singleton the WebView holds while capturing, so our config takes effect on
    /// its frames.
    private func backCamera() -> AVCaptureDevice? {
        if let d = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) {
            return d
        }
        // Fallback: first back-facing video device (older/edge hardware).
        let discovery = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.builtInWideAngleCamera],
            mediaType: .video,
            position: .back)
        return discovery.devices.first
    }

    private func clampD(_ x: Double, _ lo: Double, _ hi: Double) -> Double {
        return min(hi, max(lo, x))
    }

    @objc func capabilities(_ call: CAPPluginCall) {
        queue.async { [weak self] in
            guard let self = self, let device = self.backCamera() else {
                call.resolve(["supported": false, "reason": "no back camera"])
                return
            }
            let fmt = device.activeFormat
            let minMs = CMTimeGetSeconds(fmt.minExposureDuration) * 1000.0
            let maxMs = CMTimeGetSeconds(fmt.maxExposureDuration) * 1000.0
            let supported = device.isExposureModeSupported(.custom)
            call.resolve([
                "supported": supported,
                "minExposureMs": minMs,
                "maxExposureMs": maxMs,
                "minIso": Double(fmt.minISO),
                "maxIso": Double(fmt.maxISO)
            ])
        }
    }

    @objc func setExposure(_ call: CAPPluginCall) {
        let target = call.getDouble("target") ?? 0
        // maxExposureMs is optional (the Nyquist / manual-override ceiling). When
        // absent, the whole device range up to activeFormat.maxExposureDuration is
        // available.
        let maxExposureMs = call.getDouble("maxExposureMs")

        queue.async { [weak self] in
            guard let self = self, let device = self.backCamera() else {
                call.resolve(["applied": false, "description": "no back camera"])
                return
            }
            guard device.isExposureModeSupported(.custom) else {
                call.resolve(["applied": false, "description": "custom exposure unsupported"])
                return
            }
            let fmt = device.activeFormat
            let minSec = CMTimeGetSeconds(fmt.minExposureDuration)
            let maxSec = CMTimeGetSeconds(fmt.maxExposureDuration)
            // hi = longest exposure this target may reach, capped by the caller's
            // ceiling but never below the sensor's own minimum (mirrors planExposure).
            var hiSec = maxSec
            if let capMs = maxExposureMs {
                hiSec = max(minSec, min(hiSec, capMs / 1000.0))
            }
            let t = self.clampD(target, 0, 1)
            let durSec = minSec + t * (hiSec - minSec)
            let iso = Float(self.clampD(Double(fmt.minISO), Double(fmt.minISO), Double(fmt.maxISO)))
            let duration = CMTimeMakeWithSeconds(durSec, preferredTimescale: 1_000_000)

            do {
                try device.lockForConfiguration()
            } catch {
                call.resolve(["applied": false,
                              "description": "lock failed: \(error.localizedDescription)"])
                return
            }
            device.setExposureModeCustom(duration: duration, iso: iso) { _ in
                // Completion fires once the setting is in effect on the sensor.
                call.resolve([
                    "applied": true,
                    "description": String(format: "manual exposure %.1fms, iso %.0f",
                                          durSec * 1000.0, Double(iso)),
                    "exposureMs": durSec * 1000.0,
                    "iso": Double(iso)
                ])
            }
            device.unlockForConfiguration()
        }
    }

    @objc func clearExposure(_ call: CAPPluginCall) {
        queue.async { [weak self] in
            guard let self = self, let device = self.backCamera() else {
                call.resolve()
                return
            }
            guard device.isExposureModeSupported(.continuousAutoExposure) else {
                call.resolve()
                return
            }
            do {
                try device.lockForConfiguration()
                device.exposureMode = .continuousAutoExposure
                device.unlockForConfiguration()
            } catch {
                elog("clearExposure lock failed: \(error.localizedDescription)")
            }
            call.resolve()
        }
    }
}
