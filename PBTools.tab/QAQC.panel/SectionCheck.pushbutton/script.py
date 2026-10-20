# -*- coding: utf-8 -*-
__title__ = "Section\nCheck"
__doc__ = """Compare elements with a DWG placed in a section (e.g. a QAQC section).
1. Insert the DWG into the section (Insert > Import CAD) and move it onto the element.
2. Select the elements (or choose all visible ones) and run this.
The element is compared as it is seen in the section (the part between section line and far clip),
both ways against the closed DWG outlines. Result: a copy of the section with coloured elements,
red/magenta markers where they deviate, and a table. Works in Revit 2023 and 2025."""

from pomadaqaqcoutline import run_check

run_check("section")
