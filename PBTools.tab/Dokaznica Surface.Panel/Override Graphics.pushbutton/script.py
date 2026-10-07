# -*- coding: utf-8 -*-
# pyRevit - Override Graphic Settings - Transparency Only

__title__   = "Transparency"
__author__  = "Slobodan Vesovic"
__doc__     = "Sets surface transparency on selected elements."

import clr
clr.AddReference('RevitAPI')
clr.AddReference('RevitAPIUI')

from Autodesk.Revit.DB import (
    OverrideGraphicSettings,
    Transaction
)

from pyrevit import forms, output

# - DOCUMENT & VIEW -

uidoc = __revit__.ActiveUIDocument
doc   = uidoc.Document
view  = uidoc.ActiveView
out   = output.get_output()

# - STEP 1: GET SELECTION -

selection_ids = uidoc.Selection.GetElementIds()

if not selection_ids:
    forms.alert(
        "No elements selected.\n"
        "Please select elements in the view before running this script.",
        exitscript=True
    )

elements = [doc.GetElement(eid) for eid in selection_ids]

# - STEP 2: USER INPUT - TRANSPARENCY ONLY -

transp_str = forms.ask_for_string(
    prompt="Surface Transparency (0-100)\nLeave empty to skip:",
    title="Surface Transparency",
    default=""
)

surface_transparency = None
if transp_str and transp_str.strip():
    try:
        surface_transparency = max(0, min(100, int(transp_str.strip())))
    except Exception:
        forms.alert("Invalid transparency value. Must be a number 0-100.", exitscript=True)

if surface_transparency is None:
    forms.alert("No transparency value entered. Exiting.", exitscript=True)

# - STEP 3: BUILD OverrideGraphicSettings -

ogs = OverrideGraphicSettings()
ogs.SetSurfaceTransparency(surface_transparency)

# - STEP 4: APPLY IN TRANSACTION -

success = []
failed  = []

with Transaction(doc, "pyRevit - Override Surface Transparency") as t:
    t.Start()
    for el in elements:
        try:
            view.SetElementOverrides(el.Id, ogs)
            success.append(el.Id.IntegerValue)
        except Exception as ex:
            failed.append("{} : {}".format(el.Id.IntegerValue, str(ex)))
    t.Commit()

# - STEP 5: REPORT -

if failed:
    out.print_md("## ... ERRORS")
    out.print_md("**View:** {}".format(view.Name))
    out.print_md("---")
    out.print_md("### Failed ({} of {} elements)".format(len(failed), len(elements)))
    for msg in failed:
        out.print_md("- {}".format(msg))