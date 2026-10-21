# -*- coding: utf-8 -*-
__title__ = "Reference\nFaces"
__doc__ = """Place two points with Revit's adaptive placement (you see the points, all snaps work, also on DWGs
in 3D). You can place several pairs, Esc to finish. For every pair a Generic Model is created with:
- a vertical plate whose face lies exactly in the vertical plane through both points,
- a horizontal plate whose top face is exactly at the height of the points.
Use the faces for Set Work Plane, dimensions or Align. First run builds the small adaptive family
'PB Reference Points' from Revit's adaptive template. Works in Revit 2023 and 2025."""

import os
import tempfile

import clr
clr.AddReference("System")
from System.Collections.Generic import List

from pyrevit import revit, forms, script
from Autodesk.Revit.DB import (AdaptiveComponentFamilyUtils, AdaptiveComponentInstanceUtils, AdaptivePointType,
                               BuiltInCategory, BuiltInParameter, Color, Curve, CurveLoop, DirectShape,
                               DirectShapeReferencingOption, ElementId, Family, FamilyInstance,
                               FilteredElementCollector, GeometryCreationUtilities, GeometryObject, Line, Material,
                               ReferencePointArray, SaveAsOptions, SolidOptions, Transaction, UnitTypeId,
                               UnitUtils, XYZ)
from Autodesk.Revit.Exceptions import OperationCanceledException

doc = revit.doc
uidoc = revit.uidoc
app = doc.Application
config = script.get_config()

THICKNESS_MM = 10.0       # plate thickness (the reference face is exactly on the picked plane)
OVERHANG_MM = 500.0       # plates extend this far beyond the two points
HEIGHT_MM = 1000.0        # vertical plate reaches this far above and below the points
WIDTH_MM = 1000.0         # horizontal plate reaches this far to both sides of the vertical plate
SAME_HEIGHT_MM = 1.0
MATERIAL_NAME = "PB Reference Faces"
LABEL = "PB Reference Faces"
FAMILY_NAME = "PB Reference Points"
TITLE = "Reference Faces"


def mm(v):
    return UnitUtils.ConvertToInternalUnits(v, UnitTypeId.Millimeters)


# ---------------- adaptive helper family ----------------

def find_family():
    for f in FilteredElementCollector(doc).OfClass(Family):
        if f.Name == FAMILY_NAME:
            return f
    return None


def find_adaptive_template():
    """Revit's 'Generic Model Adaptive' template (any language), remembered after the first time."""
    saved = str(config.get_option("adaptive_template", "") or "")
    if saved and os.path.isfile(saved):
        return saved
    found = []
    root = app.FamilyTemplatePath or ""
    for base in (root, os.path.dirname(root.rstrip("\\/"))):
        if not base or not os.path.isdir(base):
            continue
        for folder, _, files in os.walk(base):
            for f in files:
                low = f.lower()
                if low.endswith(".rft") and "adaptiv" in low and "pattern" not in low and "muster" not in low:
                    found.append(os.path.join(folder, f))
        if found:
            break
    found.sort(key=lambda p: (0 if "metric" in os.path.basename(p).lower() else 1, len(p)))
    path = found[0] if found else forms.pick_file(file_ext="rft", title="Choose the 'Generic Model Adaptive' "
                                                                         "family template")
    if path:
        try:
            config.adaptive_template = path
            script.save_config()
        except Exception:
            pass
    return path


def build_family():
    template = find_adaptive_template()
    if not template:
        return None
    fam_doc = app.NewFamilyDocument(template)
    try:
        t = Transaction(fam_doc, "Adaptive points")
        t.Start()
        points = ReferencePointArray()
        for x in (0.0, mm(3000)):
            rp = fam_doc.FamilyCreate.NewReferencePoint(XYZ(x, 0, 0))
            AdaptiveComponentFamilyUtils.MakeAdaptivePoint(fam_doc, rp.Id, AdaptivePointType.PlacementPoint)
            points.Append(rp)
        fam_doc.FamilyCreate.NewCurveByPoints(points)     # visible line between the points while placing
        t.Commit()
        path = os.path.join(tempfile.gettempdir(), FAMILY_NAME + ".rfa")
        opts = SaveAsOptions()
        opts.OverwriteExistingFile = True
        fam_doc.SaveAs(path, opts)
        return fam_doc.LoadFamily(doc)
    finally:
        fam_doc.Close(False)


def helper_symbol():
    family = find_family() or build_family()
    if family is None:
        return None
    symbol = doc.GetElement(list(family.GetFamilySymbolIds())[0])
    if not symbol.IsActive:
        t = Transaction(doc, "Activate reference points")
        t.Start()
        symbol.Activate()
        t.Commit()
    return symbol


def id_int(eid):
    return eid.Value if hasattr(eid, "Value") else eid.IntegerValue


def instances_of(symbol):
    return set(id_int(i.Id) for i in FilteredElementCollector(doc).OfClass(FamilyInstance)
               if i.Symbol.Id == symbol.Id)


# ---------------- reference plates ----------------

def rectangle(corners):
    pts = list(corners) + [corners[0]]
    return CurveLoop.Create(List[Curve]([Line.CreateBound(a, b) for a, b in zip(pts[:-1], pts[1:])]))


def plate(corners, direction, thickness, options):
    loops = List[CurveLoop]([rectangle(corners)])
    return GeometryCreationUtilities.CreateExtrusionGeometry(loops, direction, thickness, options)


def helper_material():
    for m in FilteredElementCollector(doc).OfClass(Material):
        if m.Name == MATERIAL_NAME:
            return m.Id
    mid = Material.Create(doc, MATERIAL_NAME)
    mat = doc.GetElement(mid)
    mat.Color = Color(80, 170, 255)
    mat.Transparency = 60
    return mid


def horizontal_height(a, b, number):
    if abs(a.Z - b.Z) <= mm(SAME_HEIGHT_MM):
        return a.Z
    choice = forms.CommandSwitchWindow.show(
        ["Height of point 1", "Height of point 2", "In the middle"],
        message="Pair {}: the points are at different heights. Where should the horizontal face be?".format(number))
    if choice is None:
        return None
    return {"Height of point 1": a.Z, "Height of point 2": b.Z}.get(choice, (a.Z + b.Z) / 2.0)


def create_plates(a, b, zh, material_id):
    d = XYZ(b.X - a.X, b.Y - a.Y, 0)
    length = d.GetLength()
    d = d.Normalize()
    n = XYZ.BasisZ.CrossProduct(d).Normalize()      # horizontal, perpendicular to the vertical plate
    t, over, w = mm(THICKNESS_MM), mm(OVERHANG_MM), mm(WIDTH_MM)
    z0 = min(a.Z, b.Z, zh) - mm(HEIGHT_MM)
    z1 = max(a.Z, b.Z, zh) + mm(HEIGHT_MM)
    base = XYZ(a.X, a.Y, 0)

    def at(s, z, side=0.0):
        return base + d * s + n * side + XYZ.BasisZ * z

    options = SolidOptions(material_id, ElementId.InvalidElementId)
    # vertical plate: face exactly in the plane through both points, thickness towards +n
    vertical = plate([at(-over, z0), at(length + over, z0), at(length + over, z1), at(-over, z1)], n, t, options)
    # horizontal plate: top face exactly at zh, thickness downwards
    horizontal = plate([at(-over, zh, -w), at(length + over, zh, -w), at(length + over, zh, w),
                        at(-over, zh, w)], XYZ.BasisZ.Negate(), t, options)

    ds = DirectShape.CreateElement(doc, ElementId(BuiltInCategory.OST_GenericModel))
    ds.ApplicationId = "PomadaTools"
    ds.ApplicationDataId = "ReferenceFaces"
    ds.SetShape(List[GeometryObject]([vertical, horizontal]))
    opts = ds.GetOptions()
    opts.ReferencingOption = DirectShapeReferencingOption.Referenceable
    ds.SetOptions(opts)
    try:
        ds.SetName(LABEL)
    except Exception:
        pass
    p = ds.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS)
    if p is not None and not p.IsReadOnly:
        p.Set(LABEL)
    return ds


# ---------------- main ----------------

def main():
    try:
        symbol = helper_symbol()
    except Exception as ex:
        forms.alert(u"Could not create the adaptive helper family:\n{}".format(ex), title=TITLE)
        return
    if symbol is None:
        return

    before = instances_of(symbol)
    try:
        with forms.WarningBar(title="Place point 1 and point 2 (snaps work). Repeat for more pairs, Esc to finish"):
            uidoc.PromptForFamilyInstancePlacement(symbol)
    except OperationCanceledException:
        pass
    new_ids = instances_of(symbol) - before
    if not new_ids:
        return
    placed = [doc.GetElement(ElementId(i)) for i in sorted(new_ids)]

    pairs, skipped = [], 0
    for k, inst in enumerate(placed):
        ref_ids = AdaptiveComponentInstanceUtils.GetInstancePlacementPointElementRefIds(inst)
        pts = [doc.GetElement(i).Position for i in ref_ids]
        if len(pts) < 2 or XYZ(pts[1].X - pts[0].X, pts[1].Y - pts[0].Y, 0).GetLength() < mm(1):
            skipped += 1                    # points vertically above each other: no vertical plane
            pairs.append((inst, None, None, None))
            continue
        zh = horizontal_height(pts[0], pts[1], k + 1)
        pairs.append((inst, pts[0], pts[1], zh))

    created = []
    t = Transaction(doc, "Reference Faces")
    t.Start()
    try:
        material_id = helper_material()
        for inst, a, b, zh in pairs:
            if a is not None and zh is not None:
                created.append(create_plates(a, b, zh, material_id))
            doc.Delete(inst.Id)             # the adaptive helper was only used to place the points
        t.Commit()
    except Exception as ex:
        t.RollBack()
        forms.alert(u"Could not create the reference faces:\n{}".format(ex), title=TITLE)
        return

    if created:
        uidoc.Selection.SetElementIds(List[ElementId]([ds.Id for ds in created]))
    if skipped:
        forms.alert("{} pair(s) skipped: the two points were vertically above each other, so they do not "
                    "define a vertical plane.".format(skipped), title=TITLE)


main()
