# -*- coding: utf-8 -*-
__title__ = "Show Everywhere"
__doc__ = """Undo 'Only in View': unhides the selected model lines in all views and forgets their view.
With nothing selected you can choose all 'Only in View' lines in the model."""

from pyrevit import revit, forms

from Autodesk.Revit.DB import Transaction

from pomadalines import (all_marked_lines, candidate_views, clear_mark, get_selected_lines, is_model_line,
                         new_report, owned_by_others, print_report, show_everywhere)

doc = revit.doc
uidoc = revit.uidoc

preselected = [doc.GetElement(i) for i in uidoc.Selection.GetElementIds()]
if any(is_model_line(e) for e in preselected):
    lines = get_selected_lines(doc, uidoc, "")
else:
    choice = forms.CommandSwitchWindow.show(["Pick lines", "All 'Only in View' lines in the model"],
                                            message="Which lines should be visible everywhere again?")
    if choice is None:
        forms.alert("Cancelled.", title=__title__, exitscript=True)
    if choice == "Pick lines":
        lines = get_selected_lines(doc, uidoc, "Select the lines to show in all views, then Finish")
    else:
        lines = all_marked_lines(doc)
if not lines:
    forms.alert("No lines to change.", title=__title__, exitscript=True)

report = new_report()
blocked = owned_by_others(doc, [l.Id for l in lines])
report["skipped_lines"] = len(blocked)
lines = [l for l in lines if l.Id not in blocked]
views = candidate_views(doc)
blocked_views = owned_by_others(doc, [v.Id for v in views])
report["skipped_views"] = [v.Name for v in views if v.Id in blocked_views]
views = [v for v in views if v.Id not in blocked_views]

t = Transaction(doc, "Show lines in all views")
t.Start()
try:
    show_everywhere(lines, views, report)
    for l in lines:
        clear_mark(l)
    t.Commit()
except Exception as ex:
    t.RollBack()
    forms.alert("Could not show the lines:\n{}".format(ex), title=__title__, exitscript=True)

if report["failed"] or report["skipped_lines"] or report["skipped_views"]:
    print_report(__title__, len(lines), report)
else:
    forms.alert("{} line(s) are visible in all views again ({} view(s) changed).".format(
        len(lines), len(report["views"])), title=__title__)
