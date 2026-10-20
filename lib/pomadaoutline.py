# -*- coding: utf-8 -*-
"""Pure-Python 2D geometry for QAQC Outline Check (no Revit imports, works in any unit).

Points are (x, y) tuples, segments are (x1, y1, x2, y2), loops are closed point lists (first == last).

build_loops()  - turns loose DWG curves into closed outlines (closed polylines, lines meeting at corners,
                 shared edges, T-junctions); loose lines such as axes are dropped.
analyse()      - matches every element footprint loop to its best DWG outline and compares both ways.
"""

import math

EPS = 1e-9


# ---------------- basics ----------------

def dist_point_seg(px, py, seg):
    x1, y1, x2, y2 = seg
    dx, dy = x2 - x1, y2 - y1
    ll = dx * dx + dy * dy
    t = 0.0 if ll < EPS else max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / ll))
    ex, ey = x1 + t * dx - px, y1 + t * dy - py
    return math.sqrt(ex * ex + ey * ey)


def seg_param(px, py, seg):
    """Position of the closest point on the segment, 0..1."""
    x1, y1, x2, y2 = seg
    dx, dy = x2 - x1, y2 - y1
    ll = dx * dx + dy * dy
    return 0.0 if ll < EPS else max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / ll))


def clean_points(pts):
    out = [pts[0]]
    for p in pts[1:]:
        if abs(p[0] - out[-1][0]) + abs(p[1] - out[-1][1]) > EPS:
            out.append(p)
    return out


def close(pts):
    pts = clean_points(pts)
    if abs(pts[0][0] - pts[-1][0]) + abs(pts[0][1] - pts[-1][1]) > EPS:
        pts = pts + [pts[0]]
    return pts


def polyline_segments(pts):
    return [(a[0], a[1], b[0], b[1]) for a, b in zip(pts[:-1], pts[1:])
            if abs(a[0] - b[0]) + abs(a[1] - b[1]) > EPS]


def sample_segments(segs, step):
    """[(x, y, segment index)] every `step` along the segments, including both ends of each."""
    out = []
    for i, (x1, y1, x2, y2) in enumerate(segs):
        n = max(1, int(math.ceil(math.hypot(x2 - x1, y2 - y1) / step)))
        for k in range(n + 1):
            t = float(k) / n
            out.append((x1 + t * (x2 - x1), y1 + t * (y2 - y1), i))
    return out


def signed_area(pts):
    a = 0.0
    for p, q in zip(pts[:-1], pts[1:]):
        a += p[0] * q[1] - q[0] * p[1]
    return a / 2.0


def centroid(pts):
    a = signed_area(pts)
    if abs(a) < EPS:
        xs, ys = [p[0] for p in pts], [p[1] for p in pts]
        return sum(xs) / len(xs), sum(ys) / len(ys)
    cx = cy = 0.0
    for p, q in zip(pts[:-1], pts[1:]):
        f = p[0] * q[1] - q[0] * p[1]
        cx += (p[0] + q[0]) * f
        cy += (p[1] + q[1]) * f
    return cx / (6.0 * a), cy / (6.0 * a)


def bbox(pts):
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return min(xs), min(ys), max(xs), max(ys)


def bbox_overlap(a, b, margin):
    return not (a[2] + margin < b[0] or b[2] + margin < a[0] or a[3] + margin < b[1] or b[3] + margin < a[1])


def point_in_polygon(x, y, pts):
    inside = False
    for p, q in zip(pts[:-1], pts[1:]):
        if (p[1] > y) != (q[1] > y):
            xc = p[0] + (y - p[1]) * (q[0] - p[0]) / (q[1] - p[1])
            if x < xc:
                inside = not inside
    return inside


class SegmentIndex(object):
    """Uniform grid over segments for fast 'nearest segment' queries."""
    def __init__(self, segs, cell):
        self.segs = segs
        self.cell = cell
        self.grid = {}
        for i, (x1, y1, x2, y2) in enumerate(segs):
            for cx in range(self._c(min(x1, x2)), self._c(max(x1, x2)) + 1):
                for cy in range(self._c(min(y1, y2)), self._c(max(y1, y2)) + 1):
                    self.grid.setdefault((cx, cy), []).append(i)

    def _c(self, v):
        return int(math.floor(v / self.cell))

    def candidates(self, x, y, radius):
        seen = set()
        for cx in range(self._c(x - radius), self._c(x + radius) + 1):
            for cy in range(self._c(y - radius), self._c(y + radius) + 1):
                for i in self.grid.get((cx, cy), ()):
                    if i not in seen:
                        seen.add(i)
                        yield i

    def nearest(self, x, y, radius):
        """Distance to the nearest segment, capped at radius."""
        best = radius
        for i in self.candidates(x, y, radius):
            d = dist_point_seg(x, y, self.segs[i])
            if d < best:
                best = d
        return best


# ---------------- closed outlines from loose DWG curves ----------------

class _Nodes(object):
    """Snaps nearby end points to one node."""
    def __init__(self, snap):
        self.snap = snap
        self.pts = []
        self.grid = {}

    def get(self, p):
        kx, ky = int(math.floor(p[0] / self.snap)), int(math.floor(p[1] / self.snap))
        for gx in (kx - 1, kx, kx + 1):
            for gy in (ky - 1, ky, ky + 1):
                for n in self.grid.get((gx, gy), ()):
                    q = self.pts[n]
                    if math.hypot(q[0] - p[0], q[1] - p[1]) <= self.snap:
                        return n
        self.pts.append(p)
        self.grid.setdefault((kx, ky), []).append(len(self.pts) - 1)
        return len(self.pts) - 1


def _dedupe_pieces(pieces, snap):
    seen, out = set(), []
    for q in pieces:
        a, b = q[0], q[-1]
        ka = (round(a[0] / snap), round(a[1] / snap))
        kb = (round(b[0] / snap), round(b[1] / snap))
        length = sum(math.hypot(s[2] - s[0], s[3] - s[1]) for s in polyline_segments(q))
        key = (min(ka, kb), max(ka, kb), round(length / snap))
        if key not in seen:
            seen.add(key)
            out.append(q)
    return out


def _split_at_t_junctions(edges, nodes, snap):
    """Split curves where another curve's free end touches them in the middle (T-junction)."""
    degree = {}
    for a, b, _ in edges:
        degree[a] = degree.get(a, 0) + 1
        degree[b] = degree.get(b, 0) + 1
    segs, owner = [], []
    for ei, (_, _, q) in enumerate(edges):
        for si, s in enumerate(polyline_segments(q)):
            segs.append(s)
            owner.append((ei, si))
    index = SegmentIndex(segs, max(snap * 100.0, 1e-6))
    splits = {}
    for n, d in degree.items():
        if d != 1:
            continue
        px, py = nodes.pts[n]
        for i in index.candidates(px, py, snap):
            ei, si = owner[i]
            a, b, _ = edges[ei]
            if n in (a, b) or dist_point_seg(px, py, segs[i]) > snap:
                continue
            splits.setdefault(ei, []).append((si, seg_param(px, py, segs[i]), n))
    if not splits:
        return edges
    out = []
    for ei, (a, b, q) in enumerate(edges):
        if ei not in splits:
            out.append((a, b, q))
            continue
        qs = polyline_segments(q)
        cuts = sorted(splits[ei])
        start_node, cur = a, [q[0]]
        for si, s in enumerate(qs):
            for csi, t, n in cuts:
                if csi != si:
                    continue
                p = nodes.pts[n]
                cur.append(p)
                cur = clean_points(cur)
                if len(cur) >= 2 and n != start_node:
                    out.append((start_node, n, cur))
                start_node, cur = n, [p]
            cur.append((s[2], s[3]))
        cur = clean_points(cur)
        if len(cur) >= 2:
            out.append((start_node, b, cur))
    return out


def _prune_dangling(edges):
    """Remove curves that end freely (axes, leader lines...) until only closed networks remain."""
    edges = list(edges)
    while True:
        degree = {}
        for a, b, _ in edges:
            degree[a] = degree.get(a, 0) + 1
            degree[b] = degree.get(b, 0) + 1
        keep = [e for e in edges if degree[e[0]] > 1 and degree[e[1]] > 1]
        if len(keep) == len(edges):
            return keep
        edges = keep


def _faces(edges):
    """All face boundaries of the planar network (each as a list of half-edges)."""
    out_at = {}
    for ei, (a, b, q) in enumerate(edges):
        for d, node, pts in ((0, a, q), (1, b, q[::-1])):
            ang = math.atan2(pts[1][1] - pts[0][1], pts[1][0] - pts[0][0])
            out_at.setdefault(node, []).append((ang, (ei, d)))
    for node in out_at:
        out_at[node].sort()
        out_at[node] = [h for _, h in out_at[node]]
    pos = {}
    for node, hs in out_at.items():
        for i, h in enumerate(hs):
            pos[h] = (node, i)

    def head(h):
        a, b, _ = edges[h[0]]
        return b if h[1] == 0 else a

    visited, faces = set(), []
    for start in pos:
        if start in visited:
            continue
        cycle, h = [], start
        for _ in range(len(pos) + 1):
            if h in visited:
                break
            visited.add(h)
            cycle.append(h)
            twin = (h[0], 1 - h[1])
            node, i = pos[twin]
            hs = out_at[node]
            h = hs[(i - 1) % len(hs)]
        if cycle:
            faces.append(cycle)
    return faces


def build_loops(pieces, snap, min_area):
    """pieces: list of point lists from the DWG. Returns closed outlines (point lists, first == last)."""
    pieces = [clean_points(p) for p in pieces if len(p) >= 2]
    pieces = [p for p in pieces if len(p) >= 2]
    pieces = _dedupe_pieces(pieces, snap)
    nodes = _Nodes(snap)
    edges = [(nodes.get(q[0]), nodes.get(q[-1]), q) for q in pieces]
    edges = _split_at_t_junctions(edges, nodes, snap)
    edges = _prune_dangling(edges)

    loops, seen = [], set()
    for cycle in _faces(edges):
        key = frozenset(h[0] for h in cycle)
        if key in seen:
            continue
        seen.add(key)
        pts = []
        for ei, d in cycle:
            q = edges[ei][2] if d == 0 else edges[ei][2][::-1]
            pts.extend(q if not pts else q[1:])
        pts = close(pts)
        if len(pts) >= 4 and abs(signed_area(pts)) >= min_area:
            loops.append(pts)
    return loops


# ---------------- comparison ----------------

def compare_loops(el_pts, dwg_pts, step, search, cell):
    """Both-way distances between two outlines. fwd: element points -> DWG, bwd: DWG points -> element."""
    el_segs, dwg_segs = polyline_segments(el_pts), polyline_segments(dwg_pts)
    to_dwg, to_el = SegmentIndex(dwg_segs, cell), SegmentIndex(el_segs, cell)
    fwd = [(x, y, i, to_dwg.nearest(x, y, search)) for x, y, i in sample_segments(el_segs, step)]
    bwd = [(x, y, i, to_el.nearest(x, y, search)) for x, y, i in sample_segments(dwg_segs, step)]
    fmax = max(s[3] for s in fwd)
    bmax = max(s[3] for s in bwd)
    return {"fwd": fwd, "bwd": bwd, "fwd_max": fmax, "bwd_max": bmax, "h": max(fmax, bmax)}


STATUS_ORDER = ("deviates", "duplicate", "no DWG", "check", "OK")


def _element_status(loop_statuses):
    s = set(loop_statuses)
    if "deviates" in s or ("no DWG" in s and len(s) > 1):
        return "deviates"
    if s == set(["no DWG"]):
        return "no DWG"
    if "check" in s:
        return "check"
    return "OK"


def analyse(elements, dwg_loops, dwg_segments, tol, step, search, cell, min_area, region_margin):
    """elements: [(key, [loops])]. Returns (results by key, missing DWG loops).

    Per element: status, max deviation, fwd/bwd maxima, centroid shift, areas, notes and per-loop details
    (samples for drawing markers). Status: OK / deviates / check (outline fits, but only element->DWG could be
    checked, or the DWG has an extra closed outline inside) / no DWG / duplicate (two elements on one outline)."""
    all_index = SegmentIndex(dwg_segments, cell)
    dwg_bb = [bbox(L) for L in dwg_loops]
    results, matched_by = {}, {}

    for key, loops in elements:
        loop_res = []
        for el in loops:
            bb = bbox(el)
            ecx, ecy = centroid(el)
            best = None
            for j, L in enumerate(dwg_loops):
                if not bbox_overlap(bb, dwg_bb[j], search):
                    continue
                r = compare_loops(el, L, step, search, cell)
                devs = [s[3] for s in r["fwd"]] + [s[3] for s in r["bwd"]]
                near = sum(1 for d in devs if d < search * 0.999) / float(len(devs))
                dcx, dcy = centroid(L)
                overlaps = point_in_polygon(ecx, ecy, L) or point_in_polygon(dcx, dcy, el)
                if not overlaps and near < 0.5:
                    continue
                mean = sum(devs) / len(devs)
                if best is None or mean < best[2]:
                    best = (j, r, mean)
            if best is not None:
                j, r, _ = best
                status = "OK" if r["h"] <= tol else "deviates"
                loop_res.append({"pts": el, "dwg": j, "cmp": r, "status": status})
                if r["h"] <= tol:
                    matched_by.setdefault(j, []).append(key)
                continue
            # no closed DWG outline fits: check element edges against any DWG line (one way only)
            fwd = [(x, y, i, all_index.nearest(x, y, search)) for x, y, i in
                   sample_segments(polyline_segments(el), step)]
            worst = max(s[3] for s in fwd)
            if min(s[3] for s in fwd) >= search * 0.999:
                status = "no DWG"
            elif worst <= tol:
                status = "check"
            else:
                status = "deviates"
            loop_res.append({"pts": el, "dwg": None, "status": status,
                             "cmp": {"fwd": fwd, "bwd": [], "fwd_max": worst, "bwd_max": None, "h": worst}})

        res = {"loops": loop_res, "notes": []}
        if not loop_res:
            res.update(status="no geometry", max=None, fwd_max=None, bwd_max=None, shift=None,
                       area_model=None, area_dwg=None)
            results[key] = res
            continue
        res["status"] = _element_status([l["status"] for l in loop_res])
        res["fwd_max"] = max(l["cmp"]["fwd_max"] for l in loop_res)
        bwds = [l["cmp"]["bwd_max"] for l in loop_res if l["cmp"]["bwd_max"] is not None]
        res["bwd_max"] = max(bwds) if bwds else None
        res["max"] = max([res["fwd_max"]] + bwds)
        outer = max(loop_res, key=lambda l: abs(signed_area(l["pts"])))
        res["area_model"] = abs(signed_area(outer["pts"]))
        if outer["dwg"] is not None:
            L = dwg_loops[outer["dwg"]]
            res["area_dwg"] = abs(signed_area(L))
            (ex, ey), (dx, dy) = centroid(outer["pts"]), centroid(L)
            res["shift"] = (ex - dx, ey - dy)
        else:
            res["area_dwg"] = res["shift"] = None
        if any(l["dwg"] is None and l["status"] != "no DWG" for l in loop_res):
            res["notes"].append("no closed DWG outline here - only element edges -> DWG lines checked")
        results[key] = res

    # duplicates: several elements sitting on the same DWG outline
    for j, keys in matched_by.items():
        if len(set(keys)) > 1:
            for k in set(keys):
                others = [o for o in set(keys) if o != k]
                results[k]["notes"].append("same DWG outline as {}".format(", ".join(str(o) for o in others)))
                if results[k]["status"] == "OK":
                    results[k]["status"] = "duplicate"

    # DWG outlines that no element accounts for
    used = set(l["dwg"] for r in results.values() for l in r["loops"] if l["dwg"] is not None)
    el_segs, outers, all_el_pts = [], [], []
    for key, loops in elements:
        for el in loops:
            el_segs.extend(polyline_segments(el))
            all_el_pts.extend(el)
        if loops:
            outers.append((key, max(loops, key=lambda L: abs(signed_area(L)))))
    el_index = SegmentIndex(el_segs, cell) if el_segs else None
    region = bbox(all_el_pts) if all_el_pts else None
    missing = []
    for j, L in enumerate(dwg_loops):
        if j in used or abs(signed_area(L)) < min_area:
            continue
        if region is not None and not bbox_overlap(bbox(L), region, region_margin):
            continue
        if el_index is not None:
            samples = sample_segments(polyline_segments(L), step)
            near = sum(1 for x, y, _ in samples if el_index.nearest(x, y, search) < search * 0.999)
            if near >= 0.8 * len(samples):
                continue            # e.g. the combined outline of two neighbouring, matched foundations
        cx, cy = centroid(L)
        host = [k for k, o in outers if point_in_polygon(cx, cy, o)]
        if host:
            for k in host:
                results[k]["notes"].append("DWG has an extra closed outline inside (opening, step or pile?)")
                results[k].setdefault("inner_dwg", []).append(j)
                if results[k]["status"] == "OK":
                    results[k]["status"] = "check"
            continue
        missing.append(j)
    return results, missing


def deviation_runs(samples, tol):
    """Consecutive out-of-tolerance samples on the same segment -> [((x1, y1), (x2, y2))] for markers."""
    runs, start, last = [], None, None
    for x, y, si, d in samples:
        bad = d > tol
        if bad and start is not None and last[2] == si:
            last = (x, y, si)
            continue
        if start is not None and (last[0], last[1]) != (start[0], start[1]):
            runs.append(((start[0], start[1]), (last[0], last[1])))
        start = last = (x, y, si) if bad else None
    if start is not None and (last[0], last[1]) != (start[0], start[1]):
        runs.append(((start[0], start[1]), (last[0], last[1])))
    return runs
