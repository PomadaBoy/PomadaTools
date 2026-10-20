# -*- coding: utf-8 -*-
__title__ = "Levels\nfrom DWG"
__doc__ = """In a section / elevation with an imported DWG section: click the level lines, then Finish.
A window previews the levels '<prefix> <elevation>' (e.g. 'OK Fundament +3.250'), lets you pick the prefix
(or reuse one from existing levels), correct the heights if the DWG is not placed at the right height,
choose the level type and create floor or structural plans. One Undo step. Works in Revit 2023 and 2025."""

import re

from pyrevit import revit, forms, script
from Autodesk.Revit.DB import (BuiltInParameter, Curve, Edge, Element, ElementId, ElementTypeGroup,
                               FilteredElementCollector,
                               ImportInstance, Level, LevelType, SpecTypeId, Transaction, Transform,
                               UnitFormatUtils, UnitTypeId, UnitUtils, ViewFamily, ViewFamilyType, ViewPlan,
                               ViewSection, View3D)
from Autodesk.Revit.UI.Selection import ISelectionFilter, ObjectType
from Autodesk.Revit.Exceptions import OperationCanceledException

doc = revit.doc
uidoc = revit.uidoc
config = script.get_config()

SAME_HEIGHT_MM = 1.0          # picks / existing levels closer than this are the same height
FORBIDDEN = u'\\:{}[]|;<>?`~'
PLAN_CHOICES = ("No plans", "Floor plans", "Structural plans")


def mm(v):
    return UnitUtils.ConvertToInternalUnits(v, UnitTypeId.Millimeters)


def ename(e):
    try:
        return e.Name
    except Exception:
        return Element.Name.__get__(e)


def clean_name(name):
    return "".join("_" if c in FORBIDDEN else c for c in name).strip()


class DwgFilter(ISelectionFilter):
    def AllowElement(self, e):
        return isinstance(e, ImportInstance)

    def AllowReference(self, ref, pt):
        return True


# ---------------- picking ----------------

def line_is_horizontal(dwg, ref):
    """True / False for a picked DWG line, None if unknown."""
    try:
        geo = dwg.GetGeometryObjectFromReference(ref)
        crv = geo.AsCurve() if isinstance(geo, Edge) else geo
        if not isinstance(crv, Curve):
            return None
        best = None
        for tf in (Transform.Identity, dwg.GetTotalTransform()):
            res = crv.Project(tf.Inverse.OfPoint(ref.GlobalPoint))
            if res is not None and (best is None or res.Distance < best[0]):
                best = (res.Distance, tf)
        tf = best[1] if best else Transform.Identity
        return abs(tf.OfPoint(crv.GetEndPoint(0)).Z - tf.OfPoint(crv.GetEndPoint(1)).Z) < mm(1)
    except Exception:
        return None


def pick_heights():
    """[(z, horizontal?)] in pick order, same heights merged."""
    try:
        with forms.WarningBar(title="Click the level lines in the DWG, then click Finish"):
            refs = uidoc.Selection.PickObjects(ObjectType.PointOnElement, DwgFilter(),
                                               "Click the level lines in the DWG, then Finish")
    except OperationCanceledException:
        return []
    picks = []
    for ref in refs:
        z = ref.GlobalPoint.Z
        if any(abs(z - p[0]) < mm(SAME_HEIGHT_MM) for p in picks):
            continue
        picks.append((z, line_is_horizontal(doc.GetElement(ref), ref)))
    return picks


# ---------------- elevations as Revit shows them ----------------

def elevation_base(level_type_id):
    """Internal Z of the elevation base (project base point / survey point) used by this level type."""
    levels = list(FilteredElementCollector(doc).OfClass(Level))
    same = [l for l in levels if l.GetTypeId() == level_type_id] or levels
    if not same:
        return 0.0
    l = same[0]
    return l.ProjectElevation - l.get_Parameter(BuiltInParameter.LEVEL_ELEV).AsDouble()


def format_elevation(value):
    """'+3.250', '-1.200', '±0.000' in project length units (no unit symbol)."""
    text = UnitFormatUtils.Format(doc.GetUnits(), SpecTypeId.Length, abs(value), False)
    m = re.search(r"\d[\d.,' ]*\d|\d", text)
    num = m.group(0).strip() if m else text
    if not re.search(r"[1-9]", num):
        return u"±" + num
    return ("-" if value < 0 else "+") + num


def parse_number(text):
    text = (text or "").strip().replace(",", ".")
    if not text:
        return None
    return float(text)


def existing_prefixes():
    out = set()
    for l in FilteredElementCollector(doc).OfClass(Level):
        m = re.match(u"^(.*?)\\s*[+\\-±]?\\d[\\d.,]*$", l.Name)
        if m and m.group(1).strip():
            out.add(m.group(1).strip())
    return sorted(out, key=lambda s: s.lower())


# ---------------- window ----------------

XAML = """
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Levels from DWG" Width="560" SizeToContent="Height" ResizeMode="NoResize"
        WindowStartupLocation="CenterScreen" ShowInTaskbar="False">
  <StackPanel Margin="14">
    <TextBlock x:Name="picked_tb" Margin="0,0,0,10" TextWrapping="Wrap"/>

    <TextBlock Text="Prefix" FontWeight="SemiBold"/>
    <DockPanel Margin="0,4,0,0">
      <ComboBox x:Name="prefixes_cb" Width="190" DockPanel.Dock="Right" Margin="8,0,0,0"
                SelectionChanged="prefix_picked" ToolTip="Reuse the prefix of existing levels"/>
      <TextBox x:Name="prefix_tb" Padding="3" TextChanged="changed"/>
    </DockPanel>

    <TextBlock Text="Correct heights (optional)" FontWeight="SemiBold" Margin="0,12,0,0"/>
    <StackPanel Orientation="Horizontal" Margin="0,4,0,0">
      <TextBlock Text="The first line I clicked is at elevation " VerticalAlignment="Center"/>
      <TextBox x:Name="ref_tb" Width="80" Padding="3" TextChanged="changed"/>
      <TextBlock x:Name="ref_unit_tb" VerticalAlignment="Center" Margin="4,0,0,0"/>
    </StackPanel>
    <TextBlock Text="Leave empty if the DWG is placed at the right height." Foreground="#777777" Margin="0,2,0,0"/>

    <StackPanel Orientation="Horizontal" Margin="0,12,0,0">
      <TextBlock Text="Level type" FontWeight="SemiBold" Width="90" VerticalAlignment="Center"/>
      <ComboBox x:Name="type_cb" Width="250" SelectionChanged="changed"/>
    </StackPanel>
    <StackPanel Orientation="Horizontal" Margin="0,8,0,0">
      <TextBlock Text="Plans" FontWeight="SemiBold" Width="90" VerticalAlignment="Center"/>
      <ComboBox x:Name="plans_cb" Width="250"/>
    </StackPanel>
    <CheckBox x:Name="skip_cb" Content="Skip heights where a level already exists" Margin="0,10,0,0"
              Click="changed"/>

    <TextBlock Text="Preview" FontWeight="SemiBold" Margin="0,12,0,0"/>
    <TextBox x:Name="preview_tb" IsReadOnly="True" FontFamily="Consolas" Height="190" Margin="0,4,0,0"
             VerticalScrollBarVisibility="Auto" HorizontalScrollBarVisibility="Auto"/>

    <TextBlock x:Name="error_tb" Foreground="#C0392B" TextWrapping="Wrap" Margin="0,8,0,0"/>
    <StackPanel Orientation="Horizontal" HorizontalAlignment="Right" Margin="0,8,0,0">
      <Button x:Name="create_btn" Content="Create" Width="90" Margin="0,0,8,0" IsDefault="True" Click="create_click"/>
      <Button Content="Cancel" Width="80" IsCancel="True"/>
    </StackPanel>
  </StackPanel>
</Window>
"""


class LevelsWindow(forms.WPFWindow):
    def __init__(self, picks):
        forms.WPFWindow.__init__(self, XAML, literal_string=True)
        self.picks, self.result, self.plan_rows = picks, None, []
        self.ready = False
        n_sloped = sum(1 for _, h in picks if h is False)
        self.picked_tb.Text = u"{} different height(s) picked.{}".format(
            len(picks), u"  {} line(s) are not horizontal - the clicked point was used.".format(n_sloped)
            if n_sloped else "")
        self.prefixes = existing_prefixes()
        self.prefixes_cb.Items.Add(u"(existing prefixes)")
        for p in self.prefixes:
            self.prefixes_cb.Items.Add(p)
        self.prefixes_cb.SelectedIndex = 0
        self.prefix_tb.Text = str(self.cfg("prefix", ""))
        self.ref_unit_tb.Text = self.unit_label()
        self.level_types = sorted(FilteredElementCollector(doc).OfClass(LevelType), key=lambda t: ename(t))
        last_type = str(self.cfg("level_type", ""))
        default_id = doc.GetDefaultElementTypeId(ElementTypeGroup.LevelType)
        for t in self.level_types:
            self.type_cb.Items.Add(ename(t))
        names = [ename(t) for t in self.level_types]
        ids = [t.Id for t in self.level_types]
        if last_type in names:
            self.type_cb.SelectedIndex = names.index(last_type)
        elif default_id in ids:
            self.type_cb.SelectedIndex = ids.index(default_id)
        else:
            self.type_cb.SelectedIndex = 0
        for c in PLAN_CHOICES:
            self.plans_cb.Items.Add(c)
        last_plans = str(self.cfg("plans", PLAN_CHOICES[1]))
        self.plans_cb.SelectedIndex = PLAN_CHOICES.index(last_plans) if last_plans in PLAN_CHOICES else 1
        self.skip_cb.IsChecked = str(self.cfg("skip_existing", "1")) in ("1", "True", "true")
        self.ready = True
        self.update_preview()

    def cfg(self, name, default):
        try:
            val = config.get_option(name, default)
            return default if val is None else val
        except Exception:
            return default

    def unit_label(self):
        try:
            text = UnitFormatUtils.Format(doc.GetUnits(), SpecTypeId.Length, mm(1000), False)
            unit = re.sub(r"[\d.,'\s\-+]", "", text)
            return unit or "(project units)"
        except Exception:
            return "(project units)"

    def level_type(self):
        return self.level_types[self.type_cb.SelectedIndex] if self.level_types else None

    def prefix_picked(self, sender, args):
        if self.prefixes_cb.SelectedIndex > 0:
            self.prefix_tb.Text = self.prefixes[self.prefixes_cb.SelectedIndex - 1]

    def changed(self, sender, args):
        if self.ready:
            self.update_preview()

    def compute(self):
        """[(z internal, display value, name or None if skipped, note)] sorted top to bottom."""
        lt = self.level_type()
        base = elevation_base(lt.Id if lt else ElementId.InvalidElementId)
        offset = 0.0
        ref = parse_number(self.ref_tb.Text)               # raises ValueError if not a number
        if ref is not None:
            offset = (self.to_internal(ref) + base) - self.picks[0][0]
        prefix = clean_name(self.prefix_tb.Text)
        existing = list(FilteredElementCollector(doc).OfClass(Level))
        used_names = set(l.Name for l in existing)
        rows = []
        for z, horizontal in sorted(self.picks, key=lambda p: -p[0]):
            z = z + offset
            display = z - base
            label = format_elevation(display)
            name = clean_name(u"{} {}".format(prefix, label)) if prefix else label
            note = "" if horizontal is not False else "line not horizontal"
            same = [l for l in existing if abs(l.ProjectElevation - z) < mm(SAME_HEIGHT_MM)]
            if same:
                note = (note + "; " if note else "") + u"level '{}' already here".format(same[0].Name)
                if self.skip_cb.IsChecked:
                    rows.append((z, label, None, note))
                    continue
            if name in used_names:
                n = 2
                while u"{} ({})".format(name, n) in used_names:
                    n += 1
                name = u"{} ({})".format(name, n)
            used_names.add(name)
            rows.append((z, label, name, note))
        return rows

    def to_internal(self, value):
        """Number typed in project length units -> internal units."""
        unit = doc.GetUnits().GetFormatOptions(SpecTypeId.Length).GetUnitTypeId()
        return UnitUtils.ConvertToInternalUnits(value, unit)

    def update_preview(self):
        self.error_tb.Text = ""
        try:
            rows = self.compute()
        except ValueError:
            self.error_tb.Text = "The correction elevation must be a number."
            self.create_btn.IsEnabled = False
            return
        lines = []
        for z, label, name, note in rows:
            lines.append(u"{:>10}   {}{}".format(label, name if name else "(skipped)",
                                                 u"   - " + note if note else ""))
        self.preview_tb.Text = "\n".join(lines)
        self.create_btn.IsEnabled = any(r[2] for r in rows)

    def create_click(self, sender, args):
        try:
            rows = self.compute()
        except ValueError:
            return
        try:
            for k, v in (("prefix", self.prefix_tb.Text), ("plans", self.plans_cb.SelectedItem),
                         ("skip_existing", "1" if self.skip_cb.IsChecked else "0"),
                         ("level_type", ename(self.level_type()) if self.level_type() else "")):
                setattr(config, k, v)
            script.save_config()
        except Exception:
            pass
        self.result = {"rows": [r for r in rows if r[2]], "type": self.level_type(),
                       "plans": PLAN_CHOICES.index(str(self.plans_cb.SelectedItem))}
        self.Close()


# ---------------- main ----------------

def main():
    view = doc.ActiveView
    if not isinstance(view, (ViewSection, View3D)) or view.IsTemplate:
        forms.alert("Run this in the section or elevation where the DWG section is imported.",
                    title="Levels from DWG", exitscript=True)
    if not list(FilteredElementCollector(doc, view.Id).OfClass(ImportInstance)):
        forms.alert("No DWG is visible in this view. Insert it first (Insert > Import CAD).",
                    title="Levels from DWG", exitscript=True)
    picks = pick_heights()
    if not picks:
        return
    win = LevelsWindow(picks)
    win.ShowDialog()
    s = win.result
    if s is None:
        return

    vft = None
    if s["plans"]:
        family = ViewFamily.FloorPlan if s["plans"] == 1 else ViewFamily.StructuralPlan
        vft = next((t for t in FilteredElementCollector(doc).OfClass(ViewFamilyType) if t.ViewFamily == family), None)

    created = []
    t = Transaction(doc, "Levels from DWG")
    t.Start()
    try:
        for z, label, name, note in s["rows"]:
            level = Level.Create(doc, z)
            if s["type"] is not None:
                level.ChangeTypeId(s["type"].Id)
            doc.Regenerate()
            if abs(level.ProjectElevation - z) > 1e-6:      # Level.Create may measure from the elevation base
                level.Elevation = level.Elevation + (z - level.ProjectElevation)
            level.Name = name
            plan = ViewPlan.Create(doc, vft.Id, level.Id) if vft is not None else None
            created.append((level, plan, note))
        t.Commit()
    except Exception as ex:
        t.RollBack()
        forms.alert(u"Could not create the levels:\n{}".format(ex), title="Levels from DWG", exitscript=True)

    output = script.get_output()
    output.print_md("## Levels from DWG")
    rows = [[output.linkify(l.Id), l.get_Parameter(BuiltInParameter.LEVEL_ELEV).AsValueString(),
             output.linkify(p.Id) if p is not None else "-", note or ""] for l, p, note in created]
    output.print_table(rows, columns=["Level", "Elevation", "Plan", "Note"])


main()
