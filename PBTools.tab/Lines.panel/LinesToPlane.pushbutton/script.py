# -*- coding: utf-8 -*-
__title__ = "Lines to Plane"
__doc__ = """Copies 2D lines (e.g. exploded DWG in a section) onto a plane in a 3D view as model lines.
1. Select lines in the current view (or pre-select them) and click Finish
2. Pick the insertion point
3. Choose a 3D view, then pick a planar face or a reference plane
4. Pick the insertion point on that plane
Line styles are kept. The whole placement is one Undo step."""

import clr
clr.AddReference("System")
from System.Collections.Generic import List

from pyrevit import revit, forms, script
from Autodesk.Revit.DB import (BuiltInCategory, CurveElement, ElementId, FilteredElementCollector,
                               PlanarFace, Plane, ReferencePlane, SketchPlane, Transaction,
                               TransactionGroup, Transform, View3D, XYZ)
from Autodesk.Revit.UI.Selection import ISelectionFilter, ObjectType
from Autodesk.Revit.Exceptions import OperationCanceledException

doc = revit.doc
uidoc = revit.uidoc
LINES_CAT_ID = ElementId(BuiltInCategory.OST_Lines)


class LineFilter(ISelectionFilter):
    def AllowElement(self, el):
        return isinstance(el, CurveElement) and el.Category is not None \
            and el.Category.Id.Equals(LINES_CAT_ID)

    def AllowReference(self, ref, pt):
        return False


class PlanarFaceFilter(ISelectionFilter):
    def AllowElement(self, el):
        return True

    def AllowReference(self, ref, pt):
        try:
            return isinstance(doc.GetElement(ref).GetGeometryObjectFromReference(ref), PlanarFace)
        except Exception:
            return False


class RefPlaneFilter(ISelectionFilter):
    def AllowElement(self, el):
        return isinstance(el, ReferencePlane)

    def AllowReference(self, ref, pt):
        return False


def make_tf(origin, bx, by, bz):
    t = Transform.CreateTranslation(origin)
    t.BasisX = bx
    t.BasisY = by
    t.BasisZ = bz
    return t


def project_on_plane(v, n):
    return v.Subtract(n.Multiply(v.DotProduct(n)))


def target_axes(n, view3d):
    # Normal faces the camera so lines read unmirrored; "up" follows global Z where possible.
    if n.DotProduct(view3d.ViewDirection) < 0:
        n = n.Negate()
    up = project_on_plane(XYZ.BasisZ, n)
    if up.GetLength() < 1e-3:
        up = project_on_plane(view3d.UpDirection, n)
    up = up.Normalize()
    return up.CrossProduct(n).Normalize(), up, n


def pick_3d_view():
    open3d = []
    for uiv in uidoc.GetOpenUIViews():
        v = doc.GetElement(uiv.ViewId)
        if isinstance(v, View3D) and not v.IsTemplate:
            open3d.append(v)
    if len(open3d) == 1:
        return open3d[0]
    cands = open3d or [v for v in FilteredElementCollector(doc).OfClass(View3D) if not v.IsTemplate]
    cands = sorted(cands, key=lambda v: v.Name)
    return forms.SelectFromList.show(cands, name_attr="Name", title="Choose 3D view", multiselect=False)


# ---------- 1. Source lines + base point ----------
src = doc.ActiveView
if isinstance(src, View3D):
    forms.alert("Run this from the 2D view (section, elevation, drafting...) that contains the lines.",
                title=__title__, exitscript=True)

line_filter = LineFilter()
lines = [doc.GetElement(i) for i in uidoc.Selection.GetElementIds()]
lines = [e for e in lines if line_filter.AllowElement(e)]

try:
    if not lines:
        with forms.WarningBar(title="Select lines to copy, then click Finish"):
            refs = uidoc.Selection.PickObjects(ObjectType.Element, line_filter, "Select lines, then Finish")
        lines = [doc.GetElement(r) for r in refs]
    if not lines:
        script.exit()

    if src.SketchPlane is None:
        t = Transaction(doc, "Set work plane")
        t.Start()
        src.SketchPlane = SketchPlane.Create(doc, Plane.CreateByNormalAndOrigin(src.ViewDirection, src.Origin))
        t.Commit()

    with forms.WarningBar(title="Pick the insertion point"):
        base = uidoc.Selection.PickPoint("Pick the insertion point")
except OperationCanceledException:
    script.exit()

view_dir = src.ViewDirection
tf_src = make_tf(base, src.RightDirection, src.UpDirection, view_dir)

curves = []
for el in lines:
    c = el.GeometryCurve
    p = c.GetEndPoint(0) if c.IsBound else c.Evaluate(0.0, False)
    dz = p.Subtract(base).DotProduct(view_dir)
    if abs(dz) > 1e-9:
        c = c.CreateTransformed(Transform.CreateTranslation(view_dir.Multiply(-dz)))
    curves.append((c, el.LineStyle))

# ---------- 2. Target plane in 3D ----------
v3d = pick_3d_view()
if not v3d:
    script.exit()
uidoc.ActiveView = v3d

mode = forms.CommandSwitchWindow.show(["Planar face", "Reference plane"], message="Place lines on:")
if not mode:
    script.exit()

tg = TransactionGroup(doc, __title__)
tg.Start()
try:
    if mode == "Planar face":
        with forms.WarningBar(title="Pick a planar face"):
            ref = uidoc.Selection.PickObject(ObjectType.Face, PlanarFaceFilter(), "Pick a planar face")
    else:
        with forms.WarningBar(title="Pick a reference plane"):
            rp_ref = uidoc.Selection.PickObject(ObjectType.Element, RefPlaneFilter(), "Pick a reference plane")
        ref = doc.GetElement(rp_ref).GetReference()

    t = Transaction(doc, "Set work plane")
    t.Start()
    sp = SketchPlane.Create(doc, ref)
    v3d.SketchPlane = sp
    t.Commit()

    with forms.WarningBar(title="Pick the insertion point on the plane"):
        target = uidoc.Selection.PickPoint("Pick the insertion point on the plane")

    plane = sp.GetPlane()
    n0 = plane.Normal
    target = target.Subtract(n0.Multiply(target.Subtract(plane.Origin).DotProduct(n0)))
    right, up, n = target_axes(n0, v3d)
    tf_total = make_tf(target, right, up, n).Multiply(tf_src.Inverse)

    t = Transaction(doc, "Create model lines")
    t.Start()
    new_ids = List[ElementId]()
    failed = 0
    for c, style in curves:
        try:
            mc = doc.Create.NewModelCurve(c.CreateTransformed(tf_total), sp)
            new_ids.Add(mc.Id)
            try:
                mc.LineStyle = style
            except Exception:
                pass
        except Exception:
            failed += 1

    if new_ids.Count == 0:
        t.RollBack()
        tg.RollBack()
        forms.alert("No lines could be created on that plane.", title=__title__, exitscript=True)

    t.Commit()
    tg.Assimilate()
except OperationCanceledException:
    tg.RollBack()
    script.exit()
except Exception as ex:
    if tg.HasStarted() and not tg.HasEnded():
        tg.RollBack()
    forms.alert("Failed: {}".format(ex), title=__title__, exitscript=True)

uidoc.Selection.SetElementIds(new_ids)
if failed:
    forms.alert("Created {} lines. {} could not be placed (not parallel to the source view plane)."
                .format(new_ids.Count, failed), title=__title__)
