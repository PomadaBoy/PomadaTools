# -*- coding: utf-8 -*-
__title__ = "GM\nList"
__doc__ = """Window listing all Generic Models in the model. Click a row (Ctrl/Shift for several)
to select the element and zoom to it in the active 3D view. The window stays open while you work.
Works in Revit 2023 and 2025."""
__persistentengine__ = True   # window stays open after the script ends

import clr
clr.AddReference("System")
from System.Collections.Generic import List

from pyrevit import revit, forms, script, EXEC_PARAMS
from Autodesk.Revit.DB import (BuiltInCategory, Element, ElementId, FamilyInstance,
                               FilteredElementCollector, View3D, XYZ)
from Autodesk.Revit.UI import ExternalEvent, IExternalEventHandler

doc = revit.doc
uidoc = revit.uidoc
logger = script.get_logger()

ZOOM_MARGIN = 0.25     # extra space around the zoomed element (fraction of its size)
MIN_ZOOM_FT = 3.0      # never zoom tighter than about 1 m

XAML = """
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Generic Models" Width="720" Height="560" MinWidth="480" MinHeight="300"
        WindowStartupLocation="CenterScreen" ShowInTaskbar="False">
  <DockPanel Margin="10">
    <DockPanel DockPanel.Dock="Top" Margin="0,0,0,8">
      <TextBlock x:Name="count_tb" DockPanel.Dock="Right" VerticalAlignment="Center" Margin="10,0,0,0"
                 Foreground="#555555"/>
      <TextBlock Text="Search:" VerticalAlignment="Center" Margin="0,0,6,0"/>
      <TextBox x:Name="search_tb" Padding="3" TextChanged="search_changed"/>
    </DockPanel>
    <DockPanel DockPanel.Dock="Bottom" Margin="0,8,0,0" LastChildFill="False">
      <CheckBox x:Name="zoom_cb" Content="Zoom to selection" IsChecked="True" VerticalAlignment="Center"
                DockPanel.Dock="Left"/>
      <CheckBox x:Name="visible_cb" Content="Only visible in active view" VerticalAlignment="Center"
                Margin="14,0,0,0" DockPanel.Dock="Left" Click="search_changed"/>
      <Button Content="Close" Width="80" DockPanel.Dock="Right" Click="close_click"/>
      <Button Content="Refresh" Width="80" Margin="0,0,8,0" DockPanel.Dock="Right" Click="refresh_click"/>
    </DockPanel>
    <TextBlock x:Name="status_tb" DockPanel.Dock="Bottom" Foreground="#2B4C8C" TextWrapping="Wrap" Margin="0,6,0,0"/>
    <ListView x:Name="list_lv" SelectionMode="Extended" SelectionChanged="list_changed">
      <ListView.View>
        <GridView>
          <GridViewColumn Header="Family" Width="220" DisplayMemberBinding="{Binding family}"/>
          <GridViewColumn Header="Type" Width="200" DisplayMemberBinding="{Binding type}"/>
          <GridViewColumn Header="Level" Width="110" DisplayMemberBinding="{Binding level}"/>
          <GridViewColumn Header="In view" Width="60" DisplayMemberBinding="{Binding visible}"/>
          <GridViewColumn Header="Id" Width="80" DisplayMemberBinding="{Binding id}"/>
        </GridView>
      </ListView.View>
    </ListView>
  </DockPanel>
</Window>
"""


def id_int(eid):
    return eid.Value if hasattr(eid, "Value") else eid.IntegerValue


def ename(e):
    try:
        return e.Name
    except Exception:
        return Element.Name.__get__(e)


class Row(object):
    def __init__(self, elem, visible_ids):
        d = elem.Document
        etype = d.GetElement(elem.GetTypeId())
        if isinstance(elem, FamilyInstance):
            self.family = elem.Symbol.Family.Name
        elif etype is not None:
            self.family = etype.FamilyName
        else:
            self.family = "(no family)"
        self.type = ename(etype) if etype is not None else ""
        level = d.GetElement(elem.LevelId)
        self.level = ename(level) if level is not None else ""
        self.element_id = elem.Id
        self.id = str(id_int(elem.Id))
        self.visible = "yes" if id_int(elem.Id) in visible_ids else "no"
        self.search = u" ".join([self.family, self.type, self.level, self.id]).lower()


def collect_rows(d, view):
    visible_ids = set()
    if view is not None:
        for e in FilteredElementCollector(d, view.Id).OfCategory(BuiltInCategory.OST_GenericModel) \
                .WhereElementIsNotElementType().ToElementIds():
            visible_ids.add(id_int(e))
    rows = [Row(e, visible_ids) for e in FilteredElementCollector(d).OfCategory(BuiltInCategory.OST_GenericModel)
            .WhereElementIsNotElementType()]
    rows.sort(key=lambda r: (r.family.lower(), r.type.lower(), r.id))
    return rows


def zoom_to(ui_doc, ids):
    """Zoom the active view's window to the elements' combined bounding box (stays in this view)."""
    view = ui_doc.ActiveView
    boxes = [ui_doc.Document.GetElement(i).get_BoundingBox(None) for i in ids]
    boxes = [b for b in boxes if b is not None]
    if not boxes:
        return
    lo = XYZ(min(b.Min.X for b in boxes), min(b.Min.Y for b in boxes), min(b.Min.Z for b in boxes))
    hi = XYZ(max(b.Max.X for b in boxes), max(b.Max.Y for b in boxes), max(b.Max.Z for b in boxes))
    size = max((hi - lo).GetLength(), MIN_ZOOM_FT)
    pad = XYZ(1, 1, 1) * (size * ZOOM_MARGIN)
    for uiview in ui_doc.GetOpenUIViews():
        if uiview.ViewId == view.Id:
            uiview.ZoomAndCenterRectangle(lo - pad, hi + pad)
            return


class RevitAction(IExternalEventHandler):
    """Runs a function inside Revit's API context (needed because the window is modeless)."""
    # IronPython needs a unique .NET namespace per run for classes implementing Revit interfaces
    __namespace__ = EXEC_PARAMS.exec_id

    def __init__(self):
        self.func = None
        self.report = None      # callback(text) to show errors in the window

    def Execute(self, uiapp):
        func, self.func = self.func, None
        if func is None:
            return
        try:
            func(uiapp)
        except Exception as ex:
            if self.report:
                self.report("Error: {}".format(ex))
            logger.error("GM List: {}".format(ex))

    def GetName(self):
        return "PomadaTools GM List"


class GMListWindow(forms.WPFWindow):
    def __init__(self, rows):
        forms.WPFWindow.__init__(self, XAML, literal_string=True)
        self.all_rows = rows
        self.action = RevitAction()
        self.action.report = self.set_status
        self.event = ExternalEvent.Create(self.action)
        self.apply_filter()
        self.search_tb.Focus()

    # ---- list ----
    def apply_filter(self):
        words = self.search_tb.Text.lower().split()
        only_visible = bool(self.visible_cb.IsChecked)
        rows = [r for r in self.all_rows
                if all(w in r.search for w in words) and (not only_visible or r.visible == "yes")]
        self.list_lv.ItemsSource = rows
        self.count_tb.Text = "{} of {} Generic Models".format(len(rows), len(self.all_rows))

    def search_changed(self, sender, args):
        self.apply_filter()

    def set_status(self, text):
        self.status_tb.Text = text

    def run_in_revit(self, func):
        self.action.func = func
        request = self.event.Raise()
        if str(request) != "Accepted":
            self.set_status("Revit did not accept the request ({}). Try clicking again.".format(request))

    # ---- clicking rows ----
    def list_changed(self, sender, args):
        ids = [r.element_id for r in self.list_lv.SelectedItems]
        if not ids:
            return
        zoom = bool(self.zoom_cb.IsChecked)
        win = self
        self.set_status("Selecting {} element(s)...".format(len(ids)))

        def select(uiapp):
            ui_doc = uiapp.ActiveUIDocument
            if ui_doc is None or not ui_doc.Document.Equals(doc):
                win.set_status("The list belongs to '{}'. Switch back to that model.".format(doc.Title))
                return
            ui_doc.Selection.SetElementIds(List[ElementId](ids))
            if not isinstance(ui_doc.ActiveView, View3D):
                win.set_status("Selected {} - open a 3D view to zoom to it.".format(len(ids)))
                return
            if zoom:
                zoom_to(ui_doc, ids)
            win.set_status("Selected {} element(s).".format(ui_doc.Selection.GetElementIds().Count))

        self.run_in_revit(select)

    # ---- buttons ----
    def refresh_click(self, sender, args):
        win = self

        def refresh(uiapp):
            ui_doc = uiapp.ActiveUIDocument
            if ui_doc is None or not ui_doc.Document.Equals(doc):
                win.status_tb.Text = "The list belongs to '{}'. Switch back to that model.".format(doc.Title)
                return
            view = ui_doc.ActiveView if ui_doc is not None and isinstance(ui_doc.ActiveView, View3D) else None
            win.all_rows = collect_rows(doc, view)
            win.apply_filter()
            win.status_tb.Text = ""

        self.run_in_revit(refresh)

    def close_click(self, sender, args):
        self.Close()


def main():
    if not isinstance(uidoc.ActiveView, View3D):
        views = [v for v in FilteredElementCollector(doc).OfClass(View3D) if not v.IsTemplate]
        if not views:
            forms.alert("There is no 3D view in this model. Create one first.", exitscript=True)
        default = [v for v in views if v.Name in ("{3D}", "{3D - " + doc.Application.Username + "}")]
        uidoc.ActiveView = (default or views)[0]
    rows = collect_rows(doc, uidoc.ActiveView)
    if not rows:
        forms.alert("There are no Generic Models in this model.", exitscript=True)
    GMListWindow(rows).show()


main()
