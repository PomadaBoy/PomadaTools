# -*- coding: utf-8 -*-
__title__ = "Update Views"
__doc__ = """Hides all 'Only in View' lines again in every view except their own view.
Run after creating or duplicating views (new views show the lines until this is run)."""

from pyrevit import revit, forms

from Autodesk.Revit.DB import Transaction

from pomadalines import (all_marked_lines, candidate_views, get_mark, new_report, owned_by_others,
                         print_report, restrict_to_view)

doc = revit.doc

marked = all_marked_lines(doc)
if not marked:
    forms.alert("There are no 'Only in View' lines in this model yet.", title=__title__, exitscript=True)

report = new_report()
blocked = owned_by_others(doc, [l.Id for l in marked])
report["skipped_lines"] = len(blocked)
marked = [l for l in marked if l.Id not in blocked]
views = candidate_views(doc)
blocked_views = owned_by_others(doc, [v.Id for v in views])
report["skipped_views"] = [v.Name for v in views if v.Id in blocked_views]
views = [v for v in views if v.Id not in blocked_views]

groups = {}
for l in marked:
    groups.setdefault(get_mark(l), []).append(l)

missing = 0
summary = []
t = Transaction(doc, "Update 'Only in View' lines")
t.Start()
try:
    for uid, lines in groups.items():
        target = doc.GetElement(uid) if uid else None
        if target is None:
            missing += len(lines)
            continue
        restrict_to_view(doc, lines, target, views, report)
        summary.append(u"- **{}**: {} line(s)".format(target.Name, len(lines)))
    t.Commit()
except Exception as ex:
    t.RollBack()
    forms.alert("Update failed:\n{}".format(ex), title=__title__, exitscript=True)

extra = [u"**Lines per view:**"] + sorted(summary)
if missing:
    extra.append(u"**{} line(s) belong to a view that was deleted** - they were left as they are. "
                 u"Use 'Show Everywhere' or 'Only in View' on them.".format(missing))
print_report(__title__, len(marked), report, extra)
