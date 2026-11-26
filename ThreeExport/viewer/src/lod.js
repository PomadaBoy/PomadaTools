// Lighter versions of heavy geometries, for drawing only. Picking, snapping and measuring
// always use the full mesh, so measured values do not change; a lighter version is drawn
// only where its error is under a pixel on screen, or a few pixels while the view moves.
//
// meshoptimizer's simplifier (C++ compiled to WebAssembly, bundled into the page) removes
// triangles while keeping every point within the given distance of the original surface.
import * as THREE from 'three';
import { MeshoptSimplifier } from 'meshoptimizer/simplifier';

/** Largest distance (metres) between a lighter version and the real surface, finest first. */
export const LOD_ERRORS = [0.005, 0.05, 0.5];
/** Geometries drawn with fewer triangles than this (all their copies together) are drawn as they are. */
export const LOD_MIN_TRIANGLES = 5000;

/** Resolves true once the simplifier can be used (WebAssembly may be unavailable). */
export async function lodReady() {
  try {
    if (!MeshoptSimplifier.supported) return false;
    await MeshoptSimplifier.ready;
    return true;
  } catch {
    return false;
  }
}

/**
 * Lighter versions of an indexed geometry: [{ geometry, error, triangles }], finest first;
 * only versions with at most 70 % of the triangles of the one before. Revit gives each face
 * its own vertices, so vertices at the same place are joined first; each corner of a
 * simplified triangle then takes the normal of the original vertex there that fits its
 * face best (smooth surfaces stay smooth), or the face's own normal at sharp edges.
 */
export function simplifyGeometry(geometry) {
  const posAttr = geometry.getAttribute('position');
  const nrmAttr = geometry.getAttribute('normal');
  if (!geometry.index || !posAttr || !nrmAttr) return [];
  const n = posAttr.count;
  const pos = new Float32Array(n * 3);
  const nrm = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = posAttr.getX(i); pos[i * 3 + 1] = posAttr.getY(i); pos[i * 3 + 2] = posAttr.getZ(i);
    nrm[i * 3] = nrmAttr.getX(i); nrm[i * 3 + 1] = nrmAttr.getY(i); nrm[i * 3 + 2] = nrmAttr.getZ(i);
  }
  // one vertex per position (the simplifier will not move a vertex that has twins it cannot see)
  const remap = MeshoptSimplifier.generatePositionRemap(pos, 3);
  const dense = new Int32Array(n).fill(-1);
  const canon = [];
  for (let i = 0; i < n; i++) if (dense[remap[i]] < 0) { dense[remap[i]] = canon.length; canon.push(remap[i]); }
  const joined = new Float32Array(canon.length * 3);
  canon.forEach((c, k) => { joined[k * 3] = pos[c * 3]; joined[k * 3 + 1] = pos[c * 3 + 1]; joined[k * 3 + 2] = pos[c * 3 + 2]; });
  const src = geometry.index.array;
  const welded = new Uint32Array(src.length);
  for (let i = 0; i < src.length; i++) welded[i] = dense[remap[src[i]]];

  // the original vertices at each joined position (a compact list per position)
  const start = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) start[remap[i] + 1]++;
  for (let i = 0; i < n; i++) start[i + 1] += start[i];
  const fill = start.slice(0, n);
  const members = new Uint32Array(n);
  for (let i = 0; i < n; i++) members[fill[remap[i]]++] = i;

  const levels = [];
  let previous = src.length;
  for (const error of LOD_ERRORS) {
    const [out] = MeshoptSimplifier.simplify(welded, joined, 3, 0, error, ['ErrorAbsolute', 'Prune']);
    if (out.length < 3 || out.length > previous * 0.7) continue;
    const idx = out.map((k) => canon[k]);   // back to the original vertex numbers
    levels.push({ geometry: build(idx, pos, nrm, start, members), error, triangles: idx.length / 3 });
    previous = idx.length;
  }
  return levels;
}

function build(idx, pos, nrm, start, members) {
  const count = idx.length;
  const p = new Float32Array(count * 3);
  const q = new Float32Array(count * 3);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), face = new THREE.Vector3(), ab = new THREE.Vector3();
  for (let t = 0; t < count; t += 3) {
    a.fromArray(pos, idx[t] * 3);
    b.fromArray(pos, idx[t + 1] * 3);
    c.fromArray(pos, idx[t + 2] * 3);
    face.subVectors(c, b).cross(ab.subVectors(a, b)).normalize();
    for (let k = 0; k < 3; k++) {
      const v = idx[t + k];
      p[(t + k) * 3] = pos[v * 3]; p[(t + k) * 3 + 1] = pos[v * 3 + 1]; p[(t + k) * 3 + 2] = pos[v * 3 + 2];
      let best = -2, bx = face.x, by = face.y, bz = face.z;
      for (let j = start[v]; j < start[v + 1]; j++) {
        const o = members[j] * 3;
        const d = nrm[o] * face.x + nrm[o + 1] * face.y + nrm[o + 2] * face.z;
        if (d > best) { best = d; bx = nrm[o]; by = nrm[o + 1]; bz = nrm[o + 2]; }
      }
      if (best < 0.7) { bx = face.x; by = face.y; bz = face.z; }   // a sharp edge: flat
      q[(t + k) * 3] = bx; q[(t + k) * 3 + 1] = by; q[(t + k) * 3 + 2] = bz;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(q, 3));
  const index = count > 65535 ? new Uint32Array(count) : new Uint16Array(count);
  for (let i = 0; i < count; i++) index[i] = i;
  g.setIndex(new THREE.BufferAttribute(index, 1));
  return g;
}
