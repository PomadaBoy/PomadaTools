# -*- coding: utf-8 -*-
# pyRevit - Override Graphic Settings - Solid Red Fill

__title__   = "Solid\nRed"
__author__  = "Slobodan Vesovic"
__doc__     = "Applies solid red fill override to selected elements."

import clr
clr.AddReference('RevitAPI')
clr.AddReference('RevitAPIUI')

from Autodesk.Revit.DB import (
    OverrideGraphicSettings,
    Color,
    ElementId,
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

TARGET_PATTERN_NAME  = "<Solid fill>"
OVERRIDE_COLOR       = Color(255, 0, 0)   # red

# - HELPER: find FillPattern ElementId by name and type -

def find_fill_pattern_id(name, drafting=False):
    """
    Search all FillPatternElements for a match by name.
    drafting=False  looks for Model patterns  (surfaces)
    drafting=True   looks for Drafting patterns (cut)
    Returns ElementId or None.
    """
    target_type = FillPatternTarget.Drafting if drafting else FillPatternTarget.Model
    patterns = FilteredElementCollector(doc)\
        .OfClass(FillPatternElement)\
        .ToElements()

    for p in patterns:
        fp = p.GetFillPattern()
        if p.Name == name and fp.Target == target_type:
            return p.Id

    # fallback: match by name only if target type match fails
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

pattern_id = find_fill_pattern_id(TARGET_PATTERN_NAME, drafting=False)

if pattern_id is None:
    forms.alert(
        "Could not find fill pattern: '{}'\n"
        "Check the pattern exists in this project.".format(TARGET_PATTERN_NAME),
        exitscript=True
    )

out.print_md("**Pattern found:** `{}` (Id: {})".format(TARGET_PATTERN_NAME, pattern_id))

# - STEP 3: BUILD OverrideGraphicSettings -

ogs = OverrideGraphicSettings()

# Surface Foreground Pattern - Solid fill + Red
ogs.SetSurfaceForegroundPatternId(pattern_id)
ogs.SetSurfaceForegroundPatternColor(OVERRIDE_COLOR)

# Surface Background Pattern - Solid fill + Red
ogs.SetSurfaceBackgroundPatternId(pattern_id)
ogs.SetSurfaceBackgroundPatternColor(OVERRIDE_COLOR)

# - STEP 4: APPLY IN TRANSACTION -

success = []
failed  = []

with Transaction(doc, "pyRevit - Override Graphic Settings") as t:
    t.Start()
    for el in elements:
        try:
            view.SetElementOverrides(el.Id, ogs)
            success.append(el.Id.IntegerValue)
        except Exception as ex:
            failed.append("{} : {}".format(el.Id.IntegerValue, str(ex)))
    t.Commit()

# - STEP 5: REPORT -

out.print_md("## Override Graphic Settings - Results")
out.print_md("**View:** {}".format(view.Name))
out.print_md("**Pattern:** {}".format(TARGET_PATTERN_NAME))
out.print_md("**Color:** R{} G{} B{}".format(
    OVERRIDE_COLOR.Red, OVERRIDE_COLOR.Green, OVERRIDE_COLOR.Blue))
out.print_md("---")
out.print_md("### Success ({})".format(len(success)))
for eid in success:
    out.print_md("- ElementId `{}`".format(eid))

if failed:
    out.print_md("### Failed ({})".format(len(failed)))
    for msg in failed:
        out.print_md("- {}".format(msg))