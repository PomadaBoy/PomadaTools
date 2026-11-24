// three.js viewer for a Revit 3D view exported by RevitThreeExport (C#).
// build.mjs bundles it with three.js into one HTML template that the DLL embeds;
// the exporter puts the .glb into <script id="model-glb"> as gzip + base64.
// The viewer also still reads the prototype's sources: plain base64 text, or
// data-src="model.glb" / a gzip-base64 .txt beside the page.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const $ = (s) => document.querySelector(s);
const viewport = $('#viewport');
const statusEl = $('#status');
const statusText = $('#status-text');
const statusBar = $('#status-bar');

// ---------- renderer / scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
viewport.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 5000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.screenSpacePanning = true;

scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f99, 1.9));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(0.6, 1, 0.4);
scene.add(sun);

function resize() {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(viewport);

// ---------- load model ----------
function fromBase64(b64) {
  if (Uint8Array.fromBase64) return Uint8Array.fromBase64(b64);
  const bin = atob(b64), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// download with a progress bar; returns the raw bytes
async function download(src) {
  const res = await fetch(src);
  if (!res.ok) throw new Error(`${src}: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const parts = [];
  const reader = res.body.getReader();
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    const mb = (got / 1048576).toFixed(1);
    if (total) statusBar.style.width = `${Math.min(100, Math.round((got / total) * 100))}%`;
    statusText.textContent = total
      ? `Loading model… ${mb} of ${(total / 1048576).toFixed(1)} MB`
      : `Loading model… ${mb} MB`;
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// Model sources, from <script id="model-glb">:
//   data-encoding="gzip-base64"             gzipped .glb as base64: inline text (the Revit
//                                           exporter's offline file) or data-src (web page,
//                                           artifact hosts don't serve .glb)
//   data-src                                plain .glb beside the page
//   text content                            offline file, base64 .glb
async function modelBuffer() {
  const tag = $('#model-glb');
  const { src, encoding } = tag.dataset;
  if (encoding === 'gzip-base64') {
    const text = src ? new TextDecoder().decode(await download(src)) : tag.textContent;
    statusText.textContent = 'Unpacking model…';
    const gz = fromBase64(text.trim());
    const stream = new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).arrayBuffer();
  }
  if (src) return (await download(src)).buffer;
  return fromBase64(tag.textContent.trim()).buffer;
}

let model = null;
let grid = null;
const elements = [];

async function init() {
  const buf = await modelBuffer();
  statusText.textContent = 'Preparing model…';
  const gltf = await new GLTFLoader().parseAsync(buf, '');
  model = gltf.scene;
  scene.add(model);

  model.traverse((o) => { if (o.userData?.id && o.userData?.category) elements.push(o); });
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  fillHeader(model.children[0]?.userData ?? {}, size);

  const span = Math.max(size.x, size.z);
  const step = span > 200 ? 50 : 10;
  const cells = Math.ceil((span * 1.4) / step);
  gridSpec = { size: cells * step, cells, y: box.min.y - 0.01 };
  applyTheme();

  fit(model, false);
  statusEl.hidden = true;
}

function fillHeader(info, size) {
  const name = info.document ?? 'Revit model';
  $('#doc-title').textContent = name;
  const counts = {};
  for (const e of elements) counts[e.userData.category] = (counts[e.userData.category] ?? 0) + 1;
  const m = (v) => v.toLocaleString(undefined, { maximumFractionDigits: 1 });
  $('#doc-meta').textContent =
    `Revit view "${info.view ?? '?'}" · exported ${info.exportedAt ?? '?'} · ` +
    `${m(size.x)} × ${m(size.z)} m in plan, ${m(size.y)} m high`;
  $('#doc-cats').textContent = `${elements.length} elements: ` + Object.entries(counts)
    .sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`).join(' · ');
}

// grid colours follow the page theme (tokens in the template)
let gridSpec = null;
function applyTheme() {
  if (!gridSpec) return;
  const css = getComputedStyle(document.documentElement);
  const major = css.getPropertyValue('--grid-major').trim() || '#b9c0ca';
  const minor = css.getPropertyValue('--grid-minor').trim() || '#d5dae1';
  if (grid) { scene.remove(grid); grid.geometry.dispose(); grid.material.dispose(); }
  grid = new THREE.GridHelper(gridSpec.size, gridSpec.cells, major, minor);
  grid.position.y = gridSpec.y;
  grid.material.transparent = true;
  grid.material.opacity = 0.85;
  scene.add(grid);
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

// ---------- camera fit ----------
let flight = null;
function fit(obj, animate = true) {
  const box = new THREE.Box3().setFromObject(obj);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const r = Math.max(sphere.radius, 0.5);
  // fit inside the narrower of the vertical and horizontal fields of view (portrait phones)
  const halfV = THREE.MathUtils.degToRad(camera.fov / 2);
  const halfH = Math.atan(Math.tan(halfV) * camera.aspect);
  const dist = r / Math.sin(Math.min(halfV, halfH));
  const dir = camera.position.clone().sub(controls.target);
  if (!animate || dir.lengthSq() < 1e-6) dir.set(-0.9, 0.75, 1.1);
  dir.normalize();
  camera.near = Math.max(dist / 1000, 0.05);
  camera.far = dist * 50;
  camera.updateProjectionMatrix();
  const to = sphere.center.clone().add(dir.multiplyScalar(dist));
  if (!animate || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    controls.target.copy(sphere.center);
    camera.position.copy(to);
    controls.update();
    return;
  }
  flight = { t: 0, fromPos: camera.position.clone(), fromTgt: controls.target.clone(), toPos: to, toTgt: sphere.center.clone() };
}

// ---------- picking ----------
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let selected = null;
const savedMaterials = new Map();

function elementAt(ev) {
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.intersectObject(model, true)[0];
  let o = hit?.object;
  while (o && !(o.userData?.id && o.userData?.category)) o = o.parent;
  return o ?? null;
}

function setHighlight(obj, on) {
  obj.traverse((m) => {
    if (!m.isMesh) return;
    if (on) {
      savedMaterials.set(m, m.material);
      const hl = m.material.clone();
      hl.emissive = new THREE.Color(0x1f6feb);
      hl.emissiveIntensity = 0.55;
      m.material = hl;
    } else if (savedMaterials.has(m)) {
      m.material.dispose();
      m.material = savedMaterials.get(m);
      savedMaterials.delete(m);
    }
  });
}

function select(obj) {
  if (selected === obj) return;
  if (selected) setHighlight(selected, false);
  selected = obj;
  if (obj) { setHighlight(obj, true); showPanel(obj); } else hidePanel();
}

let down = null;
renderer.domElement.addEventListener('pointerdown', (ev) => { down = { x: ev.clientX, y: ev.clientY, t: performance.now() }; });
renderer.domElement.addEventListener('pointerup', (ev) => {
  if (!down || !model || ev.button !== 0) return;
  const moved = Math.hypot(ev.clientX - down.x, ev.clientY - down.y);
  if (moved < 6 && performance.now() - down.t < 600) select(elementAt(ev));
  down = null;
});
renderer.domElement.addEventListener('dblclick', () => model && fit(model));
$('#fit').addEventListener('click', () => model && fit(model));
window.addEventListener('keydown', (ev) => {
  if (ev.target.closest?.('input, textarea')) return;
  if (ev.key === 'Escape') select(null);
  if ((ev.key === 'f' || ev.key === 'F') && model) fit(selected ?? model);
});

// ---------- inspect panel ----------
const panel = $('#panel');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function swatches(obj) {
  const seen = new Map();
  obj.traverse((m) => {
    if (!m.isMesh) return;
    const mat = savedMaterials.get(m) ?? m.material;
    if (!seen.has(mat.name)) seen.set(mat.name, mat.userData?.rgb ?? [160, 160, 160]);
  });
  return [...seen].map(([name, rgb]) =>
    `<li><span class="sw" style="background:rgb(${rgb.join(',')})"></span>${esc(name)}</li>`).join('');
}

function table(obj) {
  return Object.keys(obj ?? {}).sort((a, b) => a.localeCompare(b))
    .map((k) => `<tr><th>${esc(k)}</th><td>${esc(obj[k])}</td></tr>`).join('');
}

function showPanel(obj) {
  const d = obj.userData;
  const rows = [
    ['Family', d.family], ['Level', d.level], ['Mark', d.mark], ['Comments', d.comments],
    ['Volume', d.volume_m3 ? `${d.volume_m3.toLocaleString(undefined, { maximumFractionDigits: 3 })} m³` : null],
  ].filter(([, v]) => v != null && v !== '');
  const nInst = Object.keys(d.params ?? {}).length, nType = Object.keys(d.typeParams ?? {}).length;
  panel.innerHTML = `
    <header>
      <span class="chip">${esc(d.category)}</span>
      <button class="icon" id="close" type="button" title="Close (Esc)" aria-label="Close">×</button>
    </header>
    <h2>${esc(d.type || d.family || 'Element')}</h2>
    <div class="idrow">
      <span>Element ID</span><code>${d.id}</code>
      <button id="copy" class="ghost" type="button">Copy</button>
      <button id="zoom" class="ghost" type="button">Zoom to</button>
    </div>
    <table class="key">${rows.map(([k, v]) => `<tr><th>${k}</th><td>${esc(v)}</td></tr>`).join('')}</table>
    <h3>Materials</h3>
    <ul class="mats">${swatches(obj)}</ul>
    <details><summary>Instance parameters <span>${nInst}</span></summary><table>${table(d.params)}</table></details>
    <details><summary>Type parameters <span>${nType}</span></summary><table>${table(d.typeParams)}</table></details>
    <p class="uid">${esc(d.uniqueId)}</p>`;
  panel.hidden = false;
  $('#close').onclick = () => select(null);
  $('#zoom').onclick = () => fit(obj);
  $('#copy').onclick = async (ev) => {
    const btn = ev.currentTarget;
    try { await navigator.clipboard.writeText(String(d.id)); btn.textContent = 'Copied'; }
    catch {
      const range = document.createRange();
      range.selectNodeContents(panel.querySelector('.idrow code'));
      getSelection().removeAllRanges(); getSelection().addRange(range);
      btn.textContent = 'Selected';
    }
    setTimeout(() => { btn.textContent = 'Copy'; }, 1400);
  };
}
function hidePanel() { panel.hidden = true; panel.innerHTML = ''; }

// ---------- loop ----------
const ease = (t) => 1 - Math.pow(1 - t, 3);
renderer.setAnimationLoop(() => {
  if (flight) {
    flight.t = Math.min(flight.t + 1 / 30, 1);
    const k = ease(flight.t);
    camera.position.lerpVectors(flight.fromPos, flight.toPos, k);
    controls.target.lerpVectors(flight.fromTgt, flight.toTgt, k);
    if (flight.t >= 1) flight = null;
  }
  controls.update();
  renderer.render(scene, camera);
});

resize();
init().catch((err) => {
  console.error(err);
  statusText.textContent = 'Could not load the model: ' + err.message;
  statusEl.classList.add('error');
});
