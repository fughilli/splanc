// Parity harness for AdaptiveDiffuse.swift: reads <name>.f32 (reduced interleaved
// RGB, little-endian float32, w x h from <name>.dim) and writes <name>.swift.u8 (the
// dense RGBA8 detect buffer) for compare.py to diff against the TS reference.
import Foundation

let dir = CommandLine.arguments[1]
let names = try FileManager.default.contentsOfDirectory(atPath: dir).filter { $0.hasSuffix(".f32") }.sorted()
let det = AdaptiveDiffuse()
var total = 0.0
for f in names {
    let base = String(f.dropLast(4))
    let dims = try String(contentsOfFile: "\(dir)/\(base).dim", encoding: .utf8).split(separator: " ").map { Int($0.trimmingCharacters(in: .whitespacesAndNewlines))! }
    let (w, h) = (dims[0], dims[1])
    let data = try Data(contentsOf: URL(fileURLWithPath: "\(dir)/\(f)"))
    let floats: [Float] = data.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
    var out = [UInt8](repeating: 0, count: w * h * 4)
    let t0 = Date()
    det.run(reduced: floats, w: w, h: h, params: AdaptiveDiffuse.Params()) { i, r, g, b, a in
        out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = a
        return true
    }
    total += Date().timeIntervalSince(t0)
    try Data(out).write(to: URL(fileURLWithPath: "\(dir)/\(base).swift.u8"))
}
print(String(format: "swift: %d frames, %.1f ms/frame (core, -O, this Mac)", names.count, total * 1000 / Double(max(1, names.count))))
