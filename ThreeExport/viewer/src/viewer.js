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
  operatorNeedsValue,
} from './filter.js';

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

function resize() {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
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
/** Current bounds: for the model, the shown (not ghosted) elements where they are now. */
function boundsOf(obj) {
  if (obj !== model) return new THREE.Box3().setFromObject(obj);
  const b = new THREE.Box3();
  for (const e of elements) if (e.shown && !e.ghost) b.union(e.box0.clone().translate(e.offset));
  return b.isEmpty() ? new THREE.Box3().setFromObject(model) : b;
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
    const base = baseMaterial.get(m);
    m.material = e.ghost ? ghostMaterial : sel ? highlightOf(base) : base;
  }
}

// ---------- picking ----------
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let selected = null;

function elementAt(ev) {
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  // the raycaster also hits hidden objects: take the first element that is shown and not a ghost
  for (const hit of raycaster.intersectObject(model, true)) {
    let o = hit.object;
    while (o && !byObject.has(o)) o = o.parent;
    const e = o && byObject.get(o);
    if (e && e.shown && !e.ghost) return o;
  }
  return null;
}

function select(obj) {
  if (selected === obj) return;
  const prev = selected;
  selected = obj;
  if (prev) paint(byObject.get(prev));
  if (obj) { paint(byObject.get(obj)); showPanel(obj); } else hidePanel();
  document.body.classList.toggle('inspecting', !!obj);
  markListSelection();
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
  if (ev.target.closest?.('input, textarea, select')) return;
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
    const mat = baseMaterial.get(m) ?? m.material;
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
    ['Linked model', d.link],
  ].filter(([, v]) => v != null && v !== '');
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

function place(e) { e.obj.position.copy(e.orig).add(e.offset); }

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
    let shown = true, ghost = false;
    if (active) {
      if (resultMode === 'isolate') shown = e.match;
      else if (resultMode === 'ghost') ghost = !e.match;
      else shown = !e.match;
    }
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
  $('#f-count').textContent = active ? `${n} of ${elements.length} elements` : `${elements.length} elements`;
  const badge = $('#tb-filter-n');
  badge.hidden = !active;
  badge.textContent = String(n);
  renderList();
  if (explode.f > 0) updateExplode();
}
const applyFilterSoon = debounce(applyFilter, 120);

function renderList() {
  const list = $('#f-list');
  const shownItems = listOrder.filter((e) => e.match);
  const items = shownItems.slice(0, LIST_LIMIT).map((e) =>
    `<li><button type="button" data-i="${e.i}"${selected === e.obj ? ' aria-current="true"' : ''}>` +
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
function togglePanel(button, section, open = section.hidden) {
  section.hidden = !open;
  button.setAttribute('aria-expanded', String(open));
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
  const tbExplode = $('#tb-explode'), tbFilter = $('#tb-filter');
  tbExplode.addEventListener('click', () => togglePanel(tbExplode, $('#explode')));
  tbFilter.addEventListener('click', () => togglePanel(tbFilter, $('#filter')));
  $('#f-close').addEventListener('click', () => togglePanel(tbFilter, $('#filter'), false));
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
  renderer.render(scene, camera);
});

// ---------- a small read-only API, for tests and the browser console ----------
let readyResolve;
const ready = new Promise((r) => { readyResolve = r; });
window.viewer = {
  ready,
  elements: () => elements.map((e) => ({
    id: e.d.id, category: e.d.category, link: e.d.link ?? null, match: e.match, shown: e.shown, ghost: e.ghost,
    position: e.obj.position.toArray(), original: e.orig.toArray(),
  })),
  state: () => ({
    explode: { mode: explode.mode, amount: explode.f, animating: !!explode.anim },
    filterActive: filterActive(filter), resultMode,
    selected: selected ? selected.userData.id : null,
  }),
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
