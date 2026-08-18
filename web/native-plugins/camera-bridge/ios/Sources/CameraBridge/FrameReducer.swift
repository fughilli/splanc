import CoreVideo
import Foundation

/// The native half of the detect pass (docs/design/ios-support.md §4.7).
///
/// This is a direct port of the ~15-line fragment shader in web/src/cv/detect.ts,
/// and it must stay byte-compatible with it, because the buffer it produces is fed
/// straight to the SAME `connectedComponents` the WebGL path uses:
///
///     lum = max(r, g, b)                       // max channel: robust for
///     m   = lum >= threshold ? 1 : 0           //   saturated white AND colored
///     out = vec4(rgb * m, m * lum)             //   LEDs
///
/// so RGB carries per-pixel color for the CPU stage's per-blob chroma and alpha is
/// the masked luminance CCL fills/weights on. Sub-threshold pixels are all-zero,
/// which is what makes the sparse encoding pay off: measured on-device, a mapping
/// frame lights ~300-700 of 230k pixels (~0.3%), so the payload is a few KB rather
/// than the ~921 KB a dense 640x360 RGBA readback would cost.
///
/// Downsampling is a box filter over `downscale`x`downscale` source pixels, matching
/// the shader's LINEAR-filtered 2x sample. Because the box filter is linear,
/// intensity-weighted centroids computed here track the full-resolution centroid to
/// well under a pixel.
///
/// Row order: CVPixelBuffer row 0 is the image TOP row and we copy in order, so the
/// output's row 0 is the image top — the caller therefore runs the detector with
/// `flipV = false`, the same convention as the getUserMedia path.
///
/// PERFORMANCE: this runs per frame at 30fps over ~921k source samples, so it holds
/// its output buffers across frames (allocating 276 KB per frame would churn) and
/// walks memory through unsafe pointers (Swift's bounds checks in the inner loop are
/// not free). It also skips the measure pass on frames the caller doesn't need it
/// for — scene stats move at AE speed and JS only consumes them every 6th frame, so
/// computing it every frame doubled the per-frame scan for nothing.
final class FrameReducer {

    /// One reduced frame: the thresholded detect buffer (sparse) plus, when it was
    /// computed this frame, the tiny unthresholded measure buffer (dense).
    struct Reduced {
        let width: Int
        let height: Int
        /// Indices of non-zero pixels, little-endian UInt32.
        let indices: Data
        /// RGBA bytes for those pixels, in the same order.
        let pixels: Data
        /// True when `maxSparsePixels` clipped the list — detection will be wrong
        /// for this frame, and the caller must say so rather than hide it.
        let truncated: Bool
        let nonZeroCount: Int

        /// Zero when this frame skipped the measure pass; the caller then reuses
        /// the last one it received.
        let measureWidth: Int
        let measureHeight: Int
        /// Dense RGBA, unthresholded (rgb = color, alpha = luminance).
        let measure: Data
    }

    /// Beyond this many lit pixels the scene isn't a dark room with LEDs in it and
    /// sparse encoding has stopped paying for itself (~3.5% of a 640x360 frame,
    /// ~64 KB of payload). Sized from measurement, not guesswork: a real 60-LED
    /// capture runs 100-1000 lit pixels, peaking near 8.5k while the exposure
    /// servo is still settling — so this leaves ~1000x headroom over typical and
    /// ~1x over the worst observed transient, while bounding both the payload and
    /// the scan's worst case. Exceeding it is reported, never silently trimmed.
    static let maxSparsePixels = 8_192

    // Reused across frames; sized once on first use.
    private var idxBuf = [UInt32](repeating: 0, count: FrameReducer.maxSparsePixels)
    private var pxBuf = [UInt8](repeating: 0, count: FrameReducer.maxSparsePixels * 4)
    private var measureBuf = [UInt8]()

    func reduce(
        _ buffer: CVPixelBuffer,
        downscale: Int,
        threshold: Double,
        measureWidth: Int,
        wantMeasure: Bool
    ) -> Reduced? {
        guard CVPixelBufferGetPixelFormatType(buffer) == kCVPixelFormatType_32BGRA else {
            return nil
        }
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(buffer) else { return nil }

        let srcW = CVPixelBufferGetWidth(buffer)
        let srcH = CVPixelBufferGetHeight(buffer)
        let stride = CVPixelBufferGetBytesPerRow(buffer)
        let src = base.assumingMemoryBound(to: UInt8.self)

        let ds = max(1, downscale)
        let w = max(1, srcW / ds)
        let h = max(1, srcH / ds)
        let thr = Int(max(0, min(255, Int((threshold * 255.0).rounded()))))
        let inv = ds * ds
        let cap = FrameReducer.maxSparsePixels

        var count = 0
        var truncated = false

        idxBuf.withUnsafeMutableBufferPointer { idxOut in
            pxBuf.withUnsafeMutableBufferPointer { pxOut in
                for y in 0..<h {
                    let rowBase = y * ds * stride
                    for x in 0..<w {
                        var sb = 0, sg = 0, sr = 0
                        var ro = rowBase
                        for _ in 0..<ds {
                            var o = ro + x * ds * 4
                            for _ in 0..<ds {
                                sb += Int(src[o])
                                sg += Int(src[o + 1])
                                sr += Int(src[o + 2])
                                o += 4
                            }
                            ro += stride
                        }
                        let r = sr / inv, g = sg / inv, b = sb / inv
                        let lum = max(r, max(g, b))
                        if lum < thr { continue }  // sub-threshold → all-zero, not emitted
                        if count >= cap {
                            truncated = true
                            return
                        }
                        idxOut[count] = UInt32(y * w + x).littleEndian
                        let po = count * 4
                        pxOut[po] = UInt8(r)
                        pxOut[po + 1] = UInt8(g)
                        pxOut[po + 2] = UInt8(b)
                        pxOut[po + 3] = UInt8(lum)  // alpha = masked luminance (m == 1)
                        count += 1
                    }
                }
            }
        }

        let indices = idxBuf.withUnsafeBytes { Data($0.prefix(count * 4)) }
        let pixels = pxBuf.withUnsafeBytes { Data($0.prefix(count * 4)) }

        // Measure pass: same reduction, unthresholded, into a tiny fixed width.
        var mw = 0, mh = 0
        var measure = Data()
        if wantMeasure {
            mw = max(1, measureWidth)
            mh = max(1, Int((Double(mw) * Double(srcH) / Double(srcW)).rounded()))
            if measureBuf.count != mw * mh * 4 {
                measureBuf = [UInt8](repeating: 0, count: mw * mh * 4)
            }
            let bx = max(1, srcW / mw), by = max(1, srcH / mh)
            measureBuf.withUnsafeMutableBufferPointer { dst in
                for y in 0..<mh {
                    for x in 0..<mw {
                        var sb = 0, sg = 0, sr = 0
                        for dy in 0..<by {
                            let sy = min(srcH - 1, y * by + dy)
                            var o = sy * stride + min(srcW - 1, x * bx) * 4
                            for _ in 0..<bx {
                                sb += Int(src[o])
                                sg += Int(src[o + 1])
                                sr += Int(src[o + 2])
                                o += 4
                            }
                        }
                        let n = bx * by
                        let r = UInt8(sr / n), g = UInt8(sg / n), b = UInt8(sb / n)
                        let o = (y * mw + x) * 4
                        dst[o] = r
                        dst[o + 1] = g
                        dst[o + 2] = b
                        dst[o + 3] = max(r, max(g, b))  // alpha = raw luminance
                    }
                }
            }
            measure = Data(measureBuf)
        }

        return Reduced(
            width: w, height: h,
            indices: indices, pixels: pixels,
            truncated: truncated, nonZeroCount: count,
            measureWidth: mw, measureHeight: mh, measure: measure)
    }
}
