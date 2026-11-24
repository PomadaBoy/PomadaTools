// Geometry helpers for cuts and measuring: pure, testable in Node.
import { Vector3 } from 'three';

/**
 * Revit internal coordinates (metres) of a viewer point. The exporter writes Revit
 * (x, y, z) as glTF (x, z, -y), recentred: revit = (x + o.x, -z + o.y, y + o.z).
 */
export function toRevit(p, o = [0, 0, 0]) {
  return [p.x + o[0], -p.z + o[1], p.y + o[2]];
}

/**
 * Shared (survey) coordinates of a point in Revit internal metres, with the map the exporter
 * writes: shared = origin + x·basisX + y·basisY + z·basisZ. null without one.
 */
export function toShared(r, sc) {
  if (!sc?.origin) return null;
  return [0, 1, 2].map((i) => sc.origin[i] + r[0] * sc.basisX[i] + r[1] * sc.basisY[i] + r[2] * sc.basisZ[i]);
}

/** Revit axes in viewer space: X east, Y north, Z up. */
export const REVIT_AXES = {
  X: new Vector3(1, 0, 0),
  Y: new Vector3(0, 0, -1),
  Z: new Vector3(0, 1, 0),
};

/**
 * Parameter t of the point origin + t·dir (dir a unit vector) that is closest to the
 * ray (rayOrigin, unit rayDir): how far along a handle's axis the pointer is.
 * null when the axis points along the ray, where there is no useful answer.
 */
export function axisParam(origin, dir, rayOrigin, rayDir) {
  const w = new Vector3().subVectors(origin, rayOrigin);
  const b = dir.dot(rayDir);
  const denom = 1 - b * b;
  if (denom < 1e-6) return null;
  const d = dir.dot(w), e = rayDir.dot(w);
  return (b * e - d) / denom;
}

/** A face normal within `deg` degrees of an axis becomes that axis (Revit models are mostly square). */
export function snapNormal(n, deg = 6) {
  const out = n.clone().normalize();
  const c = Math.cos((deg * Math.PI) / 180);
  for (const k of ['x', 'y', 'z']) {
    if (Math.abs(out[k]) >= c) {
      const s = Math.sign(out[k]);
      out.set(0, 0, 0);
      out[k] = s;
      return out;
    }
  }
  return out;
}

/** Index of the screen point nearest to `at` within `px` pixels, or -1. points: [[x, y] | null]. */
export function nearestWithin(points, at, px) {
  let best = -1, bestD = px;
  points.forEach((p, i) => {
    if (!p) return;
    const d = Math.hypot(p[0] - at[0], p[1] - at[1]);
    if (d <= bestD) { best = i; bestD = d; }
  });
  return best;
}

/**
 * The direction of the clicked face's edge nearest to p: the laser measures along and square
 * to it, so it follows the element, not the project grid.
 *   corners(i) -> Vector3   the i-th triangle corner of the mesh, in world space
 *   count                   number of corners (3 per triangle)
 *   n, p                    the face's unit normal and the clicked point
 * The face is every triangle of the mesh in the clicked plane; its edges are the triangle
 * edges used once (shared ones are diagonals inside the face). Edges shorter than a fifth of
 * the longest are skipped, so a small notch or chamfer doesn't decide. null when none is found.
 */
export function faceEdgeDirection(corners, count, n, p, planeTol = 1e-3) {
  const key = (v) => `${Math.round(v.x * 1e4)},${Math.round(v.y * 1e4)},${Math.round(v.z * 1e4)}`;
  const edges = new Map();
  const e1 = new Vector3(), e2 = new Vector3(), tn = new Vector3();
  for (let i = 0; i + 2 < count; i += 3) {
    const a = corners(i), b = corners(i + 1), c = corners(i + 2);
    tn.crossVectors(e1.subVectors(b, a), e2.subVectors(c, a));
    const len = tn.length();
    if (len < 1e-12) continue;
    if (Math.abs(tn.dot(n)) / len < 0.9995) continue;                  // not parallel to the face
    if (Math.abs(n.dot(e1.subVectors(a, p))) > planeTol) continue;     // another plane
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const ku = key(u), kv = key(v);
      const k = ku < kv ? `${ku}|${kv}` : `${kv}|${ku}`;
      const edge = edges.get(k);
      if (edge) edge.count++; else edges.set(k, { count: 1, u: u.clone(), v: v.clone() });
    }
  }
  const outline = [...edges.values()].filter((e) => e.count === 1);
  if (!outline.length) return null;
  const longest = Math.max(...outline.map((e) => e.u.distanceTo(e.v)));
  let best = null, bestD = Infinity;
  const q = new Vector3(), d = new Vector3();
  for (const e of outline) {
    const len = e.u.distanceTo(e.v);
    if (len < longest * 0.2) continue;
    // distance from p to the segment
    d.subVectors(e.v, e.u);
    const t = Math.max(0, Math.min(1, q.subVectors(p, e.u).dot(d) / d.lengthSq()));
    const dist = q.copy(e.u).addScaledVector(d, t).distanceTo(p);
    if (dist < bestD) { bestD = dist; best = e; }
  }
  const dir = new Vector3().subVectors(best.v, best.u);
  dir.addScaledVector(n, -dir.dot(n));                                 // in the face plane
  return dir.lengthSq() > 1e-12 ? dir.normalize() : null;
}

/** True when every clipping plane keeps the point (three.js clips negative distances). */
export function keptBy(planes, p, eps = 1e-4) {
  for (const pl of planes) if (pl.distanceToPoint(p) < -eps) return false;
  return true;
}

/** Metres with 3 decimals, in the reader's number format. */
export function metres(v, locale) {
  return v.toLocaleString(locale, { minimumFractionDigits: 3, maximumFractionDigits: 3 });
}
