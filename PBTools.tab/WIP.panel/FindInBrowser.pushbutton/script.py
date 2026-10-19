# -*- coding: utf-8 -*-
__title__ = "Find in\nBrowser"
__doc__ = """Click an element in the model - its type is found in the Project Browser
(Families > Category > Family > Type), the folders are expanded and the type is selected there."""

import time

import clr
clr.AddReference("UIAutomationClient")
clr.AddReference("UIAutomationTypes")
clr.AddReference("System.Windows.Forms")
from System.Threading import Thread, ThreadStart
from System.Windows.Automation import (AutomationElement, Condition, ControlType, ExpandCollapsePattern,
                                       ExpandCollapseState, PropertyCondition, ScrollItemPattern,
                                       SelectionItemPattern, TreeScope)
from System.Windows.Forms import Application as WinFormsApp
from System.Collections.Generic import List

from pyrevit import revit, forms, script
from Autodesk.Revit.DB import Element, ElementId, ElementType, FamilySymbol
from Autodesk.Revit.UI import DockablePanes
from Autodesk.Revit.UI.Selection import ObjectType
from Autodesk.Revit.Exceptions import OperationCanceledException

doc = revit.doc
uidoc = revit.uidoc
uiapp = __revit__  # noqa: F821  (provided by pyRevit)
output = script.get_output()

# Name of the "Families" root in the Project Browser (English / German Revit)
FAMILIES_ROOT_NAMES = ("Families", "Familien")
EXPAND_WAIT = 2.0      # seconds to wait for children to appear after expanding a folder
UIA_TIMEOUT = 20.0     # seconds before giving up on the whole browser search


def ename(e):
    try:
        return e.Name
    except Exception:
        return Element.Name.__get__(e)


def browser_path(elem_type):
    """[category, family, type] as shown under Families in the Project Browser."""
    if isinstance(elem_type, FamilySymbol):
        family = elem_type.Family.Name
    else:
        family = elem_type.FamilyName
    category = elem_type.Category.Name if elem_type.Category else None
    return [category, family, ename(elem_type)]


# ---------------- UI Automation on the Project Browser tree ----------------

def children(node):
    return list(node.FindAll(TreeScope.Children, Condition.TrueCondition))


def item_name(node):
    try:
        return (node.Current.Name or "").strip()
    except Exception:
        return ""


def expand(node):
    try:
        pat = node.GetCurrentPattern(ExpandCollapsePattern.Pattern)
        if pat.Current.ExpandCollapseState != ExpandCollapseState.Expanded:
            pat.Expand()
    except Exception:
        pass


def find_child(node, name):
    """Expand node and return its child called name (waits for lazily loaded children)."""
    expand(node)
    deadline = time.time() + EXPAND_WAIT
    kids = []
    while True:
        kids = children(node)
        for k in kids:
            if item_name(k) == name:
                return k, kids
        if time.time() > deadline:
            return None, kids
        time.sleep(0.1)


def find_families_root(main):
    trees = main.FindAll(TreeScope.Descendants, PropertyCondition(AutomationElement.ControlTypeProperty,
                                                                  ControlType.Tree))
    for tree in trees:
        # roots are either the browser folders directly, or one root per open document
        for top in children(tree):
            if item_name(top) in FAMILIES_ROOT_NAMES:
                return top
            for sub in children(top):
                if item_name(sub) in FAMILIES_ROOT_NAMES:
                    return sub
    return None


def select_in_browser(path, result):
    """Runs on a background thread: UI Automation must not run on Revit's UI thread."""
    try:
        main = AutomationElement.FromHandle(uiapp.MainWindowHandle)
        node = find_families_root(main)
        if node is None:
            result["error"] = "Could not find the 'Families' folder in the Project Browser."
            return
        walked = [item_name(node)]
        for name in path:
            child, kids = find_child(node, name)
            if child is None:
                result["error"] = "Could not find '{}' under '{}'.".format(name, " > ".join(walked))
                result["available"] = [item_name(k) for k in kids]
                return
            node = child
            walked.append(name)
        try:
            node.GetCurrentPattern(ScrollItemPattern.Pattern).ScrollIntoView()
        except Exception:
            pass
        node.GetCurrentPattern(SelectionItemPattern.Pattern).Select()
        result["ok"] = True
    except Exception as ex:
        result["error"] = "Project Browser automation failed: {}".format(ex)


def run_with_pump(func, *args):
    """Run func on a background thread while keeping Revit's window messages flowing."""
    t = Thread(ThreadStart(lambda: func(*args)))
    t.IsBackground = True
    t.Start()
    deadline = time.time() + UIA_TIMEOUT
    while t.IsAlive:
        WinFormsApp.DoEvents()
        t.Join(20)
        if time.time() > deadline:
            return False
    return True


# ---------------- main ----------------

def main():
    try:
        ref = uidoc.Selection.PickObject(ObjectType.Element, "Click an element to find its type in the Project Browser")
    except OperationCanceledException:
        return
    elem = doc.GetElement(ref)
    type_id = elem.GetTypeId()
    elem_type = doc.GetElement(type_id) if type_id != ElementId.InvalidElementId else None
    if not isinstance(elem_type, ElementType):
        forms.alert("'{}' has no type, so it is not listed under Families in the Project Browser.".format(
            ename(elem)), exitscript=True)

    path = browser_path(elem_type)
    if path[0] is None:
        forms.alert("The type of this element has no category.", exitscript=True)

    try:
        uiapp.GetDockablePane(DockablePanes.BuiltInDockablePanes.ProjectBrowser).Show()
    except Exception:
        pass

    result = {"ok": False, "error": "", "available": []}
    finished = run_with_pump(select_in_browser, path, result)

    if result["ok"]:
        return
    # fallback: select the type directly - Properties shows it even if the browser could not be driven
    uidoc.Selection.SetElementIds(List[ElementId]([type_id]))
    output.print_md("## Find in Browser")
    output.print_md("**Looking for:** Families > {}".format(" > ".join(path)))
    output.print_md("**Problem:** {}".format(result["error"] if finished else
                                             "Timed out after {:g} s.".format(UIA_TIMEOUT)))
    if result["available"]:
        output.print_md("**Items found at that level:** " + ", ".join(result["available"]))
    output.print_md("The type was selected directly instead - see the Properties palette.")


main()
