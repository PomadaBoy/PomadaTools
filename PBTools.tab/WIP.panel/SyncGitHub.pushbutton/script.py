# -*- coding: utf-8 -*-
__title__ = "Sync\nGitHub"
__doc__ = """Downloads the latest PomadaTools from GitHub and reloads pyRevit.
pyRevit Update first tests internet by connecting to 8.8.8.8:53, which company
networks block. This calls the same git pull directly, without that test."""

import os

from pyrevit import forms, script
from pyrevit.versionmgr import updater
from pyrevit.loader import sessionmgr

output = script.get_output()


def norm(path):
    return os.path.normcase(os.path.normpath(path)).rstrip("\/")


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
if after == before:
    forms.alert("PomadaTools is already up to date ({}).".format(after))
else:
    if forms.alert("Updated {} → {}\nLatest: {}\n\nReload pyRevit now?".format(
            before, after, tip.MessageShort), yes=True, no=True):
        sessionmgr.reload_pyrevit()
