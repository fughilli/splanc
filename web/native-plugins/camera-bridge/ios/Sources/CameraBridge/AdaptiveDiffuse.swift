import Accelerate
import Foundation

/// Adaptive diffuse-spot detector — the native iOS port of web/src/cv/diffuseDetect.ts.
///
/// That file is the reference and the spec; this must stay numerically equivalent
/// (the WebGL path in web/src/cv/diffuseDetectGL.ts is the other port). Same
/// algorithm, same parameters, same clamp-to-edge borders, same quarter-resolution
/// background with a GL-style bilinear upsample, same decimated noise statistics,
/// same output encoding:
///
///   spot  = separable gaussian (gaussTaps(spotSigma)) of each reduced channel
///   bg    = bgScale x bgScale box downsample, 3-pass box blur (bgBoxRadius) at that
///           resolution, bilinear upsample
///   resp  = max over channels of (spot - bg)                (signed)
///   floor = median + kSigma * 1.4826 * MAD of resp sampled every statStride px
///   keep  = max(0, resp) >= floor  &&  >= peakFrac * (square max filter of it)
///   out   = alpha: raw max-channel luminance; rgb: the spot colour scaled so its
///           max channel equals that luminance
///
/// Unlike the GL path (which uses the previous frame's floor to avoid a second GPU
/// sync), this computes the floor from the frame itself, exactly as the reference.
///
/// Foundation only (no AVFoundation/CoreVideo), so it compiles into a
/// command-line parity harness as-is (web/tests/tools/ios_adaptive_parity/run.sh).
/// PERFORMANCE: every buffer is held across frames and every inner loop walks
/// unsafe pointers; the max filter is van Herk/Gil-Werman (3 compares per pixel
/// whatever the radius), the box blurs are running sums.
final class AdaptiveDiffuse {

    struct Params {
        var spotSigma: Float = 2.45
        var bgScale = 4
        var bgBoxRadius = 3
        var peakRadius = 10
        var kSigma: Float = 20
        var peakFrac: Float = 0.6
        var statStride = 4

        /// adaptiveParamsForDownscale in diffuseDetect.ts: radii are tuned at
        /// downscale 2; scale them so they span the same image distance.
        func forDownscale(_ ds: Int) -> Params {
            if ds == 2 { return self }
            let k = 2.0 / Double(max(1, ds))
            func r(_ v: Int) -> Int { max(1, Int((Double(v) * k).rounded())) }
            var p = self
            p.spotSigma = spotSigma * Float(k)
            p.bgScale = r(bgScale)
            p.peakRadius = r(peakRadius)
            p.statStride = r(statStride)
            return p
        }
    }

    /// NOISE_SIGMA_MIN in diffuseDetect.ts.
    static let noiseSigmaMin: Float = 1e-4

    private(set) var lastFloor: Float = 0
    private var w = 0, h = 0, qw = 0, qh = 0
    // Planar buffers, reused across frames.
    private var rgb = [[Float]](repeating: [], count: 3)   // reduced channels, [0,1]
    private var spot = [[Float]](repeating: [], count: 3)
    private var raw = [Float]()
    private var resp = [Float]()
    private var clamped = [Float]()
    private var peak = [Float]()
    private var tmp = [Float]()
    private var q = [Float]()
    private var qTmp = [Float]()
    private var line = [Float]()
    private var lineG = [Float]()
    private var lineH = [Float]()
    private var sample = [Float]()

    private func ensure(_ w: Int, _ h: Int, _ p: Params) {
        let qw = (w + p.bgScale - 1) / p.bgScale, qh = (h + p.bgScale - 1) / p.bgScale
        if w == self.w && h == self.h && qw == self.qw && qh == self.qh { return }
        self.w = w; self.h = h; self.qw = qw; self.qh = qh
        let n = w * h
        rgb = [[Float]](repeating: [Float](repeating: 0, count: n), count: 3)
        spot = rgb
        raw = [Float](repeating: 0, count: n)
        resp = raw; clamped = raw; peak = raw; tmp = raw
        q = [Float](repeating: 0, count: qw * qh)
        qTmp = q
        let longest = max(w, h) + 2 * (p.peakRadius + 1)
        line = [Float](repeating: 0, count: longest)
        lineG = line; lineH = line
    }

    /// Run on a full-resolution BGRA frame, box-reducing by `ds` first (the same
    /// reduction FrameReducer's legacy path does, kept in floats). Calls `emit`
    /// for every kept pixel, in row-major order, with its index and RGBA8.
    func run(bgra src: UnsafePointer<UInt8>, srcW: Int, srcH: Int, bytesPerRow: Int, ds: Int,
             params: Params, emit: (Int, UInt8, UInt8, UInt8, UInt8) -> Bool) {
        let w = max(1, srcW / ds), h = max(1, srcH / ds)
        let p = params.forDownscale(ds)
        ensure(w, h, p)
        let inv = 1.0 / Float(255 * ds * ds)
        rgb[0].withUnsafeMutableBufferPointer { r in
        rgb[1].withUnsafeMutableBufferPointer { g in
        rgb[2].withUnsafeMutableBufferPointer { b in
            for y in 0..<h {
                for x in 0..<w {
                    var sb = 0, sg = 0, sr = 0
                    var ro = y * ds * bytesPerRow
                    for _ in 0..<ds {
                        var o = ro + x * ds * 4
                        for _ in 0..<ds {
                            sb += Int(src[o]); sg += Int(src[o + 1]); sr += Int(src[o + 2])
                            o += 4
                        }
                        ro += bytesPerRow
                    }
                    let i = y * w + x
                    r[i] = Float(sr) * inv; g[i] = Float(sg) * inv; b[i] = Float(sb) * inv
                }
            }
        }}}
        core(w: w, h: h, p: p, emit: emit)
    }

    /// Run on an already-reduced interleaved RGB image in [0,1] (the reference's
    /// own input) — the parity harness's entry point.
    func run(reduced: [Float], w: Int, h: Int, params: Params,
             emit: (Int, UInt8, UInt8, UInt8, UInt8) -> Bool) {
        ensure(w, h, params)
        for c in 0..<3 {
            rgb[c].withUnsafeMutableBufferPointer { d in
                for i in 0..<(w * h) { d[i] = reduced[i * 3 + c] }
            }
        }
        core(w: w, h: h, p: params, emit: emit)
    }

    private func core(w: Int, h: Int, p: Params, emit: (Int, UInt8, UInt8, UInt8, UInt8) -> Bool) {
        let n = w * h
        for i in 0..<n { raw[i] = max(rgb[0][i], max(rgb[1][i], rgb[2][i])) }
        for i in 0..<n { resp[i] = -.infinity }
        for c in 0..<3 {
            // spot = separable gaussian of the channel
            gauss(rgb[c], &spot[c], w, h, AdaptiveDiffuse.gaussTaps(p.spotSigma))
            // background at 1/bgScale
            downsample(rgb[c], w, h, p.bgScale, &q)
            box3(&q, qw, qh, p.bgBoxRadius, &qTmp)
            q.withUnsafeBufferPointer { qb in
            spot[c].withUnsafeBufferPointer { sp in
            resp.withUnsafeMutableBufferPointer { rp in
                for y in 0..<h {
                    let fy = min(Float(qh - 1), max(0, (Float(y) + 0.5) * Float(qh) / Float(h) - 0.5))
                    let y0 = Int(fy), y1 = min(qh - 1, y0 + 1), ay = fy - Float(y0)
                    for x in 0..<w {
                        let fx = min(Float(qw - 1), max(0, (Float(x) + 0.5) * Float(qw) / Float(w) - 0.5))
                        let x0 = Int(fx), x1 = min(qw - 1, x0 + 1), ax = fx - Float(x0)
                        let a = qb[y0 * qw + x0], b = qb[y0 * qw + x1], cc = qb[y1 * qw + x0], d = qb[y1 * qw + x1]
                        let bg = (a * (1 - ax) + b * ax) * (1 - ay) + (cc * (1 - ax) + d * ax) * ay
                        let i = y * w + x
                        let v = sp[i] - bg
                        if v > rp[i] { rp[i] = v }
                    }
                }
            }}}
        }
        // Noise floor from the decimated signed response.
        let sw = (w + p.statStride - 1) / p.statStride, sh = (h + p.statStride - 1) / p.statStride
        if sample.count != sw * sh { sample = [Float](repeating: 0, count: sw * sh) }
        for sy in 0..<sh { for sx in 0..<sw { sample[sy * sw + sx] = resp[sy * p.statStride * w + sx * p.statStride] } }
        let floorT = AdaptiveDiffuse.noiseFloor(&sample, kSigma: p.kSigma)
        lastFloor = floorT
        for i in 0..<n { clamped[i] = max(0, resp[i]) }
        maxFilter(clamped, &peak, w, h, p.peakRadius)
        for i in 0..<n {
            let r = clamped[i]
            if !(r >= floorT && r >= p.peakFrac * peak[i]) { continue }
            let lum = min(1, max(1.0 / 255.0, raw[i]))
            let cr = max(0, spot[0][i]), cg = max(0, spot[1][i]), cb = max(0, spot[2][i])
            let cmax = max(cr, max(cg, cb))
            let k = cmax > 0 ? lum / cmax : 0
            let px = { (v: Float) -> UInt8 in UInt8((min(1, v * k) * 255).rounded()) }
            if !emit(i, px(cr), px(cg), px(cb), max(1, UInt8((lum * 255).rounded()))) { return }
        }
    }

    /// noiseFloor in diffuseDetect.ts (sorts `s` in place); returns the floor.
    static func noiseFloor(_ s: inout [Float], kSigma: Float) -> Float {
        let n = s.count
        if n == 0 { return kSigma * noiseSigmaMin }
        s.sort()
        let median = s[n >> 1]
        for i in 0..<n { s[i] = abs(s[i] - median) }
        s.sort()
        let sigma = max(noiseSigmaMin, 1.4826 * s[n >> 1])
        return median + kSigma * sigma
    }

    /// gaussTaps in diffuseDetect.ts: normalised one-sided taps, radius ceil(3 sigma).
    static func gaussTaps(_ sigma: Float) -> [Float] {
        // Doubles, like the reference (JS numbers), then stored as Float.
        let sg = Double(sigma)
        let r = Int((3 * sg).rounded(.up))
        var w = [Double](repeating: 0, count: r + 1)
        var sum = 0.0
        for i in 0...r {
            w[i] = exp(-Double(i * i) / (2 * sg * sg))
            sum += i == 0 ? w[i] : 2 * w[i]
        }
        return w.map { Float($0 / sum) }
    }

    /// Separable gaussian (H then V), clamp-to-edge (gaussBlur in diffuseDetect.ts),
    /// on vImage's SIMD convolution (kvImageEdgeExtend = the reference's clamp).
    private func gauss(_ src: [Float], _ dst: inout [Float], _ w: Int, _ h: Int, _ taps: [Float]) {
        let r = taps.count - 1
        var kernel = [Float](repeating: 0, count: 2 * r + 1)
        for i in -r...r { kernel[i + r] = taps[abs(i)] }
        let rowBytes = w * MemoryLayout<Float>.stride
        var srcCopy = src
        srcCopy.withUnsafeMutableBufferPointer { s in
        tmp.withUnsafeMutableBufferPointer { t in
        dst.withUnsafeMutableBufferPointer { o in
            var bs = vImage_Buffer(data: s.baseAddress, height: vImagePixelCount(h), width: vImagePixelCount(w), rowBytes: rowBytes)
            var bt = vImage_Buffer(data: t.baseAddress, height: vImagePixelCount(h), width: vImagePixelCount(w), rowBytes: rowBytes)
            var bo = vImage_Buffer(data: o.baseAddress, height: vImagePixelCount(h), width: vImagePixelCount(w), rowBytes: rowBytes)
            _ = vImageConvolve_PlanarF(&bs, &bt, nil, 0, 0, kernel, 1, UInt32(2 * r + 1), 0, vImage_Flags(kvImageEdgeExtend))
            _ = vImageConvolve_PlanarF(&bt, &bo, nil, 0, 0, kernel, UInt32(2 * r + 1), 1, 0, vImage_Flags(kvImageEdgeExtend))
        }}}
    }

    /// Three H+V running-sum box passes, clamp-to-edge (box3 in diffuseDetect.ts).
    private func box3(_ a: inout [Float], _ w: Int, _ h: Int, _ r: Int, _ t: inout [Float]) {
        if t.count < a.count { t = [Float](repeating: 0, count: a.count) }
        let n = Float(2 * r + 1)
        a.withUnsafeMutableBufferPointer { ap in
        t.withUnsafeMutableBufferPointer { tp in
            for _ in 0..<3 {
                for y in 0..<h {
                    let row = y * w
                    var s: Float = 0
                    for i in -r...r { s += ap[row + min(w - 1, max(0, i))] }
                    for x in 0..<w {
                        tp[row + x] = s / n
                        s += ap[row + min(w - 1, x + r + 1)] - ap[row + max(0, x - r)]
                    }
                }
                for x in 0..<w {
                    var s: Float = 0
                    for i in -r...r { s += tp[min(h - 1, max(0, i)) * w + x] }
                    for y in 0..<h {
                        ap[y * w + x] = s / n
                        s += tp[min(h - 1, y + r + 1) * w + x] - tp[max(0, y - r) * w + x]
                    }
                }
            }
        }}
    }

    /// downsamplePlane in diffuseDetect.ts.
    private func downsample(_ src: [Float], _ w: Int, _ h: Int, _ k: Int, _ out: inout [Float]) {
        src.withUnsafeBufferPointer { s in
        out.withUnsafeMutableBufferPointer { o in
            for qy in 0..<qh {
                for qx in 0..<qw {
                    var acc: Float = 0
                    for j in 0..<k {
                        let y = min(h - 1, qy * k + j)
                        for i in 0..<k { acc += s[y * w + min(w - 1, qx * k + i)] }
                    }
                    o[qy * qw + qx] = acc / Float(k * k)
                }
            }
        }}
    }

    /// Square max filter (H then V), clamp-to-edge — van Herk/Gil-Werman per line.
    private func maxFilter(_ src: [Float], _ dst: inout [Float], _ w: Int, _ h: Int, _ r: Int) {
        if tmp.count < src.count { tmp = [Float](repeating: 0, count: src.count) }
        for y in 0..<h { maxLine(src, y * w, 1, w, r, &tmp) }
        for x in 0..<w { maxLine(tmp, x, w, h, r, &dst) }
    }

    /// Windowed max of the `len` samples src[off + i*step], window [i-r, i+r]
    /// clamped to the line (edge-padding = clamp), written to dst at the same places.
    private func maxLine(_ src: [Float], _ off: Int, _ step: Int, _ len: Int, _ r: Int, _ dst: inout [Float]) {
        let k = 2 * r + 1
        let padded = len + 2 * r
        let total = ((padded + k - 1) / k) * k
        if line.count < total { line = [Float](repeating: 0, count: total); lineG = line; lineH = line }
        for i in 0..<total {
            let s = min(len - 1, max(0, i - r))
            line[i] = src[off + s * step]
        }
        var b = 0
        while b < total {
            var g = -Float.infinity
            for i in b..<(b + k) { g = max(g, line[i]); lineG[i] = g }
            var hh = -Float.infinity
            var i = b + k - 1
            while i >= b { hh = max(hh, line[i]); lineH[i] = hh; i -= 1 }
            b += k
        }
        for x in 0..<len { dst[off + x * step] = max(lineH[x], lineG[x + k - 1]) }
    }
}
