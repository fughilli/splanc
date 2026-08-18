import AVFoundation
import Capacitor
import CoreMotion
import Foundation
import simd
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
/// The plugin owns the whole iOS capture path: the session, the preview layer,
/// exposure, the detector's threshold/downsample stage (FrameReducer, shipped as
/// sparse lit pixels), and the CoreMotion IMU. While it holds the camera nothing
/// may call `getUserMedia` — two capture clients can't share it — so the capture
/// screen picks exactly one source (see nativeCaptureAvailable).
@objc(CameraBridge)
public class CameraBridge: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CameraBridge"
    public let jsName = "CameraBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setExposure", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearExposure", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setDetectParams", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "log", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "saveSessionLog", returnType: CAPPluginReturnPromise)
    ]

    // Session setup/teardown blocks; keep them off the main thread (startRunning
    // in particular takes long enough to jank the UI).
    private let sessionQueue = DispatchQueue(label: "dev.splanc.camera-bridge")

    /// Must match MEASURE_W in web/src/cv/detect.ts — the measure buffer is handed
    /// straight to sceneStatsFromLuma, which assumes that geometry.
    fileprivate static let measureWidth = 64

    private var session: AVCaptureSession?
    private var device: AVCaptureDevice?
    private var previewView: PreviewView?
    private var videoOutput: AVCaptureVideoDataOutput?
    // Frame delivery runs off the session queue so a slow reduction can't stall
    // session control (start/stop/exposure).
    private let frameQueue = DispatchQueue(label: "dev.splanc.camera-bridge.frames")
    // Detect-pass parameters, mirrored from the JS DetectorGL. `threshold` is
    // servo-driven at runtime (capture.ts adjusts it as blob counts move), so it
    // has to be pushed down here rather than fixed at start.
    private let paramLock = NSLock()
    private var threshold: Double = 0.6
    private var downscale: Int = 2
    private var framesEmitted = 0
    private var framesDropped = 0
    private var reduceMsEma = 0.0
    private var lastFrameLogTime = CFAbsoluteTimeGetCurrent()
    /// Holds its scratch buffers across frames — see FrameReducer's perf note.
    private let reducer = FrameReducer()

    // CoreMotion IMU. Taken natively for the same reason as the camera: the axis
    // conventions WebKit's DeviceMotion reports vary by handset, and imu.ts can
    // only guess at them (its DEFAULT_IMU_MAPPING was fitted on an Android
    // device). On iOS that guess has never been right — maps came out
    // mis-oriented — and the VIO solve fuses camera with IMU, so a wrong mapping
    // kills the solve while decode carries on looking perfect. CoreMotion's axes
    // are documented, and its timestamps share the frames' clock.
    private let motion = CMMotionManager()
    private let imuQueue = OperationQueue()
    private let imuLock = NSLock()
    private var imuPending: [[String: Any]] = []
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
        // Frame tap for the detector. BGRA because FrameReducer reads packed 8-bit
        // channels directly; discarding late frames keeps latency bounded when a
        // reduction overruns its frame budget (reported, not hidden — see
        // framesDropped in the emitted stats).
        let out = AVCaptureVideoDataOutput()
        out.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
        out.alwaysDiscardsLateVideoFrames = true
        out.setSampleBufferDelegate(self, queue: frameQueue)
        if sess.canAddOutput(out) {
            sess.addOutput(out)
            videoOutput = out
        } else {
            clog("WARNING: cannot add video output — frames will not reach the detector")
        }
        sess.commitConfiguration()

        // Portrait for BOTH connections, so the pixel buffers the detector sees are
        // oriented the same way as the preview the user is aiming (otherwise blob
        // coordinates are transposed relative to what's on screen).
        if let conn = out.connection(with: .video) {
            if conn.isVideoOrientationSupported {
                conn.videoOrientation = .portrait
            }
            // Real intrinsics per frame, rather than the FOV heuristic in
            // xr/mediaStreamCapture.ts (f = 0.72 * long side, i.e. ~70 degrees).
            // Focal error moves the map's METRIC SCALE about 1:1, and the guess is
            // measurably wrong here: a 30-LED/m strip (33.3mm pitch, calipers)
            // solved to 29.9mm, +11% small, consistent with the true long-axis FOV
            // being nearer 64 degrees than 70.
            if conn.isCameraIntrinsicMatrixDeliverySupported {
                conn.isCameraIntrinsicMatrixDeliveryEnabled = true
            } else {
                clog("WARNING: intrinsic matrix delivery unsupported — "
                     + "the FOV heuristic (and its scale error) stays in play")
            }
        }
        sess.startRunning()

        session = sess
        device = dev
        startImu()
        clog("started: \(describe(dev))")
        DispatchQueue.main.async { self.installPreview(sess) }
        call.resolve(info(dev, sess))
    }

    @objc func stop(_ call: CAPPluginCall) {
        sessionQueue.async { [weak self] in
            guard let self = self else { call.resolve(); return }
            self.motion.stopDeviceMotionUpdates()
            self.imuLock.lock(); self.imuPending.removeAll(); self.imuLock.unlock()
            self.videoOutput?.setSampleBufferDelegate(nil, queue: nil)
            self.videoOutput = nil
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

    // MARK: - IMU

    /// Standard gravity, for converting CoreMotion's g-units to m/s².
    private static let g0 = 9.80665

    /// Stream device motion at the frame-pairing rate the solver wants.
    ///
    /// Frame conventions, which is the whole point of doing this natively:
    /// CoreMotion's device frame is +X right, +Y toward the top edge, +Z out of
    /// the screen. The wire format wants the CAMERA frame, +X right, +Y up, -Z
    /// look (see web/src/xr/imu.ts). The REAR camera looks out the back, along
    /// -Z of the device — so its look direction is already -Z and the two frames
    /// coincide: the mapping is the IDENTITY. That derivation only holds while
    /// the interface is pinned to portrait, which is why capture locks it.
    private func startImu() {
        guard motion.isDeviceMotionAvailable else {
            clog("WARNING: device motion unavailable — the VIO solve needs IMU")
            return
        }
        imuQueue.maxConcurrentOperationCount = 1
        motion.deviceMotionUpdateInterval = 1.0 / 100.0
        motion.startDeviceMotionUpdates(using: .xArbitraryZVertical, to: imuQueue) {
            [weak self] dm, _ in
            guard let self = self, let dm = dm else { return }
            let r = dm.rotationRate
            // Specific force f = R^T(a − g), which is what the solver's model wants
            // (see synth.rs: `f_body = R^T (a_world − G_WORLD)`).
            //
            // The subtlety is CoreMotion's signs. Apple reports raw acceleration as
            // (0,0,−1) at rest face-up, but an accelerometer at rest physically
            // measures specific force of +1g UPWARD — so Apple's raw is −f. Given
            // raw = gravity + userAcceleration and gravity = R^T·g, it follows that
            // userAcceleration = −R^T·a: Apple's user acceleration is the NEGATIVE
            // of body-frame inertial acceleration. Hence f = −(userAcceleration +
            // gravity), and NOT either of the plausible-looking differences.
            //
            // Both wrong forms were tried on a real 60-LED capture, and neither
            // fails loudly — which is the reason for this comment:
            //
            //   −(userAcceleration + gravity)  correct
            //    (userAcceleration − gravity)  gravity right, inertial term
            //                                  inverted → diverges: 0 leds, 150k px
            //    (gravity − userAcceleration)  inertial right, gravity inverted →
            //                                  fits at 0.97 px but the whole map is
            //                                  rotated 180° about a horizontal axis
            //                                  (upside down), because a global
            //                                  rotation that negates gravity costs
            //                                  nothing in reprojection error
            let ax = -(dm.userAcceleration.x + dm.gravity.x) * CameraBridge.g0
            let ay = -(dm.userAcceleration.y + dm.gravity.y) * CameraBridge.g0
            let az = -(dm.userAcceleration.z + dm.gravity.z) * CameraBridge.g0
            // dm.timestamp is seconds since boot — the same clock as the frames'
            // presentation timestamps, so one ClockOffset maps both.
            let sample: [String: Any] = [
                "t": dm.timestamp * 1000.0,
                "gyro": [r.x, r.y, r.z],
                "accel": [ax, ay, az],
                // Raw components too: the derived `accel` above discards which part
                // was gravity, and settling a sign convention offline needs both.
                // Working that out cost a re-capture per hypothesis once already.
                "ua": [dm.userAcceleration.x, dm.userAcceleration.y, dm.userAcceleration.z],
                "g": [dm.gravity.x, dm.gravity.y, dm.gravity.z]
            ]
            self.imuLock.lock()
            // Bound the queue: if frames stop draining it, drop the oldest rather
            // than grow without limit (2 s at 100 Hz is far more than a frame gap).
            if self.imuPending.count >= 200 { self.imuPending.removeFirst() }
            self.imuPending.append(sample)
            self.imuLock.unlock()
        }
    }

    /// Samples accumulated since the last frame, handed over and cleared.
    private func drainImu() -> [[String: Any]] {
        imuLock.lock()
        let out = imuPending
        imuPending.removeAll(keepingCapacity: true)
        imuLock.unlock()
        return out
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
        applyOrientationLock(true)
        clog("preview installed: host=\(host.bounds.size) webViewWasOpaque=\(webViewWasOpaque) "
             + "— the PAGE must also be transparent (html AND body; the root element "
             + "paints the canvas) or this layer stays hidden behind it")
    }

    /// Pin (or release) the interface orientation. The flag drives the
    /// AppDelegate's supportedInterfaceOrientationsFor; the rest forces iOS to
    /// re-evaluate it now rather than at the next device rotation, so a phone
    /// already held sideways snaps back instead of staying landscape.
    private func applyOrientationLock(_ portraitOnly: Bool) {
        CameraOrientationLock.portraitOnly = portraitOnly
        guard let vc = bridge?.viewController else { return }
        if #available(iOS 16.0, *) {
            vc.setNeedsUpdateOfSupportedInterfaceOrientations()
            vc.view.window?.windowScene?.requestGeometryUpdate(
                .iOS(interfaceOrientations: portraitOnly ? .portrait : .all))
        } else {
            UIViewController.attemptRotationToDeviceOrientation()
        }
    }

    private func removePreview() {
        applyOrientationLock(false)
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

    // MARK: - Detect params

    /// Push the JS detector's live parameters down. `threshold` is servo-driven,
    /// so this is called whenever capture.ts retunes it — the native reduction has
    /// to use the same value or the blob counts the servo reacts to are not the
    /// ones the servo is controlling.
    @objc func setDetectParams(_ call: CAPPluginCall) {
        paramLock.lock()
        if let t = call.getDouble("threshold") { threshold = min(1.0, max(0.0, t)) }
        if let d = call.getInt("downscale") { downscale = max(1, d) }
        let (t, d) = (threshold, downscale)
        paramLock.unlock()
        clog("setDetectParams threshold=\(t) downscale=\(d)")
        call.resolve()
    }

    /// A console sink for JS diagnostics on a Release build.
    ///
    /// Capacitor compiles its logging out of release builds, so `console.*` from
    /// the web layer never reaches `devicectl --console`. Turning its production
    /// logging back on is not an option here: it logs every bridge call, and this
    /// plugin emits a frame event 30x/s carrying kilobytes of base64 — the log
    /// traffic alone would distort the timings we use it to measure. So the
    /// capture path routes its own diagnostic line through here instead.
    @objc func log(_ call: CAPPluginCall) {
        clog("[js] \(call.getString("message") ?? "")")
        call.resolve()
    }

    /// Persist a capture's solver input to the app container, so it can be pulled
    /// off with `xcrun devicectl device copy from` and replayed on a Mac.
    ///
    /// A failing solve can't be debugged from the phone: the interesting state is
    /// thousands of detections and IMU samples, far too much for the console, and
    /// each hypothesis otherwise costs a rebuild plus a physical re-capture. The
    /// same JSON feeds `bazel run //solver:solver_cli` natively, so a real capture
    /// becomes a fixture you can iterate against in seconds.
    @objc func saveSessionLog(_ call: CAPPluginCall) {
        guard let name = call.getString("name"), let json = call.getString("json") else {
            call.reject("saveSessionLog: needs 'name' and 'json'")
            return
        }
        // Reject path separators — this name reaches the filesystem.
        let safe = name.replacingOccurrences(of: "/", with: "_")
        guard let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
        else {
            call.reject("saveSessionLog: no documents directory")
            return
        }
        let url = dir.appendingPathComponent(safe)
        do {
            try json.write(to: url, atomically: true, encoding: .utf8)
            clog("saved session log: \(url.path) (\(json.utf8.count) bytes)")
            call.resolve(["path": url.path, "bytes": json.utf8.count])
        } catch {
            clog("saveSessionLog failed: \(error.localizedDescription)")
            call.reject("saveSessionLog: \(error.localizedDescription)")
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

// MARK: - Frame delivery

extension CameraBridge: AVCaptureVideoDataOutputSampleBufferDelegate {
    public func captureOutput(_ output: AVCaptureOutput,
                              didOutput sampleBuffer: CMSampleBuffer,
                              from connection: AVCaptureConnection) {
        guard let pixels = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        paramLock.lock()
        let (thr, ds) = (threshold, downscale)
        paramLock.unlock()

        // Scene stats move at AE speed and capture.ts consumes them every 6th
        // frame, so computing them every frame doubled the per-frame scan for
        // nothing. NativeCaptureSource carries the last one forward.
        let wantMeasure = framesEmitted % 6 == 0
        let t0 = CFAbsoluteTimeGetCurrent()
        guard let r = reducer.reduce(pixels, downscale: ds, threshold: thr,
                                     measureWidth: CameraBridge.measureWidth,
                                     wantMeasure: wantMeasure)
        else {
            framesDropped += 1
            return
        }
        let reduceMs = (CFAbsoluteTimeGetCurrent() - t0) * 1000.0
        reduceMsEma = reduceMsEma == 0 ? reduceMs : reduceMsEma * 0.9 + reduceMs * 0.1

        // Presentation time, in the host time base — seconds since BOOT. This is
        // NOT the performance.now() epoch (milliseconds since the page's time
        // origin), so NativeCaptureSource maps it before anything downstream sees
        // it; unmapped, the solver's IMU trim throws away every IMU sample. It is
        // still the right thing to send: it's the true capture instant, free of
        // delivery latency, so frame-to-frame spacing (what the temporal decode
        // depends on) is exact.
        let tCapture = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sampleBuffer)) * 1000.0

        // Per-frame intrinsics, when the connection delivers them. Apple documents
        // the matrix as relative to the delivered buffer, so it should already
        // account for the portrait rotation — the log below prints it against the
        // buffer size on the first frame so a mismatch is visible rather than
        // silently scaling the map.
        var k: [Double]? = nil
        if let att = CMGetAttachment(
            sampleBuffer,
            key: kCMSampleBufferAttachmentKey_CameraIntrinsicMatrix,
            attachmentModeOut: nil) as? Data {
            let m = att.withUnsafeBytes { $0.load(as: matrix_float3x3.self) }
            k = [Double(m.columns.0[0]), Double(m.columns.1[1]),
                 Double(m.columns.2[0]), Double(m.columns.2[1])]
        }

        framesEmitted += 1
        if framesEmitted % 60 == 1 {
            let now = CFAbsoluteTimeGetCurrent()
            let fps = 60.0 / max(0.001, now - lastFrameLogTime)
            lastFrameLogTime = now
            let kStr = k.map { String(format: " K=[%.1f %.1f %.1f %.1f] (img %dx%d)",
                                      $0[0], $0[1], $0[2], $0[3], r.width * ds, r.height * ds) }
                ?? " K=heuristic"
            clog(String(format: "frame #%d: %dx%d lit=%d%@ fps=%.1f reduce=%.1fms dropped=%d%@",
                        framesEmitted, r.width, r.height, r.nonZeroCount,
                        r.truncated ? " TRUNCATED" : "", fps, reduceMsEma, framesDropped, kStr))
        }

        notifyListeners("cameraFrame", data: [
            "w": r.width,
            "h": r.height,
            "imgW": r.width * ds,
            "imgH": r.height * ds,
            "idx": r.indices.base64EncodedString(),
            "px": r.pixels.base64EncodedString(),
            "lit": r.nonZeroCount,
            "truncated": r.truncated,
            // measureW/H are 0 on frames that skipped the measure pass; the JS side
            // then keeps the previous buffer rather than the detector seeing a gap.
            "measureW": r.measureWidth,
            "measureH": r.measureHeight,
            "measure": wantMeasure ? r.measure.base64EncodedString() : "",
            "tCaptureMs": tCapture,
            // Omitted when the connection can't deliver it; JS then keeps heuristicK.
            "k": k as Any,
            // IMU rides along with the frames rather than on its own event: at
            // 100 Hz that would be 100 bridge calls a second, and the samples are
            // consumed against these frames anyway.
            "imu": drainImu()
        ])
    }
}

/// Whether the app is currently pinned to portrait.
///
/// Read by `application(_:supportedInterfaceOrientationsFor:)` in the generated
/// AppDelegate, which web/ios-config/apply.sh patches in (the ios/ tree is
/// regenerated, so that patch is the source of truth). Public because the app
/// target has to see it across the module boundary.
///
/// Mapping holds portrait for two reasons: a viewport that flips to landscape
/// mid-capture is distracting while you're framing a shot, and — the substantive
/// one — the camera-to-IMU relationship is fixed only while the interface
/// orientation is. The VIO solve fuses the two, so letting the device rotate
/// under a fixed IMU axis mapping makes that mapping wrong for half the run.
public enum CameraOrientationLock {
    public static var portraitOnly = false
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
