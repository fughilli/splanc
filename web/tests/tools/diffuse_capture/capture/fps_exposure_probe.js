(async () => {
  const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } }, audio: false });
  const v = document.createElement("video"); v.muted = true; v.playsInline = true; v.srcObject = s; await v.play();
  const t = s.getVideoTracks()[0]; const c = t.getCapabilities();
  const cv = document.createElement("canvas"); cv.width = 180; cv.height = 320; const cx = cv.getContext("2d", { willReadFrequently: true });
  const stats = () => { cx.drawImage(v, 0, 0, 180, 320); const d = cx.getImageData(0, 0, 180, 320).data; let s = 0; const m = []; for (let i = 0; i < d.length; i += 4) { const l = Math.max(d[i], d[i + 1], d[i + 2]); s += l; m.push(l); } m.sort((a, b) => a - b); return { mean: +(s / (d.length / 4)).toFixed(2), p99: m[Math.floor(m.length * 0.99)], p999: m[Math.floor(m.length * 0.999)] }; };
  const out = [];
  await new Promise(r => setTimeout(r, 800));
  for (const ec of [0, -2, -4]) { await t.applyConstraints({ advanced: [{ exposureMode: "continuous", exposureCompensation: ec }] }); await new Promise(r => setTimeout(r, 1500)); out.push({ mode: "ae", ec, ...stats() }); }
  for (const et of [6.3, 25]) { await t.applyConstraints({ advanced: [{ exposureMode: "manual", exposureTime: et, iso: c.iso.min }] }); await new Promise(r => setTimeout(r, 1200)); out.push({ mode: "manual", etMs: et / 10, ...stats() }); }
  s.getTracks().forEach(x => x.stop());
  return out;
})()
