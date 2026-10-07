# -*- coding: utf-8 -*-
__title__ = "Test"
__doc__ = """Shows a message to confirm that GitHub updates reach Revit."""

from pyrevit import forms

forms.alert("it works!", title="Test")
