# -*- coding: utf-8 -*-
"""Shared code for 'Only in View' line tools: keep selected model lines visible in one view only.

Lines are hidden element-by-element (Hide in View > Elements) in every other view, so lines that share
a line style with other lines are not affected. The chosen view is stored on each line in extensible
storage, so 'Update Views' can hide the lines again in views created later."""

import clr
clr.AddReference("System")
from System import Guid, String
from System.Collections.Generic import List

from pyrevit import forms, script
from Autodesk.Revit.DB import (BuiltInCategory, CheckoutStatus, CurveElement, ElementId,
                               FilteredElementCollector, ModelCurve, View, ViewType, WorksharingUtils)
from Autodesk.Revit.DB.ExtensibleStorage import AccessLevel, Entity, Schema, SchemaBuilder
from Autodesk.Revit.UI.Selection import ISelectionFilter, ObjectType
from Autodesk.Revit.Exceptions import OperationCanceledException

SCHEMA_GUID = Guid("7d3c5e2a-9b41-4f6e-8a1d-2c6f0b9e4a17")
SCHEMA_NAME = "PomadaOnlyInView"
FIELD = "ViewUniqueId"
LINES_CAT_ID = ElementId(BuiltInCategory.OST_Lines)

# views that can never show model lines (names checked with getattr: not every Revit version has all)
_SKIP_TYPE_NAMES = ("Schedule", "DrawingSheet", "ProjectBrowser", "SystemBrowser", "Internal", "Undefined",
                    "DraftingView", "Legend", "Report", "ColumnSchedule", "PanelSchedule", "CostReport",
                    "LoadsReport", "PresureLossReport")
SKIP_VIEW_TYPES = set(getattr(ViewType, n) for n in _SKIP_TYPE_NAMES if hasattr(ViewType, n))


# ---------------- storage of the chosen view on each line ----------------

def get_schema():
    schema = Schema.Lookup(SCHEMA_GUID)
    if schema is not None:
        return schema
    builder = SchemaBuilder(SCHEMA_GUID)
    builder.SetSchemaName(SCHEMA_NAME)
    builder.SetReadAccessLevel(AccessLevel.Public)
    builder.SetWriteAccessLevel(AccessLevel.Public)
    builder.SetDocumentation("PomadaTools: model line is visible only in the view with this UniqueId.")
    builder.AddSimpleField(FIELD, String)
    return builder.Finish()


def get_mark(elem):
    schema = Schema.Lookup(SCHEMA_GUID)
    if schema is None:
        return None
    ent = elem.GetEntity(schema)
    if not ent.IsValid():
        return None
    return ent.Get[String](FIELD) or None


def set_mark(elem, view):
    schema = get_schema()
    ent = Entity(schema)
    ent.Set[String](FIELD, view.UniqueId)
    elem.SetEntity(ent)


def clear_mark(elem):
    schema = Schema.Lookup(SCHEMA_GUID)
    if schema is not None and elem.GetEntity(schema).IsValid():
        elem.DeleteEntity(schema)


# ---------------- selection ----------------

def is_model_line(e):
    return isinstance(e, ModelCurve) and e.Category is not None and e.Category.Id.Equals(LINES_CAT_ID)


class ModelLineFilter(ISelectionFilter):
    def AllowElement(self, e):
        return is_model_line(e)

    def AllowReference(self, ref, pt):
        return False


def get_selected_lines(doc, uidoc, prompt):
    """Pre-selected model lines, or ask the user to pick some. Returns [] if cancelled."""
    lines = [doc.GetElement(i) for i in uidoc.Selection.GetElementIds()]
    lines = [e for e in lines if is_model_line(e)]
    if lines:
        return lines
    try:
        with forms.WarningBar(title=prompt):
            refs = uidoc.Selection.PickObjects(ObjectType.Element, ModelLineFilter(), prompt)
    except OperationCanceledException:
        return []
    return [doc.GetElement(r) for r in refs]


def all_marked_lines(doc):
    schema = Schema.Lookup(SCHEMA_GUID)
    if schema is None:
        return []
    return [e for e in FilteredElementCollector(doc).OfClass(CurveElement)
            if is_model_line(e) and e.GetEntity(schema).IsValid()]


# ---------------- views and hiding ----------------

def candidate_views(doc):
    return [v for v in FilteredElementCollector(doc).OfClass(View)
            if not v.IsTemplate and v.ViewType not in SKIP_VIEW_TYPES]


def owned_by_others(doc, element_ids):
    """Ids that another user owns in a workshared model (cannot be changed now)."""
    if not doc.IsWorkshared:
        return set()
    return set(i for i in element_ids
               if WorksharingUtils.GetCheckoutStatus(doc, i) == CheckoutStatus.OwnedByOtherUser)


def ids_list(elems):
    return List[ElementId]([e.Id for e in elems])


def restrict_to_view(doc, lines, target, views, report):
    """Unhide lines in target, hide them in every other view. Call inside a transaction."""
    for v in views:
        try:
            if v.Id == target.Id:
                hidden = [l for l in lines if l.IsHidden(v)]
                if hidden:
                    v.UnhideElements(ids_list(hidden))
            else:
                show = [l for l in lines if not l.IsHidden(v) and l.CanBeHidden(v)]
                if show:
                    v.HideElements(ids_list(show))
                    report["views"].add(v.Id)
        except Exception as ex:
            report["failed"].append(u"{} ({})".format(v.Name, str(ex).split("\n")[0]))


def show_everywhere(lines, views, report):
    for v in views:
        try:
            hidden = [l for l in lines if l.IsHidden(v)]
            if hidden:
                v.UnhideElements(ids_list(hidden))
                report["views"].add(v.Id)
        except Exception as ex:
            report["failed"].append(u"{} ({})".format(v.Name, str(ex).split("\n")[0]))


def new_report():
    return {"views": set(), "failed": [], "skipped_lines": 0, "skipped_views": []}


def print_report(title, lines_count, report, extra=None):
    out = script.get_output()
    out.print_md(u"## {}".format(title))
    out.print_md(u"**Lines:** {}  |  **Views changed:** {}".format(lines_count, len(report["views"])))
    if extra:
        for line in extra:
            out.print_md(line)
    if report["skipped_lines"]:
        out.print_md(u"**Skipped {} line(s)** owned by another user - ask them to relinquish, "
                     u"then run again.".format(report["skipped_lines"]))
    if report["skipped_views"]:
        out.print_md(u"**Skipped views owned by another user:** " + u", ".join(report["skipped_views"]))
    if report["failed"]:
        out.print_md(u"**Could not change:** " + u", ".join(report["failed"]))
