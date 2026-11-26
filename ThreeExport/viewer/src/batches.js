// Draws the model in a few BatchedMeshes instead of one draw call per mesh: a steel model
// with 30,000 elements (bolts, nuts, plates) would otherwise cost 30,000 draw calls a frame.
//
// The loaded glTF scene stays as it is, the "logical" model: picking, measuring, bounding
// boxes and metadata keep using its meshes, and the viewer keeps setting their materials
// (own, colour-by, highlighted, ghost). It is not drawn itself. Instead every mesh is an
// instance in a batch, and update() copies the mesh's state into it: shown or not, colour
// (from its material), ghosted, and where it is (explode moves the meshes).
import * as THREE from 'three';

const HIGHLIGHT = new THREE.Color(0x1f6feb);
const _color = new THREE.Color();
const _sphere = new THREE.Sphere();

/** position + normal + index of a geometry: what a batch needs, without any other attributes. */
function batchable(geometry) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', geometry.getAttribute('position'));
  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
  g.setAttribute('normal', geometry.getAttribute('normal'));
  if (geometry.index) g.setIndex(geometry.index);
  else g.setIndex([...Array(geometry.getAttribute('position').count).keys()]);
  return g;
}

export class Batches {
  /**
   * scene: where the batches are added. ghostMaterial: the viewer's ghost material; a mesh
   * that has it is drawn faint in a separate batch (made the first time it is needed).
   */
  constructor(scene, ghostMaterial, { maxVertices = 4_000_000 } = {}) {
    this.scene = scene;
    this.ghostMaterial = ghostMaterial;
    this.maxVertices = maxVertices;
    this.slots = new Map();        // mesh -> { batch, id, visible, ghost, small }
    this.ghostSlots = null;        // mesh -> { batch, id }, once something is ghosted
    this.meshes = [];
    this.batches = [];
    this.skipping = false;
    this.cache = new Map();        // geometry -> batchable copy of its attributes
    this.lods = [];                // { m, s, full, levels: [{ id, error }] } for meshes with lighter versions
  }

  /** Puts every mesh into a batch, grouped by how see-through its material is. */
  build(meshes) {
    this.meshes = meshes;
    const groups = new Map();
    for (const m of meshes) {
      const mat = m.material;
      const opacity = mat.transparent ? mat.opacity : 1;
      const key = opacity < 1 ? opacity.toFixed(3) : 'opaque';
      if (!groups.has(key)) groups.set(key, { opacity, template: mat, meshes: [] });
      groups.get(key).meshes.push(m);
    }
    for (const g of groups.values()) {
      const material = new THREE.MeshStandardMaterial({
        color: 0xffffff, roughness: g.template.roughness ?? 0.85, metalness: g.template.metalness ?? 0,
        side: g.template.side, transparent: g.opacity < 1, opacity: g.opacity, depthWrite: g.opacity >= 1,
      });
      material.name = g.opacity < 1 ? `batch ${g.opacity}` : 'batch';
      for (const batch of this._fill(g.meshes, material, (m, slot) => {
        slot.batch.setColorAt(slot.id, m.material.color);
        this.slots.set(m, { ...slot, visible: true, ghost: false, small: false });
      })) {
        batch.sortObjects = g.opacity < 1;   // see-through: back to front
        this.batches.push(batch);
      }
    }
  }

  /** Batches holding the given meshes, chunked by vertex count; add(mesh, {batch, id}) for each. */
  _fill(meshes, material, add) {
    const out = [];
    let chunk = [], geos = new Set(), vertices = 0;
    const flush = () => {
      if (!chunk.length) return;
      let indices = 0;
      for (const geo of geos) indices += this._batchable(geo).index.count;
      const batch = new THREE.BatchedMesh(chunk.length, Math.max(vertices, 1), Math.max(indices, 1), material);
      batch.frustumCulled = false;            // its own bounds go stale as elements move
      batch.perObjectFrustumCulled = true;
      const ids = new Map();
      for (const geo of geos) ids.set(geo, batch.addGeometry(this._batchable(geo)));
      batch.userData.geometryIds = ids;
      for (const m of chunk) {
        const id = batch.addInstance(ids.get(m.geometry));
        batch.setMatrixAt(id, m.matrixWorld);
        add(m, { batch, id });
      }
      this.scene.add(batch);
      out.push(batch);
      chunk = [];
      geos = new Set();
      vertices = 0;
    };
    for (const m of meshes) {
      const n = m.geometry.getAttribute('position').count;
      if (!geos.has(m.geometry) && vertices + n > this.maxVertices) flush();
      if (!geos.has(m.geometry)) { geos.add(m.geometry); vertices += n; }
      chunk.push(m);
    }
    flush();
    return out;
  }

  _batchable(geometry) {
    let g = this.cache.get(geometry);
    if (!g) { g = batchable(geometry); this.cache.set(geometry, g); }
    return g;
  }

  _buildGhost() {
    const material = this.ghostMaterial.clone();
    material.name = 'batch ghost';
    this.ghostSlots = new Map();
    for (const batch of this._fill(this.meshes, material, (m, slot) => {
      slot.batch.setVisibleAt(slot.id, false);
      this.ghostSlots.set(m, slot);
    })) {
      batch.sortObjects = false;
      this.batches.push(batch);
    }
  }

  _apply(m, s) {
    s.batch.setVisibleAt(s.id, s.visible && !s.ghost && !s.small);
    const g = this.ghostSlots?.get(m);
    if (g) g.batch.setVisibleAt(g.id, s.visible && s.ghost && !s.small);
  }

  /** Copies a mesh's state into its batch: shown (visible), its material's colour, ghosted. */
  update(m, visible) {
    const s = this.slots.get(m);
    if (!s) return;
    const mat = m.material;
    s.visible = visible;
    s.ghost = mat === this.ghostMaterial;
    if (s.ghost && !this.ghostSlots) this._buildGhost();
    if (!s.ghost) {
      _color.copy(mat.color);
      // the highlight material glows blue: tint towards it
      if (mat.emissive && mat.emissiveIntensity > 0 && (mat.emissive.r + mat.emissive.g + mat.emissive.b) > 0) _color.lerp(HIGHLIGHT, 0.5);
      s.batch.setColorAt(s.id, _color);
    }
    this._apply(m, s);
  }

  /** The mesh moved (explode): copy its world matrix. */
  move(m) {
    const s = this.slots.get(m);
    if (!s) return;
    s.batch.setMatrixAt(s.id, m.matrixWorld);
    const g = this.ghostSlots?.get(m);
    if (g) g.batch.setMatrixAt(g.id, m.matrixWorld);
  }

  /**
   * While the view moves: leave out meshes smaller than minPx on screen (most bolts of a
   * steel model seen whole). on = false: draw them all again.
   */
  skipSmall(on, camera, heightPx, minPx = 1.5) {
    if (!on && !this.skipping) return;
    this.skipping = on;
    const k = on ? heightPx / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) : 0;
    const eye = camera.position;
    for (const [m, s] of this.slots) {
      let small = false;
      if (on) {
        const geo = m.geometry;
        if (!geo.boundingSphere) geo.computeBoundingSphere();
        _sphere.copy(geo.boundingSphere).applyMatrix4(m.matrixWorld);
        const d = Math.max(_sphere.center.distanceTo(eye) - _sphere.radius, 1e-6);
        small = (_sphere.radius * k) / d < minPx;
      }
      if (small !== s.small) { s.small = small; this._apply(m, s); }
    }
  }

  /**
   * Adds lighter versions of geometries (lod.js) to the batches that draw them. lods: Map
   * geometry -> [{ geometry, error }], finest first. Each batch grows once, then chooseLods()
   * switches instances between the versions.
   */
  addLods(lods) {
    for (const batch of this.batches) {
      const ids = batch.userData.geometryIds;
      if (!ids || batch.material.name === 'batch ghost') continue;
      let extraV = 0, extraI = 0;
      const here = [];
      for (const [geo] of ids) {
        const levels = lods.get(geo);
        if (!levels?.length) continue;
        here.push([geo, levels]);
        for (const l of levels) { extraV += l.geometry.getAttribute('position').count; extraI += l.geometry.index.count; }
      }
      if (!here.length) continue;
      batch.setGeometrySize(batch._maxVertexCount + extraV, batch._maxIndexCount + extraI);
      const levelIds = new Map();
      for (const [geo, levels] of here) levelIds.set(geo, levels.map((l) => ({ id: batch.addGeometry(l.geometry), error: l.error })));
      for (const [m, s] of this.slots) {
        if (s.batch !== batch || !levelIds.has(m.geometry)) continue;
        this.lods.push({ m, s, full: ids.get(m.geometry), levels: levelIds.get(m.geometry), current: -1 });
      }
    }
    return this.lods.length;
  }

  /**
   * For each mesh with lighter versions: the lightest one whose error is under maxPx pixels on
   * screen at its distance, or the full mesh. True if any changed.
   */
  chooseLods(camera, heightPx, maxPx) {
    if (!this.lods.length) return false;
    const k = heightPx / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    const eye = camera.position;
    let changed = false;
    for (const l of this.lods) {
      const geo = l.m.geometry;
      if (!geo.boundingSphere) geo.computeBoundingSphere();
      _sphere.copy(geo.boundingSphere).applyMatrix4(l.m.matrixWorld);
      const d = Math.max(_sphere.center.distanceTo(eye) - _sphere.radius, 1e-6);
      let pick = -1;
      for (let i = l.levels.length - 1; i >= 0; i--) {
        if ((l.levels[i].error * k) / d < maxPx) { pick = i; break; }
      }
      if (pick !== l.current) {
        l.current = pick;
        l.s.batch.setGeometryIdAt(l.s.id, pick < 0 ? l.full : l.levels[pick].id);
        changed = true;
      }
    }
    return changed;
  }

  /** Draw calls the batches need at most, and how many meshes they hold. */
  get info() {
    const levels = this.lods.reduce((n, l) => n + (l.current >= 0 ? 1 : 0), 0);
    return { batches: this.batches.length, instances: this.slots.size, ghost: !!this.ghostSlots, lods: this.lods.length, lighter: levels };
  }
}
