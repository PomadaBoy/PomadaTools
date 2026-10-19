# -*- coding: utf-8 -*-
__title__ = "Find in\nBrowser"
__doc__ = """Click an element in the model - its type is found in the Project Browser
(Families > Category > Family > Type), the folders are expanded and the type is selected there.
Works in Revit 2023 and 2025."""

import ctypes
from ctypes import wintypes

import clr
clr.AddReference("System")
clr.AddReference("PresentationCore")
clr.AddReference("PresentationFramework")
clr.AddReference("WindowsBase")
from System.Collections.Generic import List
from System.Diagnostics import Process
from System.Reflection import BindingFlags
from System.Windows import PresentationSource
from System.Windows.Controls import TextBlock, TreeView, TreeViewItem, VirtualizingStackPanel
from System.Windows.Media import VisualTreeHelper

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

# ---------------- Win32 tree view (the Project Browser is a standard SysTreeView32) ----------------

user32 = ctypes.windll.user32
user32.SendMessageW.restype = ctypes.c_void_p
user32.FindWindowExW.restype = ctypes.c_void_p

TVM_EXPAND = 0x1102
TVM_GETNEXTITEM = 0x110A
TVM_SELECTITEM = 0x110B
TVM_ENSUREVISIBLE = 0x1114
TVM_GETITEMW = 0x113E
TVGN_ROOT, TVGN_NEXT, TVGN_CHILD, TVGN_CARET = 0x0, 0x1, 0x4, 0x9
TVE_EXPAND = 0x2
TVIF_TEXT, TVIF_HANDLE = 0x1, 0x10
WM_KEYDOWN, VK_RIGHT = 0x0100, 0x27


class TVITEMW(ctypes.Structure):
    _fields_ = [("mask", wintypes.UINT), ("hItem", ctypes.c_void_p), ("state", wintypes.UINT),
                ("stateMask", wintypes.UINT), ("pszText", ctypes.c_wchar_p), ("cchTextMax", ctypes.c_int),
                ("iImage", ctypes.c_int), ("iSelectedImage", ctypes.c_int), ("cChildren", ctypes.c_int),
                ("lParam", ctypes.c_void_p)]


def send(hwnd, msg, wparam, lparam):
    return user32.SendMessageW(ctypes.c_void_p(hwnd), wintypes.UINT(msg),
                               ctypes.c_size_t(wparam), lparam)


def tv_next(tree, item, flag):
    return send(tree, TVM_GETNEXTITEM, flag, ctypes.c_void_p(item or 0))


def tv_children(tree, item):
    kids = []
    child = tv_next(tree, item, TVGN_CHILD) if item else tv_next(tree, None, TVGN_ROOT)
    while child:
        kids.append(child)
        child = tv_next(tree, child, TVGN_NEXT)
    return kids


def tv_text(tree, item):
    buf = ctypes.create_unicode_buffer(512)
    tvi = TVITEMW()
    tvi.mask = TVIF_TEXT | TVIF_HANDLE
    tvi.hItem = item
    tvi.pszText = ctypes.cast(buf, ctypes.c_wchar_p)
    tvi.cchTextMax = 512
    send(tree, TVM_GETITEMW, 0, ctypes.byref(tvi))
    # Revit may answer with a pointer to its own text instead of filling our buffer
    return (tvi.pszText or buf.value or "").strip()


def tv_select(tree, item):
    send(tree, TVM_SELECTITEM, TVGN_CARET, ctypes.c_void_p(item))


def tv_expand(tree, item):
    """Expand a folder. TVM_EXPAND does not tell Revit, so if the folder is still empty
    afterwards (filled on demand), select it and press Right arrow like a user would."""
    send(tree, TVM_EXPAND, TVE_EXPAND, ctypes.c_void_p(item))
    if not tv_next(tree, item, TVGN_CHILD):
        tv_select(tree, item)
        send(tree, WM_KEYDOWN, VK_RIGHT, ctypes.c_void_p(0))


def class_name(hwnd):
    buf = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(ctypes.c_void_p(hwnd), buf, 256)
    return buf.value


def child_windows(parent):
    kids, after = [], None
    while True:
        after = user32.FindWindowExW(ctypes.c_void_p(parent or 0), ctypes.c_void_p(after or 0), None, None)
        if not after:
            return kids
        kids.append(after)


def revit_windows():
    """Main window plus every other top-level window of this Revit process (floating panes)."""
    pid = Process.GetCurrentProcess().Id
    tops = [int(uiapp.MainWindowHandle.ToInt64())]
    for h in child_windows(None):
        owner = wintypes.DWORD()
        user32.GetWindowThreadProcessId(ctypes.c_void_p(h), ctypes.byref(owner))
        if owner.value == pid and h not in tops:
            tops.append(h)
    return tops


def find_tree_views(diag):
    trees, todo, seen, tree_like = [], revit_windows(), set(), set()
    while todo:
        h = todo.pop()
        if h in seen:
            continue
        seen.add(h)
        cls = class_name(h)
        if cls == "SysTreeView32":
            trees.append(h)
        elif "tree" in cls.lower():
            tree_like.add(cls)
        todo.extend(child_windows(h))
    diag.append("Win32 windows searched: {}".format(len(seen)))
    if tree_like:
        diag.append("Other tree-like window classes: " + ", ".join(sorted(tree_like)))
    return trees


def find_families_root(trees, diag):
    for tree in trees:
        roots = tv_children(tree, None)
        names = [tv_text(tree, r) for r in roots]
        diag.append(names[:10])
        for r, n in zip(roots, names):
            if n in FAMILIES_ROOT_NAMES:
                return tree, r
        for r in roots:                 # one root per document in some setups
            for c in tv_children(tree, r):
                if tv_text(tree, c) in FAMILIES_ROOT_NAMES:
                    return tree, c
    return None, None


def select_in_win32_tree(path, diag):
    """Returns (ok, error text, names available where the search stopped)."""
    trees = find_tree_views(diag)
    diag.append("Win32 tree controls: {}".format(len(trees)))
    if not trees:
        return False, "No Win32 tree control found.", []
    roots = []
    tree, node = find_families_root(trees, roots)
    for names in roots:
        diag.append("Win32 tree top items: " + (", ".join(names) or "(empty)"))
    if node is None:
        return False, "Could not find the 'Families' folder in the Win32 tree.", []
    walked = [tv_text(tree, node)]
    for name in path:
        tv_expand(tree, node)
        kids = tv_children(tree, node)
        match = [k for k in kids if tv_text(tree, k) == name]
        if not match:
            return False, "Could not find '{}' under '{}'.".format(name, " > ".join(walked)), \
                [tv_text(tree, k) for k in kids]
        node = match[0]
        walked.append(name)
    user32.SetFocus(ctypes.c_void_p(tree))
    tv_select(tree, node)
    send(tree, TVM_ENSUREVISIBLE, 0, ctypes.c_void_p(node))
    return True, "", []


# ---------------- WPF tree view (Project Browser drawn by WPF, reached directly in-process) ----------------

ANY_MEMBER = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance
TEXT_PROPERTIES = ("Name", "Text", "Header", "DisplayName", "Title", "Label", "Caption")


def visual_children(v):
    try:
        return [VisualTreeHelper.GetChild(v, i) for i in range(VisualTreeHelper.GetChildrenCount(v))]
    except Exception:
        return []


def wpf_roots():
    roots = []
    for src in PresentationSource.CurrentSources:
        try:
            if src.RootVisual is not None:
                roots.append(src.RootVisual)
        except Exception:
            pass
    return roots


def find_wpf_trees(diag):
    trees, tree_like = [], set()
    todo = wpf_roots()
    diag.append("WPF windows: {}".format(len(todo)))
    while todo:
        v = todo.pop()
        if isinstance(v, TreeView):
            trees.append(v)
        else:
            tname = v.GetType().Name
            if "tree" in tname.lower():
                tree_like.add(v.GetType().FullName)
        todo.extend(visual_children(v))
    diag.append("WPF TreeViews: {}".format(len(trees)))
    if tree_like:
        diag.append("Other tree-like WPF controls: " + ", ".join(sorted(tree_like)))
    return trees


def header_text(tvi):
    """First TextBlock text in the item's own header (not in its children)."""
    start = None
    try:
        start = tvi.Template.FindName("PART_Header", tvi)
    except Exception:
        pass
    todo = [start or tvi]
    while todo:
        v = todo.pop(0)
        if isinstance(v, TextBlock) and (v.Text or "").strip():
            return v.Text.strip()
        for c in visual_children(v):
            if not isinstance(c, TreeViewItem):
                todo.append(c)
    return ""


def data_text(item):
    """Text of a data item behind a tree row, read from common property names."""
    if isinstance(item, str):
        return item.strip()
    for prop_name in TEXT_PROPERTIES:
        try:
            prop = item.GetType().GetProperty(prop_name, ANY_MEMBER)
            if prop is not None:
                val = prop.GetValue(item, None)
                if val is not None and str(val).strip():
                    return str(val).strip()
        except Exception:
            pass
    try:
        return str(item).strip()
    except Exception:
        return ""


def wpf_items(parent):
    """[(text, container or None, index)] for the rows directly under a TreeView/TreeViewItem."""
    rows = []
    gen = parent.ItemContainerGenerator
    for i in range(parent.Items.Count):
        item = parent.Items[i]
        cont = item if isinstance(item, TreeViewItem) else gen.ContainerFromIndex(i)
        text = header_text(cont) if cont is not None else ""
        rows.append((text or data_text(item), cont, i))
    return rows


def wpf_container(parent, index):
    """Container for a row that is virtualized (not built yet): scroll it into existence."""
    cont = parent.ItemContainerGenerator.ContainerFromIndex(index)
    if cont is not None:
        return cont
    parent.UpdateLayout()
    todo = visual_children(parent)
    while todo:
        v = todo.pop(0)
        if isinstance(v, VirtualizingStackPanel):
            try:
                v.BringIndexIntoViewPublic(index)
            except Exception:
                pass
            break
        if not isinstance(v, TreeViewItem):
            todo.extend(visual_children(v))
    parent.UpdateLayout()
    return parent.ItemContainerGenerator.ContainerFromIndex(index)


def wpf_child(parent, name):
    if isinstance(parent, TreeViewItem) and not parent.IsExpanded:
        parent.IsExpanded = True
    parent.UpdateLayout()
    rows = wpf_items(parent)
    for text, cont, i in rows:
        if text == name:
            return cont or wpf_container(parent, i), rows
    return None, rows


def select_in_wpf_tree(path, diag):
    trees = find_wpf_trees(diag)
    if not trees:
        return False, "No WPF TreeView found.", []
    node = None
    for tree in trees:
        tops = wpf_items(tree)
        diag.append("WPF tree top items: " + (", ".join(t for t, _, _ in tops[:10]) or "(empty)"))
        for root_name in FAMILIES_ROOT_NAMES:
            node, _ = wpf_child(tree, root_name)
            if node is not None:
                break
        if node is None:                  # one root per document in some setups
            for _, cont, i in tops:
                cont = cont or wpf_container(tree, i)
                if cont is None:
                    continue
                for root_name in FAMILIES_ROOT_NAMES:
                    node, _ = wpf_child(cont, root_name)
                    if node is not None:
                        break
                if node is not None:
                    break
        if node is not None:
            break
    if node is None:
        return False, "Could not find the 'Families' folder in the WPF tree.", []
    walked = [header_text(node) or "Families"]
    for name in path:
        child, rows = wpf_child(node, name)
        if child is None:
            return False, "Could not find '{}' under '{}'.".format(name, " > ".join(walked)), \
                [t for t, _, _ in rows]
        node = child
        walked.append(name)
    node.IsSelected = True
    node.BringIntoView()
    node.Focus()
    return True, "", []


def select_in_browser(path):
    """Try the WPF tree first, then a classic Win32 tree. Returns (ok, error, available, diagnostics)."""
    diag = []
    errors = []
    available = []
    for method in (select_in_wpf_tree, select_in_win32_tree):
        try:
            ok, error, avail = method(path, diag)
        except Exception as ex:
            ok, error, avail = False, "{} failed: {}".format(method.__name__, ex), []
        if ok:
            return True, "", [], diag
        errors.append(error)
        available = available or avail
    return False, " / ".join(errors), available, diag


# ---------------- main ----------------

def ename(e):
    try:
        return e.Name
    except Exception:
        return Element.Name.__get__(e)


def browser_path(elem_type):
    """[category, family, type] as shown under Families in the Project Browser."""
    family = elem_type.Family.Name if isinstance(elem_type, FamilySymbol) else elem_type.FamilyName
    category = elem_type.Category.Name if elem_type.Category else None
    return [category, family, ename(elem_type)]


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

    try:
        ok, error, available, diag = select_in_browser(path)
    except Exception as ex:
        ok, error, available, diag = False, "Project Browser search failed: {}".format(ex), [], []
    if ok:
        return

    # fallback: select the type directly - Properties shows it even if the browser could not be driven
    uidoc.Selection.SetElementIds(List[ElementId]([type_id]))
    output.print_md("## Find in Browser")
    output.print_md("**Looking for:** Families > {}".format(" > ".join(path)))
    output.print_md("**Problem:** {}".format(error))
    if available:
        output.print_md("**Items found at that level:** " + ", ".join(available))
    output.print_md("**Diagnostics:**")
    for line in diag:
        output.print_md("- " + line)
    output.print_md("The type was selected directly instead - see the Properties palette.")


main()
