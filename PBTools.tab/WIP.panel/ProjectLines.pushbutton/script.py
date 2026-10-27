# -*- coding: utf-8 -*-
__title__ = "Project\nLines"
__doc__ = """Project lines from a floor plan vertically onto chosen surfaces (e.g. an irregular bridge deck).
1. In the plan: pick Revit lines, single DWG lines, or whole DWG layers.
2. In 3D: pick the surfaces to project onto, then Finish.
Creates model lines (style 'PB Projected Lines') lying exactly on the surfaces, with exact kinks where a line
crosses from one face to the next. Parts of a line that miss the surfaces are left out.
Works in Revit 2023 and 2025."""

import math

import clr
clr.AddReference("System")
from System.Collections.Generic import List

from pyrevit import revit, forms, script
from Autodesk.Revit.DB import (BuiltInCategory, Color, Curve, CurveElement, ElementId, FilteredElementCollector,
                               GeometryInstance, GraphicsStyle, GraphicsStyleType, ImportInstance, Instance,
                               IntersectionResultArray, Line, Options, Plane, PolyLine, SetComparisonResult,
                               SketchPlane, Transaction, Transform, UnitTypeId, UnitUtils, View3D, ViewPlan, XYZ)
from Autodesk.Revit.UI.Selection import ISelectionFilter, ObjectType
from Autodesk.Revit.Exceptions import OperationCanceledException

doc = revit.doc
uidoc = revit.uidoc
TITLE = "Project Lines"

STEP_MM = 250.0            # sample distance along each plan line
SIMPLIFY_MM = 0.5          # points closer than this to a straight run are dropped
BISECT_STEPS = 14          # precision of kink / end points: STEP / 2^14 (about 0.02 mm)
LINE_STYLE = ("PB Projected Lines", Color(255, 120, 0), 3)


def mm(v):
    return UnitUtils.ConvertToInternalUnits(v, UnitTypeId.Millimeters)


class CurveElementFilter(ISelectionFilter):
    def AllowElement(self, e):
        return isinstance(e, CurveElement)

    def AllowReference(self, ref, pt):
        return False


class DwgFilter(ISelectionFilter):
    def AllowElement(self, e):
        return isinstance(e, ImportInstance)

    def AllowReference(self, ref, pt):
        return True


# ---------------- plan lines -> lists of points ----------------

def best_transform(elem, pts_local, gpt):
    """Sub-geometry can come in element or in project coordinates: use the one that fits the click."""
    candidates = [Transform.Identity]
    if isinstance(elem, Instance):
        candidates.append(elem.GetTotalTransform())
    best = None
    for tf in candidates:
        pts = [tf.OfPoint(p) for p in pts_local]
        d = min(Line.CreateBound(a, b).Distance(gpt) if a.DistanceTo(b) > 1e-6 else a.DistanceTo(gpt)
                for a, b in zip(pts[:-1], pts[1:]))
        if best is None or d < best[0]:
            best = (d, tf)
    return best[1]


def curve_points(geo):
    if isinstance(geo, PolyLine):
        return list(geo.GetCoordinates())
    if isinstance(geo, Curve):
        return list(geo.Tessellate())
    return None


def pick_revit_lines():
    pre = [doc.GetElement(i) for i in uidoc.Selection.GetElementIds()]
    pre = [e for e in pre if isinstance(e, CurveElement)]
    if not pre:
        with forms.WarningBar(title="Select the lines to project, then click Finish"):
            refs = uidoc.Selection.PickObjects(ObjectType.Element, CurveElementFilter(),
                                               "Select the lines to project, then Finish")
        pre = [doc.GetElement(r) for r in refs]
    return [list(e.GeometryCurve.Tessellate()) for e in pre]


def pick_dwg_lines():
    with forms.WarningBar(title="Click the DWG lines to project, then click Finish"):
        refs = uidoc.Selection.PickObjects(ObjectType.PointOnElement, DwgFilter(),
                                           "Click the DWG lines to project, then Finish")
    out, seen = [], set()
    for ref in refs:
        key = ref.ConvertToStableRepresentation(doc)
        if key in seen:
            continue
        seen.add(key)
        dwg = doc.GetElement(ref)
        pts = curve_points(dwg.GetGeometryObjectFromReference(ref))
        if pts and len(pts) >= 2:
            tf = best_transform(dwg, pts, ref.GlobalPoint)
            out.append([tf.OfPoint(p) for p in pts])
    return out


def layer_name(obj):
    style = doc.GetElement(obj.GraphicsStyleId)
    if isinstance(style, GraphicsStyle) and style.GraphicsStyleCategory is not None:
        return style.GraphicsStyleCategory.Name
    return "(no layer)"


def pick_dwg_layers():
    with forms.WarningBar(title="Click the DWG"):
        ref = uidoc.Selection.PickObject(ObjectType.Element, DwgFilter(), "Click the DWG")
    dwg = doc.GetElement(ref)
    opts = Options()
    opts.View = doc.ActiveView
    layers = {}

    def walk(geo):
        for o in geo:
            if isinstance(o, GeometryInstance):
                walk(o.GetInstanceGeometry())
            else:
                pts = curve_points(o)
                if pts and len(pts) >= 2:
                    layers.setdefault(layer_name(o), []).append(pts)

    geo = dwg.get_Geometry(opts)
    if geo is not None:
        walk(geo)
    if not layers:
        return []
    names = sorted(layers, key=lambda n: n.lower())
    labels = [u"{}   ({} lines)".format(n, len(layers[n])) for n in names]
    picked = forms.SelectFromList.show(labels, multiselect=True, title="DWG layers to project",
                                       button_name="Project these layers")
    if not picked:
        return []
    return [pts for n, lab in zip(names, labels) if lab in picked for pts in layers[n]]


# ---------------- surfaces ----------------

class Surface(object):
    def __init__(self, elem, face, tf):
        self.face, self.tf, self.inv = face, tf, tf.Inverse
        pts = [tf.OfPoint(p) for p in face.Triangulate().Vertices]
        self.x0, self.x1 = min(p.X for p in pts), max(p.X for p in pts)
        self.y0, self.y1 = min(p.Y for p in pts), max(p.Y for p in pts)
        self.z0, self.z1 = min(p.Z for p in pts), max(p.Z for p in pts)

    def height_at(self, x, y):
        eps = mm(1)
        if not (self.x0 - eps <= x <= self.x1 + eps and self.y0 - eps <= y <= self.y1 + eps):
            return None
        ray = Line.CreateBound(self.inv.OfPoint(XYZ(x, y, self.z1 + mm(1000))),
                               self.inv.OfPoint(XYZ(x, y, self.z0 - mm(1000))))
        hits = clr.Reference[IntersectionResultArray]()
        if self.face.Intersect(ray, hits) != SetComparisonResult.Overlap or hits.Value is None:
            return None
        zs = [self.tf.OfPoint(hits.Value.get_Item(i).XYZPoint).Z for i in range(hits.Value.Size)]
        return max(zs) if zs else None


def pick_surfaces():
    with forms.WarningBar(title="Pick the surfaces to project onto (e.g. the deck top faces), then click Finish"):
        refs = uidoc.Selection.PickObjects(ObjectType.Face, "Pick the surfaces to project onto, then Finish")
    surfaces = []
    for ref in refs:
        elem = doc.GetElement(ref)
        face = elem.GetGeometryObjectFromReference(ref)
        candidates = [Transform.Identity]
        if isinstance(elem, Instance):
            candidates.append(elem.GetTotalTransform())
        best = None
        for tf in candidates:
            res = face.Project(tf.Inverse.OfPoint(ref.GlobalPoint))
            if res is not None and (best is None or res.Distance < best[0]):
                best = (res.Distance, tf)
        surfaces.append(Surface(elem, face, best[1] if best else Transform.Identity))
    return surfaces


def project_point(surfaces, x, y):
    """(z on the highest picked surface, surface index) or (None, None)."""
    best = (None, None)
    for i, s in enumerate(surfaces):
        z = s.height_at(x, y)
        if z is not None and (best[0] is None or z > best[0]):
            best = (z, i)
    return best


# ---------------- projection ----------------

def project_segment(surfaces, p, q, step):
    """Pieces of the plan segment p-q lying over the surfaces, as lists of 3D points with exact kinks."""
    length = math.hypot(q.X - p.X, q.Y - p.Y)
    n = max(1, int(math.ceil(length / step)))

    def at(t):
        x, y = p.X + t * (q.X - p.X), p.Y + t * (q.Y - p.Y)
        z, i = project_point(surfaces, x, y)
        return (t, XYZ(x, y, z) if z is not None else None, i)

    def boundary(a, b):
        """Bisect between samples a and b (different face or hit/miss): last point on a's side + first on b's."""
        lo, hi = a, b
        for _ in range(BISECT_STEPS):
            mid = at((lo[0] + hi[0]) / 2.0)
            if mid[2] == lo[2]:
                lo = mid
            else:
                hi = mid
        return lo, hi

    samples = [at(float(k) / n) for k in range(n + 1)]
    pieces, cur = [], []
    for prev, s in zip([None] + samples[:-1], samples):
        if prev is not None and prev[2] != s[2]:
            lo, hi = boundary(prev, s)
            if lo[1] is not None:
                cur.append(lo[1])
            if hi[1] is None or lo[1] is None:          # the line leaves / enters the surfaces
                if len(cur) >= 2:
                    pieces.append(cur)
                cur = []
            if hi[1] is not None:
                cur.append(hi[1])
        if s[1] is not None:
            cur.append(s[1])
    if len(cur) >= 2:
        pieces.append(cur)
    return pieces


def simplify(points, tol):
    """Douglas-Peucker in 3D: keeps kinks, drops points on straight runs."""
    if len(points) < 3:
        return points
    a, b = points[0], points[-1]
    if a.DistanceTo(b) < 1e-9:
        return [a, b]
    line = Line.CreateUnbound(a, (b - a).Normalize())
    idx, dmax = 0, -1.0
    for i in range(1, len(points) - 1):
        d = line.Distance(points[i])
        if d > dmax:
            idx, dmax = i, d
    if dmax <= tol:
        return [a, b]
    return simplify(points[:idx + 1], tol)[:-1] + simplify(points[idx:], tol)


def join_pieces(pieces):
    """Glue consecutive pieces of one plan line that touch (segment ends)."""
    out = []
    for pc in pieces:
        if out and out[-1][-1].DistanceTo(pc[0]) < mm(0.1):
            out[-1] = out[-1] + pc[1:]
        else:
            out.append(pc)
    return out


# ---------------- output ----------------

def line_style():
    name, color, weight = LINE_STYLE
    lines_cat = doc.Settings.Categories.get_Item(BuiltInCategory.OST_Lines)
    sub = None
    for s in lines_cat.SubCategories:
        if s.Name == name:
            sub = s
    if sub is None:
        sub = doc.Settings.Categories.NewSubcategory(lines_cat, name)
        sub.LineColor = color
        sub.SetLineWeight(weight, GraphicsStyleType.Projection)
    return sub.GetGraphicsStyle(GraphicsStyleType.Projection)


def find_3d_view():
    open3d = [doc.GetElement(v.ViewId) for v in uidoc.GetOpenUIViews()]
    open3d = [v for v in open3d if isinstance(v, View3D) and not v.IsTemplate]
    if open3d:
        return open3d[0]
    views = [v for v in FilteredElementCollector(doc).OfClass(View3D) if not v.IsTemplate]
    named = [v for v in views if v.Name.startswith("{3D")]
    return (named or views or [None])[0]


def main():
    view = doc.ActiveView
    if not isinstance(view, ViewPlan):
        forms.alert("Start in the floor plan that shows the lines (Revit lines or the DWG).", title=TITLE)
        return
    preselected = [i for i in uidoc.Selection.GetElementIds() if isinstance(doc.GetElement(i), CurveElement)]
    try:
        if preselected:
            plan_lines = pick_revit_lines()
        else:
            choice = forms.CommandSwitchWindow.show(
                ["Revit lines (model / detail)", "Single DWG lines", "Whole DWG layers"],
                message="Which lines should be projected onto the surfaces?")
            if choice is None:
                return
            plan_lines = {"Revit lines (model / detail)": pick_revit_lines, "Single DWG lines": pick_dwg_lines,
                          "Whole DWG layers": pick_dwg_layers}[choice]()
        if not plan_lines:
            return
        view3d = find_3d_view()
        if view3d is None:
            forms.alert("There is no 3D view to pick the surfaces in.", title=TITLE)
            return
        uidoc.ActiveView = view3d
        surfaces = pick_surfaces()
    except OperationCanceledException:
        return
    if not surfaces:
        return

    step, tol = mm(STEP_MM), mm(SIMPLIFY_MM)
    results, missed = [], 0
    with forms.ProgressBar(title="Projecting lines ({value} of {max_value})", cancellable=True) as pb:
        for k, pts in enumerate(plan_lines):
            if pb.cancelled:
                return
            pieces = []
            for p, q in zip(pts[:-1], pts[1:]):
                if math.hypot(q.X - p.X, q.Y - p.Y) > mm(0.1):
                    pieces.extend(project_segment(surfaces, p, q, step))
            pieces = [simplify(pc, tol) for pc in join_pieces(pieces)]
            if pieces:
                results.append(pieces)
            else:
                missed += 1
            pb.update_progress(k + 1, len(plan_lines))
    if not results:
        forms.alert("None of the lines lies over the picked surfaces.", title=TITLE)
        return

    created, planes = [], {}
    t = Transaction(doc, "Project Lines")
    t.Start()
    try:
        style = line_style()
        for pieces in results:
            for pc in pieces:
                for a, b in zip(pc[:-1], pc[1:]):
                    if a.DistanceTo(b) < doc.Application.ShortCurveTolerance:
                        continue
                    # every projected point of a plan segment lies in the vertical plane through it
                    horiz = XYZ(b.X - a.X, b.Y - a.Y, 0)
                    normal = XYZ.BasisZ.CrossProduct(horiz.Normalize()) if horiz.GetLength() > 1e-9 \
                        else XYZ.BasisX
                    key = (round(normal.X, 6), round(normal.Y, 6), round(normal.DotProduct(a), 4))
                    sp = planes.get(key)
                    if sp is None:
                        sp = SketchPlane.Create(doc, Plane.CreateByNormalAndOrigin(normal, a))
                        planes[key] = sp
                    mc = doc.Create.NewModelCurve(Line.CreateBound(a, b), sp)
                    mc.LineStyle = style
                    created.append(mc.Id)
        t.Commit()
    except Exception as ex:
        t.RollBack()
        forms.alert(u"Could not create the lines:\n{}".format(ex), title=TITLE)
        return

    uidoc.Selection.SetElementIds(List[ElementId](created))
    output = script.get_output()
    output.print_md("## Project Lines")
    output.print_md("**Plan lines:** {}  |  **projected:** {}  |  **outside the surfaces:** {}  |  "
                    "**model lines created:** {} (style '{}', selected)".format(
                        len(plan_lines), len(results), missed, len(created), LINE_STYLE[0]))


main()
