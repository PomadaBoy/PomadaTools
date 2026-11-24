// Measuring: point to point, 3-axis laser and position markers. Points are anchored to the
// element they were taken on (local = point without its explode offset), so they move
// with Explode and the numbers stay the real, unexploded ones.
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { toRevit, metres } from './geom.js';

export const AXIS_COLOURS = { X: '#e34948', Y: '#008300', Z: '#2a78d6' };
const DISTANCE_COLOUR = '#eb6834';

/** Where an anchor is drawn now (with the explode offset). */
export const drawnAt = (a) => (a.e ? a.local.clone().add(a.e.offset) : a.local.clone());
/** Where an anchor really is (no explode). */
const realAt = (a) => a.local.clone();

export class Measure {
  /** overlay: scene drawn on top; host: HTML layer for dots and labels; offset(): revitOffsetMetres */
  constructor(overlay, host, offset) {
    this.overlay = overlay;
    this.host = host;
    this.offset = offset;
    this.items = [];
    this.nextId = 1;
    this.materials = new Map();
    this.size = [1, 1];
    this.snap = host.appendChild(Object.assign(document.createElement('div'), { className: 'msnap', hidden: true }));
    this.rubber = null;      // the line from the first point to the pointer
  }

  revit(a) { return toRevit(realAt(a), this.offset() ?? [0, 0, 0]); }

  material(colour) {
    let m = this.materials.get(colour);
    if (!m) {
      m = new LineMaterial({ color: colour, linewidth: 3, depthTest: false, transparent: true });
      m.resolution.set(...this.size);
      this.materials.set(colour, m);
    }
    return m;
  }

  setSize(w, h) {
    this.size = [w, h];
    for (const m of this.materials.values()) m.resolution.set(w, h);
  }

  line(colour, from, to) {
    const g = new LineGeometry();
    g.setPositions([0, 0, 0, 1, 1, 1]);
    const l = new Line2(g, this.material(colour));
    l.renderOrder = 11;
    l.userData.ends = [from, to];
    this.overlay.add(l);
    this.placeLine(l);
    return l;
  }

  placeLine(l) {
    const [a, b] = l.userData.ends.map((x) => (typeof x === 'function' ? x() : drawnAt(x)));
    l.geometry.setPositions([a.x, a.y, a.z, b.x, b.y, b.z]);
    l.computeLineDistances();
  }

  el(className, text, colour) {
    const d = document.createElement('div');
    d.className = className;
    if (text != null) d.textContent = text;
    if (colour) d.style.setProperty('--mc', colour);
    this.host.appendChild(d);
    return d;
  }

  dot(anchor, colour) { return { el: this.el('mdot', null, colour), at: () => drawnAt(anchor) }; }

  add(item) {
    item.id = this.nextId++;
    this.items.push(item);
    return item;
  }

  addDistance(a, b) {
    const pa = realAt(a), pb = realAt(b);
    const d = pa.distanceTo(pb);
    const ra = this.revit(a), rb = this.revit(b);
    const item = {
      kind: 'distance', anchors: [a, b], d, delta: [rb[0] - ra[0], rb[1] - ra[1], rb[2] - ra[2]],
      lines: [this.line(DISTANCE_COLOUR, a, b)],
      marks: [this.dot(a, DISTANCE_COLOUR), this.dot(b, DISTANCE_COLOUR),
        { el: this.el('mlabel', `${metres(d)} m`, DISTANCE_COLOUR), at: () => drawnAt(a).lerp(drawnAt(b), 0.5) }],
    };
    return this.add(item);
  }

  addPoint(a) {
    const r = this.revit(a);
    const item = {
      kind: 'point', anchors: [a], at: r, lines: [],
      marks: [this.dot(a, '#1b222c'),
        { el: this.el('mlabel mpos', `X ${metres(r[0])}\nY ${metres(r[1])}\nZ ${metres(r[2])}`), at: () => drawnAt(a), above: true }],
    };
    return this.add(item);
  }

  /**
   * hits: [{ axis: 'X'|'Y'|'Z', sign: 1|-1, anchor, d }] (missing when nothing was hit, or
   * when that direction goes into the clicked surface)
   */
  addLaser(origin, hits) {
    const lines = [], marks = [this.dot(origin, '#1b222c')];
    const spans = {};
    for (const axis of ['X', 'Y', 'Z']) {
      const plus = hits.find((h) => h.axis === axis && h.sign > 0);
      const minus = hits.find((h) => h.axis === axis && h.sign < 0);
      spans[axis] = { plus: plus?.d ?? null, minus: minus?.d ?? null, span: plus || minus ? (plus?.d ?? 0) + (minus?.d ?? 0) : null };
      const colour = AXIS_COLOURS[axis];
      for (const h of [plus, minus]) {
        if (!h) continue;
        lines.push(this.line(colour, origin, h.anchor));
        marks.push(this.dot(h.anchor, colour));
        marks.push({ el: this.el('mlabel', `${axis} ${metres(h.d)}`, colour), at: () => drawnAt(origin).lerp(drawnAt(h.anchor), 0.5) });
      }
    }
    return this.add({ kind: 'laser', anchors: [origin, ...hits.map((h) => h.anchor)], origin: this.revit(origin), spans, lines, marks });
  }

  remove(item) {
    for (const l of item.lines) { this.overlay.remove(l); l.geometry.dispose(); }
    for (const m of item.marks) m.el.remove();
    this.items = this.items.filter((x) => x !== item);
  }

  clear() { for (const item of [...this.items]) this.remove(item); }

  /** One line of text for the list. */
  describe(item) {
    if (item.kind === 'distance') {
      const [dx, dy, dz] = item.delta.map((v) => metres(Math.abs(v)));
      return { title: `${metres(item.d)} m`, detail: `ΔX ${dx} · ΔY ${dy} · ΔZ ${dz}` };
    }
    if (item.kind === 'point') {
      const [x, y, z] = item.at.map((v) => metres(v));
      return { title: 'Position', detail: `X ${x} · Y ${y} · Z ${z}` };
    }
    const s = (a) => (item.spans[a].span == null ? '—' : metres(item.spans[a].span));
    return { title: 'Laser', detail: `X ${s('X')} · Y ${s('Y')} · Z ${s('Z')} m` };
  }

  /** Explode moved elements: move the lines with them. */
  refresh() {
    for (const item of this.items) for (const l of item.lines) this.placeLine(l);
  }

  /** Every frame: dots and labels follow the camera. */
  place(camera, W, H) {
    const v = new THREE.Vector3();
    const put = (el, p, above = false) => {
      v.copy(p).project(camera);
      const show = v.z < 1 && v.x >= -1.2 && v.x <= 1.2 && v.y >= -1.2 && v.y <= 1.2;
      el.style.visibility = show ? '' : 'hidden';
      if (show) {
        const x = ((v.x + 1) / 2) * W, y = ((1 - v.y) / 2) * H;
        el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)${above ? ' translate(-50%, calc(-100% - 10px))' : ' translate(-50%, -50%)'}`;
      }
    };
    for (const item of this.items) for (const m of item.marks) put(m.el, m.at(), m.above);
    if (this.snapAt) put(this.snap, this.snapAt);
    if (this.rubberLabel && this.rubber) put(this.rubberLabel, this.rubber.userData.mid());
  }

  /** The marker under the pointer: a square on a snapped corner, a ring on a surface. */
  preview(anchor, snapped, first = null) {
    this.snap.hidden = !anchor;
    this.snapAt = anchor ? drawnAt(anchor) : null;
    this.snap.classList.toggle('corner', !!snapped);
    if (anchor && first) {
      if (!this.rubber) {
        this.rubber = this.line(DISTANCE_COLOUR, first, anchor);
        this.rubberLabel = this.el('mlabel live', '', DISTANCE_COLOUR);
      }
      this.rubber.userData.ends = [first, anchor];
      this.rubber.userData.mid = () => drawnAt(first).lerp(drawnAt(anchor), 0.5);
      this.placeLine(this.rubber);
      this.rubberLabel.textContent = `${metres(realAt(first).distanceTo(realAt(anchor)))} m`;
    } else if (this.rubber) {
      this.overlay.remove(this.rubber);
      this.rubber.geometry.dispose();
      this.rubber = null;
      this.rubberLabel.remove();
      this.rubberLabel = null;
    }
  }
}
