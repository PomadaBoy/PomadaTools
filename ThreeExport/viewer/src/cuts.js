// Section cuts: planes ("Add cut") and one section box ("Box cut"). The model is drawn
// with renderer.clippingPlanes = cuts.planes; the frames and arrow handles live in the
// overlay scene, which is drawn afterwards without clipping.
import * as THREE from 'three';
import { axisParam, keptBy } from './geom.js';

const HANDLE = 0xeb6834;     // orange arrows: stand out on grey concrete and on the colour palette
const LINE = 0x1f6feb;
const MIN_BOX = 0.05;        // the box never gets thinner than 5 cm
const Y = new THREE.Vector3(0, 1, 0);

/** A double arrow along +Y, about 2 units long, with a bigger invisible sphere to grab it by. */
function arrow() {
  const mat = new THREE.MeshBasicMaterial({ color: HANDLE, depthTest: false, transparent: true });
  const g = new THREE.Group();
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 1.2, 12), mat);
  const up = new THREE.Mesh(new THREE.ConeGeometry(0.32, 0.7, 20), mat);
  up.position.y = 0.95;
  const down = up.clone();
  down.rotation.z = Math.PI;
  down.position.y = -0.95;
  const grab = new THREE.Mesh(new THREE.SphereGeometry(1.15, 12, 8), new THREE.MeshBasicMaterial({ visible: false }));
  g.add(shaft, up, down, grab);
  g.renderOrder = 10;
  for (const m of [shaft, up, down]) m.renderOrder = 10;
  g.userData.grab = grab;
  return g;
}

export class Cuts {
  /** overlay: scene drawn without clipping; onChange(): called after every change */
  constructor(overlay, onChange) {
    this.overlay = overlay;
    this.onChange = onChange;
    this.planes = [];          // what the renderer clips with (planes first, then the box's six)
    this.items = [];           // plane cuts: { id, kind:'plane', normal, base, offset, plane, group, frame, handle }
    this.box = null;           // { kind:'box', box, group, edges, handles:[...] }
    this.drag = null;
    this.nextId = 1;
  }

  get count() { return this.items.length + (this.box ? 1 : 0); }

  isKept(p) { return keptBy(this.planes, p); }

  /** A plane through `point` that keeps the side `keep` points to; size: width of the drawn frame. */
  addPlane(point, keep, size) {
    const normal = keep.clone().normalize();
    const group = new THREE.Group();
    const s = Math.max(size, 0.5);
    const fill = new THREE.Mesh(new THREE.PlaneGeometry(s, s), new THREE.MeshBasicMaterial({
      color: LINE, transparent: true, opacity: 0.07, side: THREE.DoubleSide, depthWrite: false,
    }));
    const rim = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(s, s)),
      new THREE.LineBasicMaterial({ color: LINE, transparent: true, opacity: 0.7 }));
    const frame = new THREE.Group();
    frame.add(fill, rim);
    const handle = arrow();
    group.add(frame, handle);
    this.overlay.add(group);
    const item = {
      id: this.nextId++, kind: 'plane', normal, base: point.clone(), offset: 0,
      plane: new THREE.Plane(), group, frame, handle,
    };
    handle.userData.grab.userData.handle = {
      item,
      origin: () => item.base.clone().addScaledVector(item.normal, item.offset),
      dir: () => item.normal,
      get: () => item.offset,
      set: (v) => this.setOffset(item, v),
    };
    this.items.push(item);
    this.placePlane(item);
    this.rebuild();
    return item;
  }

  placePlane(item) {
    const at = item.base.clone().addScaledVector(item.normal, item.offset);
    item.plane.setFromNormalAndCoplanarPoint(item.normal, at);
    // the frame lies in the plane (PlaneGeometry faces +Z); the arrow points along the normal
    item.frame.position.copy(at);
    item.frame.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), item.normal);
    item.handle.position.copy(at);
    item.handle.quaternion.setFromUnitVectors(Y, item.normal);
  }

  setOffset(item, v) {
    item.offset = v;
    this.placePlane(item);
    this.onChange();
  }

  /** Keeps the other side: the plane stays where it is. */
  flip(item) {
    item.normal.negate();
    item.offset = -item.offset;
    this.placePlane(item);
    this.onChange();
  }

  /** The section box; replaces an earlier one. */
  setBox(box) {
    if (this.box) this.removeBox(false);
    const group = new THREE.Group();
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
      new THREE.LineBasicMaterial({ color: LINE, transparent: true, opacity: 0.8 }));
    group.add(edges);
    const b = { kind: 'box', box: box.clone(), group, edges, handles: [], planes: [] };
    for (const axis of ['x', 'y', 'z']) {
      for (const side of ['min', 'max']) {
        const h = arrow();
        const dir = new THREE.Vector3();
        dir[axis] = 1;
        h.quaternion.setFromUnitVectors(Y, dir);
        h.userData.grab.userData.handle = {
          item: b, axis, side,
          origin: () => this.faceCentre(b, axis, side),
          dir: () => dir,
          get: () => b.box[side][axis],
          set: (v) => {
            const other = b.box[side === 'min' ? 'max' : 'min'][axis];
            b.box[side][axis] = side === 'min' ? Math.min(v, other - MIN_BOX) : Math.max(v, other + MIN_BOX);
            this.placeBox();
            this.onChange();
          },
        };
        b.handles.push(h);
        group.add(h);
      }
    }
    // keep x >= min.x, x <= max.x ... as six planes
    for (const axis of ['x', 'y', 'z']) {
      for (const sign of [1, -1]) {
        const n = new THREE.Vector3();
        n[axis] = sign;
        b.planes.push(new THREE.Plane(n, 0));
      }
    }
    this.box = b;
    this.overlay.add(group);
    this.placeBox();
    this.rebuild();
    return b;
  }

  faceCentre(b, axis, side) {
    const c = b.box.getCenter(new THREE.Vector3());
    c[axis] = b.box[side][axis];
    return c;
  }

  placeBox() {
    const b = this.box;
    const size = b.box.getSize(new THREE.Vector3());
    b.edges.position.copy(b.box.getCenter(new THREE.Vector3()));
    b.edges.scale.copy(size);
    let i = 0;
    for (const axis of ['x', 'y', 'z']) {
      // min face: x - min >= 0; max face: -x + max >= 0
      b.planes[i++].constant = -b.box.min[axis];
      b.planes[i++].constant = b.box.max[axis];
    }
    b.handles.forEach((h) => {
      const { axis, side } = h.userData.grab.userData.handle;
      h.position.copy(this.faceCentre(b, axis, side));
    });
  }

  removeBox(notify = true) {
    if (!this.box) return;
    this.dispose(this.box.group);
    this.box = null;
    this.rebuild();
    if (notify) this.onChange();
  }

  remove(item) {
    if (item.kind === 'box') { this.removeBox(); return; }
    this.dispose(item.group);
    this.items = this.items.filter((x) => x !== item);
    this.rebuild();
    this.onChange();
  }

  clear() {
    for (const item of this.items) this.dispose(item.group);
    this.items = [];
    if (this.box) this.removeBox(false);
    this.rebuild();
    this.onChange();
  }

  dispose(group) {
    this.overlay.remove(group);
    group.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
  }

  /** The renderer keeps this array: change it in place. */
  rebuild() {
    this.planes.length = 0;
    for (const item of this.items) this.planes.push(item.plane);
    if (this.box) this.planes.push(...this.box.planes);
    this.onChange();
  }

  handleObjects() {
    const out = this.items.map((i) => i.handle);
    if (this.box) out.push(...this.box.handles);
    return out;
  }

  /** The handle under the ray, or null. */
  handleAt(raycaster) {
    const grabs = this.handleObjects().map((h) => h.userData.grab);
    const hit = raycaster.intersectObjects(grabs, false)[0];
    return hit ? hit.object.userData.handle : null;
  }

  beginDrag(handle, ray) {
    const origin = handle.origin(), dir = handle.dir().clone();
    const t0 = axisParam(origin, dir, ray.origin, ray.direction);
    if (t0 == null) return false;
    this.drag = { handle, origin, dir, t0, v0: handle.get() };
    return true;
  }

  dragTo(ray) {
    const d = this.drag;
    if (!d) return;
    const t = axisParam(d.origin, d.dir, ray.origin, ray.direction);
    if (t != null) d.handle.set(d.v0 + (t - d.t0));
  }

  endDrag() { this.drag = null; }

  /** Handles keep the same size on screen. */
  scaleHandles(camera, viewHeight) {
    const k = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / Math.max(viewHeight, 1);
    for (const h of this.handleObjects()) {
      const world = h.getWorldPosition(new THREE.Vector3());
      h.scale.setScalar(Math.max(camera.position.distanceTo(world) * k * 13, 1e-3));   // about 26 px long
    }
  }
}
