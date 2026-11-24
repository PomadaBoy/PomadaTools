// Explode offsets: pure maths, no three.js, so it can be tested in Node.
//
// items: [{ center: [x, y, z], category, shown }]  (original world bbox centres, Y up)
// mode:  'centre' | 'vertical' | 'category'
// f:     0..1 (slider)
// radius: maximum displacement in metres (about the model's bounding radius)
// Returns one [x, y, z] offset per item; items that are not shown get [0, 0, 0].

export const EXPLODE_MODES = [
  { id: 'centre', label: 'From centre' },
  { id: 'vertical', label: 'Vertical' },
  { id: 'category', label: 'By category' },
];

export function explodeOffsets(items, mode, f, radius) {
  const out = items.map(() => [0, 0, 0]);
  const shown = items.map((it, i) => i).filter((i) => items[i].shown);
  if (!(f > 0) || !(radius > 0) || shown.length === 0) return out;
  const amount = Math.min(f, 1) * radius;

  if (mode === 'vertical') {
    // every element rises in proportion to how high its centre is: layers separate
    let lo = Infinity, hi = -Infinity;
    for (const i of shown) { lo = Math.min(lo, items[i].center[1]); hi = Math.max(hi, items[i].center[1]); }
    const span = hi - lo;
    if (span <= 1e-9) return out;
    for (const i of shown) out[i][1] = ((items[i].center[1] - lo) / span) * amount;
    return out;
  }

  if (mode === 'category') {
    // categories stacked by their average height: the lowest stays, the highest rises the most
    const sum = new Map();
    for (const i of shown) {
      const c = items[i].category;
      const s = sum.get(c) ?? { y: 0, n: 0 };
      s.y += items[i].center[1]; s.n++;
      sum.set(c, s);
    }
    const order = [...sum.entries()]
      .sort((a, b) => a[1].y / a[1].n - b[1].y / b[1].n || String(a[0]).localeCompare(String(b[0])))
      .map(([c]) => c);
    if (order.length < 2) return out;
    const rank = new Map(order.map((c, r) => [c, r / (order.length - 1)]));
    for (const i of shown) out[i][1] = rank.get(items[i].category) * amount;
    return out;
  }

  // from centre: along (element centre - centre of the shown elements), the farthest moves `amount`
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const i of shown) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], items[i].center[k]);
      hi[k] = Math.max(hi[k], items[i].center[k]);
    }
  }
  const c = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2);
  let far = 0;
  for (const i of shown) far = Math.max(far, Math.hypot(...[0, 1, 2].map((k) => items[i].center[k] - c[k])));
  if (far <= 1e-9) return out;
  for (const i of shown) for (let k = 0; k < 3; k++) out[i][k] = ((items[i].center[k] - c[k]) / far) * amount;
  return out;
}
