# -*- coding: utf-8 -*-
"""Revit side of QAQC Outline Check, shared by the plan and the section version.

A Frame maps model points into 2D view coordinates (plan: X/Y, section: along the view's right/up
directions), so the pure 2D comparison in pomadaoutline works the same for both. run_check("plan") or
run_check("section") runs the whole tool."""

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
from Autodesk.Revit.DB import (BooleanOperationsType, BooleanOperationsUtils, BuiltInCategory, BuiltInParameter,
                               CategoryType, Color, Curve, Element, ElementId, ElementTypeGroup,
                               ExtrusionAnalyzer, FillPatternElement, FilteredElementCollector, GeometryInstance,
                               GraphicsStyle, GraphicsStyleType, ImportInstance, Line, Options,
                               OverrideGraphicSettings, PlanarFace, Plane, PolyLine, Solid, TextNote, Transaction,
                               UnitTypeId, UnitUtils, View, ViewDetailLevel, ViewDuplicateOption, ViewPlan,
                               ViewSection, ViewType, XYZ)
from Autodesk.Revit.UI.Selection import ISelectionFilter, ObjectType
from Autodesk.Revit.Exceptions import OperationCanceledException

import pomadaoutline as po

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
TITLE = "Outline Check"

# same conventions as QAQC Section
QAQC_PARAM = "QAQC"
BROWSER_PARAMS = ("5d Projektbrowserstruktur Stufe 1", "5d Projektbrowserstruktur Stufe 2",
                  "5d Projektbrowserstruktur Stufe 3")
PLAN_BROWSER_VALUES = ("00 QAQC", "Plan", "Outline Check")

STATUS_COLOR = {"OK": Color(0, 170, 0), "check": Color(230, 180, 0), "deviates": Color(220, 0, 0),
                "duplicate": Color(150, 0, 200), "no DWG": Color(255, 120, 0), "no geometry": Color(255, 120, 0)}
STATUS_TEXT = {"OK": "OK", "check": "check", "deviates": "deviates", "duplicate": "duplicate",
               "no DWG": "no DWG nearby", "no geometry": "not in view"}
MODEL_STYLE = ("QAQC Outline - model deviates", Color(220, 0, 0), 8)
DWG_STYLE = ("QAQC Outline - DWG not modelled", Color(230, 0, 200), 8)
SECTION_TYPES = (ViewType.Section, ViewType.Elevation, ViewType.Detail)

doc = revit.doc
uidoc = revit.uidoc


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

def cfg_get(config, name, default):
    try:
        val = config.get_option(name, default)
        return default if val is None else val
    except Exception:
        return default


def cfg_flag(config, name):
    return str(cfg_get(config, name, "1")).lower() in ("1", "true", "yes")


def cfg_save(config, **values):
    try:
        for k, v in values.items():
            setattr(config, k, v)
        script.save_config()
    except Exception:
        pass


# ---------------- view frames ----------------

class Frame(object):
    """Model <-> 2D view coordinates. offsets: distances along the normal where markers may be drawn."""
    def __init__(self, origin, right, up, normal, offsets, axis_names):
        self.o, self.r, self.u, self.n = origin, right, up, normal
        self.offsets = offsets
        self.axis_names = axis_names
        self.depth = None            # (cut point, far point or None) for sections

    def to2d(self, p):
        d = p - self.o
        return d.DotProduct(self.r), d.DotProduct(self.u)

    def to3d(self, uv, offset=0.0):
        return self.o + self.r * uv[0] + self.u * uv[1] + self.n * offset


def plan_frame(view):
    offsets = []
    try:
        offsets.append(view.SketchPlane.GetPlane().Origin.Z)
    except Exception:
        pass
    if view.GenLevel is not None:
        offsets.append(view.GenLevel.ProjectElevation)
    offsets.append(0.0)
    return Frame(XYZ.Zero, XYZ.BasisX, XYZ.BasisY, XYZ.BasisZ, offsets, ("X", "Y"))


def section_frame(view):
    n = view.ViewDirection                       # points towards the viewer
    frame = Frame(view.Origin, view.RightDirection, view.UpDirection, n, [0.0], ("horizontal", "vertical"))
    crop = view.CropBox
    a = crop.Transform.OfPoint(XYZ(0, 0, crop.Min.Z))
    b = crop.Transform.OfPoint(XYZ(0, 0, crop.Max.Z))
    cut, far = (a, b) if a.DotProduct(n) > b.DotProduct(n) else (b, a)
    p = view.get_Parameter(BuiltInParameter.VIEWER_BOUND_FAR_CLIPPING)
    if p is not None and p.AsInteger() == 0:     # far clipping off: everything behind the cut is visible
        far = None
    frame.depth = (cut, far)
    frame.offsets.append((cut - view.Origin).DotProduct(n))
    return frame


# ---------------- element outlines ----------------

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


def clip_to_depth(solid, frame):
    """Part of the solid between the section plane and the far clip (what the section shows)."""
    cut, far = frame.depth
    try:
        s = BooleanOperationsUtils.CutWithHalfSpace(solid, Plane.CreateByNormalAndOrigin(frame.n.Negate(), cut))
        if s is not None and s.Volume > 1e-9 and far is not None:
            s = BooleanOperationsUtils.CutWithHalfSpace(s, Plane.CreateByNormalAndOrigin(frame.n, far))
    except Exception:
        return solid
    return s if s is not None and s.Volume > 1e-9 else None


def curve_loop_points(loop, frame):
    pts = []
    for crv in loop:
        for p in crv.Tessellate():
            pts.append(frame.to2d(p))
    return po.close(pts)


def element_loops(elem, frame):
    """Outline of the element as seen in the view: solids projected along the view normal, as 2D loops."""
    solids = element_solids(elem)
    if frame.depth is not None:
        solids = [c for c in (clip_to_depth(s, frame) for s in solids) if c is not None]
    plane = Plane.CreateByNormalAndOrigin(frame.n, frame.o)
    loops = []
    for solid in union(solids):
        try:
            base = ExtrusionAnalyzer.Create(solid, plane, frame.n).GetExtrusionBase()
            loops.extend(curve_loop_points(cl, frame) for cl in base.GetEdgesAsCurveLoops())
        except Exception:
            # fallback: outlines of the faces that look along the view normal
            for face in solid.Faces:
                if isinstance(face, PlanarFace) and abs(face.FaceNormal.DotProduct(frame.n)) > 0.99:
                    loops.extend(curve_loop_points(cl, frame) for cl in face.GetEdgesAsCurveLoops())
    return [L for L in loops if len(L) >= 4]


# ---------------- DWG ----------------

def dwgs_in_view(view):
    return list(FilteredElementCollector(doc, view.Id).OfClass(ImportInstance))


def dwg_name(dwg):
    t = doc.GetElement(dwg.GetTypeId())
    return ename(t) if t is not None else "DWG"


def dwg_label(dwg):
    return u"{}  [{}]".format(dwg_name(dwg), id_int(dwg.Id))


def layer_name(geo_obj):
    style = doc.GetElement(geo_obj.GraphicsStyleId)
    if isinstance(style, GraphicsStyle) and style.GraphicsStyleCategory is not None:
        return style.GraphicsStyleCategory.Name
    return "(no layer)"


def dwg_pieces(dwg, view, frame):
    """{layer: [2D point lists]} for every curve / polyline of the DWG visible in the view (incl. blocks)."""
    opts = Options()
    opts.View = view
    layers = {}

    def add(layer, pts):
        layers.setdefault(layer, []).append([frame.to2d(p) for p in pts])

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
      <TextBlock x:Name="layers_title" Text="DWG layers to compare with" FontWeight="SemiBold"
                 VerticalAlignment="Center"/>
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
    def __init__(self, view, frame, preselected, view_elements, all_label, dwgs, config):
        forms.WPFWindow.__init__(self, XAML, literal_string=True)
        self.view, self.frame, self.dwgs, self.config, self.result = view, frame, dwgs, config, None
        self.layer_cache = {}
        self.preselected = preselected
        if preselected:
            self.selected_tb.Text = "{} selected element(s) will be checked.".format(len(preselected))
            self.all_rb.Visibility = Visibility.Collapsed
            self.pick_rb.Visibility = Visibility.Collapsed
        else:
            self.selected_tb.Text = "Nothing is selected."
            self.all_rb.Content = "{} ({})".format(all_label, len(view_elements))
            self.all_rb.IsChecked = len(view_elements) > 0
            self.pick_rb.IsChecked = not view_elements
        self.tol_tb.Text = str(cfg_get(config, "tolerance_mm", "{:g}".format(DEFAULT_TOLERANCE_MM)))
        self.markers_cb.IsChecked = cfg_flag(config, "draw_markers")
        self.missing_cb.IsChecked = cfg_flag(config, "report_missing")
        saved = cfg_get(config, "layers_json", "{}")
        try:
            self.saved_layers = saved if isinstance(saved, dict) else json.loads(str(saved))
        except Exception:
            self.saved_layers = {}
        last = str(cfg_get(config, "last_dwg", ""))
        for d in dwgs:
            self.dwg_cb.Items.Add(dwg_label(d))
        names = [dwg_name(d) for d in dwgs]
        self.dwg_cb.SelectedIndex = names.index(last) if last in names else 0

    def current_dwg(self):
        return self.dwgs[self.dwg_cb.SelectedIndex]

    def dwg_changed(self, sender, args):
        self.error_tb.Text = ""
        dwg = self.current_dwg()
        key = id_int(dwg.Id)
        if key not in self.layer_cache:
            self.layer_cache[key] = dwg_pieces(dwg, self.view, self.frame)
        layers = self.layer_cache[key]
        saved = self.saved_layers.get(dwg_name(dwg))
        self.layers_sp.Children.Clear()
        for name in sorted(layers, key=lambda n: n.lower()):
            cb = CheckBox()
            cb.Content = u"{}   ({} curves)".format(name, len(layers[name]))
            cb.Tag = name
            cb.Margin = Thickness(0, 2, 0, 2)
            if saved is not None:
                cb.IsChecked = name in saved
            elif len(layers) == 1:
                cb.IsChecked = True
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
        dwg = self.current_dwg()
        self.saved_layers[dwg_name(dwg)] = layers
        cfg_save(self.config, tolerance_mm=self.tol_tb.Text,
                 draw_markers="1" if self.markers_cb.IsChecked else "0",
                 report_missing="1" if self.missing_cb.IsChecked else "0",
                 layers_json=json.dumps(self.saved_layers), last_dwg=dwg_name(dwg))
        self.result = {"dwg": dwg, "layers": layers, "tol_mm": tol, "pieces": self.layer_cache[id_int(dwg.Id)],
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


def tag_view(view, browser_values):
    p = view.LookupParameter(QAQC_PARAM)
    if p is not None and not p.IsReadOnly:
        p.Set("QAQC")
    for name, val in zip(BROWSER_PARAMS, browser_values):
        p = view.LookupParameter(name)
        if p is not None and not p.IsReadOnly and val is not None:
            p.Set(val)


def make_result_view(source, dwg, browser_values):
    name = RESULT_PREFIX + source.Name
    for v in FilteredElementCollector(doc).OfClass(View):
        if not v.IsTemplate and v.Name == name and v.Id != source.Id:
            doc.Delete(v.Id)            # previous result of this view: replaced
    if browser_values is None:      # same browser folder as the source view
        browser_values = []
        for pname in BROWSER_PARAMS:
            p = source.LookupParameter(pname)
            browser_values.append(p.AsString() if p is not None else None)
    option = ViewDuplicateOption.WithDetailing if dwg.ViewSpecific else ViewDuplicateOption.Duplicate
    view = doc.GetElement(source.Duplicate(option))
    if view.ViewTemplateId != ElementId.InvalidElementId:
        view.ViewTemplateId = ElementId.InvalidElementId
    view.Name = name
    tag_view(view, browser_values)
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
    """Detail lines and text notes in the result view (2D view coordinates in, via the frame)."""
    def __init__(self, view, frame):
        self.view, self.frame = view, frame
        self.offset = None
        self.count = 0
        self.failed = 0
        self.text_type = doc.GetDefaultElementTypeId(ElementTypeGroup.TextNoteType)
        self.styles = {"model": line_style(*MODEL_STYLE), "dwg": line_style(*DWG_STYLE)}

    def line(self, a, b, kind):
        if self.count >= MAX_MARKER_LINES or math.hypot(b[0] - a[0], b[1] - a[1]) < mm(2):
            return
        for off in ([self.offset] if self.offset is not None else self.frame.offsets):
            try:
                crv = Line.CreateBound(self.frame.to3d(a, off), self.frame.to3d(b, off))
                dc = doc.Create.NewDetailCurve(self.view, crv)
                dc.LineStyle = self.styles[kind]
                self.offset = off
                self.count += 1
                return
            except Exception:
                continue
        self.failed += 1

    def polyline(self, pts, kind):
        for a, b in zip(pts[:-1], pts[1:]):
            self.line(a, b, kind)

    def text(self, uv, text):
        try:
            TextNote.Create(doc, self.view.Id, self.frame.to3d(uv, self.offset or 0.0), text, self.text_type)
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


def draw_markers(markers, results, missing, dwg_loops, tol, search):
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
            res["notes"].append("{} closed DWG outlines inside - hatch on this layer? (not drawn)".format(len(inner)))
        wp = worst_point(res)
        if res["status"] == "deviates" and wp is not None and wp[2] > tol:
            markers.text(wp, u"Δ {} mm".format(fmt_mm(wp[2], search)))
    for j in missing:
        markers.polyline(dwg_loops[j], "dwg")
        markers.text(po.centroid(dwg_loops[j]), "no model element")


# ---------------- report ----------------

def report(results, by_id, missing, s, search, rview, markers, n_loops, frame):
    output = script.get_output()
    order = dict((st, i) for i, st in enumerate(po.STATUS_ORDER + ("no geometry",)))
    keys = sorted(results, key=lambda k: (order.get(results[k]["status"], 9), -(results[k]["max"] or 0)))
    m2 = 0.3048 ** 2
    rows = []
    for k in keys:
        r, e = results[k], by_id[k]
        etype = doc.GetElement(e.GetTypeId())
        shift = "-" if r["shift"] is None else "{:.0f} / {:.0f}".format(to_mm(r["shift"][0]), to_mm(r["shift"][1]))
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
                                      "DWG→Model", u"Shift {} / {} (mm)".format(*frame.axis_names),
                                      "Area model / DWG (m²)", "Notes"])


# ---------------- main ----------------

def run_check(kind):
    """kind: "plan" (footprints in a plan) or "section" (outline as seen in a section / elevation)."""
    global doc, uidoc
    doc, uidoc = revit.doc, revit.uidoc      # fresh every run: pyRevit may keep this module loaded
    view = doc.ActiveView
    if kind == "plan":
        if not isinstance(view, ViewPlan) or view.IsTemplate:
            forms.alert("Run this in the plan view where the DWG is visible.", title=TITLE, exitscript=True)
    else:
        if not isinstance(view, ViewSection) or view.IsTemplate or view.ViewType not in SECTION_TYPES:
            forms.alert("Run this in the section where you placed the DWG on the element.", title=TITLE,
                        exitscript=True)
    if view.Name.startswith(RESULT_PREFIX):
        forms.alert("This is a result view. Run the check from the original view.", title=TITLE, exitscript=True)
    dwgs = dwgs_in_view(view)
    if not dwgs:
        forms.alert("No DWG is visible in this view. Insert it (Insert > Import CAD) and place it on the element.",
                    title=TITLE, exitscript=True)
    frame = plan_frame(view) if kind == "plan" else section_frame(view)

    preselected = [doc.GetElement(i) for i in uidoc.Selection.GetElementIds()]
    preselected = [e for e in preselected if is_checkable(e)]
    if kind == "plan":
        view_elements = list(FilteredElementCollector(doc, view.Id).OfCategory(BuiltInCategory.OST_GenericModel)
                             .WhereElementIsNotElementType())
        all_label = "All Generic Models visible in this view"
    else:
        view_elements = [e for e in FilteredElementCollector(doc, view.Id).WhereElementIsNotElementType()
                         if is_checkable(e)]
        all_label = "All model elements visible in this view"

    config = script.get_config()
    win = SettingsWindow(view, frame, preselected, view_elements, all_label, dwgs, config)
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
        elements = view_elements
    if not elements:
        forms.alert("No elements to check.", title=TITLE, exitscript=True)

    tol, step, search = mm(s["tol_mm"]), mm(SAMPLE_STEP_MM), mm(max(SEARCH_MM, 5 * s["tol_mm"]))
    cell, snap = mm(CELL_MM), mm(min(max(1.0, s["tol_mm"] / 2.0), 5.0))
    min_area = MIN_OUTLINE_M2 / (0.3048 ** 2)

    pieces = [p for layer in s["layers"] for p in s["pieces"].get(layer, [])]
    dwg_segments = [seg for p in pieces for seg in po.polyline_segments(p)]
    dwg_loops = po.build_loops(pieces, snap, min_area)

    outlines = []
    with forms.ProgressBar(title="Reading element outlines ({value} of {max_value})", cancellable=True) as pb:
        for i, e in enumerate(elements):
            if pb.cancelled:
                return
            loops = element_loops(e, frame)
            # "all visible" in a section also lists things that only touch the view: keep those with geometry
            if loops or preselected or s["pick"] or kind == "plan":
                outlines.append((id_int(e.Id), loops))
            pb.update_progress(i + 1, len(elements))
    if not outlines:
        forms.alert("None of the elements has geometry in this view.", title=TITLE, exitscript=True)
    results, missing = po.analyse(outlines, dwg_loops, dwg_segments, tol, step, search, cell, min_area,
                                  mm(REGION_MARGIN_MM))
    if not s["missing"]:
        missing = []

    by_id = dict((id_int(e.Id), e) for e in elements)
    checked = [by_id[k] for k, _ in outlines]
    fill_id = solid_fill_id()
    t = Transaction(doc, "QAQC Outline Check")
    t.Start()
    try:
        rview = make_result_view(view, s["dwg"], PLAN_BROWSER_VALUES if kind == "plan" else None)
        doc.Regenerate()
        # a DWG imported "current view only" is copied with the view (new id): keep whatever copy is there
        dwg_ids = [i.Id for i in FilteredElementCollector(doc, rview.Id).OfClass(ImportInstance)
                   if i.GetTypeId() == s["dwg"].GetTypeId()]
        rview.IsolateElementsTemporary(List[ElementId]([e.Id for e in checked] + dwg_ids))
        rview.ConvertTemporaryHideIsolateToPermanent()
        for key, res in results.items():
            rview.SetElementOverrides(by_id[key].Id, overrides(STATUS_COLOR[res["status"]], fill_id))
        markers = None
        if s["markers"]:
            markers = Markers(rview, frame)
            draw_markers(markers, results, missing, dwg_loops, tol, search)
        t.Commit()
    except Exception as ex:
        t.RollBack()
        forms.alert("Could not create the result view:\n{}".format(ex), title=TITLE, exitscript=True)
    uidoc.ActiveView = rview
    report(results, by_id, missing, s, search, rview, markers, len(dwg_loops), frame)
