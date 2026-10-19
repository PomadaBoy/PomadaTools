# -*- coding: utf-8 -*-
__title__ = "Rename\nGM"
__doc__ = """Click a Generic Model, rename its family and type in a small window.
Keeps asking for the next one until you press Esc or Done. Works in Revit 2023 and 2025."""

from pyrevit import revit, forms, script
from Autodesk.Revit.DB import FamilyInstance
from Autodesk.Revit.UI.Selection import ISelectionFilter, ObjectType
from Autodesk.Revit.Exceptions import OperationCanceledException

from pomadagm import RenameWindow, apply_rename, is_generic_model

doc = revit.doc
uidoc = revit.uidoc
output = script.get_output()


class GenericModelFilter(ISelectionFilter):
    def AllowElement(self, e):
        return is_generic_model(e)

    def AllowReference(self, ref, pt):
        return False


def main():
    renamed = []
    while True:
        try:
            ref = uidoc.Selection.PickObject(ObjectType.Element, GenericModelFilter(),
                                             "Click a Generic Model to rename (Esc to finish)")
        except OperationCanceledException:
            break
        elem = doc.GetElement(ref)
        if not isinstance(elem, FamilyInstance):
            forms.alert("This Generic Model is not a family (for example a DirectShape), "
                        "so it has no family name to rename.")
            continue
        symbol = elem.Symbol
        family = symbol.Family

        win = RenameWindow(doc, family, symbol)
        win.ShowDialog()
        if win.result is None:
            break
        if win.result[0] == "skip":
            continue
        try:
            row = apply_rename(doc, family, symbol, win.result[1], win.result[2])
            if row:
                renamed.append(row)
        except Exception as ex:
            forms.alert(u"Rename failed:\n{}".format(ex))

    if renamed:
        output.print_md("## Renamed Generic Models")
        output.print_table(renamed, columns=["Old family", "Old type", "New family", "New type"])


main()
