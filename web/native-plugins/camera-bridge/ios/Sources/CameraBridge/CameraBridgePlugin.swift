import AVFoundation
import Capacitor
import Foundation
import UIKit
import WebKit

// print() lands on the process stdout, which `devicectl process launch --console`
// streams back (tools/iosctl log), so these show up live on a real device.
private func clog(_ s: String) {
    print("[camera-bridge] \(s)")
}

/// Native capture session for iOS (docs/design/ios-support.md §4.7).
///
/// The predecessor to this plugin (`@splanc/exposure-bridge`) tried to configure
/// the `AVCaptureDevice` that WebKit's `getUserMedia` was using. That cannot work:
/// `AVCaptureDevice` configuration is per-process and WebKit captures in its own
/// GPU process, so the writes landed on an object with no session behind them —
/// `exposureDuration` never moved and `setExposureModeCustom`'s completion handler
/// never fired (§4.6 records the measurements).
///
/// The fix is to stop asking WebKit for the camera and own the session outright.
/// Exposure is then an ordinary `setExposureModeCustom` on a device this process
/// is actually streaming, so it takes effect and the readback proves it.
///
/// This is phase 1+2 of §4.7: session, preview, and exposure — enough to confirm
/// exposure control works on-device. Frames do not yet reach the detector; that's
/// the threshold/downsample + sparse-transport stage, which lands next. While this
/// plugin holds the camera nothing may call `getUserMedia` — two capture clients
/// can't share it — so today only the checkpoint screen starts it.
@objc(CameraBridge)
public class CameraBridge: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CameraBridge"
    public let jsName = "CameraBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setExposure", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearExposure", returnType: CAPPluginReturnPromise)
    ]

    // Session setup/teardown blocks; keep them off the main thread (startRunning
    // in particular takes long enough to jank the UI).
    private let sessionQueue = DispatchQueue(label: "dev.splanc.camera-bridge")

    private var session: AVCaptureSession?
    private var device: AVCaptureDevice?
    private var previewView: PreviewView?
    // WKWebView paints an opaque background by default, which would hide the
    // preview layer sitting behind it. Remember what to put back on stop().
    private var webViewWasOpaque = true

    // MARK: - Lifecycle

    @objc func start(_ call: CAPPluginCall) {
        AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
            guard let self = self else { return }
            guard granted else {
                call.reject("camera permission denied")
                return
            }
            self.sessionQueue.async { self.configureAndStart(call) }
        }
    }

    private func configureAndStart(_ call: CAPPluginCall) {
        // Idempotent: a re-entered screen shouldn't build a second session.
        if let existing = session, let dev = device {
            clog("start: already running")
            call.resolve(info(dev, existing))
            return
        }
        guard let dev = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back)
        else {
            call.reject("no back camera")
            return
        }

        let sess = AVCaptureSession()
        sess.beginConfiguration()
        // Matches what the web path asked getUserMedia for, so the detector's
        // resolution assumptions carry over unchanged when frames land here.
        if sess.canSetSessionPreset(.hd1280x720) {
            sess.sessionPreset = .hd1280x720
        }
        do {
            let input = try AVCaptureDeviceInput(device: dev)
            guard sess.canAddInput(input) else {
                sess.commitConfiguration()
                call.reject("cannot add camera input")
                return
            }
            sess.addInput(input)
        } catch {
            sess.commitConfiguration()
            call.reject("camera input failed: \(error.localizedDescription)")
            return
        }
        sess.commitConfiguration()
        sess.startRunning()

        session = sess
        device = dev
        clog("started: \(describe(dev))")
        DispatchQueue.main.async { self.installPreview(sess) }
        call.resolve(info(dev, sess))
    }

    @objc func stop(_ call: CAPPluginCall) {
        sessionQueue.async { [weak self] in
            guard let self = self else { call.resolve(); return }
            self.session?.stopRunning()
            self.session = nil
            self.device = nil
            clog("stopped")
            DispatchQueue.main.async {
                self.removePreview()
                call.resolve()
            }
        }
    }

    // MARK: - Preview

    /// Put the preview layer *behind* the WebView and make the WebView see-through,
    /// so the web UI (slider, readout) composites over the live camera. The page
    /// must also drop its own background — see the checkpoint screen, which clears
    /// `body`'s while mounted.
    private func installPreview(_ sess: AVCaptureSession) {
        guard let web = bridge?.webView, let host = web.superview else {
            clog("installPreview: no webView superview — preview not shown")
            return
        }
        let pv = PreviewView(frame: host.bounds)
        pv.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        pv.previewLayer.session = sess
        pv.previewLayer.videoGravity = .resizeAspectFill
        if let conn = pv.previewLayer.connection, conn.isVideoOrientationSupported {
            conn.videoOrientation = .portrait
        }
        host.insertSubview(pv, belowSubview: web)

        webViewWasOpaque = web.isOpaque
        web.isOpaque = false
        web.backgroundColor = .clear
        web.scrollView.backgroundColor = .clear
        previewView = pv
        clog("preview installed: host=\(host.bounds.size) webViewWasOpaque=\(webViewWasOpaque) "
             + "— the PAGE must also be transparent (html AND body; the root element "
             + "paints the canvas) or this layer stays hidden behind it")
    }

    private func removePreview() {
        previewView?.removeFromSuperview()
        previewView = nil
        guard let web = bridge?.webView else { return }
        web.isOpaque = webViewWasOpaque
        web.backgroundColor = nil
        web.scrollView.backgroundColor = nil
    }

    // MARK: - Exposure

    @objc func setExposure(_ call: CAPPluginCall) {
        let target = call.getDouble("target") ?? 0
        // Optional Nyquist / manual-override ceiling on the longest exposure.
        let maxExposureMs = call.getDouble("maxExposureMs")

        sessionQueue.async { [weak self] in
            guard let self = self, let device = self.device else {
                call.resolve(["applied": false, "description": "camera not started"])
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
            // ceiling but never below the sensor's own minimum (mirrors planExposure
            // in web/src/xr/exposureControl.ts, so both platforms feel the same).
            var hiSec = maxSec
            if let capMs = maxExposureMs {
                hiSec = max(minSec, min(hiSec, capMs / 1000.0))
            }
            let t = min(1.0, max(0.0, target))
            // GEOMETRIC, matching planExposure in web/src/xr/exposureControl.ts:
            // equal slider travel = equal stops. A linear ramp over this sensor's
            // 0.02–250 ms range buries everything from well-exposed to black in
            // the bottom 1% of the control. Degenerate ranges keep the linear ramp.
            let durSec = (minSec > 0 && hiSec > minSec)
                ? minSec * pow(hiSec / minSec, t)
                : minSec + t * (hiSec - minSec)
            // Pin gain at the sensor minimum: raising ISO undoes the point of
            // shortening the exposure (holding the LEDs out of clipping).
            let iso = fmt.minISO
            let duration = CMTimeMakeWithSeconds(durSec, preferredTimescale: 1_000_000)

            do {
                try device.lockForConfiguration()
            } catch {
                clog("setExposure lock failed: \(error.localizedDescription)")
                call.resolve(["applied": false,
                              "description": "lock failed: \(error.localizedDescription)"])
                return
            }
            // We own the session, so this completion DOES fire (unlike the removed
            // exposure-bridge). Report `applied` from the readback regardless — a
            // value that didn't move is the signal that something is wrong, and
            // that's exactly the failure the old plugin hid.
            let once = ResolveOnce(call: call, wantSec: durSec)
            device.setExposureModeCustom(duration: duration, iso: iso) { _ in
                once.finish(device, describe: self.describe(device), via: "completion")
            }
            device.unlockForConfiguration()
            // Pure backstop against a permanently-pending promise (the old
            // exposure-bridge's failure mode). Now that we own the session the
            // completion is the authority and does fire, so keep this well clear of
            // a real retune — at 0.35s it was beating the sensor and reporting a
            // stale duration as applied=false while the setting landed moments later.
            self.sessionQueue.asyncAfter(deadline: .now() + 2.0) {
                once.finish(device, describe: self.describe(device), via: "timeout")
            }
        }
    }

    @objc func clearExposure(_ call: CAPPluginCall) {
        sessionQueue.async { [weak self] in
            guard let self = self, let device = self.device,
                  device.isExposureModeSupported(.continuousAutoExposure)
            else {
                call.resolve()
                return
            }
            do {
                try device.lockForConfiguration()
                device.exposureMode = .continuousAutoExposure
                device.unlockForConfiguration()
                clog("clearExposure → \(self.describe(device))")
            } catch {
                clog("clearExposure lock failed: \(error.localizedDescription)")
            }
            call.resolve()
        }
    }

    // MARK: - Introspection

    private func info(_ d: AVCaptureDevice, _ s: AVCaptureSession) -> [String: Any] {
        let fmt = d.activeFormat
        let dims = CMVideoFormatDescriptionGetDimensions(fmt.formatDescription)
        return [
            "width": Int(dims.width),
            "height": Int(dims.height),
            "minExposureMs": CMTimeGetSeconds(fmt.minExposureDuration) * 1000.0,
            "maxExposureMs": CMTimeGetSeconds(fmt.maxExposureDuration) * 1000.0,
            "minIso": Double(fmt.minISO),
            "maxIso": Double(fmt.maxISO),
            "customExposureSupported": d.isExposureModeSupported(.custom),
            "running": s.isRunning
        ]
    }

    fileprivate func describe(_ d: AVCaptureDevice) -> String {
        let modes: [AVCaptureDevice.ExposureMode: String] = [
            .locked: "locked", .autoExpose: "auto", .continuousAutoExposure: "continuousAuto",
            .custom: "custom"
        ]
        let dims = CMVideoFormatDescriptionGetDimensions(d.activeFormat.formatDescription)
        return String(format: "mode=%@ duration=%.2fms iso=%.0f fmt=%dx%d",
                      modes[d.exposureMode] ?? "?",
                      CMTimeGetSeconds(d.exposureDuration) * 1000.0,
                      Double(d.iso),
                      Int(dims.width), Int(dims.height))
    }
}

/// A view whose backing layer IS the preview layer, so it tracks bounds through
/// rotation and safe-area changes without a manual frame-sync.
private final class PreviewView: UIView {
    override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
    // swiftlint:disable:next force_cast
    var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
}

/// Resolves a `CAPPluginCall` exactly once, reporting whether the sensor ACTUALLY
/// took the setting rather than merely that we asked for it. Two racers can call
/// `finish` — setExposureModeCustom's completion and a watchdog — and either way
/// `applied` comes from reading the device back.
private final class ResolveOnce {
    private let call: CAPPluginCall
    private let wantSec: Double
    private let lock = NSLock()
    private var done = false

    init(call: CAPPluginCall, wantSec: Double) {
        self.call = call
        self.wantSec = wantSec
    }

    func finish(_ device: AVCaptureDevice, describe: String, via: String) {
        lock.lock()
        if done { lock.unlock(); return }
        done = true
        lock.unlock()

        let gotSec = CMTimeGetSeconds(device.exposureDuration)
        // Generous tolerance: the sensor quantises the duration to its own clock,
        // so we only need to tell "moved to roughly what we asked" from "never
        // moved at all".
        let tol = max(0.0005, wantSec * 0.25)
        let applied = device.exposureMode == .custom && abs(gotSec - wantSec) <= tol
        let desc = applied
            ? String(format: "manual exposure %.1fms, iso %.0f", gotSec * 1000.0, Double(device.iso))
            : String(format: "NOT applied — asked %.2fms, sensor reads %.2fms",
                     wantSec * 1000.0, gotSec * 1000.0)
        clog("setExposure resolve via \(via): applied=\(applied) | \(describe)")
        call.resolve([
            "applied": applied,
            "description": desc,
            "exposureMs": gotSec * 1000.0,
            "iso": Double(device.iso)
        ])
    }
}
