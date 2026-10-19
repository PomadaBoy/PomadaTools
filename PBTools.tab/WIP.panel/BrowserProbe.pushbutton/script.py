# -*- coding: utf-8 -*-
__title__ = "Browser\nProbe"
__doc__ = """Temporary diagnostic for Find in Browser: after OK, hover the mouse over a family name
in the Project Browser for 3 seconds. Reports what Windows sees under the cursor."""

import ctypes
import time
from ctypes import wintypes

import clr
clr.AddReference("UIAutomationClient")
clr.AddReference("UIAutomationTypes")
clr.AddReference("System.Windows.Forms")
clr.AddReference("WindowsBase")
from System.Threading import Thread, ThreadStart
from System.Windows import Point
from System.Windows.Automation import AutomationElement, TreeWalker
from System.Windows.Forms import Application as WinFormsApp

from pyrevit import forms, script

output = script.get_output()
user32 = ctypes.windll.user32
user32.WindowFromPoint.restype = ctypes.c_void_p
user32.GetParent.restype = ctypes.c_void_p
user32.GetAncestor.restype = ctypes.c_void_p

WAIT_SECONDS = 3


def class_name(hwnd):
    buf = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(ctypes.c_void_p(hwnd), buf, 256)
    return buf.value


def window_text(hwnd):
    buf = ctypes.create_unicode_buffer(256)
    user32.GetWindowTextW(ctypes.c_void_p(hwnd), buf, 256)
    return buf.value


def pump(seconds):
    end = time.time() + seconds
    while time.time() < end:
        WinFormsApp.DoEvents()
        time.sleep(0.02)


forms.alert("After you press OK, move the mouse over a family name in the Project Browser "
            "and keep it still for {} seconds.".format(WAIT_SECONDS))
pump(WAIT_SECONDS)

pt = wintypes.POINT()
user32.GetCursorPos(ctypes.byref(pt))
hwnd = user32.WindowFromPoint(pt)

output.print_md("## Browser Probe")
output.print_md("**Cursor:** {}, {}".format(pt.x, pt.y))
output.print_md("### Win32 window under cursor and its parents")
h, depth = hwnd, 0
while h and depth < 8:
    output.print_md("- `{}`  text: `{}`".format(class_name(h), window_text(h)))
    h = user32.GetParent(ctypes.c_void_p(h))
    depth += 1

# UI Automation must not run on Revit's UI thread: run it on a worker while pumping messages
lines = []


def uia_probe():
    try:
        el = AutomationElement.FromPoint(Point(pt.x, pt.y))
        walker = TreeWalker.ControlViewWalker
        node, depth = el, 0
        while node is not None and depth < 8:
            c = node.Current
            pats = ", ".join(p.ProgrammaticName.replace("PatternIdentifiers.Pattern", "")
                             for p in node.GetSupportedPatterns())
            lines.append("{} | name: `{}` | class: `{}` | framework: `{}` | patterns: {}".format(
                c.ControlType.ProgrammaticName.replace("ControlType.", ""), c.Name, c.ClassName,
                c.FrameworkId, pats or "-"))
            node = walker.GetParent(node)
            depth += 1
        # siblings of the hovered item, to see how rows are exposed
        parent = walker.GetParent(el)
        if parent is not None:
            sib, n = walker.GetFirstChild(parent), 0
            while sib is not None and n < 8:
                lines.append("sibling: {} `{}`".format(
                    sib.Current.ControlType.ProgrammaticName.replace("ControlType.", ""), sib.Current.Name))
                sib = walker.GetNextSibling(sib)
                n += 1
    except Exception as ex:
        lines.append("UI Automation error: {}".format(ex))


t = Thread(ThreadStart(uia_probe))
t.IsBackground = True
t.Start()
deadline = time.time() + 15
while t.IsAlive and time.time() < deadline:
    WinFormsApp.DoEvents()
    t.Join(20)
if t.IsAlive:
    lines.append("UI Automation timed out")

output.print_md("### UI Automation element under cursor and its parents")
for line in lines:
    output.print_md("- " + line)
output.print_md("*Please send a photo of this window.*")
