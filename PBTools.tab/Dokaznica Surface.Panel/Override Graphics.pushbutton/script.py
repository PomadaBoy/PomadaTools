# -*- coding: utf-8 -*-
# pyRevit - Override Graphic Settings

__title__   = "Override\nGraphics"
__author__  = "Slobodan Vesovic"
__doc__     = "Override graphic settings for selected elements in the active view."

import clr
clr.AddReference('RevitAPI')
clr.AddReference('RevitAPIUI')

from Autodesk.Revit.DB import (
    OverrideGraphicSettings,
    Color,
    ElementId,
    Transaction,
    FillPatternElement,
    LinePatternElement,
    FilteredElementCollector,
    View
)

from pyrevit import forms, output, script

# - DOCUMENT & VIEW -

app   = __revit__.Application
uidoc = __revit__.ActiveUIDocument
doc   = uidoc.Document
view  = uidoc.ActiveView

out = output.get_output()

# - HELPER: [R, G, B] → Revit Color -

def parse_color(text):
    """
    Parse a string 'R,G,B' into Autodesk.Revit.DB.Color.
    Returns None if empty or invalid.
    """
    text = text.strip()
    if not text:
        return None
    try:
        parts = [int(x.strip()) for x in text.split(",")]
        if len(parts) != 3:
            raise ValueError
        r = max(0, min(255, parts[0]))
        g = max(0, min(255, parts[1]))
        b = max(0, min(255, parts[2]))
        return Color(r, g, b)
    except Exception:
        forms.alert(
            "Invalid color value: '{}'\n"
            "Use format: R,G,B  (e.g. 255,0,0)".format(text),
            exitscript=True
        )

# - HELPER: get all FillPatterns as {name: element} -

def get_fill_patterns():
    patterns = FilteredElementCollector(doc)\
        .OfClass(FillPatternElement)\
        .ToElements()
    return {p.Name: p for p in sorted(patterns, key=lambda x: x.Name)}

# - HELPER: get all LinePatterns as {name: element} -

def get_line_patterns():
    patterns = FilteredElementCollector(doc)\
        .OfClass(LinePatternElement)\
        .ToElements()
    result = {"< Solid >": None}   # solid line has no LinePatternElement
    result.update({p.Name: p for p in sorted(patterns, key=lambda x: x.Name)})
    return result

# - HELPER: element Id from pattern element -

def to_element_id(pattern_element):
    """Returns ElementId from a pattern element, or None if not selected."""
    if pattern_element is None:
        return None
    if isinstance(pattern_element, ElementId):
        return pattern_element          # already an ElementId, return as-is
    if hasattr(pattern_element, 'Id'):
        return pattern_element.Id       # in pyRevit .Id is already ElementId, no wrapping needed
    return None

# - STEP 1: GET SELECTION -

selection_ids = uidoc.Selection.GetElementIds()

if not selection_ids:
    forms.alert(
        "No elements selected.\n"
        "Please select elements in the view before running this script.",
        exitscript=True
    )

elements = [doc.GetElement(eid) for eid in selection_ids]

# - STEP 2: COLLECT PATTERN OPTIONS -

fill_patterns = get_fill_patterns()
line_patterns = get_line_patterns()

fill_options = ["< None (skip) >"] + list(fill_patterns.keys())
line_options = list(line_patterns.keys())

# - STEP 3: BUILD FORM -

class OverrideForm(forms.WPFWindow):
    def __init__(self):
        forms.WPFWindow.__init__(self, "OverrideGraphicsForm.xaml")

# Since we use the built-in CommandSwitchWindow for simplicity,
# we use a series of pyRevit ask dialogs instead:

# -- STEP 4: USER INPUT VIA FORMS 

# -- 4a. Surface Transparency 
transp_str = forms.ask_for_string(
    prompt="Surface Transparency (0–100)\nLeave empty to skip:",
    title="Surface Transparency",
    default=""
)
surface_transparency = None
if transp_str and transp_str.strip():
    try:
        surface_transparency = max(0, min(100, int(transp_str.strip())))
    except Exception:
        forms.alert("Invalid transparency value. Skipping.", warn_icon=True)

# -- 4b. Cut Background Pattern
cut_bg_pat_name = forms.SelectFromList.show(
    fill_options,
    title="Cut Background Pattern Id",
    multiselect=False
)
cut_bg_pat_id = None
if cut_bg_pat_name and cut_bg_pat_name != "< None (skip) >":
    cut_bg_pat_id = to_element_id(fill_patterns.get(cut_bg_pat_name))

cut_bg_color_str = forms.ask_for_string(
    prompt="Cut Background Pattern Color (R,G,B)\nLeave empty to skip:",
    title="Cut Background Pattern Color",
    default=""
)
cut_bg_pat_color = parse_color(cut_bg_color_str) if cut_bg_color_str else None

# -- 4c. Cut Foreground Pattern 
cut_fg_pat_name = forms.SelectFromList.show(
    fill_options,
    title="Cut Foreground Pattern Id",
    multiselect=False
)
cut_fg_pat_id = None
if cut_fg_pat_name and cut_fg_pat_name != "< None (skip) >":
    cut_fg_pat_id = to_element_id(fill_patterns.get(cut_fg_pat_name))

cut_fg_color_str = forms.ask_for_string(
    prompt="Cut Foreground Pattern Color (R,G,B)\nLeave empty to skip:",
    title="Cut Foreground Pattern Color",
    default=""
)
cut_fg_pat_color = parse_color(cut_fg_color_str) if cut_fg_color_str else None

# -- 4d. Cut Line Pattern & Color 
cut_line_pat_name = forms.SelectFromList.show(
    line_options,
    title="Cut Line Pattern Id",
    multiselect=False
)
cut_line_pat_id = None
if cut_line_pat_name and cut_line_pat_name != "< Solid >":
    cut_line_pat_id = to_element_id(line_patterns.get(cut_line_pat_name))

cut_line_color_str = forms.ask_for_string(
    prompt="Cut Line Color (R,G,B)\nLeave empty to skip:",
    title="Cut Line Color",
    default=""
)
cut_line_color = parse_color(cut_line_color_str) if cut_line_color_str else None

# -- 4e. Surface Foreground Pattern 
surf_fg_pat_name = forms.SelectFromList.show(
    fill_options,
    title="Surface Foreground Pattern Id",
    multiselect=False
)
surf_fg_pat_id = None
if surf_fg_pat_name and surf_fg_pat_name != "< None (skip) >":
    surf_fg_pat_id = to_element_id(fill_patterns.get(surf_fg_pat_name))

surf_fg_color_str = forms.ask_for_string(
    prompt="Surface Foreground Pattern Color (R,G,B)\nLeave empty to skip:",
    title="Surface Foreground Pattern Color",
    default=""
)
surf_fg_pat_color = parse_color(surf_fg_color_str) if surf_fg_color_str else None

# -- 4f. Surface Background Pattern 
surf_bg_pat_name = forms.SelectFromList.show(
    fill_options,
    title="Surface Background Pattern Id",
    multiselect=False
)
surf_bg_pat_id = None
if surf_bg_pat_name and surf_bg_pat_name != "< None (skip) >":
    surf_bg_pat_id = to_element_id(fill_patterns.get(surf_bg_pat_name))

surf_bg_color_str = forms.ask_for_string(
    prompt="Surface Background Pattern Color (R,G,B)\nLeave empty to skip:",
    title="Surface Background Pattern Color",
    default=""
)
surf_bg_pat_color = parse_color(surf_bg_color_str) if surf_bg_color_str else None

# -- STEP 5: BUILD OverrideGraphicSettings 

ogs = OverrideGraphicSettings()

if surface_transparency is not None:
    ogs.SetSurfaceTransparency(surface_transparency)

if cut_bg_pat_id is not None:
    ogs.SetCutBackgroundPatternId(cut_bg_pat_id)
if cut_bg_pat_color is not None:
    ogs.SetCutBackgroundPatternColor(cut_bg_pat_color)

if cut_fg_pat_id is not None:
    ogs.SetCutForegroundPatternId(cut_fg_pat_id)
if cut_fg_pat_color is not None:
    ogs.SetCutForegroundPatternColor(cut_fg_pat_color)

if cut_line_pat_id is not None:
    ogs.SetCutLinePatternId(cut_line_pat_id)
if cut_line_color is not None:
    ogs.SetCutLineColor(cut_line_color)

if surf_fg_pat_id is not None:
    ogs.SetSurfaceForegroundPatternId(surf_fg_pat_id)
if surf_fg_pat_color is not None:
    ogs.SetSurfaceForegroundPatternColor(surf_fg_pat_color)

if surf_bg_pat_id is not None:
    ogs.SetSurfaceBackgroundPatternId(surf_bg_pat_id)
if surf_bg_pat_color is not None:
    ogs.SetSurfaceBackgroundPatternColor(surf_bg_pat_color)

# -- STEP 6: APPLY IN TRANSACTION 

success = []
failed  = []

with Transaction(doc, "pyRevit — Override Graphic Settings") as t:
    t.Start()
    for el in elements:
        try:
            el_id = ElementId(el.Id.IntegerValue)
            view.SetElementOverrides(el_id, ogs)
            success.append(el_id.IntegerValue)
        except Exception as ex:
            failed.append("{} : {}".format(el.Id.IntegerValue, str(ex)))
    t.Commit()

# -- STEP 7: REPORT 

out.print_md("## Override Graphic Settings — Results")
out.print_md("**View:** {}".format(view.Name))
out.print_md("---")
out.print_md("### ✅ Success ({})".format(len(success)))
for eid in success:
    out.print_md("- ElementId `{}`".format(eid))

if failed:
    out.print_md("### ❌ Failed ({})".format(len(failed)))
    for msg in failed:
        out.print_md("- {}".format(msg))