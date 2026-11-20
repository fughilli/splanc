(async () => {
  if (window.__camv) { window.__camv.srcObject.getTracks().forEach(t => t.stop()); window.__camv.remove(); }
  const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } }, audio: false });
  const v = document.createElement("video"); v.muted = true; v.playsInline = true; v.srcObject = s;
  v.style.cssText = "position:fixed;right:0;bottom:0;width:90px;z-index:99999;opacity:0.9";
  document.body.append(v); await v.play(); window.__camv = v;
  // Same geometric map as planExposure (exposureControl.ts), hi capped at bitPeriod/2 = 55 ms.
  window.__setExp = async (x) => { const t = v.srcObject.getVideoTracks()[0]; const c = t.getCapabilities();
    const lo = c.exposureTime.min, hi = Math.max(lo, Math.min(c.exposureTime.max, 55 / 0.1));
    const et = lo * Math.pow(hi / lo, x);
    await t.applyConstraints({ advanced: [{ exposureMode: "manual", exposureTime: et, iso: c.iso.min }] });
    return et; };
  await new Promise(r => setTimeout(r, 800));
  const t = s.getVideoTracks()[0];
  return { w: v.videoWidth, h: v.videoHeight, label: t.label, s: t.getSettings().exposureTime };
})()
