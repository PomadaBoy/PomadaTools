# -*- coding: utf-8 -*-
__title__ = "Sync\nGitHub"
__doc__ = """Downloads the latest PomadaTools from GitHub and reloads pyRevit.
pyRevit Update first tests internet by connecting to 8.8.8.8:53, which company
networks block. This calls the same git pull directly, without that test.
It also precompiles changed extensions when another add-in (SOFiSTiK) holds an
older Roslyn in Revit, which would otherwise make the Reload fail."""

import os

from pyrevit import forms, script
from pyrevit.versionmgr import updater
from pyrevit.loader import sessionmgr

import pomadaroslyn

output = script.get_output()


def norm(path):
    return os.path.normcase(os.path.normpath(path)).rstrip("\\/")


ext_dir = norm(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
repo_info = None
for r in updater.get_thirdparty_ext_repos():
    if norm(r.directory) == ext_dir or ext_dir.startswith(norm(r.directory)):
        repo_info = r
        break

if repo_info is None:
    forms.alert("This extension folder is not a git clone:\n{}\n\n"
                "Install it with:\npyrevit extend ui PomadaTools "
                "https://github.com/PomadaBoy/PomadaTools.git --branch=main".format(ext_dir),
                exitscript=True)

before = repo_info.repo.Head.Tip.Sha[:7]
try:
    updated = updater.update_repo(repo_info)
except Exception as ex:
    forms.alert("Could not download from GitHub:\n{}".format(ex), exitscript=True)

tip = updated.repo.Head.Tip
after = tip.Sha[:7]

# When SOFiSTiK has loaded its older Roslyn into Revit, pyRevit can't compile a
# changed extension on Reload. Compile every changed extension (PomadaRebar too)
# here in a private context first; unchanged ones are cache hits. This also runs
# when nothing new was pulled, so a failed Reload is fixed by clicking Sync again.
try:
    built = pomadaroslyn.prebuild_if_needed()
except Exception as ex:
    built = ["Could not precompile extensions: {}".format(ex)]
note = "\n\n" + "\n".join(built) if built else ""

if after == before and not built:
    forms.alert("PomadaTools is already up to date ({}).".format(after))
else:
    if after == before:
        msg = "PomadaTools is already up to date ({}).".format(after)
    else:
        msg = "Updated {} → {}\nLatest: {}".format(before, after, tip.MessageShort)
    if forms.alert(msg + note + "\n\nReload pyRevit now?", yes=True, no=True):
        sessionmgr.reload_pyrevit()
