# -*- coding: utf-8 -*-
__title__ = "Outline\nCheck"
__doc__ = """Compare the plan outline (footprint) of model elements, e.g. Generic Model extrusions, with a DWG.
Run it in the plan where the DWG is visible. Closed DWG outlines are found automatically and every element
is compared both ways (element -> DWG and DWG -> element). Result: a QAQC plan with the elements coloured,
red/magenta markers where they deviate, DWG outlines without an element, and a table.
Works in Revit 2023 and 2025."""

from pomadaqaqcoutline import run_check

run_check("plan")
