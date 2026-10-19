# -*- coding: utf-8 -*-
__title__ = "Rename\nGM"
__doc__ = """Click a Generic Model, rename its family and type in a small window.
Keeps asking for the next one until you press Esc or Done. Works in Revit 2023 and 2025."""

from pyrevit import revit, forms, script
from Autodesk.Revit.DB import (BuiltInCategory, Element, Family, FamilyInstance, FilteredElementCollector,
                               Transaction)
from Autodesk.Revit.UI.Selection import ISelectionFilter, ObjectType
from Autodesk.Revit.Exceptions import OperationCanceledException

doc = revit.doc
uidoc = revit.uidoc
output = script.get_output()

GM_CATEGORY = int(BuiltInCategory.OST_GenericModel)
FORBIDDEN = u'\\:{}[]|;<>?`~'

XAML = """
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Rename Generic Model" Width="460" SizeToContent="Height"
        WindowStartupLocation="CenterScreen" ResizeMode="NoResize" ShowInTaskbar="False">
  <StackPanel Margin="14">
    <TextBlock x:Name="info_tb" TextWrapping="Wrap" Margin="0,0,0,12" Foreground="#555555"/>
    <TextBlock Text="Family name" FontWeight="SemiBold"/>
    <TextBox x:Name="family_tb" Margin="0,3,0,10" Padding="3" TextChanged="family_changed"/>
    <TextBlock Text="Type name" FontWeight="SemiBold"/>
    <TextBox x:Name="type_tb" Margin="0,3,0,6" Padding="3"/>
    <CheckBox x:Name="same_cb" Content="Type name = family name" Margin="0,2,0,10" Click="same_click"/>
    <TextBlock x:Name="error_tb" Foreground="#C0392B" TextWrapping="Wrap" Margin="0,0,0,8"/>
    <StackPanel Orientation="Horizontal" HorizontalAlignment="Right">
      <Button Content="Rename" Width="90" Margin="0,0,8,0" IsDefault="True" Click="rename_click"/>
      <Button Content="Skip" Width="80" Margin="0,0,8,0" Click="skip_click"/>
      <Button Content="Done" Width="80" IsCancel="True" Click="done_click"/>
    </StackPanel>
  </StackPanel>
</Window>
"""


def id_int(eid):
    return eid.Value if hasattr(eid, "Value") else eid.IntegerValue


def ename(e):
    try:
        return e.Name
    except Exception:
        return Element.Name.__get__(e)


def set_name(e, name):
    try:
        e.Name = name
    except Exception:
        Element.Name.SetValue(e, name)


class GenericModelFilter(ISelectionFilter):
    def AllowElement(self, e):
        return e.Category is not None and id_int(e.Category.Id) == GM_CATEGORY

    def AllowReference(self, ref, pt):
        return False


def bad_chars(name):
    return "".join(sorted(set(c for c in name if c in FORBIDDEN)))


def validate(family, symbol, new_family, new_type):
    if not new_family or not new_type:
        return "Names cannot be empty."
    for label, name in (("Family", new_family), ("Type", new_type)):
        chars = bad_chars(name)
        if chars:
            return u"{} name contains characters Revit does not allow: {}".format(label, chars)
    if new_family.lower() != family.Name.lower():
        for f in FilteredElementCollector(doc).OfClass(Family):
            if f.Id != family.Id and f.Name.lower() == new_family.lower():
                return u"A family called '{}' already exists.".format(f.Name)
    if new_type.lower() != ename(symbol).lower():
        for sid in family.GetFamilySymbolIds():
            other = doc.GetElement(sid)
            if sid != symbol.Id and ename(other).lower() == new_type.lower():
                return u"Family already has a type called '{}'.".format(ename(other))
    return ""


class RenameWindow(forms.WPFWindow):
    def __init__(self, family, symbol, info):
        forms.WPFWindow.__init__(self, XAML, literal_string=True)
        self.family, self.symbol, self.result = family, symbol, None
        self.info_tb.Text = info
        self.family_tb.Text = family.Name
        self.type_tb.Text = ename(symbol)
        self.same_cb.IsChecked = family.Name == ename(symbol)
        self.type_tb.IsEnabled = not self.same_cb.IsChecked
        self.family_tb.Focus()
        self.family_tb.SelectAll()

    def family_changed(self, sender, args):
        if self.same_cb.IsChecked:
            self.type_tb.Text = self.family_tb.Text

    def same_click(self, sender, args):
        self.type_tb.IsEnabled = not self.same_cb.IsChecked
        if self.same_cb.IsChecked:
            self.type_tb.Text = self.family_tb.Text

    def rename_click(self, sender, args):
        new_family = self.family_tb.Text.strip()
        new_type = self.type_tb.Text.strip()
        error = validate(self.family, self.symbol, new_family, new_type)
        if error:
            self.error_tb.Text = error
            return
        self.result = ("rename", new_family, new_type)
        self.Close()

    def skip_click(self, sender, args):
        self.result = ("skip",)
        self.Close()

    def done_click(self, sender, args):
        self.result = None
        self.Close()


def describe(family, symbol):
    instances = [e for e in FilteredElementCollector(doc).OfCategoryId(family.FamilyCategory.Id)
                 .WhereElementIsNotElementType() if e.GetTypeId() == symbol.Id]
    parts = [u"Category: Generic Models",
             u"{} type(s) in this family".format(family.GetFamilySymbolIds().Count),
             u"{} instance(s) of this type".format(len(instances))]
    if family.IsInPlace:
        parts.append(u"in-place family")
    return u"  ·  ".join(parts)


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

        win = RenameWindow(family, symbol, describe(family, symbol))
        win.ShowDialog()
        if win.result is None:
            break
        if win.result[0] == "skip":
            continue
        _, new_family, new_type = win.result
        old_family, old_type = family.Name, ename(symbol)
        if new_family == old_family and new_type == old_type:
            continue

        t = Transaction(doc, "Rename Generic Model")
        t.Start()
        try:
            if new_family != old_family:
                family.Name = new_family
            if new_type != old_type:
                set_name(symbol, new_type)
            t.Commit()
            renamed.append([old_family, old_type, new_family, new_type])
        except Exception as ex:
            t.RollBack()
            forms.alert(u"Rename failed:\n{}".format(ex))

    if renamed:
        output.print_md("## Renamed Generic Models")
        output.print_table(renamed, columns=["Old family", "Old type", "New family", "New type"])


main()
