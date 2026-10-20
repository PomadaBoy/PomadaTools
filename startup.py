# -*- coding: utf-8 -*-
"""PomadaTools startup: give the PBTools ribbon tab its own KeyTip (press Alt, then B)."""

import clr
clr.AddReference("AdWindows")
clr.AddReference("WindowsBase")
from System import Action
from System.Windows.Threading import Dispatcher, DispatcherPriority
from Autodesk.Windows import ComponentManager

from pyrevit.coreutils.logger import get_logger

TAB_TITLE = "PBTools"
KEYTIP = "B"

logger = get_logger(__name__)


def apply_keytip():
    """Returns True when the tab was found."""
    try:
        tabs = list(ComponentManager.Ribbon.Tabs)
    except Exception:
        return False
    taken = [t.KeyTip for t in tabs if t.Title != TAB_TITLE and t.KeyTip]
    for tab in tabs:
        if tab.Title == TAB_TITLE:
            if KEYTIP in taken:
                logger.warning("KeyTip %s is already used by another tab", KEYTIP)
            tab.KeyTip = KEYTIP
            return True
    return False


# pyRevit runs startup scripts before it builds the ribbon, so also try again once Revit is idle.
if not apply_keytip():
    Dispatcher.CurrentDispatcher.BeginInvoke(DispatcherPriority.ApplicationIdle, Action(apply_keytip))
