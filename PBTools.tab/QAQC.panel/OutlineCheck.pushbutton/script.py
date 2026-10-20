# -*- coding: utf-8 -*-
__title__ = "Outline\nCheck"
__doc__ = """Compare the plan outline (footprint) of model elements, e.g. Generic Model extrusions, with a DWG.
Run it in the plan where the DWG is visible. Closed DWG outlines are found automatically and every element
is compared both ways (element -> DWG and DWG -> element). Result: a QAQC plan with the elements coloured,
red/magenta markers where they deviate, DWG outlines without an element, and a table.
Works in Revit 2023 and 2025."""

import json
import math

import clr
clr.AddReference("System")
clr.AddReference("PresentationFramework")
clr.AddReference("PresentationCore")
from System.Collections.Generic import List
from System.Windows import Thickness, Visibility
from System.Windows.Controls import CheckBox

from pyrevit import revit, forms, script
from Autodesk.Revit.DB import (BooleanOperationsType, BooleanOperationsUtils, BuiltInCategory, CategoryType,
                               Color, Curve, Element, ElementId, ElementTypeGroup, ExtrusionAnalyzer,
                               FillPatternElement, FilteredElementCollector, GeometryInstance, GraphicsStyle,
                               GraphicsStyleType, ImportInstance, Line, Options, OverrideGraphicSettings,
                               PlanarFace, Plane, PolyLine, Solid, TextNote, Transaction, UnitTypeId, UnitUtils,
                               ViewDetailLevel, ViewDuplicateOption, ViewPlan, XYZ)
from Autodesk.Revit.UI.Selection import ISelectionFilter, ObjectType
from Autodesk.Revit.Exceptions import OperationCanceledException

import pomadaoutline as po

doc = revit.doc
uidoc = revit.uidoc
output = script.get_output()
config = script.get_config()

DEFAULT_TOLERANCE_MM = 10.0
SAMPLE_STEP_MM = 50.0        # check points along every outline
SEARCH_MM = 500.0            # deviations are measured up to this distance (shown as ">500")
CELL_MM = 500.0              # spatial grid for fast lookups
MIN_OUTLINE_M2 = 0.05        # smaller closed DWG outlines (symbols, text boxes) are ignored
REGION_MARGIN_MM = 5000.0    # DWG outlines farther than this from the checked elements are not reported
MAX_MARKER_LINES = 3000
MAX_INNER_MARKERS = 3        # more closed DWG outlines inside one element = probably a hatch
LAYER_HINTS = ("temelj", "fund", "found", "fdn")
RESULT_PREFIX = "QAQC Outline Check - "

# same conventions as QAQC Section
QAQC_PARAM = "QAQC"
BROWSER_PARAMS = ("5d Projektbrowserstruktur Stufe 1", "5d Projektbrowserstruktur Stufe 2",
                  "5d Projektbrowserstruktur Stufe 3")
BROWSER_VALUES = ("00 QAQC", "Plan", "Outline Check")

STATUS_COLOR = {"OK": Color(0, 170, 0), "check": Color(230, 180, 0), "deviates": Color(220, 0, 0),
                "duplicate": Color(150, 0, 200), "no DWG": Color(255, 120, 0), "no geometry": Color(255, 120, 0)}
STATUS_TEXT = {"OK": "OK", "check": "check", "deviates": "deviates", "duplicate": "duplicate",
               "no DWG": "no DWG nearby", "no geometry": "no geometry"}
MODEL_STYLE = ("QAQC Outline - model deviates", Color(220, 0, 0), 8)
DWG_STYLE = ("QAQC Outline - DWG not modelled", Color(230, 0, 200), 8)


def mm(v):
    return UnitUtils.ConvertToInternalUnits(v, UnitTypeId.Millimeters)


def to_mm(v):
    return UnitUtils.ConvertFromInternalUnits(v, UnitTypeId.Millimeters)


def id_int(eid):
    return eid.Value if hasattr(eid, "Value") else eid.IntegerValue


def ename(e):
    try:
        return e.Name
    except Exception:
        return Element.Name.__get__(e)


# ---------------- settings memory ----------------

def cfg_get(name, default):
    try:
        val = config.get_option(name, default)
        return default if val is None else val
    except Exception:
        return default


def cfg_flag(name):
    return str(cfg_get(name, "1")).lower() in ("1", "true", "yes")


def cfg_save(**values):
    try:
        for k, v in values.items():
            setattr(config, k, v)
        script.save_config()
    except Exception:
        pass


# ---------------- elements and their footprints ----------------

def is_checkable(e):
    return e.Category is not None and e.Category.CategoryType == CategoryType.Model \
        and not isinstance(e, ImportInstance)


class CheckableFilter(ISelectionFilter):
    def AllowElement(self, e):
        return is_checkable(e)

    def AllowReference(self, ref, pt):
        return False


def element_solids(elem):
    opts = Options()
    opts.DetailLevel = ViewDetailLevel.Fine
    solids = []

    def walk(geo):
        for o in geo:
            if isinstance(o, GeometryInstance):
                walk(o.GetInstanceGeometry())
            elif isinstance(o, Solid) and o.Volume > 1e-9:
                solids.append(o)

    geo = elem.get_Geometry(opts)
    if geo is not None:
        walk(geo)
    return solids


def union(solids):
    """Merge touching solids so their shared faces do not show up as outline edges."""
    merged = []
    for s in solids:
        for i, m in enumerate(merged):
            try:
                merged[i] = BooleanOperationsUtils.ExecuteBooleanOperation(m, s, BooleanOperationsType.Union)
                break
            except Exception:
                continue
        else:
            merged.append(s)
    return merged


def curve_loop_points(loop):
    pts = []
    for crv in loop:
        for p in crv.Tessellate():
            pts.append((p.X, p.Y))
    return po.close(pts)


def footprint_loops(elem):
    """Plan footprint of the element (all solids projected along Z) as closed 2D loops."""
    plane = Plane.CreateByNormalAndOrigin(XYZ.BasisZ, XYZ.Zero)
    loops = []
    for solid in union(element_solids(elem)):
        try:
            base = ExtrusionAnalyzer.Create(solid, plane, XYZ.BasisZ).GetExtrusionBase()
            loops.extend(curve_loop_points(cl) for cl in base.GetEdgesAsCurveLoops())
        except Exception:
            # fallback: outlines of the downward-facing faces
            for face in solid.Faces:
                if isinstance(face, PlanarFace) and face.FaceNormal.Z < -0.99:
                    loops.extend(curve_loop_points(cl) for cl in face.GetEdgesAsCurveLoops())
    return [L for L in loops if len(L) >= 4]


# ---------------- DWG ----------------

def dwgs_in_view(view):
    return list(FilteredElementCollector(doc, view.Id).OfClass(ImportInstance))


def dwg_label(dwg):
    t = doc.GetElement(dwg.GetTypeId())
    return u"{}  [{}]".format(ename(t) if t is not None else "DWG", id_int(dwg.Id))


def layer_name(geo_obj):
    style = doc.GetElement(geo_obj.GraphicsStyleId)
    if isinstance(style, GraphicsStyle) and style.GraphicsStyleCategory is not None:
        return style.GraphicsStyleCategory.Name
    return "(no layer)"


def dwg_pieces(dwg, view):
    """{layer: [point lists]} for every curve / polyline of the DWG visible in the view (incl. blocks)."""
    opts = Options()
    opts.View = view
    layers = {}

    def add(layer, pts):
        layers.setdefault(layer, []).append([(p.X, p.Y) for p in pts])

    def walk(geo):
        for o in geo:
            if isinstance(o, GeometryInstance):
                walk(o.GetInstanceGeometry())
            elif isinstance(o, PolyLine):
                add(layer_name(o), o.GetCoordinates())
            elif isinstance(o, Curve):
                try:
                    add(layer_name(o), o.Tessellate())
                except Exception:
                    pass

    geo = dwg.get_Geometry(opts)
    if geo is not None:
        walk(geo)
    return layers


# ---------------- settings window ----------------

XAML = """
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="QAQC Outline Check" Width="520" SizeToContent="Height" ResizeMode="NoResize"
        WindowStartupLocation="CenterScreen" ShowInTaskbar="False">
  <StackPanel Margin="14">
    <TextBlock Text="Elements" FontWeight="SemiBold"/>
    <TextBlock x:Name="selected_tb" Margin="0,4,0,0" TextWrapping="Wrap"/>
    <RadioButton x:Name="all_rb" Margin="0,4,0,0" GroupName="els"/>
    <RadioButton x:Name="pick_rb" Content="Let me pick the elements after OK" Margin="0,4,0,0" GroupName="els"/>

    <TextBlock Text="DWG" FontWeight="SemiBold" Margin="0,14,0,0"/>
    <ComboBox x:Name="dwg_cb" Margin="0,4,0,0" SelectionChanged="dwg_changed"/>

    <DockPanel Margin="0,14,0,0">
      <StackPanel Orientation="Horizontal" DockPanel.Dock="Right">
        <Button Content="All" Width="50" Margin="0,0,6,0" Click="all_layers"/>
        <Button Content="None" Width="50" Click="no_layers"/>
      </StackPanel>
      <TextBlock Text="DWG layers with the foundation outlines" FontWeight="SemiBold" VerticalAlignment="Center"/>
    </DockPanel>
    <Border BorderBrush="#BBBBBB" BorderThickness="1" Margin="0,4,0,0">
      <ScrollViewer MaxHeight="230" VerticalScrollBarVisibility="Auto">
        <StackPanel x:Name="layers_sp" Margin="6"/>
      </ScrollViewer>
    </Border>

    <StackPanel Orientation="Horizontal" Margin="0,14,0,0">
      <TextBlock Text="Tolerance" FontWeight="SemiBold" VerticalAlignment="Center" Width="80"/>
      <TextBox x:Name="tol_tb" Width="70" Padding="3"/>
      <TextBlock Text=" mm" VerticalAlignment="Center"/>
    </StackPanel>
    <CheckBox x:Name="markers_cb" Content="Draw markers where outlines deviate (detail lines + values)"
              Margin="0,10,0,0"/>
    <CheckBox x:Name="missing_cb" Content="Report DWG outlines that have no model element" Margin="0,6,0,0"/>

    <TextBlock x:Name="error_tb" Foreground="#C0392B" TextWrapping="Wrap" Margin="0,10,0,0"/>
    <StackPanel Orientation="Horizontal" HorizontalAlignment="Right" Margin="0,8,0,0">
      <Button Content="Check" Width="90" Margin="0,0,8,0" IsDefault="True" Click="run_click"/>
      <Button Content="Cancel" Width="80" IsCancel="True"/>
    </StackPanel>
  </StackPanel>
</Window>
"""


class SettingsWindow(forms.WPFWindow):
    def __init__(self, view, preselected, view_elements, dwgs):
        forms.WPFWindow.__init__(self, XAML, literal_string=True)
        self.view, self.dwgs, self.result = view, dwgs, None
        self.layer_cache = {}
        self.preselected = preselected
        if preselected:
            self.selected_tb.Text = "{} selected element(s) will be checked.".format(len(preselected))
            self.all_rb.Visibility = Visibility.Collapsed
            self.pick_rb.Visibility = Visibility.Collapsed
        else:
            self.selected_tb.Text = "Nothing is selected."
            self.all_rb.Content = "All Generic Models visible in this view ({})".format(len(view_elements))
            self.all_rb.IsChecked = len(view_elements) > 0
            self.pick_rb.IsChecked = not view_elements
        self.tol_tb.Text = str(cfg_get("tolerance_mm", "{:g}".format(DEFAULT_TOLERANCE_MM)))
        self.markers_cb.IsChecked = cfg_flag("draw_markers")
        self.missing_cb.IsChecked = cfg_flag("report_missing")
        saved = cfg_get("layers_json", "{}")
        try:
            self.saved_layers = saved if isinstance(saved, dict) else json.loads(str(saved))
        except Exception:
            self.saved_layers = {}
        last = str(cfg_get("last_dwg", ""))
        labels = [dwg_label(d) for d in dwgs]
        for label in labels:
            self.dwg_cb.Items.Add(label)
        names = [ename(doc.GetElement(d.GetTypeId())) for d in dwgs]
        self.dwg_cb.SelectedIndex = names.index(last) if last in names else 0

    def current_dwg(self):
        return self.dwgs[self.dwg_cb.SelectedIndex]

    def dwg_name(self):
        return ename(doc.GetElement(self.current_dwg().GetTypeId()))

    def dwg_changed(self, sender, args):
        self.error_tb.Text = ""
        dwg = self.current_dwg()
        key = id_int(dwg.Id)
        if key not in self.layer_cache:
            self.layer_cache[key] = dwg_pieces(dwg, self.view)
        layers = self.layer_cache[key]
        saved = self.saved_layers.get(self.dwg_name())
        self.layers_sp.Children.Clear()
        for name in sorted(layers, key=lambda n: n.lower()):
            cb = CheckBox()
            cb.Content = u"{}   ({} curves)".format(name, len(layers[name]))
            cb.Tag = name
            cb.Margin = Thickness(0, 2, 0, 2)
            if saved is not None:
                cb.IsChecked = name in saved
            else:
                cb.IsChecked = any(h in name.lower() for h in LAYER_HINTS)
            self.layers_sp.Children.Add(cb)
        if not layers:
            self.error_tb.Text = "This DWG has no lines in this view."

    def set_layers(self, state):
        for cb in self.layers_sp.Children:
            cb.IsChecked = state

    def all_layers(self, sender, args):
        self.set_layers(True)

    def no_layers(self, sender, args):
        self.set_layers(False)

    def run_click(self, sender, args):
        try:
            tol = float(self.tol_tb.Text.replace(",", "."))
            if tol <= 0:
                raise ValueError()
        except ValueError:
            self.error_tb.Text = "Tolerance must be a positive number of millimetres."
            return
        layers = [cb.Tag for cb in self.layers_sp.Children if cb.IsChecked]
        if not layers:
            self.error_tb.Text = "Tick at least one DWG layer."
            return
        self.saved_layers[self.dwg_name()] = layers
        cfg_save(tolerance_mm=self.tol_tb.Text, draw_markers="1" if self.markers_cb.IsChecked else "0",
                 report_missing="1" if self.missing_cb.IsChecked else "0",
                 layers_json=json.dumps(self.saved_layers), last_dwg=self.dwg_name())
        self.result = {"dwg": self.current_dwg(), "layers": layers, "tol_mm": tol,
                       "pieces": self.layer_cache[id_int(self.current_dwg().Id)],
                       "pick": bool(self.pick_rb.IsChecked) and not self.preselected,
                       "markers": bool(self.markers_cb.IsChecked), "missing": bool(self.missing_cb.IsChecked)}
        self.Close()


# ---------------- result view ----------------

def solid_fill_id():
    for fp in FilteredElementCollector(doc).OfClass(FillPatternElement):
        if fp.GetFillPattern().IsSolidFill:
            return fp.Id
    return ElementId.InvalidElementId


def overrides(color, fill_id):
    ogs = OverrideGraphicSettings()
    ogs.SetProjectionLineColor(color)
    ogs.SetCutLineColor(color)
    if fill_id != ElementId.InvalidElementId:
        ogs.SetSurfaceForegroundPatternId(fill_id)
        ogs.SetSurfaceForegroundPatternColor(color)
        ogs.SetCutForegroundPatternId(fill_id)
        ogs.SetCutForegroundPatternColor(color)
    ogs.SetSurfaceTransparency(40)
    return ogs


def tag_view(view):
    p = view.LookupParameter(QAQC_PARAM)
    if p is not None and not p.IsReadOnly:
        p.Set("QAQC")
    for name, val in zip(BROWSER_PARAMS, BROWSER_VALUES):
        p = view.LookupParameter(name)
        if p is not None and not p.IsReadOnly:
            p.Set(val)


def make_result_view(source, dwg):
    name = RESULT_PREFIX + source.Name
    for v in FilteredElementCollector(doc).OfClass(ViewPlan):
        if not v.IsTemplate and v.Name == name:
            doc.Delete(v.Id)            # previous result of this plan: replaced
    option = ViewDuplicateOption.WithDetailing if dwg.ViewSpecific else ViewDuplicateOption.Duplicate
    view = doc.GetElement(source.Duplicate(option))
    if view.ViewTemplateId != ElementId.InvalidElementId:
        view.ViewTemplateId = ElementId.InvalidElementId
    view.Name = name
    tag_view(view)
    return view


def line_style(name, color, weight):
    lines_cat = doc.Settings.Categories.get_Item(BuiltInCategory.OST_Lines)
    sub = None
    for s in lines_cat.SubCategories:
        if s.Name == name:
            sub = s
    if sub is None:
        sub = doc.Settings.Categories.NewSubcategory(lines_cat, name)
    sub.LineColor = color
    sub.SetLineWeight(weight, GraphicsStyleType.Projection)
    return sub.GetGraphicsStyle(GraphicsStyleType.Projection)


class Markers(object):
    """Detail lines and text notes in the result view."""
    def __init__(self, view):
        self.view = view
        self.z = None
        self.count = 0
        self.failed = 0
        self.text_type = doc.GetDefaultElementTypeId(ElementTypeGroup.TextNoteType)
        self.styles = {"model": line_style(*MODEL_STYLE), "dwg": line_style(*DWG_STYLE)}

    def _z_candidates(self):
        zs = []
        try:
            zs.append(self.view.SketchPlane.GetPlane().Origin.Z)
        except Exception:
            pass
        if self.view.GenLevel is not None:
            zs.append(self.view.GenLevel.ProjectElevation)
        zs.append(0.0)
        return zs

    def line(self, a, b, kind):
        if self.count >= MAX_MARKER_LINES or math.hypot(b[0] - a[0], b[1] - a[1]) < mm(2):
            return
        for z in ([self.z] if self.z is not None else self._z_candidates()):
            try:
                dc = doc.Create.NewDetailCurve(self.view, Line.CreateBound(XYZ(a[0], a[1], z), XYZ(b[0], b[1], z)))
                dc.LineStyle = self.styles[kind]
                self.z = z
                self.count += 1
                return
            except Exception:
                continue
        self.failed += 1

    def polyline(self, pts, kind):
        for a, b in zip(pts[:-1], pts[1:]):
            self.line(a, b, kind)

    def text(self, xy, text):
        try:
            TextNote.Create(doc, self.view.Id, XYZ(xy[0], xy[1], self.z or 0.0), text, self.text_type)
        except Exception:
            pass


def fmt_mm(v, search):
    if v is None:
        return "-"
    return ">{:.0f}".format(to_mm(search)) if v >= search * 0.999 else "{:.1f}".format(to_mm(v))


def worst_point(res):
    best = None
    for L in res["loops"]:
        for x, y, _, d in L["cmp"]["fwd"] + L["cmp"]["bwd"]:
            if best is None or d > best[2]:
                best = (x, y, d)
    return best


# ---------------- main ----------------

def main():
    view = doc.ActiveView
    if not isinstance(view, ViewPlan) or view.IsTemplate:
        forms.alert("Run this in the plan view where the DWG is visible.", title="Outline Check", exitscript=True)
    if view.Name.startswith(RESULT_PREFIX):
        forms.alert("This is a result view. Run the check from the original plan.", title="Outline Check",
                    exitscript=True)
    dwgs = dwgs_in_view(view)
    if not dwgs:
        forms.alert("No DWG is visible in this view.", title="Outline Check", exitscript=True)

    preselected = [doc.GetElement(i) for i in uidoc.Selection.GetElementIds()]
    preselected = [e for e in preselected if is_checkable(e)]
    view_gms = list(FilteredElementCollector(doc, view.Id).OfCategory(BuiltInCategory.OST_GenericModel)
                    .WhereElementIsNotElementType())

    win = SettingsWindow(view, preselected, view_gms, dwgs)
    win.ShowDialog()
    s = win.result
    if s is None:
        return
    if preselected:
        elements = preselected
    elif s["pick"]:
        try:
            with forms.WarningBar(title="Select the elements to check, then click Finish"):
                refs = uidoc.Selection.PickObjects(ObjectType.Element, CheckableFilter(),
                                                   "Select the elements to check, then Finish")
        except OperationCanceledException:
            return
        elements = [doc.GetElement(r) for r in refs]
    else:
        elements = view_gms
    if not elements:
        forms.alert("No elements to check.", title="Outline Check", exitscript=True)

    tol, step, search = mm(s["tol_mm"]), mm(SAMPLE_STEP_MM), mm(max(SEARCH_MM, 5 * s["tol_mm"]))
    cell, snap = mm(CELL_MM), mm(min(max(1.0, s["tol_mm"] / 2.0), 5.0))
    min_area = MIN_OUTLINE_M2 / (0.3048 ** 2)

    pieces = [p for layer in s["layers"] for p in s["pieces"].get(layer, [])]
    dwg_segments = [seg for p in pieces for seg in po.polyline_segments(p)]
    dwg_loops = po.build_loops(pieces, snap, min_area)

    footprints = []
    with forms.ProgressBar(title="Reading element footprints ({value} of {max_value})", cancellable=True) as pb:
        for i, e in enumerate(elements):
            if pb.cancelled:
                return
            footprints.append((id_int(e.Id), footprint_loops(e)))
            pb.update_progress(i + 1, len(elements))
    results, missing = po.analyse(footprints, dwg_loops, dwg_segments, tol, step, search, cell, min_area,
                                  mm(REGION_MARGIN_MM))
    if not s["missing"]:
        missing = []

    by_id = dict((id_int(e.Id), e) for e in elements)
    fill_id = solid_fill_id()
    t = Transaction(doc, "QAQC Outline Check")
    t.Start()
    try:
        rview = make_result_view(view, s["dwg"])
        doc.Regenerate()
        # a DWG imported "current view only" is copied with the view (new id): keep whatever copy is there
        dwg_ids = [i.Id for i in FilteredElementCollector(doc, rview.Id).OfClass(ImportInstance)
                   if i.GetTypeId() == s["dwg"].GetTypeId()]
        rview.IsolateElementsTemporary(List[ElementId]([e.Id for e in elements] + dwg_ids))
        rview.ConvertTemporaryHideIsolateToPermanent()
        for key, res in results.items():
            rview.SetElementOverrides(by_id[key].Id, overrides(STATUS_COLOR[res["status"]], fill_id))

        markers = None
        if s["markers"]:
            markers = Markers(rview)
            for key, res in results.items():
                if res["status"] not in ("deviates", "check", "duplicate"):
                    continue
                for L in res["loops"]:
                    for a, b in po.deviation_runs(L["cmp"]["fwd"], tol):
                        markers.line(a, b, "model")
                    for a, b in po.deviation_runs(L["cmp"]["bwd"], tol):
                        markers.line(a, b, "dwg")
                inner = res.get("inner_dwg", [])
                if len(inner) <= MAX_INNER_MARKERS:
                    for j in inner:
                        markers.polyline(dwg_loops[j], "dwg")
                else:
                    res["notes"].append("{} closed DWG outlines inside - hatch on this layer? "
                                        "(not drawn)".format(len(inner)))
                wp = worst_point(res)
                if res["status"] == "deviates" and wp is not None and wp[2] > tol:
                    markers.text(wp, u"Δ {} mm".format(fmt_mm(wp[2], search)))
            for j in missing:
                markers.polyline(dwg_loops[j], "dwg")
                markers.text(po.centroid(dwg_loops[j]), "no model element")
        t.Commit()
    except Exception as ex:
        t.RollBack()
        forms.alert("Could not create the result view:\n{}".format(ex), title="Outline Check", exitscript=True)
    uidoc.ActiveView = rview
    report(results, by_id, missing, s, search, rview, markers, len(dwg_loops))


def report(results, by_id, missing, s, search, rview, markers, n_loops):
    order = dict((st, i) for i, st in enumerate(po.STATUS_ORDER + ("no geometry",)))
    keys = sorted(results, key=lambda k: (order.get(results[k]["status"], 9), -(results[k]["max"] or 0)))
    rows = []
    for k in keys:
        r, e = results[k], by_id[k]
        etype = doc.GetElement(e.GetTypeId())
        shift = "-" if r["shift"] is None else "{:.0f} / {:.0f}".format(to_mm(r["shift"][0]), to_mm(r["shift"][1]))
        m2 = 0.3048 ** 2
        area = "-" if r["area_model"] is None else "{:.2f} / {}".format(
            r["area_model"] * m2, "-" if r["area_dwg"] is None else "{:.2f}".format(r["area_dwg"] * m2))
        rows.append([output.linkify(e.Id), getattr(etype, "FamilyName", "") if etype is not None else "",
                     ename(etype) if etype is not None else "", STATUS_TEXT[r["status"]],
                     fmt_mm(r["max"], search), fmt_mm(r["fwd_max"], search), fmt_mm(r["bwd_max"], search),
                     shift, area, "; ".join(r["notes"])])
    counts = {}
    for r in results.values():
        counts[r["status"]] = counts.get(r["status"], 0) + 1

    output.print_md("## QAQC Outline Check")
    output.print_md(u"**View:** {}  |  **DWG:** {}  |  **Layers:** {}  |  **Tolerance:** {:g} mm".format(
        rview.Name, dwg_label(s["dwg"]), ", ".join(s["layers"]), s["tol_mm"]))
    output.print_md(u"**Closed DWG outlines found:** {}  |  ".format(n_loops) + "  |  ".join(
        u"**{}:** {}".format(STATUS_TEXT[st], counts[st]) for st in po.STATUS_ORDER + ("no geometry",)
        if counts.get(st)))
    if s["missing"]:
        output.print_md(u"**DWG outlines without a model element:** {}{}".format(
            len(missing), " (outlined in magenta, labelled 'no model element')" if missing and markers else ""))
    output.print_md("Colours: green OK, yellow check, red deviates, purple duplicate, orange no DWG nearby. "
                    "Markers: red = model edge off the DWG, magenta = DWG outline the model does not follow.")
    if markers is not None and markers.failed:
        output.print_md("**{} marker line(s) could not be drawn in this view.**".format(markers.failed))
    if markers is not None and markers.count >= MAX_MARKER_LINES:
        output.print_md("**Marker limit reached ({}) - not all deviations are drawn.**".format(MAX_MARKER_LINES))
    output.print_table(rows, columns=["Element", "Family", "Type", "Result", "Max dev (mm)", "Model→DWG",
                                      "DWG→Model", "Shift X / Y (mm)", "Area model / DWG (m²)", "Notes"])


main()
