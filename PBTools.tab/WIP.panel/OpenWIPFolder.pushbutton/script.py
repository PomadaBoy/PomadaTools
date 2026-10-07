# -*- coding: utf-8 -*-
__title__ = "Open WIP\nFolder"
__doc__ = """Opens the WIP panel folder in Explorer.
Put new scripts here as <Name>.pushbutton folders, then reload pyRevit."""

import os
import subprocess

wip_folder = os.path.dirname(os.path.dirname(__file__))
subprocess.Popen(["explorer", wip_folder])
