# -*- coding: utf-8 -*-
__title__ = "QAQC Section"
__doc__ = """Click faces to create QAQC sections looking straight at each face (Esc to finish).
First run in a project sets up: QAQC view parameter, QAQC plan on the 0.00 level,
and filters so QAQC sections show only in the QAQC plan and other sections are hidden there."""

import os
import re
import tempfile

import clr
clr.AddReference("System")
from System import Guid
from System.Collections.Generic import List

from pyrevit import revit, forms, script
from Autodesk.Revit.DB import (BoundingBoxXYZ, BuiltInCategory, BuiltInParameter, ElementId,
                               ElementParameterFilter, Face, FamilyInstance, FilteredElementCollector,
                               Instance, Level, ParameterElement, ParameterFilterElement,
                               ParameterFilterRuleFactory, PlanViewPlane, SharedParameterElement,
                               Transaction, Transform, View, ViewFamily, ViewFamilyType, ViewPlan,
                               ViewSection, ViewType, XYZ)
from Autodesk.Revit.UI.Selection import ObjectType
from Autodesk.Revit.Exceptions import OperationCanceledException

doc = revit.doc
uidoc = revit.uidoc
app = doc.Application
output = script.get_output()

PARAM_NAME = "QAQC"
PARAM_GUID = Guid("5f1c2a7e-3b9d-4e61-9a2f-7c4b8d0e1a35")
QAQC_VALUE = "QAQC"
PLAN_NAME = "QAQC"
FILTER_HIDE_QAQC = "QAQC - hide QAQC sections"
FILTER_HIDE_OTHER = "QAQC - hide other sections"
BROWSER_PARAMS = ("5d Projektbrowserstruktur Stufe 1",
                  "5d Projektbrowserstruktur Stufe 2",
                  "5d Projektbrowserstruktur Stufe 3")
BROWSER_FOLDER = "00 QAQC"

M = 1.0 / 0.3048
FRONT, BACK, MARGIN = 0.2 * M, 0.3 * M, 0.5 * M
VIEW_RANGE_MARGIN = 20.0 * M
SECTION_SCALE = 50
HIDE_COARSER_THAN = 5000

PLAN_TYPES = (ViewType.FloorPlan, ViewType.EngineeringPlan, ViewType.CeilingPlan, ViewType.AreaPlan)
SECTION_TYPES = (ViewType.Section, ViewType.Elevation, ViewType.Detail)
FILTERS_PARAM_ID = ElementId(BuiltInParameter.VIS_GRAPHICS_FILTERS)


def id_int(eid):
    return eid.Value if hasattr(eid, "Value") else eid.IntegerValue


# ---------------- setup (runs only what is missing) ----------------

def find_qaqc_param_id():
    sp = SharedParameterElement.Lookup(doc, PARAM_GUID)
    if sp is not None:
        return sp.Id
    for pe in FilteredElementCollector(doc).OfClass(ParameterElement):
        if pe.Name == PARAM_NAME:
            return pe.Id
    return None


def create_qaqc_param():
    from Autodesk.Revit.DB import ExternalDefinitionCreationOptions
    original = app.SharedParametersFilename
    tmp = os.path.join(tempfile.gettempdir(), "pbtools_qaqc_sharedparams.txt")
    open(tmp, "w").close()
    try:
        app.SharedParametersFilename = tmp
        group = app.OpenSharedParameterFile().Groups.Create("PBTools")
        try:
            from Autodesk.Revit.DB import SpecTypeId
            opts = ExternalDefinitionCreationOptions(PARAM_NAME, SpecTypeId.String.Text)
        except ImportError:
            from Autodesk.Revit.DB import ParameterType
            opts = ExternalDefinitionCreationOptions(PARAM_NAME, ParameterType.Text)
        opts.GUID = PARAM_GUID
        opts.Description = "QAQC marker for views created by PBTools QAQC Section"
        definition = group.Definitions.Create(opts)

        cats = app.Create.NewCategorySet()
        cats.Insert(doc.Settings.Categories.get_Item(BuiltInCategory.OST_Views))
        binding = app.Create.NewInstanceBinding(cats)
        try:
            from Autodesk.Revit.DB import GroupTypeId
            doc.ParameterBindings.Insert(definition, binding, GroupTypeId.IdentityData)
        except ImportError:
            from Autodesk.Revit.DB import BuiltInParameterGroup
            doc.ParameterBindings.Insert(definition, binding, BuiltInParameterGroup.PG_IDENTITY_DATA)
    finally:
        try:
            app.SharedParametersFilename = original or ""
        except Exception:
            pass
        try:
            os.remove(tmp)
        except Exception:
            pass
    doc.Regenerate()
    return find_qaqc_param_id()


def make_rule(pid, equals):
    factory = ParameterFilterRuleFactory.CreateEqualsRule if equals else ParameterFilterRuleFactory.CreateNotEqualsRule
    try:
        return factory(pid, QAQC_VALUE)
    except Exception:
        return factory(pid, QAQC_VALUE, True)


def get_or_create_filter(name, pid, equals):
    for f in FilteredElementCollector(doc).OfClass(ParameterFilterElement):
        if f.Name == name:
            return f, False
    cats = List[ElementId]()
    cats.Add(ElementId(BuiltInCategory.OST_Sections))
    return ParameterFilterElement.Create(doc, name, cats, ElementParameterFilter(make_rule(pid, equals))), True


def zero_level():
    levels = list(FilteredElementCollector(doc).OfClass(Level))
    for attr in ("ProjectElevation", "Elevation"):
        for lvl in levels:
            if abs(getattr(lvl, attr)) < 1e-4:
                return lvl, levels
    lvl = forms.SelectFromList.show(sorted(levels, key=lambda l: l.Elevation), name_attr="Name",
                                    title="No level at 0.00 - choose level for QAQC plan", multiselect=False)
    if not lvl:
        script.exit()
    return lvl, levels


def find_plan():
    for v in FilteredElementCollector(doc).OfClass(ViewPlan):
        if not v.IsTemplate and v.Name == PLAN_NAME:
            return v
    return None


def create_plan():
    lvl, levels = zero_level()
    vfts = [t for t in FilteredElementCollector(doc).OfClass(ViewFamilyType)
            if t.ViewFamily in (ViewFamily.StructuralPlan, ViewFamily.FloorPlan)]
    vfts.sort(key=lambda t: 0 if t.ViewFamily == ViewFamily.StructuralPlan else 1)
    plan = ViewPlan.Create(doc, vfts[0].Id, lvl.Id)
    plan.ViewTemplateId = ElementId.InvalidElementId
    plan.Name = PLAN_NAME
    plan.Scale = 500

    top = max(l.Elevation for l in levels) - lvl.Elevation + VIEW_RANGE_MARGIN
    bottom = min(l.Elevation for l in levels) - lvl.Elevation - VIEW_RANGE_MARGIN
    vr = plan.GetViewRange()
    vr.SetOffset(PlanViewPlane.TopClipPlane, top)
    vr.SetOffset(PlanViewPlane.CutPlane, top)
    vr.SetOffset(PlanViewPlane.BottomClipPlane, bottom)
    vr.SetOffset(PlanViewPlane.ViewDepthPlane, bottom)
    plan.SetViewRange(vr)

    tag_view(plan, "Plan", "QAQC plan")
    return plan


def tag_view(view, stufe2, stufe3):
    p = view.get_Parameter(PARAM_GUID) or view.LookupParameter(PARAM_NAME)
    if p is None:
        raise Exception("View has no '{}' parameter.".format(PARAM_NAME))
    p.Set(QAQC_VALUE)
    for pname, val in zip(BROWSER_PARAMS, (BROWSER_FOLDER, stufe2, stufe3)):
        bp = view.LookupParameter(pname)
        if bp is not None and not bp.IsReadOnly:
            bp.Set(val)


def has_filter(view, fid):
    return any(f.Equals(fid) for f in view.GetFilters())


def hide_with_filter(view, fid):
    if has_filter(view, fid):
        return False
    view.AddFilter(fid)
    view.SetFilterVisibility(fid, False)
    return True


def filter_target(view):
    tid = view.ViewTemplateId
    if tid != ElementId.InvalidElementId:
        tpl = doc.GetElement(tid)
        if not any(i.Equals(FILTERS_PARAM_ID) for i in tpl.GetNonControlledTemplateParameterIds()):
            return tpl
    return view


def sync_view_filters(plan, f_hide_qaqc, f_hide_other):
    changed = hide_with_filter(plan, f_hide_other.Id)
    if has_filter(plan, f_hide_qaqc.Id):
        plan.RemoveFilter(f_hide_qaqc.Id)
        changed = True

    targets = {}
    for v in FilteredElementCollector(doc).OfClass(View):
        if v.ViewType not in PLAN_TYPES + SECTION_TYPES or v.Id.Equals(plan.Id):
            continue
        if v.IsTemplate:
            targets[id_int(v.Id)] = v
        elif v.AreGraphicsOverridesAllowed():
            t = filter_target(v)
            targets[id_int(t.Id)] = t
    for t in targets.values():
        try:
            changed = hide_with_filter(t, f_hide_qaqc.Id) or changed
        except Exception:
            pass
    return changed


def setup():
    t = Transaction(doc, "QAQC setup")
    t.Start()
    changed = False
    pid = find_qaqc_param_id()
    if pid is None:
        pid = create_qaqc_param()
        changed = True
    f_hide_qaqc, c1 = get_or_create_filter(FILTER_HIDE_QAQC, pid, True)
    f_hide_other, c2 = get_or_create_filter(FILTER_HIDE_OTHER, pid, False)
    plan = find_plan()
    if plan is None:
        plan = create_plan()
        changed = True
    changed = sync_view_filters(plan, f_hide_qaqc, f_hide_other) or c1 or c2 or changed
    if changed:
        t.Commit()
    else:
        t.RollBack()


# ---------------- section from face ----------------

def face_frame(elem, ref):
    face = elem.GetGeometryObjectFromReference(ref)
    if not isinstance(face, Face):
        return None
    gpt = ref.GlobalPoint
    candidates = [Transform.Identity]
    if isinstance(elem, Instance):
        candidates.append(elem.GetTotalTransform())
    best = None
    for tf in candidates:
        res = face.Project(tf.Inverse.OfPoint(gpt))
        if res is not None and (best is None or res.Distance < best[0]):
            best = (res.Distance, tf, res.UVPoint)
    if best is None:
        return None
    _, tf, uv = best
    normal = tf.OfVector(face.ComputeNormal(uv)).Normalize()
    points = [tf.OfPoint(p) for loop in face.EdgeLoops for edge in loop for p in edge.Tessellate()]
    return gpt, normal, points


def up_vector(n):
    for v in (XYZ.BasisZ, XYZ.BasisY, XYZ.BasisX):
        up = v.Subtract(n.Multiply(v.DotProduct(n)))
        if up.GetLength() > 1e-3:
            return up.Normalize()


def element_label(elem):
    if isinstance(elem, FamilyInstance):
        name = elem.Symbol.FamilyName
    else:
        name = getattr(elem, "Name", None) or (elem.Category.Name if elem.Category else "Element")
    return re.sub(r'[\\:{}\[\]|;<>?`~]', "_", name).strip() or "Element"


def unique_name(label, existing):
    n = 1
    while True:
        name = u"QAQC_{}_{:03d}".format(label, n)
        if name not in existing:
            existing.add(name)
            return name
        n += 1


def set_hide_scale(view):
    for bip in ("SECTION_COARSER_SCALE_PULLDOWN_METRIC", "SECTION_COARSER_SCALE_PULLDOWN_IMPERIAL"):
        p = view.get_Parameter(getattr(BuiltInParameter, bip))
        if p is not None and not p.IsReadOnly:
            try:
                p.Set(HIDE_COARSER_THAN)
                return
            except Exception:
                pass


def create_section(elem, ref, section_type_id, existing_names):
    frame = face_frame(elem, ref)
    if frame is None:
        raise Exception("Pick a face, not an edge.")
    origin, n, points = frame
    up = up_vector(n)
    look = n.Negate()                # box +Z points into the face; Revit looks along it
    right = up.CrossProduct(look)

    tf = Transform.Identity
    tf.Origin = origin
    tf.BasisX = right
    tf.BasisY = up
    tf.BasisZ = look
    inv = tf.Inverse
    local = [inv.OfPoint(p) for p in points] or [XYZ.Zero]

    box = BoundingBoxXYZ()
    box.Transform = tf
    box.Min = XYZ(min(p.X for p in local) - MARGIN, min(p.Y for p in local) - MARGIN,
                  min(p.Z for p in local) - FRONT)
    box.Max = XYZ(max(p.X for p in local) + MARGIN, max(p.Y for p in local) + MARGIN,
                  max(p.Z for p in local) + BACK)

    sec = ViewSection.CreateSection(doc, section_type_id, box)
    sec.ViewTemplateId = ElementId.InvalidElementId
    label = element_label(elem)
    sec.Name = unique_name(label, existing_names)
    sec.Scale = SECTION_SCALE
    sec.CropBoxActive = True
    set_hide_scale(sec)
    tag_view(sec, "Sections", label)
    return sec


# ---------------- main ----------------

setup()

section_type = next((t for t in FilteredElementCollector(doc).OfClass(ViewFamilyType)
                     if t.ViewFamily == ViewFamily.Section), None)
if section_type is None:
    forms.alert("No section type in this project.", title=__title__, exitscript=True)

existing_names = set(v.Name for v in FilteredElementCollector(doc).OfClass(View))
created = []

with forms.WarningBar(title="Click faces to create QAQC sections - Esc to finish"):
    while True:
        try:
            ref = uidoc.Selection.PickObject(ObjectType.PointOnElement, "Click a face (Esc to finish)")
        except OperationCanceledException:
            break
        elem = doc.GetElement(ref)
        t = Transaction(doc, "QAQC section")
        t.Start()
        try:
            sec = create_section(elem, ref, section_type.Id, existing_names)
            t.Commit()
            created.append(sec)
        except Exception as ex:
            t.RollBack()
            forms.alert("Could not create section:\n{}".format(ex), title=__title__)

if created:
    output.print_md("### Created {} QAQC section(s)".format(len(created)))
    for sec in created:
        print(output.linkify(sec.Id, sec.Name))
