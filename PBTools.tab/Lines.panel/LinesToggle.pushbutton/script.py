# -*- coding: utf-8 -*-
__title__ = "Toggle Lines"
__doc__ = """Toggles visibility of the Lines category (model and detail lines) in the active view.
Shortcut: LL"""

from pyrevit import revit, forms, script
from Autodesk.Revit.DB import BuiltInCategory, Category, Transaction

doc = revit.doc
view = doc.ActiveView

cat = Category.GetCategory(doc, BuiltInCategory.OST_Lines)

if cat is None or not view.CanCategoryBeHidden(cat.Id):
    forms.alert("Lines category cannot be hidden in this view.", title=__title__, exitscript=True)

hide = not view.GetCategoryHidden(cat.Id)

t = Transaction(doc, __title__)
t.Start()
try:
    view.SetCategoryHidden(cat.Id, hide)
    t.Commit()
except Exception as ex:
    t.RollBack()
    forms.alert("Could not change Lines visibility.\n\n{}".format(ex), title=__title__, exitscript=True)

script.toggle_icon(not hide)
