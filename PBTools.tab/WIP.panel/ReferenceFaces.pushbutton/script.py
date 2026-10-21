# -*- coding: utf-8 -*-
__title__ = "Reference\nFaces"
__doc__ = """Click two points (on faces, edges, model lines or an imported DWG).
Creates a Generic Model (DirectShape) with two thin plates you can pick as faces / references:
- a vertical plate whose face lies exactly in the vertical plane through both points,
- a horizontal plate perpendicular to it, whose top face is exactly at the height of the points.
Use them for Set Work Plane, dimensions or Align. Delete the element when done. Works in Revit 2023 and 2025."""

import clr
clr.AddReference("System")
from System.Collections.Generic import List

from pyrevit import revit, forms
from Autodesk.Revit.DB import (BuiltInCategory, BuiltInParameter, Color, Curve, CurveLoop, DirectShape,
                               DirectShapeReferencingOption, ElementId, FilteredElementCollector,
                               GeometryCreationUtilities, GeometryObject, Line, Material, SolidOptions,
                               Transaction, UnitTypeId, UnitUtils, XYZ)
from Autodesk.Revit.UI.Selection import ObjectType
from Autodesk.Revit.Exceptions import OperationCanceledException

doc = revit.doc
uidoc = revit.uidoc

THICKNESS_MM = 10.0       # plate thickness (the reference face is exactly on the picked plane)
OVERHANG_MM = 500.0       # plates extend this far beyond the two points
HEIGHT_MM = 1000.0        # vertical plate reaches this far above and below the points
WIDTH_MM = 1000.0         # horizontal plate reaches this far to both sides of the vertical plate
SAME_HEIGHT_MM = 1.0
MATERIAL_NAME = "PB Reference Faces"
LABEL = "PB Reference Faces"


def mm(v):
    return UnitUtils.ConvertToInternalUnits(v, UnitTypeId.Millimeters)


def pick_point(prompt):
    with forms.WarningBar(title=prompt):
        ref = uidoc.Selection.PickObject(ObjectType.PointOnElement, prompt)
    return ref.GlobalPoint


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


def main():
    try:
        a = pick_point("Click the FIRST point (face, edge, line or DWG)")
        b = pick_point("Click the SECOND point")
    except OperationCanceledException:
        return

    d = XYZ(b.X - a.X, b.Y - a.Y, 0)
    length = d.GetLength()
    if length < mm(1):
        forms.alert("The two points are (almost) vertically above each other, so they do not define a vertical "
                    "plane. Pick two points with some horizontal distance.", title="Reference Faces")
        return
    d = d.Normalize()
    n = XYZ.BasisZ.CrossProduct(d).Normalize()      # horizontal, perpendicular to the vertical plate

    zh = a.Z
    if abs(a.Z - b.Z) > mm(SAME_HEIGHT_MM):
        choice = forms.CommandSwitchWindow.show(
            ["Height of point 1", "Height of point 2", "In the middle"],
            message="The points are at different heights. Where should the horizontal face be?")
        if choice is None:
            return
        zh = {"Height of point 1": a.Z, "Height of point 2": b.Z}.get(choice, (a.Z + b.Z) / 2.0)

    t, over, w = mm(THICKNESS_MM), mm(OVERHANG_MM), mm(WIDTH_MM)
    z0 = min(a.Z, b.Z, zh) - mm(HEIGHT_MM)
    z1 = max(a.Z, b.Z, zh) + mm(HEIGHT_MM)
    base = XYZ(a.X, a.Y, 0)

    def at(s, z, side=0.0):
        return base + d * s + n * side + XYZ.BasisZ * z

    tr = Transaction(doc, "Reference Faces")
    tr.Start()
    try:
        options = SolidOptions(helper_material(), ElementId.InvalidElementId)
        # vertical plate: face exactly in the plane through both points, thickness towards +n
        vertical = plate([at(-over, z0), at(length + over, z0), at(length + over, z1), at(-over, z1)],
                         n, t, options)
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
        tr.Commit()
    except Exception as ex:
        tr.RollBack()
        forms.alert(u"Could not create the reference faces:\n{}".format(ex), title="Reference Faces")
        return

    uidoc.Selection.SetElementIds(List[ElementId]([ds.Id]))


main()
