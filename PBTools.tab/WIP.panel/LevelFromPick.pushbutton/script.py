# -*- coding: utf-8 -*-
__title__ = "Level\nfrom Pick"
__doc__ = """Click a horizontal face, an edge / line or a point on an element: a level is created at that height.
Horizontal faces and edges give their exact height, anything else the height of the clicked point.
At the end you can create a floor or structural plan on the new level. One Undo step.
Works in Revit 2023 and 2025."""

from pyrevit import revit, forms
from Autodesk.Revit.DB import (BuiltInParameter, Curve, Edge, Element, FamilyInstance, FilteredElementCollector,
                               Instance, Level, PlanarFace, Transaction, TransactionGroup, Transform, UnitTypeId,
                               UnitUtils, ViewFamily, ViewFamilyType, ViewPlan)
from Autodesk.Revit.UI.Selection import ObjectType
from Autodesk.Revit.Exceptions import OperationCanceledException

doc = revit.doc
uidoc = revit.uidoc

SAME_LEVEL_MM = 1.0           # existing level closer than this counts as "already there"
FORBIDDEN = u'\\:{}[]|;<>?`~'


def mm(v):
    return UnitUtils.ConvertToInternalUnits(v, UnitTypeId.Millimeters)


def ename(e):
    try:
        return e.Name
    except Exception:
        return Element.Name.__get__(e)


def element_label(elem):
    if isinstance(elem, FamilyInstance):
        return elem.Symbol.FamilyName
    return ename(elem) or (elem.Category.Name if elem.Category else "Element")


def geometry_transform(elem, geo, gpt):
    """Family geometry can come in family or in project coordinates: use the one that fits the click."""
    candidates = [Transform.Identity]
    if isinstance(elem, Instance):
        candidates.append(elem.GetTotalTransform())
    best = None
    for tf in candidates:
        local = tf.Inverse.OfPoint(gpt)
        try:
            if isinstance(geo, PlanarFace):
                res = geo.Project(local)
                dist = res.Distance if res is not None else None
            else:
                crv = geo.AsCurve() if isinstance(geo, Edge) else geo
                res = crv.Project(local)
                dist = res.Distance if res is not None else None
        except Exception:
            dist = None
        if dist is not None and (best is None or dist < best[0]):
            best = (dist, tf)
    return best[1] if best else Transform.Identity


def picked_height(elem, ref):
    """(height in internal units, description of what was picked)."""
    gpt = ref.GlobalPoint
    try:
        geo = elem.GetGeometryObjectFromReference(ref)
    except Exception:
        geo = None
    if isinstance(geo, PlanarFace):
        tf = geometry_transform(elem, geo, gpt)
        if abs(tf.OfVector(geo.FaceNormal).Z) > 0.9999:
            return tf.OfPoint(geo.Origin).Z, "horizontal face"
        return gpt.Z, "sloped face - height of the clicked point"
    if isinstance(geo, (Edge, Curve)):
        tf = geometry_transform(elem, geo, gpt)
        crv = geo.AsCurve() if isinstance(geo, Edge) else geo
        try:
            z0, z1 = tf.OfPoint(crv.GetEndPoint(0)).Z, tf.OfPoint(crv.GetEndPoint(1)).Z
            if abs(z0 - z1) < 1e-6:
                return z0, "horizontal edge"
        except Exception:
            pass
        return gpt.Z, "sloped edge - height of the clicked point"
    return gpt.Z, "point"


def unique_level_name(name):
    existing = set(l.Name for l in FilteredElementCollector(doc).OfClass(Level))
    if name not in existing:
        return name
    n = 2
    while u"{} ({})".format(name, n) in existing:
        n += 1
    return u"{} ({})".format(name, n)


def clean_name(name):
    return "".join("_" if c in FORBIDDEN else c for c in name).strip()


def main():
    try:
        with forms.WarningBar(title="Click a horizontal face, an edge / line or a point on an element"):
            ref = uidoc.Selection.PickObject(ObjectType.PointOnElement,
                                             "Click a horizontal face, an edge / line or a point")
    except OperationCanceledException:
        return
    elem = doc.GetElement(ref)
    z, what = picked_height(elem, ref)

    near = [l for l in FilteredElementCollector(doc).OfClass(Level) if abs(l.ProjectElevation - z) < mm(SAME_LEVEL_MM)]
    if near:
        if not forms.alert(u"Level '{}' is already at this height. Create another one anyway?".format(near[0].Name),
                           title=__title__, yes=True, no=True):
            return

    tg = TransactionGroup(doc, "Level from Pick")
    tg.Start()
    t = None
    try:
        t = Transaction(doc, "Create level")
        t.Start()
        level = Level.Create(doc, z)
        doc.Regenerate()
        if abs(level.ProjectElevation - z) > 1e-6:      # Level.Create may measure from the elevation base
            level.Elevation = level.Elevation + (z - level.ProjectElevation)
        t.Commit()

        shown = level.get_Parameter(BuiltInParameter.LEVEL_ELEV).AsValueString()
        sign = "" if shown.startswith("-") else "+"
        name = forms.ask_for_string(default=clean_name(u"{} {}{}".format(element_label(elem), sign, shown)),
                                    prompt=u"Level at {}{} ({}). Name:".format(sign, shown, what), title=__title__)
        if name is None:
            tg.RollBack()
            return
        name = unique_level_name(clean_name(name) or level.Name)

        t = Transaction(doc, "Name level")
        t.Start()
        level.Name = name
        t.Commit()

        vfts = dict((vt.ViewFamily, vt) for vt in FilteredElementCollector(doc).OfClass(ViewFamilyType)
                    if vt.ViewFamily in (ViewFamily.FloorPlan, ViewFamily.StructuralPlan))
        options = []
        if ViewFamily.FloorPlan in vfts:
            options.append("Floor plan")
        if ViewFamily.StructuralPlan in vfts:
            options.append("Structural plan")
        options.append("No plan")
        choice = forms.CommandSwitchWindow.show(options, message=u"Level '{}' created. Create a plan on it?".format(name))
        plan = None
        if choice in ("Floor plan", "Structural plan"):
            family = ViewFamily.FloorPlan if choice == "Floor plan" else ViewFamily.StructuralPlan
            t = Transaction(doc, "Create plan")
            t.Start()
            plan = ViewPlan.Create(doc, vfts[family].Id, level.Id)
            t.Commit()
        tg.Assimilate()
    except Exception as ex:
        if t is not None and t.HasStarted() and not t.HasEnded():
            t.RollBack()
        if tg.HasStarted() and not tg.HasEnded():
            tg.RollBack()
        forms.alert(u"Could not create the level:\n{}".format(ex), title=__title__)
        return

    if plan is not None:
        uidoc.ActiveView = plan


main()
