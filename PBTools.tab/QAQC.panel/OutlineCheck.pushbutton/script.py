# -*- coding: utf-8 -*-
__title__ = "Outline\nCheck"
__doc__ = """Compare the plan outline of model elements (e.g. Generic Model extrusions) with a DWG.
1. Select the elements (or pre-select them), 2. pick the DWG, 3. choose DWG layers and tolerance.
Creates a QAQC view with only these elements and the DWG: green = outline matches the DWG within
tolerance, red = deviates, orange = no DWG lines near it. Only X/Y is compared (plan outline)."""

import math
import datetime

import clr
clr.AddReference("System")
from System.Collections.Generic import List

from pyrevit import revit, forms, script
from Autodesk.Revit.DB import (CategoryType, Color, Curve, ElementId, ExtrusionAnalyzer, FillPatternElement,
                               FilteredElementCollector, GeometryInstance, GraphicsStyle, ImportInstance,
                               Options, OverrideGraphicSettings, PlanarFace, Plane, PolyLine, Solid,
                               Transaction, UnitTypeId, UnitUtils, View3D, ViewDetailLevel, ViewDuplicateOption,
                               ViewFamily, ViewFamilyType, ViewPlan, XYZ)
from Autodesk.Revit.UI.Selection import ISelectionFilter, ObjectType
from Autodesk.Revit.Exceptions import OperationCanceledException

doc = revit.doc
uidoc = revit.uidoc
output = script.get_output()

DEFAULT_TOLERANCE_MM = 10.0
SAMPLE_STEP_MM = 50.0      # distance between check points along each outline
SEARCH_MM = 500.0          # DWG lines farther than this count as "no DWG here"
CELL_MM = 1000.0           # spatial grid size for fast nearest-line lookup

GREEN = Color(0, 170, 0)
RED = Color(220, 0, 0)
ORANGE = Color(255, 140, 0)


def mm(v):
    return UnitUtils.ConvertToInternalUnits(v, UnitTypeId.Millimeters)


def to_mm(v):
    return UnitUtils.ConvertFromInternalUnits(v, UnitTypeId.Millimeters)


def id_int(eid):
    return eid.Value if hasattr(eid, "Value") else eid.IntegerValue


def ename(e):
    try:
        return e.Name
    except Exception:
        from Autodesk.Revit.DB import Element
        return Element.Name.__get__(e)


# ---------------- selection ----------------

class ModelElementFilter(ISelectionFilter):
    def AllowElement(self, e):
        return e.Category is not None and e.Category.CategoryType == CategoryType.Model \
            and not isinstance(e, ImportInstance)

    def AllowReference(self, ref, pt):
        return False


class DwgFilter(ISelectionFilter):
    def AllowElement(self, e):
        return isinstance(e, ImportInstance)

    def AllowReference(self, ref, pt):
        return False


def pick_elements():
    pre = [doc.GetElement(i) for i in uidoc.Selection.GetElementIds()]
    pre = [e for e in pre if ModelElementFilter().AllowElement(e)]
    if pre:
        return pre
    try:
        with forms.WarningBar(title="Select the elements to check, then click Finish"):
            refs = uidoc.Selection.PickObjects(ObjectType.Element, ModelElementFilter(),
                                               "Select the elements to check, then Finish")
    except OperationCanceledException:
        return []
    return [doc.GetElement(r) for r in refs]


def pick_dwg():
    try:
        with forms.WarningBar(title="Now click the DWG to compare with"):
            ref = uidoc.Selection.PickObject(ObjectType.Element, DwgFilter(), "Click the DWG")
    except OperationCanceledException:
        return None
    return doc.GetElement(ref)


# ---------------- DWG lines (2D segments in model coordinates) ----------------

def layer_name(geo_obj):
    style = doc.GetElement(geo_obj.GraphicsStyleId)
    if isinstance(style, GraphicsStyle) and style.GraphicsStyleCategory is not None:
        return style.GraphicsStyleCategory.Name
    return "(no layer)"


def dwg_polylines(dwg):
    """[(layer, [XYZ...])] for every curve / polyline in the DWG, including nested blocks."""
    opts = Options()
    opts.View = doc.ActiveView        # needed for DWGs imported into this view only
    result = []

    def walk(geo):
        for o in geo:
            if isinstance(o, GeometryInstance):
                walk(o.GetInstanceGeometry())
            elif isinstance(o, PolyLine):
                result.append((layer_name(o), list(o.GetCoordinates())))
            elif isinstance(o, Curve):
                try:
                    result.append((layer_name(o), list(o.Tessellate())))
                except Exception:
                    pass

    geo = dwg.get_Geometry(opts)
    if geo is not None:
        walk(geo)
    return result


def to_segments(points):
    segs = []
    for a, b in zip(points[:-1], points[1:]):
        if abs(a.X - b.X) + abs(a.Y - b.Y) > 1e-9:
            segs.append((a.X, a.Y, b.X, b.Y))
    return segs


class SegmentIndex(object):
    """Uniform grid over 2D segments for nearest-distance queries."""
    def __init__(self, segments, cell):
        self.cell = cell
        self.grid = {}
        self.segs = segments
        for i, (x1, y1, x2, y2) in enumerate(segments):
            for cx in range(self.c(min(x1, x2)), self.c(max(x1, x2)) + 1):
                for cy in range(self.c(min(y1, y2)), self.c(max(y1, y2)) + 1):
                    self.grid.setdefault((cx, cy), []).append(i)

    def c(self, v):
        return int(math.floor(v / self.cell))

    def nearest(self, x, y, radius):
        best = radius
        seen = set()
        for cx in range(self.c(x - radius), self.c(x + radius) + 1):
            for cy in range(self.c(y - radius), self.c(y + radius) + 1):
                for i in self.grid.get((cx, cy), ()):
                    if i in seen:
                        continue
                    seen.add(i)
                    d = point_segment_distance(x, y, self.segs[i])
                    if d < best:
                        best = d
        return best


def point_segment_distance(px, py, seg):
    x1, y1, x2, y2 = seg
    dx, dy = x2 - x1, y2 - y1
    ll = dx * dx + dy * dy
    t = 0.0 if ll == 0 else max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / ll))
    ex, ey = x1 + t * dx - px, y1 + t * dy - py
    return math.sqrt(ex * ex + ey * ey)


# ---------------- element plan outlines ----------------

def element_solids(elem):
    opts = Options()
    opts.DetailLevel = ViewDetailLevel.Fine
    solids = []

    def walk(geo):
        for o in geo:
            if isinstance(o, GeometryInstance):
                walk(o.GetInstanceGeometry())
            elif isinstance(o, Solid) and o.Volume > 1e-9:
                solids.append(o)

    geo = elem.get_Geometry(opts)
    if geo is not None:
        walk(geo)
    return solids


def outline_segments(elem):
    """Plan outline (projected along Z) as 2D segments."""
    plane = Plane.CreateByNormalAndOrigin(XYZ.BasisZ, XYZ.Zero)
    segs = []
    for solid in element_solids(elem):
        try:
            base = ExtrusionAnalyzer.Create(solid, plane, XYZ.BasisZ).GetExtrusionBase()
            for loop in base.GetEdgesAsCurveLoops():
                for crv in loop:
                    segs.extend(to_segments(list(crv.Tessellate())))
        except Exception:
            # fallback: edges of horizontal faces
            for face in solid.Faces:
                if isinstance(face, PlanarFace) and abs(face.FaceNormal.Z) > 0.99:
                    for loop in face.GetEdgesAsCurveLoops():
                        for crv in loop:
                            segs.extend(to_segments(list(crv.Tessellate())))
    return segs


def sample_points(segs, step):
    pts = []
    for x1, y1, x2, y2 in segs:
        length = math.hypot(x2 - x1, y2 - y1)
        n = max(1, int(math.ceil(length / step)))
        for k in range(n + 1):
            t = float(k) / n
            pts.append((x1 + t * (x2 - x1), y1 + t * (y2 - y1)))
    return pts


def check_element(elem, index, tol, step, search):
    segs = outline_segments(elem)
    if not segs:
        return {"status": "no geometry", "max": None, "within": 0.0}
    devs = [index.nearest(x, y, search) for x, y in sample_points(segs, step)]
    worst = max(devs)
    within = 100.0 * sum(1 for d in devs if d <= tol) / len(devs)
    if min(devs) >= search:
        status = "no DWG"
    elif worst <= tol:
        status = "OK"
    else:
        status = "deviates"
    return {"status": status, "max": worst, "within": within}


# ---------------- result view ----------------

def solid_fill_id():
    for fp in FilteredElementCollector(doc).OfClass(FillPatternElement):
        if fp.GetFillPattern().IsSolidFill:
            return fp.Id
    return ElementId.InvalidElementId


def overrides(color, fill_id):
    ogs = OverrideGraphicSettings()
    ogs.SetProjectionLineColor(color)
    ogs.SetCutLineColor(color)
    if fill_id != ElementId.InvalidElementId:
        ogs.SetSurfaceForegroundPatternId(fill_id)
        ogs.SetSurfaceForegroundPatternColor(color)
        ogs.SetCutForegroundPatternId(fill_id)
        ogs.SetCutForegroundPatternColor(color)
    return ogs


def create_result_view(source):
    if isinstance(source, ViewPlan) and source.CanViewBeDuplicated(ViewDuplicateOption.WithDetailing):
        view = doc.GetElement(source.Duplicate(ViewDuplicateOption.WithDetailing))
    else:
        vft = [t for t in FilteredElementCollector(doc).OfClass(ViewFamilyType)
               if t.ViewFamily == ViewFamily.ThreeDimensional][0]
        view = View3D.CreateIsometric(doc, vft.Id)
    if view.ViewTemplateId != ElementId.InvalidElementId:
        view.ViewTemplateId = ElementId.InvalidElementId
    view.Name = "QAQC Outline Check {}".format(datetime.datetime.now().strftime("%Y-%m-%d %H%M%S"))
    return view


# ---------------- main ----------------

def main():
    elements = pick_elements()
    if not elements:
        return
    dwg = pick_dwg()
    if dwg is None:
        return

    polylines = dwg_polylines(dwg)
    if not polylines:
        forms.alert("No lines found in this DWG (in the active view).", title=__title__, exitscript=True)
    layers = sorted(set(l for l, _ in polylines))
    if len(layers) > 1:
        picked = forms.SelectFromList.show(layers, multiselect=True, title="DWG layers to compare with",
                                           button_name="Use these layers")
        if not picked:
            return
        layers = set(picked)
    tol_text = forms.ask_for_string(default="{:g}".format(DEFAULT_TOLERANCE_MM),
                                    prompt="Tolerance in mm (max distance from the DWG line):", title=__title__)
    if tol_text is None:
        return
    try:
        tol_mm = float(tol_text.replace(",", "."))
    except ValueError:
        forms.alert("'{}' is not a number.".format(tol_text), title=__title__, exitscript=True)

    segments = []
    for layer, pts in polylines:
        if layer in layers:
            segments.extend(to_segments(pts))
    index = SegmentIndex(segments, mm(CELL_MM))
    tol, step, search = mm(tol_mm), mm(SAMPLE_STEP_MM), mm(max(SEARCH_MM, 5 * tol_mm))

    results = []
    with forms.ProgressBar(title="Checking outlines ({value} of {max_value})") as pb:
        for i, elem in enumerate(elements):
            results.append((elem, check_element(elem, index, tol, step, search)))
            pb.update_progress(i + 1, len(elements))

    source_view = doc.ActiveView
    fill_id = solid_fill_id()
    colors = {"OK": GREEN, "deviates": RED, "no DWG": ORANGE, "no geometry": ORANGE}
    t = Transaction(doc, "QAQC Outline Check")
    t.Start()
    try:
        view = create_result_view(source_view)
        doc.Regenerate()
        # a DWG imported "current view only" is copied with the view (new id): use whatever copy is there
        dwgs = [i.Id for i in FilteredElementCollector(doc, view.Id).OfClass(ImportInstance)
                if i.GetTypeId() == dwg.GetTypeId()]
        ids = List[ElementId]([e.Id for e in elements] + dwgs)
        view.IsolateElementsTemporary(ids)
        view.ConvertTemporaryHideIsolateToPermanent()
        for elem, res in results:
            view.SetElementOverrides(elem.Id, overrides(colors[res["status"]], fill_id))
        t.Commit()
    except Exception as ex:
        t.RollBack()
        forms.alert("Could not create the result view:\n{}".format(ex), title=__title__, exitscript=True)
    uidoc.ActiveView = view

    order = {"deviates": 0, "no DWG": 1, "no geometry": 2, "OK": 3}
    results.sort(key=lambda r: (order[r[1]["status"]], -(r[1]["max"] or 0)))
    rows = []
    for elem, res in results:
        etype = doc.GetElement(elem.GetTypeId())
        family = getattr(etype, "FamilyName", "") if etype is not None else ""
        max_dev = "-" if res["max"] is None else (
            ">{:.0f}".format(to_mm(search)) if res["status"] == "no DWG" else "{:.1f}".format(to_mm(res["max"])))
        rows.append([output.linkify(elem.Id), family, ename(etype) if etype is not None else "",
                     res["status"], max_dev, "{:.0f}%".format(res["within"])])
    counts = dict((s, sum(1 for _, r in results if r["status"] == s)) for s in order)
    output.print_md("## QAQC Outline Check")
    output.print_md("**View:** {}  |  **DWG:** {}  |  **Tolerance:** {:g} mm  |  **Layers:** {}".format(
        view.Name, ename(doc.GetElement(dwg.GetTypeId())), tol_mm, ", ".join(sorted(layers))))
    output.print_md("**OK:** {OK}  |  **Deviates:** {deviates}  |  **No DWG nearby:** {nodwg}".format(
        OK=counts["OK"], deviates=counts["deviates"], nodwg=counts["no DWG"] + counts["no geometry"]))
    output.print_table(rows, columns=["Element", "Family", "Type", "Result", "Max deviation (mm)",
                                      "Outline within tolerance"])


main()
