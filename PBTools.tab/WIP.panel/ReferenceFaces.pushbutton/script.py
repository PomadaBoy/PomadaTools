# -*- coding: utf-8 -*-
__title__ = "Reference\nFaces"
__doc__ = """Place two points with Revit's adaptive placement (you see the points, all snaps work, also on DWGs
in 3D). You can place several pairs, Esc to finish. For every pair a Generic Model is created with two
surfaces without thickness:
- a vertical surface exactly in the vertical plane through both points,
- a surface through the line point 1 -> point 2, perpendicular to the vertical one (it tilts with the line).
Use the faces for Set Work Plane, dimensions or Align. First run builds the small adaptive family
'PB Reference Points' from Revit's adaptive template. Works in Revit 2023 and 2025."""

import os
import tempfile

import clr
clr.AddReference("System")
from System.Collections.Generic import List

from pyrevit import revit, forms, script
from Autodesk.Revit.DB import (AdaptiveComponentFamilyUtils, AdaptiveComponentInstanceUtils, AdaptivePointType,
                               BuiltInCategory, BuiltInParameter, Color, DirectShape, DirectShapeReferencingOption,
                               ElementId, Family, FamilyInstance, FilteredElementCollector, GeometryObject,
                               Material, ReferencePointArray, SaveAsOptions, TessellatedFace,
                               TessellatedShapeBuilder, TessellatedShapeBuilderFallback,
                               TessellatedShapeBuilderOutcome, TessellatedShapeBuilderTarget, Transaction,
                               UnitTypeId, UnitUtils, XYZ)
from Autodesk.Revit.Exceptions import OperationCanceledException

doc = revit.doc
uidoc = revit.uidoc
app = doc.Application
config = script.get_config()

OVERHANG_MM = 500.0       # surfaces extend this far beyond the two points
HEIGHT_MM = 1000.0        # vertical surface reaches this far above and below the points
WIDTH_MM = 1000.0         # the surface along the line reaches this far to both sides of the vertical one
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


# ---------------- reference surfaces (no thickness) ----------------

def helper_material():
    for m in FilteredElementCollector(doc).OfClass(Material):
        if m.Name == MATERIAL_NAME:
            return m.Id
    mid = Material.Create(doc, MATERIAL_NAME)
    mat = doc.GetElement(mid)
    mat.Color = Color(80, 170, 255)
    mat.Transparency = 60
    return mid


def sheet(corners, material_id):
    """One flat face without thickness (an open 'sheet'). Returns (geometry objects, outcome)."""
    builder = TessellatedShapeBuilder()
    builder.OpenConnectedFaceSet(False)
    builder.AddFace(TessellatedFace(List[XYZ](corners), material_id))
    builder.CloseConnectedFaceSet()
    builder.Target = TessellatedShapeBuilderTarget.AnyGeometry
    builder.Fallback = TessellatedShapeBuilderFallback.Mesh
    builder.Build()
    result = builder.GetBuildResult()
    return list(result.GetGeometricalObjects()), result.Outcome


def create_surfaces(a, b, material_id):
    """Vertical surface through a and b + surface through the line a-b perpendicular to it.
    Returns (DirectShape, True if both are real faces and not just meshes)."""
    line = b - a
    d = XYZ(line.X, line.Y, 0).Normalize()           # horizontal direction of the line
    n = XYZ.BasisZ.CrossProduct(d).Normalize()       # normal of the vertical surface (horizontal)
    u = line.Normalize()                             # direction of the line itself (may slope)
    over, w, h = mm(OVERHANG_MM), mm(WIDTH_MM), mm(HEIGHT_MM)
    length_h = XYZ(line.X, line.Y, 0).GetLength()
    length = line.GetLength()
    base = XYZ(a.X, a.Y, 0)
    z0, z1 = min(a.Z, b.Z) - h, max(a.Z, b.Z) + h

    def vert(s, z):
        return base + d * s + XYZ.BasisZ * z

    def along(s, side):
        return a + u * s + n * side

    vertical = [vert(-over, z0), vert(length_h + over, z0), vert(length_h + over, z1), vert(-over, z1)]
    # contains the line (u) and the vertical surface's normal (n): perpendicular to the vertical surface
    on_line = [along(-over, -w), along(length + over, -w), along(length + over, w), along(-over, w)]

    shapes, faces_ok = [], True
    for corners in (vertical, on_line):
        objs, outcome = sheet(corners, material_id)
        shapes.extend(objs)
        faces_ok = faces_ok and outcome != TessellatedShapeBuilderOutcome.Mesh

    ds = DirectShape.CreateElement(doc, ElementId(BuiltInCategory.OST_GenericModel))
    ds.ApplicationId = "PomadaTools"
    ds.ApplicationDataId = "ReferenceFaces"
    ds.SetShape(List[GeometryObject](shapes))
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
    return ds, faces_ok


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

    created, skipped, meshes = [], 0, 0
    t = Transaction(doc, "Reference Faces")
    t.Start()
    try:
        material_id = helper_material()
        for inst in placed:
            ref_ids = AdaptiveComponentInstanceUtils.GetInstancePlacementPointElementRefIds(inst)
            pts = [doc.GetElement(i).Position for i in ref_ids]
            if len(pts) >= 2 and XYZ(pts[1].X - pts[0].X, pts[1].Y - pts[0].Y, 0).GetLength() >= mm(1):
                ds, faces_ok = create_surfaces(pts[0], pts[1], material_id)
                created.append(ds)
                meshes += 0 if faces_ok else 1
            else:
                skipped += 1                # points vertically above each other: no vertical plane
            doc.Delete(inst.Id)             # the adaptive helper was only used to place the points
        t.Commit()
    except Exception as ex:
        t.RollBack()
        forms.alert(u"Could not create the reference faces:\n{}".format(ex), title=TITLE)
        return

    if created:
        uidoc.Selection.SetElementIds(List[ElementId]([ds.Id for ds in created]))
    notes = []
    if skipped:
        notes.append("{} pair(s) skipped: the two points were vertically above each other, so they do not "
                     "define a vertical plane.".format(skipped))
    if meshes:
        notes.append("{} element(s) could only be built as a mesh - their surfaces may not be pickable as "
                     "work planes.".format(meshes))
    if notes:
        forms.alert("\n\n".join(notes), title=TITLE)


main()
