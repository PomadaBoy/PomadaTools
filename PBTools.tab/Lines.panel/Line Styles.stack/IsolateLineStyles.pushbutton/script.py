# -*- coding: utf-8 -*-
__title__ = "Isolate Line Styles"
__doc__ = """Select lines; every line style NOT used by the selection is hidden in the active view
(Visibility/Graphics > Lines subcategories). Use 'Show All Line Styles' to restore."""

from System.Collections.Generic import List
from pyrevit import revit, forms, script
from Autodesk.Revit.DB import BuiltInCategory, CurveElement, ElementId, Transaction
from Autodesk.Revit.UI.Selection import ISelectionFilter, ObjectType
from Autodesk.Revit.Exceptions import OperationCanceledException

doc = revit.doc
uidoc = revit.uidoc
view = doc.ActiveView
LINES_CAT_ID = ElementId(BuiltInCategory.OST_Lines)


def id_int(eid):
    return eid.Value if hasattr(eid, "Value") else eid.IntegerValue


class LineFilter(ISelectionFilter):
    def AllowElement(self, el):
        return isinstance(el, CurveElement) and el.Category is not None \
            and el.Category.Id.Equals(LINES_CAT_ID)

    def AllowReference(self, ref, pt):
        return False


line_filter = LineFilter()
lines = [doc.GetElement(i) for i in uidoc.Selection.GetElementIds()]
lines = [e for e in lines if line_filter.AllowElement(e)]

if not lines:
    try:
        with forms.WarningBar(title="Select lines whose styles stay visible, then click Finish"):
            refs = uidoc.Selection.PickObjects(ObjectType.Element, line_filter, "Select lines, then Finish")
        lines = [doc.GetElement(r) for r in refs]
    except OperationCanceledException:
        script.exit()
if not lines:
    script.exit()

keep = set()
for ln in lines:
    gs = ln.LineStyle
    if gs is not None and gs.GraphicsStyleCategory is not None:
        keep.add(id_int(gs.GraphicsStyleCategory.Id))

lines_cat = doc.Settings.Categories.get_Item(BuiltInCategory.OST_Lines)

t = Transaction(doc, __title__)
t.Start()
try:
    if view.CanCategoryBeHidden(lines_cat.Id):
        view.SetCategoryHidden(lines_cat.Id, False)
    for sub in lines_cat.SubCategories:
        if view.CanCategoryBeHidden(sub.Id):
            view.SetCategoryHidden(sub.Id, id_int(sub.Id) not in keep)
    t.Commit()
except Exception as ex:
    t.RollBack()
    msg = "Could not change line style visibility in this view."
    if view.ViewTemplateId != ElementId.InvalidElementId:
        msg += "\nThe view template probably controls Visibility/Graphics."
    forms.alert("{}\n\n{}".format(msg, ex), title=__title__, exitscript=True)

uidoc.Selection.SetElementIds(List[ElementId]())
