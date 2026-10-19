# -*- coding: utf-8 -*-
"""Shared Generic Model helpers: rename window and checks (used by Rename GM and GM List)."""

import clr
clr.AddReference("PresentationCore")
from System.Windows import Visibility

from pyrevit import forms
from Autodesk.Revit.DB import BuiltInCategory, Element, Family, FilteredElementCollector, Transaction

GM_CATEGORY = int(BuiltInCategory.OST_GenericModel)
FORBIDDEN = u'\\:{}[]|;<>?`~'

RENAME_XAML = """
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
      <Button x:Name="skip_btn" Content="Skip" Width="80" Margin="0,0,8,0" Click="skip_click"/>
      <Button x:Name="done_btn" Content="Done" Width="80" IsCancel="True" Click="done_click"/>
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


def is_generic_model(e):
    return e.Category is not None and id_int(e.Category.Id) == GM_CATEGORY


def bad_chars(name):
    return "".join(sorted(set(c for c in name if c in FORBIDDEN)))


def validate(doc, family, symbol, new_family, new_type):
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


def describe(doc, family, symbol):
    instances = [e for e in FilteredElementCollector(doc).OfCategoryId(family.FamilyCategory.Id)
                 .WhereElementIsNotElementType() if e.GetTypeId() == symbol.Id]
    parts = [u"Category: Generic Models",
             u"{} type(s) in this family".format(family.GetFamilySymbolIds().Count),
             u"{} instance(s) of this type".format(len(instances))]
    if family.IsInPlace:
        parts.append(u"in-place family")
    return u"  ·  ".join(parts)


class RenameWindow(forms.WPFWindow):
    """result: None (Done/Esc), ("skip",) or ("rename", new_family, new_type)."""
    def __init__(self, doc, family, symbol, show_skip=True):
        forms.WPFWindow.__init__(self, RENAME_XAML, literal_string=True)
        self.doc, self.family, self.symbol, self.result = doc, family, symbol, None
        self.info_tb.Text = describe(doc, family, symbol)
        self.family_tb.Text = family.Name
        self.type_tb.Text = ename(symbol)
        self.same_cb.IsChecked = family.Name == ename(symbol)
        self.type_tb.IsEnabled = not self.same_cb.IsChecked
        if not show_skip:
            self.skip_btn.Visibility = Visibility.Collapsed
            self.done_btn.Content = "Cancel"
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
        error = validate(self.doc, self.family, self.symbol, new_family, new_type)
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


def apply_rename(doc, family, symbol, new_family, new_type):
    """Rename in one transaction. Returns [old family, old type, new family, new type] or None if unchanged."""
    old_family, old_type = family.Name, ename(symbol)
    if new_family == old_family and new_type == old_type:
        return None
    t = Transaction(doc, "Rename Generic Model")
    t.Start()
    try:
        if new_family != old_family:
            family.Name = new_family
        if new_type != old_type:
            set_name(symbol, new_type)
        t.Commit()
    except Exception:
        t.RollBack()
        raise
    return [old_family, old_type, new_family, new_type]
