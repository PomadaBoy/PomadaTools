# -*- coding: utf-8 -*-
__title__ = "Show All Line Styles"
__doc__ = """Makes the Lines category and all line styles visible again in the active view."""

from pyrevit import revit, forms
from Autodesk.Revit.DB import BuiltInCategory, ElementId, Transaction

doc = revit.doc
view = doc.ActiveView
lines_cat = doc.Settings.Categories.get_Item(BuiltInCategory.OST_Lines)

t = Transaction(doc, __title__)
t.Start()
try:
    for cat in [lines_cat] + list(lines_cat.SubCategories):
        if view.CanCategoryBeHidden(cat.Id) and view.GetCategoryHidden(cat.Id):
            view.SetCategoryHidden(cat.Id, False)
    t.Commit()
except Exception as ex:
    t.RollBack()
    msg = "Could not change line style visibility in this view."
    if view.ViewTemplateId != ElementId.InvalidElementId:
        msg += "\nThe view template probably controls Visibility/Graphics."
    forms.alert("{}\n\n{}".format(msg, ex), title=__title__)
