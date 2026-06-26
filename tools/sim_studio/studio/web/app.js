import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ----------------------------------------------------------------------------
// API helpers
// ----------------------------------------------------------------------------
async function api(path, body) {
  const opts = body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : { method: 'GET' };
  const res = await fetch(path, opts);
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).detail || msg; } catch (_) {}
    throw new Error(msg);
  }
  return res.json();
}

const $ = (id) => document.getElementById(id);
let toastTimer;
function toast(msg, isError) {
  const t = $('toast');
  t.textContent = msg;
  t.style.borderColor = isError ? '#5b2435' : '#2c3543';
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

// ----------------------------------------------------------------------------
// Three.js scene
// ----------------------------------------------------------------------------
const view = $('view');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
view.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0d12);

const camera = new THREE.PerspectiveCamera(55, 1, 0.01, 1000);
camera.position.set(0, 1.2, 4);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

scene.add(new THREE.AmbientLight(0xffffff, 0.8));
const grid = new THREE.GridHelper(10, 20, 0x2a3340, 0x1a2029);
scene.add(grid);
scene.add(new THREE.AxesHelper(0.5));

// Scene-content groups (cleared on new scene / reset).
let gtObj = null;          // ground-truth points (THREE.Points)
let solvedObj = null;      // solved points (THREE.Points, vertex-coloured)
let errorLines = null;     // GT↔solved segments
const frustums = new THREE.Group();
scene.add(frustums);

let sceneInfo = null;      // {leds, centroid, span, suggestedRadius}

function clearObject(o) { if (o) { scene.remove(o); o.geometry?.dispose(); o.material?.dispose(); } }

function resize() {
  const w = view.clientWidth, h = view.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / Math.max(h, 1);
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
resize();
animate();

// ----------------------------------------------------------------------------
// Rendering helpers
// ----------------------------------------------------------------------------
function renderGroundTruth(leds) {
  clearObject(gtObj);
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(leds.length * 3);
  leds.forEach((p, i) => { pos[i * 3] = p[0]; pos[i * 3 + 1] = p[1]; pos[i * 3 + 2] = p[2]; });
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const size = Math.max((sceneInfo?.span || 1) * 0.012, 0.006);
  const m = new THREE.PointsMaterial({ color: 0x46d39a, size, sizeAttenuation: true });
  gtObj = new THREE.Points(g, m);
  scene.add(gtObj);
}

// green (low error) → red (high error)
function errorColor(err, threshold) {
  const t = Math.min(err / threshold, 1);
  const hue = (1 - t) * 140 / 360; // 140° green → 0° red
  const c = new THREE.Color();
  c.setHSL(hue, 0.75, 0.55);
  return c;
}

function renderSolution(solveResult) {
  clearObject(solvedObj);
  clearObject(errorLines);
  const leds = solveResult.map.leds;
  const gt = sceneInfo.leds;
  const threshold = Math.max((sceneInfo.span || 1) * 0.02, 1e-4);

  const pos = new Float32Array(leds.length * 3);
  const col = new Float32Array(leds.length * 3);
  const linePos = new Float32Array(leds.length * 2 * 3);
  leds.forEach((e, i) => {
    const [x, y, z] = e.xyz;
    pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
    const err = solveResult.errorsByLed[String(e.id)] ?? 0;
    const c = errorColor(err, threshold);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    const g = gt[e.id];
    linePos[i * 6] = g[0]; linePos[i * 6 + 1] = g[1]; linePos[i * 6 + 2] = g[2];
    linePos[i * 6 + 3] = x; linePos[i * 6 + 4] = y; linePos[i * 6 + 5] = z;
  });

  const sg = new THREE.BufferGeometry();
  sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  sg.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const size = Math.max((sceneInfo.span || 1) * 0.02, 0.01);
  solvedObj = new THREE.Points(sg, new THREE.PointsMaterial({ size, vertexColors: true, sizeAttenuation: true }));
  scene.add(solvedObj);

  const lg = new THREE.BufferGeometry();
  lg.setAttribute('position', new THREE.BufferAttribute(linePos, 3));
  errorLines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0xf06a6a, transparent: true, opacity: 0.5 }));
  scene.add(errorLines);
}

function addFrustum(eye, target, hfovDeg) {
  const e = new THREE.Vector3(...eye);
  const t = new THREE.Vector3(...target);
  const fwd = t.clone().sub(e).normalize();
  let up = new THREE.Vector3(0, 1, 0);
  if (Math.abs(fwd.dot(up)) > 0.95) up = new THREE.Vector3(1, 0, 0);
  const right = new THREE.Vector3().crossVectors(fwd, up).normalize();
  const tup = new THREE.Vector3().crossVectors(right, fwd).normalize();
  const L = (sceneInfo?.span || 1) * 0.5;
  const hw = L * Math.tan(THREE.MathUtils.degToRad(hfovDeg) / 2);
  const hh = hw / camera.aspect;
  const ctr = e.clone().add(fwd.clone().multiplyScalar(L));
  const corner = (sx, sy) => ctr.clone()
    .add(right.clone().multiplyScalar(sx * hw))
    .add(tup.clone().multiplyScalar(sy * hh));
  const c = [corner(1, 1), corner(-1, 1), corner(-1, -1), corner(1, -1)];
  const pts = [
    e, c[0], e, c[1], e, c[2], e, c[3],
    c[0], c[1], c[1], c[2], c[2], c[3], c[3], c[0],
  ];
  const g = new THREE.BufferGeometry().setFromPoints(pts);
  frustums.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x5b6b86, transparent: true, opacity: 0.55 })));
}

// ----------------------------------------------------------------------------
// Actions
// ----------------------------------------------------------------------------
function noiseSpec() {
  return {
    pixelNoisePx: +$('nPix').value,
    poseNoiseDeg: +$('nDeg').value,
    poseNoisePosM: (+$('nPos').value) / 1000,
    dropoutProb: +$('nDrop').value,
  };
}

function frameView() {
  const c = sceneInfo.centroid, r = sceneInfo.suggestedRadius;
  controls.target.set(c[0], c[1], c[2]);
  camera.position.set(c[0], c[1] + sceneInfo.span * 0.3, c[2] + r);
  controls.update();
}

async function newScene() {
  try {
    sceneInfo = await api('/api/scene', {
      fixture: $('fixture').value, leds: +$('leds').value, scale: +$('scale').value,
    });
    renderGroundTruth(sceneInfo.leds);
    clearObject(solvedObj); solvedObj = null;
    clearObject(errorLines); errorLines = null;
    frustums.clear();
    frameView();
    await refreshState();
    clearSolveStats();
    toast(`Scene: ${sceneInfo.fixture}, ${sceneInfo.ledCount} LEDs`);
  } catch (e) { toast(e.message, true); }
}

async function captureView() {
  if (!sceneInfo) return toast('Make a scene first', true);
  const eye = [camera.position.x, camera.position.y, camera.position.z];
  const target = [controls.target.x, controls.target.y, controls.target.z];
  try {
    const r = await api('/api/capture', { eye, target, hfov: +$('hfov').value, noise: noiseSpec() });
    addFrustum(eye, target, +$('hfov').value);
    setState(r.totalViews, r.totalDetections);
    toast(`Captured ${r.added} LEDs (${r.visible} visible)`);
    if ($('autoSolve').checked) await solve();
  } catch (e) { toast(e.message, true); }
}

async function autoArc() {
  if (!sceneInfo) return toast('Make a scene first', true);
  const n = Math.max(2, +$('arcViews').value);
  const arc = THREE.MathUtils.degToRad(+$('arcDeg').value);
  const c = sceneInfo.centroid, r = sceneInfo.suggestedRadius, span = sceneInfo.span;
  const hfov = +$('hfov').value, noise = noiseSpec();
  try {
    for (let i = 0; i < n; i++) {
      const a = -arc / 2 + arc * (i / (n - 1));
      const vert = span * 0.25 * Math.cos(Math.PI * (i / (n - 1) - 0.5));
      const eye = [c[0] + r * Math.sin(a), c[1] + vert, c[2] + r * Math.cos(a)];
      const target = [c[0], c[1], c[2]];
      const res = await api('/api/capture', { eye, target, hfov, noise, seed: i });
      addFrustum(eye, target, hfov);
      setState(res.totalViews, res.totalDetections);
    }
    toast(`Auto-arc: ${n} captures`);
    await solve();
  } catch (e) { toast(e.message, true); }
}

async function solve() {
  if (!sceneInfo) return;
  try {
    const r = await api('/api/solve', {
      minViews: +$('minViews').value, minParallaxDeg: +$('minPar').value,
    });
    renderSolution(r);
    showSolveStats(r);
  } catch (e) { toast(e.message, true); }
}

async function resetCaptures() {
  try {
    await api('/api/reset', {});
    frustums.clear();
    clearObject(solvedObj); solvedObj = null;
    clearObject(errorLines); errorLines = null;
    setState(0, 0); clearSolveStats();
    toast('Captures cleared');
  } catch (e) { toast(e.message, true); }
}

// ----------------------------------------------------------------------------
// Stats / state
// ----------------------------------------------------------------------------
function setState(views, det) { $('sViews').textContent = views; $('sDet').textContent = det; }
async function refreshState() { const s = await api('/api/state'); setState(s.views, s.detections); }

function fmtErr(m) {
  if (m < 0.01) return `${(m * 1000).toFixed(2)} mm`;
  return `${m.toFixed(3)} m`;
}
function cls(m, span) {
  const frac = m / (span || 1);
  return frac < 0.005 ? 'good' : frac < 0.02 ? 'warn' : 'bad';
}
function showSolveStats(r) {
  const span = sceneInfo.span;
  $('sSolved').textContent = `${r.solvedCount} / ${r.ledCount}`;
  $('sSolved').className = 'num ' + (r.solvedCount >= r.ledCount * 0.95 ? 'good' : r.solvedCount >= r.ledCount * 0.7 ? 'warn' : 'bad');
  const mean = $('sMean'), max = $('sMax');
  mean.textContent = fmtErr(r.meanErrorM); mean.className = 'num ' + cls(r.meanErrorM, span);
  max.textContent = fmtErr(r.maxErrorM); max.className = 'num ' + cls(r.maxErrorM, span);
  $('sRms').textContent = r.map.stats.rmsReprojPxGlobal.toFixed(2);
  $('sPar').textContent = r.map.stats.medianParallaxDeg.toFixed(1) + '°';
  $('sTime').textContent = r.solveMs.toFixed(0) + ' ms';
}
function clearSolveStats() {
  ['sSolved', 'sMean', 'sMax', 'sRms', 'sPar', 'sTime'].forEach((id) => {
    $(id).textContent = id === 'sSolved' ? '0 / 0' : '—'; $(id).className = 'num';
  });
}

// ----------------------------------------------------------------------------
// Wire up UI
// ----------------------------------------------------------------------------
async function init() {
  const { fixtures } = await api('/api/fixtures');
  const sel = $('fixture');
  fixtures.forEach((f) => { const o = document.createElement('option'); o.value = o.textContent = f; sel.appendChild(o); });
  sel.value = fixtures.includes('cube') ? 'cube' : fixtures[0];

  $('newScene').onclick = newScene;
  $('capture').onclick = captureView;
  $('autoArc').onclick = autoArc;
  $('solve').onclick = solve;
  $('reset').onclick = resetCaptures;
  [['hfov', 'hfovVal'], ['nPix', 'nPixVal'], ['nDeg', 'nDegVal'], ['nPos', 'nPosVal'], ['nDrop', 'nDropVal']]
    .forEach(([inp, out]) => { const u = () => $(out).textContent = $(inp).value; $(inp).oninput = u; u(); });

  await newScene(); // start with a default scene
}
init().catch((e) => toast('Init failed: ' + e.message, true));
