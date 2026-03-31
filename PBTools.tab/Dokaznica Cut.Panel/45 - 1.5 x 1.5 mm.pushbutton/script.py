# -*- coding: utf-8 -*-
# pyRevit - Override Graphic Settings - Transparency + Cut Foreground Pattern

__title__   = "45-1.5x1.5"
__author__  = "Slobodan Vesovic"
__doc__     = "Sets surface transparency, cut foreground pattern and color on selected elements."

import clr
clr.AddReference('RevitAPI')
clr.AddReference('RevitAPIUI')

from Autodesk.Revit.DB import (
    OverrideGraphicSettings,
    Color,
    Transaction,
    FillPatternElement,
    FilteredElementCollector,
    FillPatternTarget
)

from pyrevit import forms, output

# - DOCUMENT & VIEW -

uidoc = __revit__.ActiveUIDocument
doc   = uidoc.Document
view  = uidoc.ActiveView
out   = output.get_output()

# - HARDCODED SETTINGS -

SURFACE_TRANSPARENCY    = 100
TARGET_PATTERN_NAME     = "45° - 1.5 x 1.5 mm" # u"45Â° - 1.5 mm" using unicode escape
CUT_FG_PATTERN_COLOR    = Color(255, 0, 0)        # red

# - HELPER: find Drafting FillPattern ElementId by name -

def find_fill_pattern_id(name, drafting=True):
    """
    Search all FillPatternElements for a match by name.
    drafting=True   looks for Drafting patterns (cut planes)
    drafting=False  looks for Model patterns    (surfaces)
    Returns ElementId or None.
    """
    target_type = FillPatternTarget.Drafting if drafting else FillPatternTarget.Model
    patterns = FilteredElementCollector(doc)\
        .OfClass(FillPatternElement)\
        .ToElements()

    # first pass - match name AND pattern target type
    for p in patterns:
        fp = p.GetFillPattern()
        if p.Name == name and fp.Target == target_type:
            return p.Id

    # second pass - match name only as fallback
    for p in patterns:
        if p.Name == name:
            return p.Id

    return None

# - STEP 1: GET SELECTION -

selection_ids = uidoc.Selection.GetElementIds()

if not selection_ids:
    forms.alert(
        "No elements selected.\n"
        "Please select elements in the view first.",
        exitscript=True
    )

elements = [doc.GetElement(eid) for eid in selection_ids]

# - STEP 2: FIND PATTERN ID AUTOMATICALLY -
# Cut patterns use FillPatternTarget.Drafting

cut_fg_pattern_id = find_fill_pattern_id(TARGET_PATTERN_NAME, drafting=True)

if cut_fg_pattern_id is None:
    forms.alert(
        "Could not find fill pattern: '{}'\n"
        "Check the exact pattern name in your project.\n\n"
        "Tip: pattern names are case-sensitive.".format(TARGET_PATTERN_NAME),
        exitscript=True
    )

out.print_md("**Pattern found:** `{}` (Id: {})".format(TARGET_PATTERN_NAME, cut_fg_pattern_id))

# - STEP 3: BUILD OverrideGraphicSettings -

ogs = OverrideGraphicSettings()

# Surface Transparency
ogs.SetSurfaceTransparency(SURFACE_TRANSPARENCY)

# Cut Foreground Pattern - 45 degrees 1.5mm + Red
ogs.SetCutForegroundPatternId(cut_fg_pattern_id)
ogs.SetCutForegroundPatternColor(CUT_FG_PATTERN_COLOR)

# - STEP 4: APPLY IN TRANSACTION -

success = []
failed  = []

with Transaction(doc, "pyRevit - Override Cut Pattern Settings") as t:
    t.Start()
    for el in elements:
        try:
            view.SetElementOverrides(el.Id, ogs)
            success.append(el.Id.IntegerValue)
        except Exception as ex:
            failed.append("{} : {}".format(el.Id.IntegerValue, str(ex)))
    t.Commit()

# - STEP 5: REPORT -

out.print_md("## Override Cut Graphic Settings - Results")
out.print_md("**View:** {}".format(view.Name))
out.print_md("**Surface Transparency:** {}%".format(SURFACE_TRANSPARENCY))
out.print_md("**Cut Foreground Pattern:** {}".format(TARGET_PATTERN_NAME))
out.print_md("**Cut Foreground Color:** R{} G{} B{}".format(
    CUT_FG_PATTERN_COLOR.Red,
    CUT_FG_PATTERN_COLOR.Green,
    CUT_FG_PATTERN_COLOR.Blue))
out.print_md("---")
out.print_md("### Success ({})".format(len(success)))
for eid in success:
    out.print_md("- ElementId `{}`".format(eid))

if failed:
    out.print_md("### Failed ({})".format(len(failed)))
    for msg in failed:
        out.print_md("- {}".format(msg))