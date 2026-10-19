# -*- coding: utf-8 -*-
__title__ = "Only in View"
__doc__ = """Select model lines: they stay visible in the active view and are hidden (element by element)
in every other view. Other lines with the same line style are not affected.
Use 'Update Views' after creating new views, 'Show Everywhere' to undo."""

from System.Collections.Generic import List

from pyrevit import revit, forms
from Autodesk.Revit.DB import ElementId, Transaction, View3D

from pomadalines import (SKIP_VIEW_TYPES, candidate_views, get_schema, get_selected_lines, new_report,
                         owned_by_others, print_report, restrict_to_view, set_mark)

doc = revit.doc
uidoc = revit.uidoc
view = doc.ActiveView

if view.IsTemplate or view.ViewType in SKIP_VIEW_TYPES:
    forms.alert("Run this in the view where the lines should stay visible (usually a 3D view).",
                title=__title__, exitscript=True)
if not isinstance(view, View3D):
    if not forms.alert("The active view '{}' is not a 3D view. Keep the lines only in this view anyway?".format(
            view.Name), title=__title__, yes=True, no=True):
        forms.alert("Cancelled.", title=__title__, exitscript=True)

lines = get_selected_lines(doc, uidoc, "Select the model lines to keep only in this view, then Finish")
if not lines:
    forms.alert("No model lines selected.", title=__title__, exitscript=True)

report = new_report()
blocked = owned_by_others(doc, [l.Id for l in lines])
report["skipped_lines"] = len(blocked)
lines = [l for l in lines if l.Id not in blocked]
views = candidate_views(doc)
blocked_views = owned_by_others(doc, [v.Id for v in views])
report["skipped_views"] = [v.Name for v in views if v.Id in blocked_views]
views = [v for v in views if v.Id not in blocked_views]
if not lines:
    print_report(__title__, 0, report)
    forms.alert("All selected lines are owned by another user.", title=__title__, exitscript=True)

get_schema()
t = Transaction(doc, "Lines only in view")
t.Start()
try:
    restrict_to_view(doc, lines, view, views, report)
    for l in lines:
        set_mark(l, view)
    t.Commit()
except Exception as ex:
    t.RollBack()
    forms.alert("Could not hide the lines:\n{}".format(ex), title=__title__, exitscript=True)

uidoc.Selection.SetElementIds(List[ElementId]())
if report["failed"] or report["skipped_lines"] or report["skipped_views"]:
    print_report(__title__, len(lines), report)
else:
    forms.alert("{} line(s) now visible only in '{}' (hidden in {} other view(s)).".format(
        len(lines), view.Name, len(report["views"])), title=__title__)
