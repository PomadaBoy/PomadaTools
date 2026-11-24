// Geometry helpers for cuts and measuring: pure, testable in Node.
import { Vector3 } from 'three';

/**
 * Revit internal coordinates (metres) of a viewer point. The exporter writes Revit
 * (x, y, z) as glTF (x, z, -y), recentred: revit = (x + o.x, -z + o.y, y + o.z).
 */
export function toRevit(p, o = [0, 0, 0]) {
  return [p.x + o[0], -p.z + o[1], p.y + o[2]];
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

/** True when every clipping plane keeps the point (three.js clips negative distances). */
export function keptBy(planes, p, eps = 1e-4) {
  for (const pl of planes) if (pl.distanceToPoint(p) < -eps) return false;
  return true;
}

/** Metres with 3 decimals, in the reader's number format. */
export function metres(v, locale) {
  return v.toLocaleString(locale, { minimumFractionDigits: 3, maximumFractionDigits: 3 });
}
