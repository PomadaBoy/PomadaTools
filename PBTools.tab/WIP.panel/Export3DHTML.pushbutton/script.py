# -*- coding: utf-8 -*-
"""Export the elements visible in a 3D view to one HTML file with a 3D viewer.

The file opens by double-click in any browser, works offline and can be emailed.
Click an element to see its parameters; explode the model and filter it by
properties. Linked models are included; rebar is optional.
The export is read-only: nothing in the model changes.
Revit 2021-2024 use bin/net48, Revit 2025+ bin/net8.0-windows."""

import os
import re
import time
from collections import OrderedDict

import clr
clr.AddReference("System")
import System
from System import Func

from pyrevit import revit, forms, script, DB

doc = revit.doc
TITLE = "Export 3D HTML"
HERE = os.path.dirname(__file__)
CACHE_KEY = "PomadaTools.ThreeExport.Assembly"

OPT_LINKS = "Include linked models"
OPT_TYPES = "Include type parameters"
OPT_REBAR = "Include rebar (large files)"
OPT_OPEN = "Open the file when done"


def load_exporter():
    """Loads RevitThreeExport.dll from its bytes, so the file is never locked and can
    be rebuilt while Revit runs. Reuses the loaded copy until the file changes."""
    version = int(__revit__.Application.VersionNumber)
    tfm = "net8.0-windows" if version >= 2025 else "net48"
    dll = os.path.join(HERE, "bin", tfm, "RevitThreeExport.dll")
    if not os.path.isfile(dll):
        forms.alert("The exporter DLL is missing:\n{}\n\nRun ThreeExport\\build.ps1.".format(dll),
                    title=TITLE, exitscript=True)
    stamp = "{}|{}".format(dll, System.IO.File.GetLastWriteTimeUtc(dll).Ticks)
    cached = System.AppDomain.CurrentDomain.GetData(CACHE_KEY)
    if cached is not None and cached[0] == stamp:
        asm = cached[1]
    else:
        asm = System.Reflection.Assembly.Load(System.IO.File.ReadAllBytes(dll))
        System.AppDomain.CurrentDomain.SetData(CACHE_KEY, System.Array[System.Object]([stamp, asm]))
    # take the types from this exact assembly (clr.AddReference would merge every
    # copy loaded this session into one namespace)
    exporter = clr.GetPythonType(asm.GetType("RevitThreeExport.Exporter", True))
    options = clr.GetPythonType(asm.GetType("RevitThreeExport.ExportOptions", True))
    return exporter, options


def pick_view():
    active = doc.ActiveView
    if isinstance(active, DB.View3D) and not active.IsTemplate:
        return active
    views = [v for v in DB.FilteredElementCollector(doc).OfClass(DB.View3D) if not v.IsTemplate]
    if not views:
        forms.alert("This model has no 3D views.", title=TITLE, exitscript=True)
    by_name = dict((v.Name, v) for v in views)
    name = forms.SelectFromList.show(sorted(by_name), title="Export which 3D view?",
                                     button_name="Use this view", multiselect=False)
    if not name:
        script.exit()
    return by_name[name]


def safe_name(text):
    return re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", text).strip(" .") or "model"


def ask_options(cfg, view):
    switches = OrderedDict([
        (OPT_LINKS, cfg.get_option("links", True)),
        (OPT_TYPES, cfg.get_option("type_params", True)),
        (OPT_REBAR, cfg.get_option("rebar", True)),
        (OPT_OPEN, cfg.get_option("open_file", True)),
    ])
    choice, chosen = forms.CommandSwitchWindow.show(
        ["Export"], switches=switches,
        message='Export the 3D view "{}" to an HTML file:'.format(view.Name))
    if not choice:
        script.exit()
    cfg.links = bool(chosen.get(OPT_LINKS))
    cfg.type_params = bool(chosen.get(OPT_TYPES))
    cfg.rebar = bool(chosen.get(OPT_REBAR))
    cfg.open_file = bool(chosen.get(OPT_OPEN))
    return chosen


def ask_path(cfg, view):
    last_dir = cfg.get_option("last_dir", "")
    if not last_dir or not os.path.isdir(last_dir):
        last_dir = os.path.join(os.path.expanduser("~"), "Desktop")
    default = safe_name(u"{}_{}".format(doc.Title, view.Name)) + ".html"
    path = forms.save_file(file_ext="html", init_dir=last_dir, default_name=default, restore_dir=False)
    if not path:
        script.exit()
    if not path.lower().endswith(".html"):
        path += ".html"
    cfg.last_dir = os.path.dirname(path)
    return path


def size_text(n):
    return "{:.1f} MB".format(n / 1048576.0) if n >= 1048576 else "{:.0f} KB".format(n / 1024.0)


def main():
    view = pick_view()
    cfg = script.get_config()
    chosen = ask_options(cfg, view)
    path = ask_path(cfg, view)
    script.save_config()

    Exporter, ExportOptions = load_exporter()
    opts = ExportOptions()
    opts.OutputPath = path
    opts.IncludeLinks = bool(chosen.get(OPT_LINKS))
    opts.IncludeTypeParameters = bool(chosen.get(OPT_TYPES))
    opts.IncludeRebar = bool(chosen.get(OPT_REBAR))

    started = time.time()
    with forms.ProgressBar(title="Export 3D HTML", cancellable=True) as pb:
        state = {"phase": None}

        def progress(phase, done, total):
            if phase != state["phase"]:
                state["phase"] = phase
                pb.title = phase + u" … {value} of {max_value}" if total > 1 else phase + u" …"
            pb.update_progress(done, max(total, 1))
            return not pb.cancelled

        opts.Progress = Func[str, int, int, bool](progress)
        try:
            result = Exporter.Export(doc, view, opts)
        except Exception as ex:
            forms.alert("The export failed:\n{}".format(ex), title=TITLE, exitscript=True)

    if result.Cancelled:
        forms.alert("Export cancelled. No file was written.", title=TITLE)
        return

    output = script.get_output()
    output.set_title(TITLE)
    # .Keys: looping over a .NET Dictionary itself gives KeyValuePairs in IronPython
    per_category = dict((c, result.PerCategory[c]) for c in result.PerCategory.Keys)
    cats = sorted(per_category, key=lambda c: (-per_category[c], c))
    print(u"Exported 3D view \"{}\" of {}".format(view.Name, doc.Title))
    print(u"File: {}".format(path))
    print(u"{:,} elements, {:,} triangles, {} materials".format(result.Elements, result.Triangles, result.Materials))
    if result.LinkElements:
        print(u"{:,} of the elements are from linked models".format(result.LinkElements))
    if result.SkippedRebar:
        print(u"{:,} reinforcement elements left out".format(result.SkippedRebar))
    print(u", ".join(u"{} {}".format(c, per_category[c]) for c in cats))
    print(u"{} file ({} model), {:.1f} s".format(size_text(result.FileBytes), size_text(result.GlbBytes),
                                                 time.time() - started))
    for w in list(result.Warnings)[:20]:
        print(u"Warning: {}".format(w))
    if result.Elements == 0:
        forms.alert("Nothing was exported: no visible element in the view has 3D geometry.", title=TITLE)
    elif chosen.get(OPT_OPEN):
        start = System.Diagnostics.ProcessStartInfo(path)
        start.UseShellExecute = True   # default browser (needed on .NET 8)
        System.Diagnostics.Process.Start(start)


main()
