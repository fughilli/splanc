// gen.cjs <compiled web/src dir> <dataset dir> <out dir>: reduced frames + the TS reference's detect buffers.
const fs = require("fs"), path = require("path"), zlib = require("zlib");
const [srcDir, ds, out] = process.argv.slice(2);
const { adaptiveDiffuseReduce } = require(path.resolve(srcDir, "cv/diffuseDetect.js"));
const truth = JSON.parse(fs.readFileSync(path.join(ds, "truth.json"), "utf8"));
const w = truth.crop.w / 2, h = truth.crop.h / 2;
fs.mkdirSync(out, { recursive: true });
for (const f of truth.frames) {
  const u8 = zlib.inflateSync(fs.readFileSync(path.join(ds, f.file)));
  const rgb = new Float32Array(u8.length);
  for (let i = 0; i < u8.length; i++) rgb[i] = u8[i] / 255;
  const base = path.join(out, f.file.replace(/\.rgbz$/, ""));
  fs.writeFileSync(base + ".f32", Buffer.from(rgb.buffer));
  fs.writeFileSync(base + ".dim", `${w} ${h}`);
  fs.writeFileSync(base + ".ts.u8", adaptiveDiffuseReduce(rgb, w, h).detect);
}
