// three.js viewer for a Revit 3D view exported by RevitThreeExport (C#).
// build.mjs bundles it with three.js into one HTML template that the DLL embeds;
// the exporter puts the .glb into <script id="model-glb"> as gzip + base64.
// The viewer also still reads the prototype's sources: plain base64 text, or
// data-src="model.glb" / a gzip-base64 .txt beside the page.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { explodeOffsets } from './explode.js';
import {
  OPERATORS, FACETS, FIELDS, NONE, emptyFilter, filterActive, matches, searchText, facetValues,
  operatorNeedsValue, fieldValue,
} from './filter.js';
import { colourScheme, valueKey, SLOTS, BINS } from './colour.js';
import { Cuts } from './cuts.js';
import { Measure } from './measure.js';
import { REVIT_AXES, snapNormal, nearestWithin, metres, toRevit } from './geom.js';

const $ = (s) => document.querySelector(s);
const viewport = $('#viewport');
const statusEl = $('#status');
const statusText = $('#status-text');
const statusBar = $('#status-bar');
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

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

// drawn after the model and never cut: the grid, cut frames and handles, measurements
const overlay = new THREE.Scene();
const noPlanes = [];
const marks = $('#marks');
let measure = null;      // set up after loading (needs the model's Revit offset)
const cuts = new Cuts(overlay, () => renderCuts());

function resize() {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  measure?.setSize(w, h);
}
new ResizeObserver(resize).observe(viewport);

// the tools column sits under the header and above the hint: follow their heights
function trackHeight(el, cssVar) {
  const set = () => document.documentElement.style.setProperty(cssVar, `${el.offsetHeight}px`);
  new ResizeObserver(set).observe(el);
  set();
}
trackHeight($('#head'), '--head-h');
trackHeight($('#hint'), '--hint-h');

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
    tag.textContent = '';   // the text can be tens of MB; the bytes are kept instead
    statusText.textContent = 'Unpacking model…';
    const gz = fromBase64(text.trim());
    const stream = new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).arrayBuffer();
  }
  if (src) return (await download(src)).buffer;
  const bytes = fromBase64(tag.textContent.trim());
  tag.textContent = '';
  return bytes.buffer;
}

let model = null;
let grid = null;
let glbBytes = null;     // the .glb, for "Download .glb"
let docInfo = {};        // root node extras: document, view, exportedAt ...
let modelRadius = 1;     // bounding radius: the largest explode displacement

/**
 * One record per Revit element, independent of how it is drawn:
 *   obj     the element's node (three.js object, userData = metadata)
 *   d       metadata, text (lower-case search text)
 *   box0    world bounding box before any explode; center0 its centre; orig the node position
 *   offset  current explode offset (from -> to while animating)
 *   match   passes the filter; shown: visible; ghost: drawn as a faint ghost, not pickable
 */
const elements = [];
const byObject = new Map();
const baseMaterial = new WeakMap();   // mesh -> its own material (ghost/highlight swap it)

async function init() {
  const buf = await modelBuffer();
  glbBytes = buf;
  statusText.textContent = 'Preparing model…';
  const gltf = await new GLTFLoader().parseAsync(buf, '');
  model = gltf.scene;
  scene.add(model);
  model.updateMatrixWorld(true);

  model.traverse((o) => {
    if (!(o.userData?.id && o.userData?.category)) return;
    const e = {
      i: elements.length, obj: o, d: o.userData, text: searchText(o.userData), meshes: [],
      box0: new THREE.Box3().setFromObject(o), orig: o.position.clone(),
      offset: new THREE.Vector3(), from: new THREE.Vector3(), to: new THREE.Vector3(),
      match: true, shown: true, ghost: false,
    };
    e.center0 = e.box0.getCenter(new THREE.Vector3());
    o.traverse((m) => { if (m.isMesh) { baseMaterial.set(m, m.material); e.meshes.push(m); } });
    elements.push(e);
    byObject.set(o, e);
  });
  docInfo = model.children[0]?.userData ?? {};

  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  modelRadius = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 0.5);
  fillHeader(docInfo, size);

  const span = Math.max(size.x, size.z);
  const step = span > 200 ? 50 : 10;
  const cells = Math.ceil((span * 1.4) / step);
  gridSpec = { size: cells * step, cells, y: box.min.y - 0.01 };
  applyTheme();

  fit(model, false);
  setupTools();
  statusEl.hidden = true;
}

function fillHeader(info, size) {
  const name = info.document ?? 'Revit model';
  $('#doc-title').textContent = name;
  const counts = {};
  for (const e of elements) counts[e.d.category] = (counts[e.d.category] ?? 0) + 1;
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
  if (grid) { overlay.remove(grid); grid.geometry.dispose(); grid.material.dispose(); }
  grid = new THREE.GridHelper(gridSpec.size, gridSpec.cells, major, minor);
  grid.position.y = gridSpec.y;
  grid.material.transparent = true;
  grid.material.opacity = 0.85;
  overlay.add(grid);
  if (colour.scheme) refreshColourTheme();
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

// ---------- camera fit ----------
/** Current bounds: for the model, the shown (not ghosted) elements where they are now. */
function boundsOf(obj) {
  if (obj.isBox3) return obj.clone();
  if (obj !== model) return new THREE.Box3().setFromObject(obj);
  const b = new THREE.Box3();
  for (const e of elements) if (e.shown && !e.ghost) b.union(e.box0.clone().translate(e.offset));
  if (b.isEmpty()) b.setFromObject(model);
  // with a section box, what is left of the model is inside it
  if (cuts.box) {
    const inside = b.clone().intersect(cuts.box.box);
    if (!inside.isEmpty()) return inside;
  }
  return b;
}

let flight = null;
function fit(obj, animate = true) {
  const box = boundsOf(obj);
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
  if (!animate || reducedMotion()) {
    controls.target.copy(sphere.center);
    camera.position.copy(to);
    controls.update();
    return;
  }
  flight = { t: 0, fromPos: camera.position.clone(), fromTgt: controls.target.clone(), toPos: to, toTgt: sphere.center.clone() };
}

// ---------- materials: own, highlighted (selected) or ghost ----------
const ghostMaterial = new THREE.MeshStandardMaterial({
  color: 0xc3c8cf, transparent: true, opacity: 0.1, depthWrite: false, side: THREE.DoubleSide,
});
const highlights = new Map();
function highlightOf(base) {
  let hl = highlights.get(base);
  if (!hl) {
    hl = base.clone();
    hl.emissive = new THREE.Color(0x1f6feb);
    hl.emissiveIntensity = 0.55;
    highlights.set(base, hl);
  }
  return hl;
}
function paint(e) {
  const sel = selected === e.obj;
  for (const m of e.meshes) {
    let mat = baseMaterial.get(m);
    if (colour.scheme) mat = colourMaterial(colour.byMesh ? meshTone.get(m) : e.tone, mat);
    m.material = e.ghost ? ghostMaterial : sel ? highlightOf(mat) : mat;
  }
}

// colour by parameter: one material per colour (and transparency), shared by all meshes
const colourMats = new Map();
function colourMaterial(tone, base) {
  const hex = colour.tones[tone] || '#a0a0a0';
  const opacity = base.transparent ? base.opacity : 1;
  const key = `${hex}|${opacity}`;
  let m = colourMats.get(key);
  if (!m) {
    // like the exported materials: matte, double-sided, see-through ones keep their transparency
    m = new THREE.MeshStandardMaterial({
      color: new THREE.Color(hex), roughness: 0.85, metalness: 0, side: THREE.DoubleSide,
      transparent: opacity < 1, opacity, depthWrite: opacity >= 1,
    });
    m.name = `colour ${hex}`;
    colourMats.set(key, m);
  }
  return m;
}

// ---------- picking ----------
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let selected = null;

function rayFrom(ev) {
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  return raycaster;
}

/**
 * The first hit along the raycaster's ray on what can be seen: the raycaster also hits
 * hidden, ghosted and cut-away geometry, so skip those. min: ignore hits closer than this.
 */
function firstHit(min = 0) {
  for (const hit of raycaster.intersectObject(model, true)) {
    if (hit.distance < min) continue;
    let o = hit.object;
    while (o && !byObject.has(o)) o = o.parent;
    const e = o && byObject.get(o);
    if (e && e.shown && !e.ghost && cuts.isKept(hit.point)) {
      // the face normal in world space, towards the viewer
      const normal = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : new THREE.Vector3(0, 1, 0);
      if (normal.dot(raycaster.ray.direction) > 0) normal.negate();
      return { e, obj: o, mesh: hit.object, face: hit.face, point: hit.point.clone(), normal, distance: hit.distance };
    }
  }
  return null;
}

function elementAt(ev) {
  rayFrom(ev);
  const hit = firstHit();
  return hit && { obj: hit.obj, point: hit.point, normal: hit.normal };
}

/** For measuring: the surface point under the pointer, or a corner of that face within 12 px. */
function surfaceAt(ev) {
  rayFrom(ev);
  const hit = firstHit();
  if (!hit) return null;
  let point = hit.point, snapped = false;
  if (hit.face) {
    const pos = hit.mesh.geometry.attributes.position;
    const corners = [hit.face.a, hit.face.b, hit.face.c].map((i) =>
      new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(hit.mesh.matrixWorld));
    const W = viewport.clientWidth, H = viewport.clientHeight;
    const screen = corners.map((c) => {
      if (!cuts.isKept(c)) return null;
      const v = c.clone().project(camera);
      return [((v.x + 1) / 2) * W, ((1 - v.y) / 2) * H];
    });
    const r = renderer.domElement.getBoundingClientRect();
    const k = nearestWithin(screen, [ev.clientX - r.left, ev.clientY - r.top], 12);
    if (k >= 0) { point = corners[k]; snapped = true; }
  }
  return { ...hit, hit: hit.point, point, snapped, anchor: { e: hit.e, local: point.clone().sub(hit.e.offset) } };
}

/** Selects an element (or nothing). point, normal: where it was clicked, for the Hide / Isolate / Cut bar. */
function select(obj, point = null, normal = null) {
  if (selected === obj) {
    if (obj && point) showPick(byObject.get(obj), point, normal);
    return;
  }
  const prev = selected;
  selected = obj;
  if (prev) paint(byObject.get(prev));
  if (obj) {
    const e = byObject.get(obj);
    paint(e);
    showPanel(obj);
    showPick(e, point, normal);
  } else {
    hidePanel();
    hidePick();
  }
  document.body.classList.toggle('inspecting', !!obj);
  markListSelection();
}

// Cut handles: grabbed before OrbitControls sees the pointer (capture on the parent)
viewport.addEventListener('pointerdown', (ev) => {
  if (!model || ev.button !== 0 || !cuts.count) return;
  const h = cuts.handleAt(rayFrom(ev));
  if (!h || !cuts.beginDrag(h, raycaster.ray)) return;
  ev.stopPropagation();
  ev.preventDefault();
  viewport.setPointerCapture?.(ev.pointerId);
  viewport.classList.add('dragging');
}, { capture: true });
viewport.addEventListener('pointermove', (ev) => {
  if (cuts.drag) { cuts.dragTo(rayFrom(ev).ray); return; }
  if (!ev.buttons) hoverAt = ev;   // handled once per frame; not while orbiting
});
const endDrag = (ev) => {
  if (!cuts.drag) return;
  cuts.endDrag();
  viewport.releasePointerCapture?.(ev.pointerId);
  viewport.classList.remove('dragging');
};
viewport.addEventListener('pointerup', endDrag);
viewport.addEventListener('pointercancel', endDrag);
viewport.addEventListener('pointerleave', () => { hoverAt = null; if (measureMode()) measure.preview(null); });

/**
 * Pointer moves: handle cursor, and the measuring preview. A raycast on a big model takes
 * tens of milliseconds without a spatial index: at most one every 50 ms.
 */
let hoverAt = null, lastHover = 0;
function hover() {
  if (!hoverAt || !model || cuts.drag) return;
  const now = performance.now();
  if (now - lastHover < 50) return;   // keep the pointer position for a later frame
  lastHover = now;
  const ev = hoverAt;
  hoverAt = null;
  const onHandle = cuts.count > 0 && !!cuts.handleAt(rayFrom(ev));
  viewport.classList.toggle('on-handle', onHandle);
  if (measureMode()) {
    const s = onHandle ? null : surfaceAt(ev);
    measure.preview(s?.anchor ?? null, s?.snapped, mState.first);
  }
}

let down = null;
renderer.domElement.addEventListener('pointerdown', (ev) => { down = { x: ev.clientX, y: ev.clientY, t: performance.now() }; });
renderer.domElement.addEventListener('pointerup', (ev) => {
  if (!down || !model || ev.button !== 0) return;
  const moved = Math.hypot(ev.clientX - down.x, ev.clientY - down.y);
  if (moved < 6 && performance.now() - down.t < 600) {
    if (measureMode()) measureClick(ev);
    else {
      const hit = elementAt(ev);
      select(hit?.obj ?? null, hit?.point, hit?.normal);
    }
  }
  down = null;
});
renderer.domElement.addEventListener('dblclick', () => model && fit(model));
$('#fit').addEventListener('click', () => model && fit(model));

// Revit's shortcuts for temporary hide / isolate: HH, HI, HC, IC, HR
let chord = null;
window.addEventListener('keydown', (ev) => {
  if (ev.target.closest?.('input, textarea, select')) return;
  const k = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
  if (ev.ctrlKey || ev.metaKey || ev.altKey) {
    if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && k === 'z' && model) { ev.preventDefault(); undoVisibility(); }
    return;
  }
  const e = selected && byObject.get(selected);
  if (chord && performance.now() - chord.t < 1500) {
    const pair = chord.key + k;
    chord = null;
    const act = { hh: ['hide', 'element'], hi: ['isolate', 'element'], hc: ['hide', 'category'], ic: ['isolate', 'category'] }[pair];
    if (act && e) { runScope(act[0], act[1], e); return; }
    if (pair === 'hr') { showAll(); return; }
  }
  chord = null;
  if ((k === 'h' || k === 'i') && model) { chord = { key: k, t: performance.now() }; return; }
  if (k === 'Escape') {
    if (!pickMenu.hidden) closePickMenu(true);
    else if (measureMode()) escapeMeasuring();
    else select(null);
  }
  if (k === 'f' && model) fit(selected ?? model);
});

// ---------- inspect panel ----------
const panel = $('#panel');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const ICONS = {
  copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/></svg>',
  colour: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 0 0 18c1.4 0 2-1 2-2 0-1.4-1.2-1.8-1.2-3 0-1.1.9-2 2-2H17a4 4 0 0 0 4-4c0-3.9-4-7-9-7z"/><circle cx="7.5" cy="11" r="1.2"/><circle cx="10.5" cy="7" r="1.2"/><circle cx="15" cy="7.5" r="1.2"/></svg>',
  filter: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16l-6.2 7.4V19l-3.6-1.8v-4.8z"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  hide: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6z"/><circle cx="12" cy="12" r="2.6"/><path d="M4 20 20 4"/></svg>',
  cut: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M8.1 8.1 20 19M8.1 15.9 20 5"/></svg>',
  isolate: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8.5" y="8.5" width="7" height="7" rx="1"/><path d="M3 7V4.5A1.5 1.5 0 0 1 4.5 3H7M17 3h2.5A1.5 1.5 0 0 1 21 4.5V7M21 17v2.5a1.5 1.5 0 0 1-1.5 1.5H17M7 21H4.5A1.5 1.5 0 0 1 3 19.5V17" stroke-dasharray="2 2.2"/></svg>',
};
// phones: Hide / Isolate in the inspect sheet (the floating bar has no room there)
const SHEET_ACTIONS = '<div class="pactions">' + ['hide', 'isolate', 'cut'].map((a) => {
  const label = { hide: 'Hide', isolate: 'Isolate', cut: 'Cut' }[a];
  return `<div class="split"><button class="pk-main" type="button" data-act="${a}">${ICONS[a]}${label}</button>` +
    `<button class="pk-more" type="button" data-act="${a}" aria-haspopup="menu" aria-expanded="false" aria-label="More ways to ${a}">▼</button></div>`;
}).join('') + '</div>';
const ACTS = '<span class="acts">' +
  `<button type="button" data-a="copy" title="Copy value" aria-label="Copy value">${ICONS.copy}</button>` +
  `<button type="button" data-a="colour" title="Colour by this parameter" aria-label="Colour by this parameter">${ICONS.colour}</button>` +
  `<button type="button" data-a="filter" title="Filter on value" aria-label="Filter on value">${ICONS.filter}</button></span>`;

/** A property row. field: the name Filter and Colour use; raw: the value a filter rule compares. */
const propRow = (label, field, shown, raw = shown) =>
  `<tr data-f="${esc(field)}" data-v="${esc(raw)}"><th>${esc(label)}</th><td><span class="val">${esc(shown)}</span>${ACTS}</td></tr>`;

function swatches(obj) {
  const seen = new Map();
  obj.traverse((m) => {
    if (!m.isMesh) return;
    const mat = baseMaterial.get(m) ?? m.material;
    if (!seen.has(mat.name)) seen.set(mat.name, mat.userData?.rgb ?? [160, 160, 160]);
  });
  return [...seen].map(([name, rgb]) =>
    `<li data-f="Material" data-v="${esc(name)}"><span class="sw" style="background:rgb(${rgb.join(',')})"></span>` +
    `<span class="val">${esc(name)}</span>${ACTS}</li>`).join('');
}

function table(obj) {
  return Object.keys(obj ?? {}).sort((a, b) => a.localeCompare(b)).map((k) => propRow(k, k, obj[k])).join('');
}

function showPanel(obj) {
  const d = obj.userData;
  const rows = [
    ['Category', 'Category', d.category], ['Family', 'Family', d.family], ['Type', 'Type', d.type],
    ['Level', 'Level', d.level], ['Mark', 'Mark', d.mark], ['Comments', 'Comments', d.comments],
    ['Volume', 'Volume (m³)', d.volume_m3 ? `${d.volume_m3.toLocaleString(undefined, { maximumFractionDigits: 3 })} m³` : null, d.volume_m3],
    ['Linked model', 'Link', d.link],
  ].filter(([, , v]) => v != null && v !== '');
  const nInst = Object.keys(d.params ?? {}).length, nType = Object.keys(d.typeParams ?? {}).length;
  panel.innerHTML = `
    <header>
      <span class="chip">${esc(d.category)}</span>
      <button class="icon" id="close" type="button" title="Close (Esc)" aria-label="Close">×</button>
    </header>
    <h2>${esc(d.type || d.family || 'Element')}</h2>
    <div class="idrow">
      <span>Element ID</span><code>${esc(d.id)}</code>
      <button id="copy" class="ghost" type="button">Copy</button>
      <button id="zoom" class="ghost" type="button">Zoom to</button>
    </div>
    ${SHEET_ACTIONS}
    <table class="key">${rows.map((r) => propRow(...r)).join('')}</table>
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
    if (await copyText(String(d.id))) btn.textContent = 'Copied';
    else {
      const range = document.createRange();
      range.selectNodeContents(panel.querySelector('.idrow code'));
      getSelection().removeAllRanges(); getSelection().addRange(range);
      btn.textContent = 'Selected';
    }
    setTimeout(() => { btn.textContent = 'Copy'; }, 1400);
  };
}
function hidePanel() { panel.hidden = true; panel.innerHTML = ''; }

// row actions; on touch screens a tap on the row shows them
panel.addEventListener('click', async (ev) => {
  const item = ev.target.closest('[data-f]');
  const b = ev.target.closest('.acts button');
  if (!item) return;
  if (!b) {
    const open = !item.classList.contains('open');
    for (const x of panel.querySelectorAll('.open')) x.classList.remove('open');
    item.classList.toggle('open', open);
    return;
  }
  const field = item.dataset.f, value = item.dataset.v;
  if (b.dataset.a === 'copy') {
    const ok = await copyText(item.querySelector('.val').textContent);
    const icon = b.innerHTML;
    b.innerHTML = ok ? ICONS.check : icon;
    b.title = ok ? 'Copied' : 'Copy failed';
    setTimeout(() => { b.innerHTML = icon; b.title = 'Copy value'; }, 1400);
  } else if (b.dataset.a === 'colour') {
    colourBy(field);
  } else {
    filterOnValue(field, value);
  }
});

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* try the old way */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;left:-9999px;top:0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

// ---------- explode ----------
const explode = { mode: 'centre', f: 0, anim: null };

let moved = false;        // explode moved elements this frame: measurements follow
function place(e) { e.obj.position.copy(e.orig).add(e.offset); moved = true; }

/** Moves every element towards its explode target (animated unless reduced motion). */
function updateExplode(animate = true) {
  const items = elements.map((e) => ({ center: [e.center0.x, e.center0.y, e.center0.z], category: e.d.category, shown: e.shown }));
  const targets = explodeOffsets(items, explode.mode, explode.f, modelRadius);
  elements.forEach((e, i) => { e.from.copy(e.offset); e.to.fromArray(targets[i]); });
  if (!animate || reducedMotion()) {
    for (const e of elements) { e.offset.copy(e.to); place(e); }
    explode.anim = null;
    return;
  }
  explode.anim = { start: performance.now(), duration: 450 };
}

function stepExplode(now) {
  const a = explode.anim;
  if (!a) return;
  const t = Math.min((now - a.start) / a.duration, 1);
  const k = ease(t);
  for (const e of elements) {
    if (t >= 1) e.offset.copy(e.to);   // exact end values: 0 % restores the original positions
    else e.offset.lerpVectors(e.from, e.to, k);
    place(e);
  }
  if (t >= 1) explode.anim = null;
}

function setupExplode() {
  const amount = $('#explode-amount'), value = $('#explode-value');
  const setAmount = (pct) => {
    explode.f = pct / 100;
    amount.value = String(pct);
    value.textContent = `${pct}%`;
    updateExplode();
  };
  amount.addEventListener('input', () => setAmount(Number(amount.value)));
  $('#explode-reset').addEventListener('click', () => setAmount(0));
  for (const b of document.querySelectorAll('#explode-mode button')) {
    b.addEventListener('click', () => {
      explode.mode = b.dataset.mode;
      for (const x of document.querySelectorAll('#explode-mode button')) x.setAttribute('aria-pressed', String(x === b));
      updateExplode();
    });
  }
}

// ---------- filter ----------
const filter = emptyFilter();
let resultMode = 'isolate';     // isolate | ghost | hide
let listOrder = [];              // elements sorted for the results list
const LIST_LIMIT = 300;
const canonicalName = new Map(); // lower-case parameter name -> name as written in the model
const resolveName = (n) => canonicalName.get(n.toLocaleLowerCase()) ?? n;

function debounce(fn, ms) {
  let t = 0;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function applyFilter() {
  const active = filterActive(filter);
  let n = 0;
  for (const e of elements) {
    e.match = !active || matches(e, filter, resolveName);
    if (e.match) n++;
  }
  $('#f-count').textContent = active ? `${n} of ${elements.length} elements` : `${elements.length} elements`;
  const badge = $('#tb-filter-n');
  badge.hidden = !active;
  badge.textContent = String(n);
  applyVisibility();
}
const applyFilterSoon = debounce(applyFilter, 120);

// ---------- hide / isolate (on top of the filter) ----------
// hidden: elements hidden by hand; isolated: when set, only these can show.
const manual = { hidden: new Set(), isolated: null, undo: [] };
const handHidden = (e) => manual.hidden.has(e.i) || (manual.isolated != null && !manual.isolated.has(e.i));

/** Shows, hides and ghosts every element from the filter result and the hand-made hide / isolate. */
function applyVisibility() {
  const active = filterActive(filter);
  for (const e of elements) {
    let shown = true, ghost = false;
    if (active) {
      if (resultMode === 'isolate') shown = e.match;
      else if (resultMode === 'ghost') ghost = !e.match;
      else shown = !e.match;
    }
    if (handHidden(e)) { shown = false; ghost = false; }
    const repaint = ghost !== e.ghost;
    e.shown = shown;
    e.ghost = ghost;
    e.obj.visible = shown;
    if (repaint) paint(e);
  }
  if (selected) {
    const s = byObject.get(selected);
    if (!s.shown || s.ghost) select(null);
  }
  renderList();
  renderVisibility();
  syncLegend();
  if (explode.f > 0) updateExplode();
}

function remember() {
  manual.undo.push({ hidden: new Set(manual.hidden), isolated: manual.isolated && new Set(manual.isolated) });
  if (manual.undo.length > 50) manual.undo.shift();
}
function hideElements(list) {
  remember();
  for (const e of list) manual.hidden.add(e.i);
  applyVisibility();
}
function isolateElements(list) {
  remember();
  manual.isolated = new Set(list.map((e) => e.i));
  for (const e of list) manual.hidden.delete(e.i);
  applyVisibility();
}
/** Makes hand-hidden elements visible again (the filter still applies). */
function revealElements(list) {
  remember();
  for (const e of list) { manual.hidden.delete(e.i); manual.isolated?.add(e.i); }
  applyVisibility();
}
function showAll() {
  if (!manual.hidden.size && !manual.isolated) return;
  remember();
  manual.hidden.clear();
  manual.isolated = null;
  applyVisibility();
}
function undoVisibility() {
  const last = manual.undo.pop();
  if (!last) return;
  manual.hidden = last.hidden;
  manual.isolated = last.isolated;
  applyVisibility();
}

function renderVisibility() {
  const h = manual.hidden.size, iso = manual.isolated;
  const n = (k) => `${k} element${k === 1 ? '' : 's'}`;
  $('#vis').hidden = !h && !iso;
  $('#vis-text').textContent = [iso && `Isolated: ${n(iso.size)}`, h && `Hidden: ${n(h)}`].filter(Boolean).join(' · ');
  $('#vis-undo').disabled = !manual.undo.length;
}

/** Elements like e: the same element, type, family, category or level. */
const SCOPES = [
  { id: 'element', label: 'This element', like: (x, e) => x === e },
  { id: 'type', label: 'Same type', like: (x, e) => x.d.category === e.d.category && x.d.family === e.d.family && x.d.type === e.d.type },
  { id: 'family', label: 'Same family', like: (x, e) => x.d.category === e.d.category && x.d.family === e.d.family },
  { id: 'category', label: 'Same category', like: (x, e) => x.d.category === e.d.category },
  { id: 'level', label: 'Same level', like: (x, e) => !!e.d.level && x.d.level === e.d.level, when: (e) => !!e.d.level },
];
const alike = (e, scope) => elements.filter((x) => SCOPES.find((s) => s.id === scope).like(x, e));
const CUT_OPTIONS = [
  { id: 'plane', label: 'Add cut', title: 'A section plane on the clicked face; drag the arrow to move it' },
  { id: 'box', label: 'Box cut', title: 'A section box around this element; drag the arrows to resize it' },
];
function runScope(action, scope, e) {
  if (action === 'cut') { if (scope === 'box') boxCut(e); else planeCut(e); return; }
  const list = alike(e, scope);
  if (action === 'hide') hideElements(list); else isolateElements(list);
}

// ---------- Hide / Isolate: a bar at the clicked point (in the inspect sheet on phones) ----------
const pickBar = $('#pick'), pickDot = $('#pick-dot'), pickMenu = $('#pk-menu');
const pickAt = new THREE.Vector3();     // the clicked point, without the explode offset
const pickNdc = new THREE.Vector3();
let pickSize = null;

let pickNormal = null;                  // the clicked face's normal, towards the viewer
function showPick(e, point, normal = null) {
  pickAt.copy(point ? point.clone().sub(e.offset) : e.center0);
  pickNormal = point && normal ? normal.clone() : null;
  closePickMenu();
  pickBar.hidden = false;
  pickDot.hidden = false;
  pickSize = { w: pickBar.offsetWidth, h: pickBar.offsetHeight };
  placePick();
}
function hidePick() {
  closePickMenu();
  pickBar.hidden = true;
  pickDot.hidden = true;
}

/** Where the bar and dot may go: the window, less the inspect panel (right side, or bottom on phones). */
function freeArea() {
  const W = viewport.clientWidth, H = viewport.clientHeight, g = 8;
  const a = { l: g, t: g, r: W - g, b: H - g };
  if (!panel.hidden) {
    const p = panel.getBoundingClientRect();
    if (p.left > W * 0.3) a.r = p.left - g; else a.b = p.top - g;
  }
  return a;
}

/** Keeps the bar beside the clicked point as the camera moves; the dot only while the point is in view. */
function placePick() {
  if (pickBar.hidden || !selected) return;
  const e = byObject.get(selected);
  pickNdc.copy(pickAt).add(e.offset).project(camera);
  const W = viewport.clientWidth, H = viewport.clientHeight;
  const x = ((pickNdc.x + 1) / 2) * W, y = ((1 - pickNdc.y) / 2) * H;
  const a = freeArea();
  const front = pickNdc.z < 1;
  const inside = front && x >= a.l && x <= a.r && y >= a.t && y <= a.b;
  pickDot.style.visibility = inside ? '' : 'hidden';
  if (inside) pickDot.style.transform = `translate(${x}px, ${y}px)`;
  if (!front || !pickSize.w) return;   // behind the camera, or the bar is not shown (phones)
  const { w, h } = pickSize;
  const px = Math.max(a.l, Math.min(x - w / 2, a.r - w));
  let py = y - h - 18;
  if (py < a.t) py = y + 18;
  py = Math.max(a.t, Math.min(py, a.b - h));
  pickBar.style.transform = `translate(${Math.round(px)}px, ${Math.round(py)}px)`;
}

/** The menu of a ▼ button: this element, same type, family, category or level. */
function openPickMenu(action, opener) {
  const e = byObject.get(selected);
  const verb = { hide: 'Hide', isolate: 'Isolate', cut: 'Cut' }[action];
  pickMenu.innerHTML = action === 'cut'
    ? CUT_OPTIONS.map((o) => `<button type="button" role="menuitem" data-scope="${o.id}" title="${esc(o.title)}"><span>${esc(o.label)}</span></button>`).join('')
    : SCOPES.filter((s) => !s.when || s.when(e)).map((s) => {
      const n = s.id === 'element' ? 1 : alike(e, s.id).length;
      const what = { type: e.d.type, family: e.d.family, category: e.d.category, level: e.d.level }[s.id];
      return `<button type="button" role="menuitem" data-scope="${s.id}" title="${esc(verb)}${what ? `: ${esc(what)}` : ''}">` +
        `<span>${esc(s.label)}</span><span class="n">${n}</span></button>`;
    }).join('');
  pickMenu.dataset.action = action;
  pickMenu.setAttribute('aria-label', `${verb}…`);
  for (const b of document.querySelectorAll('.pk-more')) b.setAttribute('aria-expanded', String(b === opener));
  pickMenu.hidden = false;
  // under the button, or above it when there is no room below
  const r = opener.closest('.pk-act, .split').getBoundingClientRect();
  const mw = pickMenu.offsetWidth, mh = pickMenu.offsetHeight, W = innerWidth, H = innerHeight;
  const left = Math.max(8, Math.min(r.left, W - mw - 8));
  const top = r.bottom + 6 + mh <= H - 8 ? r.bottom + 6 : Math.max(8, r.top - 6 - mh);
  pickMenu.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  pickMenu.querySelector('button')?.focus();
}
function closePickMenu(refocus = false) {
  if (pickMenu.hidden) return;
  const opener = document.querySelector('.pk-more[aria-expanded="true"]');
  pickMenu.hidden = true;
  for (const b of document.querySelectorAll('.pk-more')) b.setAttribute('aria-expanded', 'false');
  if (refocus) opener?.focus();
}

function setupPick() {
  // the floating bar and the row in the inspect sheet share these handlers
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest('.pk-main[data-act], .pk-more[data-act]');
    if (!b || !selected) return;
    if (b.classList.contains('pk-main')) runScope(b.dataset.act, b.dataset.act === 'cut' ? 'plane' : 'element', byObject.get(selected));
    else if (!pickMenu.hidden && b.getAttribute('aria-expanded') === 'true') closePickMenu();
    else openPickMenu(b.dataset.act, b);
  });
  $('#pk-close').addEventListener('click', () => select(null));
  pickMenu.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-scope]');
    if (!b || !selected) return;
    const action = pickMenu.dataset.action;
    closePickMenu();
    runScope(action, b.dataset.scope, byObject.get(selected));
  });
  pickMenu.addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
    ev.preventDefault();
    const items = [...pickMenu.querySelectorAll('button')];
    const i = items.indexOf(document.activeElement);
    items[(i + (ev.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
  });
  // the menu stays where it opened: close it when the view moves or something else is clicked
  document.addEventListener('pointerdown', (ev) => {
    if (!pickMenu.hidden && !pickMenu.contains(ev.target) && !ev.target.closest('.pk-more')) closePickMenu();
  });
  renderer.domElement.addEventListener('wheel', () => closePickMenu(), { passive: true });
  $('#vis-undo').addEventListener('click', undoVisibility);
  $('#vis-all').addEventListener('click', showAll);
}

function renderList() {
  const list = $('#f-list');
  const shownItems = listOrder.filter((e) => e.match);
  const items = shownItems.slice(0, LIST_LIMIT).map((e) =>
    `<li><button type="button" data-i="${e.i}"${selected === e.obj ? ' aria-current="true"' : ''}${handHidden(e) ? ' class="off"' : ''}>` +
    `<span class="cat">${esc(e.d.category)}</span><span class="nm">${esc(e.d.type || e.d.family || '')}</span>` +
    `<code>${esc(e.d.id)}</code></button></li>`);
  if (shownItems.length > LIST_LIMIT) {
    items.push(`<li class="more">…and ${shownItems.length - LIST_LIMIT} more. Narrow the filter to list them.</li>`);
  }
  if (!shownItems.length) items.push('<li class="more">No element matches.</li>');
  list.innerHTML = items.join('');
}

function markListSelection() {
  for (const b of document.querySelectorAll('#f-list button[aria-current]')) b.removeAttribute('aria-current');
  if (!selected) return;
  const e = byObject.get(selected);
  document.querySelector(`#f-list button[data-i="${e.i}"]`)?.setAttribute('aria-current', 'true');
}

function buildFacets() {
  const host = $('#f-facets');
  host.innerHTML = '';
  for (const f of FACETS) {
    const counts = new Map();
    for (const e of elements) for (const v of new Set(facetValues(e.d, f))) counts.set(v, (counts.get(v) ?? 0) + 1);
    const values = [...counts.keys()].sort((a, b) =>
      (a === NONE) - (b === NONE) || a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    const det = document.createElement('details');
    det.className = 'facet';
    det.dataset.facet = f.key;
    det.innerHTML =
      `<summary>${esc(f.label)} <span>${values.length}</span><span class="off" hidden></span></summary>` +
      '<div class="fl-actions"><button type="button" class="link" data-all>All</button>' +
      '<button type="button" class="link" data-none>None</button></div>' +
      `<ul class="fl">${values.map((v) =>
        `<li><label><input type="checkbox" checked value="${esc(v)}"><span class="v">${esc(v)}</span>` +
        `<span class="c">${counts.get(v)}</span></label></li>`).join('')}</ul>`;
    const excluded = filter.excluded[f.key];
    const off = det.querySelector('.off');
    const sync = () => {
      for (const cb of det.querySelectorAll('input')) cb.checked = !excluded.has(cb.value);
      off.hidden = !excluded.size;
      off.textContent = `${excluded.size} off`;
    };
    det.addEventListener('change', (ev) => {
      const cb = ev.target;
      if (cb.checked) excluded.delete(cb.value); else excluded.add(cb.value);
      sync();
      applyFilter();
    });
    det.querySelector('[data-all]').onclick = () => { excluded.clear(); sync(); applyFilter(); };
    det.querySelector('[data-none]').onclick = () => { for (const v of values) excluded.add(v); sync(); applyFilter(); };
    det.sync = sync;
    host.appendChild(det);
  }
}

function renderRules() {
  const host = $('#f-rules');
  host.innerHTML = '';
  filter.rules.forEach((rule, idx) => {
    const row = document.createElement('div');
    row.className = 'rule';
    row.innerHTML =
      `<input class="field r-name" list="f-names" placeholder="Parameter, e.g. Volume" aria-label="Parameter" value="${esc(rule.name)}">` +
      `<select class="field r-op" aria-label="Operator">${OPERATORS.map((o) =>
        `<option value="${o.id}"${o.id === rule.op ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>` +
      `<input class="field r-val" placeholder="Value" aria-label="Value" value="${esc(rule.value)}">` +
      '<button type="button" class="icon r-del" title="Remove this rule" aria-label="Remove this rule">×</button>';
    const val = row.querySelector('.r-val');
    const syncValue = () => { val.disabled = !operatorNeedsValue(rule.op); };
    row.querySelector('.r-name').addEventListener('input', (ev) => { rule.name = ev.target.value; applyFilterSoon(); });
    row.querySelector('.r-op').addEventListener('change', (ev) => { rule.op = ev.target.value; syncValue(); applyFilter(); });
    val.addEventListener('input', () => { rule.value = val.value; applyFilterSoon(); });
    row.querySelector('.r-del').addEventListener('click', () => { filter.rules.splice(idx, 1); renderRules(); applyFilter(); });
    syncValue();
    host.appendChild(row);
  });
  $('#f-combine-wrap').hidden = filter.rules.length < 2;
}

function setupFilter() {
  // parameter names for the rule autocomplete: every instance and type parameter, plus fields
  const names = new Set(Object.keys(FIELDS));
  for (const e of elements) {
    for (const k of Object.keys(e.d.params ?? {})) names.add(k);
    for (const k of Object.keys(e.d.typeParams ?? {})) names.add(k);
  }
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  for (const n of sorted) if (!canonicalName.has(n.toLocaleLowerCase())) canonicalName.set(n.toLocaleLowerCase(), n);
  $('#f-names').innerHTML = sorted.map((n) => `<option value="${esc(n)}"></option>`).join('');

  listOrder = [...elements].sort((a, b) =>
    String(a.d.category).localeCompare(String(b.d.category)) ||
    String(a.d.type ?? '').localeCompare(String(b.d.type ?? ''), undefined, { numeric: true }) || a.d.id - b.d.id);
  buildFacets();
  renderRules();

  const search = $('#f-search');
  search.addEventListener('input', () => { filter.search = search.value; applyFilterSoon(); });
  search.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') applyFilter(); });
  for (const b of document.querySelectorAll('#f-mode button')) {
    b.addEventListener('click', () => {
      resultMode = b.dataset.mode;
      for (const x of document.querySelectorAll('#f-mode button')) x.setAttribute('aria-pressed', String(x === b));
      applyFilter();
    });
  }
  $('#f-add').addEventListener('click', () => {
    filter.rules.push({ name: '', op: 'eq', value: '' });
    renderRules();
    $('#f-rules').lastElementChild?.querySelector('.r-name')?.focus();
  });
  $('#f-combine').addEventListener('change', (ev) => { filter.combine = ev.target.value; applyFilter(); });
  $('#f-clear').addEventListener('click', () => {
    const fresh = emptyFilter();
    filter.search = '';
    filter.rules = fresh.rules;
    filter.combine = 'and';
    for (const f of FACETS) filter.excluded[f.key].clear();
    search.value = '';
    $('#f-combine').value = 'and';
    for (const det of document.querySelectorAll('#f-facets details')) det.sync();
    renderRules();
    applyFilter();
  });
  $('#f-list').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-i]');
    if (!b) return;
    const e = elements[Number(b.dataset.i)];
    if (handHidden(e)) revealElements([e]);   // picked from the list: show it again
    select(e.obj);
    fit(e.obj);
  });
  $('#f-copy').addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    const chosen = elements.filter((e) => e.match);
    // elements of linked models have IDs of the link document: Revit's Select by ID can't use them
    const ids = chosen.filter((e) => !e.d.link).map((e) => e.d.id);
    const skipped = chosen.length - ids.length;
    const ok = ids.length > 0 && await copyText(ids.join(','));
    btn.textContent = !ids.length ? 'No IDs to copy' : ok ? `Copied ${ids.length} IDs` : 'Copy failed';
    btn.title = skipped ? `${skipped} elements from linked models were left out` : btn.title;
    setTimeout(() => { btn.textContent = 'Copy filtered IDs'; }, 1800);
  });
  applyFilter();
}

// ---------- tools ----------
// opening the Measure panel starts measuring; closing it stops
const PANEL_HOOKS = { measure: (open) => (open ? startMeasuring() : stopMeasuring()) };
function setPanel(button, section, open) {
  const was = !section.hidden;
  section.hidden = !open;
  button.setAttribute('aria-expanded', String(open));
  if (was !== open) PANEL_HOOKS[section.id]?.(open);
}
function togglePanel(button, section, open = section.hidden) {
  // phones have room for one tool panel at a time
  if (open && matchMedia('(max-width: 640px)').matches) {
    for (const b of document.querySelectorAll('#tools .tool[aria-controls]')) {
      if (b !== button) setPanel(b, document.getElementById(b.getAttribute('aria-controls')), false);
    }
  }
  setPanel(button, section, open);
}

// ---------- cuts ----------
/** Add cut: a plane on the clicked face that keeps what is behind it; from the list, a plan cut through the middle. */
function planeCut(e) {
  const size = THREE.MathUtils.clamp(e.box0.getSize(new THREE.Vector3()).length() * 1.2, 1, modelRadius * 1.5);
  if (pickNormal) {
    cuts.addPlane(pickAt.clone().add(e.offset), snapNormal(pickNormal).negate(), size);
  } else {
    cuts.addPlane(e.center0.clone().add(e.offset), new THREE.Vector3(0, -1, 0), size);
  }
}

/** Box cut: a section box a little bigger than the element, and the view fitted to it. */
function boxCut(e) {
  const b = e.box0.clone().translate(e.offset);
  b.expandByScalar(Math.max(b.getSize(new THREE.Vector3()).length() * 0.05, 0.05));
  cuts.setBox(b);
  fit(b);
}

let cutsKey = '';
function renderCuts() {
  const card = $('#cuts'), list = $('#cut-list');
  card.hidden = !cuts.count;
  const key = cuts.items.map((i) => i.id).join(',') + (cuts.box ? ',box' : '');
  const range = Math.ceil(Math.max(modelRadius * 2, 1));   // whole metres: the 0.01 m steps count from it
  if (key !== cutsKey) {
    cutsKey = key;
    list.innerHTML = cuts.items.map((item, n) =>
      `<li data-id="${item.id}"><span class="cl">Cut ${n + 1}</span>` +
      `<input type="range" min="${-range}" max="${range}" step="0.01" value="${item.offset}" aria-label="Move cut ${n + 1}">` +
      `<output></output><button type="button" class="ghost" data-a="flip" title="Keep the other side">Flip</button>` +
      `<button type="button" class="icon" data-a="remove" title="Remove this cut" aria-label="Remove cut ${n + 1}">×</button></li>`).join('') +
      (cuts.box ? '<li data-id="box"><span class="cl">Box</span><span class="note">Drag the arrows to resize</span>' +
        '<button type="button" class="ghost" data-a="fit">Zoom to</button>' +
        '<button type="button" class="icon" data-a="remove" title="Remove the section box" aria-label="Remove the section box">×</button></li>' : '');
  }
  for (const item of cuts.items) {
    const li = list.querySelector(`li[data-id="${item.id}"]`);
    const input = li.querySelector('input');
    if (document.activeElement !== input) input.value = String(item.offset);
    li.querySelector('output').textContent = `${item.offset >= 0 ? '+' : '−'}${metres(Math.abs(item.offset))} m`;
  }
  $('#cut-count').textContent = cuts.count ? `${cuts.count}` : '';
}

function setupCuts() {
  const list = $('#cut-list');
  const itemOf = (li) => (li.dataset.id === 'box' ? cuts.box : cuts.items.find((i) => String(i.id) === li.dataset.id));
  list.addEventListener('input', (ev) => {
    const li = ev.target.closest('li');
    const item = li && itemOf(li);
    if (item?.kind === 'plane') cuts.setOffset(item, Number(ev.target.value));
  });
  list.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-a]');
    const item = b && itemOf(b.closest('li'));
    if (!item) return;
    if (b.dataset.a === 'remove') cuts.remove(item);
    else if (b.dataset.a === 'flip') cuts.flip(item);
    else if (b.dataset.a === 'fit') fit(item.box);
  });
  $('#cut-clear').addEventListener('click', () => cuts.clear());
}

// ---------- measure ----------
const mState = { mode: 'distance', active: false, first: null, note: '' };
const measureMode = () => mState.active && !!measure;
const MEASURE_NOTES = {
  distance: 'Click two points. A corner within a few pixels is snapped to.',
  distance2: 'Click the second point. Esc starts again.',
  laser: 'Click a surface: the laser measures to the nearest surfaces along Revit X, Y and Z.',
  point: 'Click a point for its Revit coordinates (metres, from the internal origin).',
};

function startMeasuring() {
  mState.active = true;
  mState.first = null;
  mState.note = '';
  viewport.classList.add('measuring');
  syncMeasure();
}
function stopMeasuring() {
  mState.active = false;
  mState.first = null;
  measure?.preview(null);
  viewport.classList.remove('measuring');
  syncMeasure();
}
function escapeMeasuring() {
  if (mState.first) { mState.first = null; measure.preview(null); syncMeasure(); return; }
  togglePanel($('#tb-measure'), $('#measure'), false);
}

function syncMeasure() {
  for (const b of document.querySelectorAll('#m-mode button')) b.setAttribute('aria-pressed', String(mState.active && b.dataset.mode === mState.mode));
  const key = mState.mode === 'distance' && mState.first ? 'distance2' : mState.mode;
  $('#m-note').textContent = mState.note || MEASURE_NOTES[key];
}

function measureClick(ev) {
  const s = surfaceAt(ev);
  if (!s) return;
  mState.note = '';
  if (mState.mode === 'point') measure.addPoint(s.anchor);
  else if (mState.mode === 'distance') {
    if (!mState.first) { mState.first = s.anchor; syncMeasure(); return; }
    measure.addDistance(mState.first, s.anchor);
    mState.first = null;
    measure.preview(null);
  } else {
    laser(s);
  }
  syncMeasure();
  renderMeasures();
}

/** Rays along Revit X, Y and Z from the clicked surface; not into the surface itself. */
function laser(s) {
  if (explode.f > 0) { mState.note = 'Reset Explode first: the laser measures the model as built.'; return; }
  const start = s.hit.clone();
  const origin = start.clone().addScaledVector(s.normal, 0.002);   // just off the surface
  const hits = [];
  for (const [axis, dir] of Object.entries(REVIT_AXES)) {
    for (const sign of [1, -1]) {
      const d = dir.clone().multiplyScalar(sign);
      if (d.dot(s.normal) < -0.5) continue;
      raycaster.set(origin, d);
      raycaster.far = modelRadius * 8;
      const h = firstHit(0.001);
      if (h) hits.push({ axis, sign, anchor: { e: h.e, local: h.point.clone().sub(h.e.offset) }, d: h.point.distanceTo(start) });
    }
  }
  raycaster.far = Infinity;
  if (!hits.length) { mState.note = 'Nothing along X, Y or Z from there: try a surface with something beside, above or below it.'; return; }
  measure.addLaser({ e: s.e, local: start.clone().sub(s.e.offset) }, hits);
}

function renderMeasures() {
  const list = $('#m-list');
  list.innerHTML = measure.items.map((item, n) => {
    const { title, detail } = measure.describe(item);
    return `<li data-id="${item.id}"><span class="mn">${n + 1}</span><span class="mt"><b>${esc(title)}</b><span>${esc(detail)}</span></span>` +
      `<button type="button" class="icon" title="Remove" aria-label="Remove measurement ${n + 1}">×</button></li>`;
  }).join('');
  $('#m-clear').disabled = !measure.items.length;
}

function setupMeasure() {
  measure = new Measure(overlay, marks, () => docInfo.revitOffsetMetres);
  measure.setSize(viewport.clientWidth, viewport.clientHeight);
  for (const b of document.querySelectorAll('#m-mode button')) {
    b.addEventListener('click', () => {
      mState.mode = b.dataset.mode;
      mState.first = null;
      mState.note = '';
      measure.preview(null);
      if (!mState.active) startMeasuring(); else syncMeasure();
    });
  }
  $('#m-list').addEventListener('click', (ev) => {
    const li = ev.target.closest('button') && ev.target.closest('li');
    const item = li && measure.items.find((i) => String(i.id) === li.dataset.id);
    if (item) { measure.remove(item); renderMeasures(); }
  });
  $('#m-clear').addEventListener('click', () => { measure.clear(); renderMeasures(); });
  renderMeasures();
  syncMeasure();
}

// ---------- colour by parameter ----------
// field: parameter name; kind: auto | values | range. Material colours each part of an
// element by its own material (meshTone); other fields colour the whole element (e.tone).
const colour = { field: '', kind: 'auto', scheme: null, byMesh: false, tones: {} };
const meshTone = new Map();
const TONES = [...Array.from({ length: SLOTS }, (_, i) => `s${i + 1}`), ...Array.from({ length: BINS }, (_, i) => `q${i + 1}`), 'other', 'none'];
const OTHER_LIST_LIMIT = 200;

function readTones() {
  const css = getComputedStyle(document.documentElement);
  return Object.fromEntries(TONES.map((t) => [t, css.getPropertyValue(`--cb-${t}`).trim()]));
}

const meshMaterialName = (m) => baseMaterial.get(m).name || 'Default';

function applyColour() {
  const name = colour.field.trim() ? resolveName(colour.field.trim()) : '';
  meshTone.clear();
  if (!name) {
    colour.scheme = null;
    for (const e of elements) { e.tone = null; e.colourEntries = null; }
  } else {
    colour.byMesh = name === 'Material';
    const items = elements.map((e) => colour.byMesh
      ? [...new Set(e.meshes.map(meshMaterialName))]
      : valueKey(fieldValue(e.d, name)));
    const s = colourScheme(items, colour.kind);
    colour.scheme = s;
    elements.forEach((e, i) => {
      if (colour.byMesh) {
        for (const m of e.meshes) meshTone.set(m, s.entries[s.entryOf(meshMaterialName(m))].tone);
        e.tone = null;
        e.colourEntries = [...new Set(items[i].map((k) => s.entryOf(k)))];
      } else {
        const idx = s.entryOf(items[i]);
        e.tone = s.entries[idx].tone;
        e.colourEntries = [idx];
      }
    });
  }
  colour.tones = readTones();
  for (const e of elements) paint(e);
  renderLegend();
}

/** Theme switched: the colours come from the page tokens, so rebuild the colour materials. */
function refreshColourTheme() {
  colour.tones = readTones();
  for (const m of colourMats.values()) {
    highlights.get(m)?.dispose();
    highlights.delete(m);
    m.dispose();
  }
  colourMats.clear();
  for (const e of elements) paint(e);
}

function renderLegend() {
  const s = colour.scheme;
  const legend = $('#c-legend'), note = $('#c-note');
  const field = colour.field.trim() ? resolveName(colour.field.trim()) : '';
  for (const b of document.querySelectorAll('#c-quick button')) b.setAttribute('aria-pressed', String(b.dataset.field === field));
  $('#tb-colour-dot').hidden = !s;
  const kinds = document.querySelectorAll('#c-kind button');
  for (const b of kinds) {
    b.setAttribute('aria-pressed', String(!!s && b.dataset.kind === s.kind));
    b.disabled = !s || (b.dataset.kind === 'range' && !s.canRange);
  }
  if (!s) {
    legend.innerHTML = '';
    note.textContent = 'Pick a parameter: each value gets its own colour. Clicked properties have a colour button too.';
    return;
  }
  const valued = s.entries.filter((en) => en.tone !== 'none');
  if (s.kind === 'range') {
    note.textContent = `Up to ${BINS} steps with about as many elements in each, light (small) to dark (large). Untick a row to hide those elements.`;
  } else {
    const other = s.entries.find((en) => en.tone === 'other');
    const nValues = valued.length - (other ? 1 : 0) + (other ? other.keys.length : 0);
    note.textContent = other
      ? `${nValues} values: the ${SLOTS} most common have colours, the rest are grey. Untick a row to hide those elements.`
      : `${nValues} value${nValues === 1 ? '' : 's'}. Untick a row to hide those elements.`;
  }
  legend.innerHTML = s.entries.map((en, i) => {
    let more = '';
    if (en.keys?.length) {
      const shown = en.keys.slice(0, OTHER_LIST_LIMIT).map((k) =>
        `<li><span class="v">${esc(k.label)}</span><span class="c">${k.count}</span></li>`).join('');
      const extra = en.keys.length > OTHER_LIST_LIMIT ? `<li>…and ${en.keys.length - OTHER_LIST_LIMIT} more</li>` : '';
      more = `<details><summary>${en.keys.length} value${en.keys.length === 1 ? '' : 's'}</summary><ul>${shown}${extra}</ul></details>`;
    }
    return `<li><label><input type="checkbox" checked data-entry="${i}">` +
      `<span class="sw" style="background:var(--cb-${en.tone})"></span><span class="v">${esc(en.label)}</span>` +
      `<span class="c">${en.count}</span></label>${more}</li>`;
  }).join('');
  syncLegend();
}

/** Legend ticks follow hide / isolate: a row is ticked while any of its elements may show. */
function syncLegend() {
  const s = colour.scheme;
  if (!s) return;
  const on = new Array(s.entries.length).fill(false);
  for (const e of elements) if (!handHidden(e)) for (const i of e.colourEntries) on[i] = true;
  for (const cb of document.querySelectorAll('#c-legend input[data-entry]')) cb.checked = on[Number(cb.dataset.entry)];
}

function colourBy(field) {
  colour.field = field;
  colour.kind = 'auto';
  $('#c-field').value = field;
  togglePanel($('#tb-colour'), $('#colour'), true);
  applyColour();
}

function setupColour() {
  const input = $('#c-field');
  const known = (v) => canonicalName.has(v.trim().toLocaleLowerCase());
  // apply when the name is complete: a known parameter while typing, anything on Enter / leaving the box
  input.addEventListener('input', () => {
    if (!input.value.trim() || known(input.value)) { colour.field = input.value; colour.kind = 'auto'; applyColour(); }
  });
  input.addEventListener('change', () => {
    if (input.value !== colour.field) { colour.field = input.value; colour.kind = 'auto'; applyColour(); }
  });
  $('#c-quick').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-field]');
    if (b) colourBy(b.dataset.field);
  });
  for (const b of document.querySelectorAll('#c-kind button')) {
    b.addEventListener('click', () => { colour.kind = b.dataset.kind; applyColour(); });
  }
  $('#c-off').addEventListener('click', () => { colour.field = ''; input.value = ''; applyColour(); });
  $('#c-legend').addEventListener('change', (ev) => {
    const cb = ev.target.closest('input[data-entry]');
    if (!cb) return;
    const i = Number(cb.dataset.entry);
    const group = elements.filter((e) => e.colourEntries?.includes(i));
    if (cb.checked) revealElements(group); else hideElements(group);
  });
  renderLegend();
}

/** "Filter on value" in the inspect panel: one rule, field = value, in place of an earlier one for the field. */
function filterOnValue(field, value) {
  const rule = String(value ?? '').trim() === ''
    ? { name: field, op: 'hasnot', value: '' }
    : { name: field, op: 'eq', value: String(value) };
  const key = field.toLocaleLowerCase();
  const i = filter.rules.findIndex((r) => r.name.trim().toLocaleLowerCase() === key && (r.op === 'eq' || r.op === 'hasnot'));
  if (i >= 0) filter.rules[i] = rule; else filter.rules.push(rule);
  renderRules();
  togglePanel($('#tb-filter'), $('#filter'), true);
  applyFilter();
}

function downloadGlb() {
  const name = `${docInfo.document ?? 'model'}_${docInfo.view ?? 'view'}`.replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_');
  const url = URL.createObjectURL(new Blob([glbBytes], { type: 'model/gltf-binary' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}.glb`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function setupTools() {
  setupExplode();
  setupFilter();
  setupColour();
  setupPick();
  setupCuts();
  setupMeasure();
  for (const b of document.querySelectorAll('#tools .tool[aria-controls]')) {
    const section = document.getElementById(b.getAttribute('aria-controls'));
    b.addEventListener('click', () => togglePanel(b, section));
  }
  $('#f-close').addEventListener('click', () => togglePanel($('#tb-filter'), $('#filter'), false));
  $('#c-close').addEventListener('click', () => togglePanel($('#tb-colour'), $('#colour'), false));
  $('#m-close').addEventListener('click', () => togglePanel($('#tb-measure'), $('#measure'), false));
  $('#tb-download').addEventListener('click', downloadGlb);
  $('#side').hidden = false;
}

// ---------- loop ----------
const ease = (t) => 1 - Math.pow(1 - t, 3);
renderer.setAnimationLoop((now) => {
  stepExplode(now ?? performance.now());
  if (flight) {
    flight.t = Math.min(flight.t + 1 / 30, 1);
    const k = ease(flight.t);
    camera.position.lerpVectors(flight.fromPos, flight.toPos, k);
    controls.target.lerpVectors(flight.fromTgt, flight.toTgt, k);
    if (flight.t >= 1) flight = null;
  }
  controls.update();
  hover();
  placePick();
  if (measure) {
    if (moved) measure.refresh();
    measure.place(camera, viewport.clientWidth, viewport.clientHeight);
  }
  moved = false;
  cuts.scaleHandles(camera, viewport.clientHeight);
  // the model with the cuts; then the grid, cut handles and measurements, uncut, on top
  renderer.clippingPlanes = cuts.planes;
  renderer.render(scene, camera);
  renderer.autoClear = false;
  renderer.clippingPlanes = noPlanes;
  renderer.render(overlay, camera);
  renderer.autoClear = true;
});

// ---------- a small read-only API, for tests and the browser console ----------
let readyResolve;
const ready = new Promise((r) => { readyResolve = r; });
window.viewer = {
  ready,
  elements: () => elements.map((e) => ({
    id: e.d.id, category: e.d.category, link: e.d.link ?? null, match: e.match, shown: e.shown, ghost: e.ghost,
    position: e.obj.position.toArray(), original: e.orig.toArray(),
    tones: colour.scheme ? [...new Set(e.meshes.map((m) => (colour.byMesh ? meshTone.get(m) : e.tone)))] : null,
    // the colours drawn now (sRGB hex), one per mesh
    colours: e.meshes.map((m) => `#${m.material.color.getHexString()}`),
    box: (() => { const b = e.box0.clone().translate(e.offset); return [b.min.toArray(), b.max.toArray()]; })(),
  })),
  state: () => ({
    explode: { mode: explode.mode, amount: explode.f, animating: !!explode.anim },
    filterActive: filterActive(filter), resultMode,
    selected: selected ? selected.userData.id : null,
    hidden: manual.hidden.size, isolated: manual.isolated ? manual.isolated.size : null, undo: manual.undo.length,
    colour: colour.scheme ? {
      field: resolveName(colour.field.trim()), kind: colour.scheme.kind, canRange: colour.scheme.canRange,
      entries: colour.scheme.entries.map(({ label, tone, count }) => ({ label, tone, count })),
      tones: colour.tones,
    } : null,
    cuts: {
      planes: cuts.items.map((i) => ({ offset: i.offset, normal: i.normal.toArray(), constant: i.plane.constant })),
      box: cuts.box ? [cuts.box.box.min.toArray(), cuts.box.box.max.toArray()] : null,
    },
    measure: { active: mState.active, mode: mState.mode, first: !!mState.first },
  }),
  /** Measurements in Revit metres. */
  measures: () => (measure ? measure.items.map((i) => ({
    kind: i.kind, d: i.d ?? null, delta: i.delta ?? null, at: i.at ?? null, origin: i.origin ?? null, spans: i.spans ?? null,
    points: i.anchors.map((a) => measure.revit(a)), text: measure.describe(i),
  })) : []),
  /** Screen position (client px) of a point in viewer space, and the Revit coordinates of it. */
  project(p) {
    const v = new THREE.Vector3(...p).project(camera);
    const r = renderer.domElement.getBoundingClientRect();
    return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
  },
  toRevit: (p) => toRevit(new THREE.Vector3(...p), docInfo.revitOffsetMetres),
  /** Screen positions of the cut arrows: { kind: 'plane' | 'box', axis, side, at }. */
  handles() {
    const out = [];
    const r = renderer.domElement.getBoundingClientRect();
    const scr = (h) => {
      const v = h.getWorldPosition(new THREE.Vector3()).project(camera);
      return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
    };
    cuts.items.forEach((i) => out.push({ kind: 'plane', at: scr(i.handle) }));
    cuts.box?.handles.forEach((h) => {
      const { axis, side } = h.userData.grab.userData.handle;
      out.push({ kind: 'box', axis, side, at: scr(h) });
    });
    return out;
  },
  /** Screen position (client px) of an element's current centre. */
  screenPoint(id) {
    const e = elements.find((x) => x.d.id === id);
    if (!e) return null;
    const c = e.center0.clone().add(e.offset).project(camera);
    const r = renderer.domElement.getBoundingClientRect();
    return [r.left + ((c.x + 1) / 2) * r.width, r.top + ((1 - c.y) / 2) * r.height];
  },
};

resize();
init().then(() => readyResolve(true)).catch((err) => {
  console.error(err);
  statusText.textContent = 'Could not load the model: ' + err.message;
  statusEl.classList.add('error');
  readyResolve(false);
});
