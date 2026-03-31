# -*- coding: utf-8 -*-
# pyRevit - Override Graphic Settings - Transparency + Cut Foreground Color

__title__   = "CutRed"
__author__  = "Slobodan Vesovic"
__doc__     = "Sets surface transparency and cut foreground color on selected elements."

import clr
clr.AddReference('RevitAPI')
clr.AddReference('RevitAPIUI')

from Autodesk.Revit.DB import (
    OverrideGraphicSettings,
    Color,
    Transaction
)

from pyrevit import forms, output

# - DOCUMENT & VIEW -

uidoc = __revit__.ActiveUIDocument
doc   = uidoc.Document
view  = uidoc.ActiveView
out   = output.get_output()

# - HARDCODED SETTINGS -

SURFACE_TRANSPARENCY    = 100             # 0 = opaque, 100 = fully transparent
CUT_FG_PATTERN_COLOR    = Color(255, 0, 0)  # red

# - STEP 1: GET SELECTION -

selection_ids = uidoc.Selection.GetElementIds()

if not selection_ids:
    forms.alert(
        "No elements selected.\n"
        "Please select elements in the view first.",
        exitscript=True
    )

elements = [doc.GetElement(eid) for eid in selection_ids]

# - STEP 2: BUILD OverrideGraphicSettings -

ogs = OverrideGraphicSettings()

# Surface Transparency
ogs.SetSurfaceTransparency(SURFACE_TRANSPARENCY)

# Cut Foreground Pattern Color only - no pattern Id needed to override color
ogs.SetCutForegroundPatternColor(CUT_FG_PATTERN_COLOR)

# - STEP 3: APPLY IN TRANSACTION -

success = []
failed  = []

with Transaction(doc, "pyRevit - Override Transparency and Cut Color") as t:
    t.Start()
    for el in elements:
        try:
            view.SetElementOverrides(el.Id, ogs)
            success.append(el.Id.IntegerValue)
        except Exception as ex:
            failed.append("{} : {}".format(el.Id.IntegerValue, str(ex)))
    t.Commit()

# - STEP 4: REPORT -

out.print_md("## Override Graphic Settings - Results")
out.print_md("**View:** {}".format(view.Name))
out.print_md("**Surface Transparency:** {}%".format(SURFACE_TRANSPARENCY))
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