# -*- coding: utf-8 -*-
__title__ = "Rename Line Styles"
__doc__ = """Lists all line styles, then renames the ones you specify.
Enter old names (one per line) and new names (same order).
Revit API cannot rename a line style, so each one is recreated under the new
name (same weight, color, pattern), all lines are moved to it, and the old style is deleted."""

import clr
clr.AddReference("System.Windows.Forms")
clr.AddReference("System.Drawing")
import System.Windows.Forms as WF
import System.Drawing as SD
from collections import defaultdict

from pyrevit import revit, forms, script
from Autodesk.Revit.DB import (BuiltInCategory, GraphicsStyleType, FilteredElementCollector,
                               CurveElement, Transaction, SubTransaction, ElementId)

doc = revit.doc
output = script.get_output()
PROJ = GraphicsStyleType.Projection
SOLID_ID = -3000010


def lines_category():
    return doc.Settings.Categories.get_Item(BuiltInCategory.OST_Lines)


def pattern_name(sub):
    pid = sub.GetLinePatternId(PROJ)
    if pid == ElementId.InvalidElementId:
        return "-"
    if pid.IntegerValue == SOLID_ID:
        return "Solid"
    el = doc.GetElement(pid)
    return el.Name if el else "?"


def color_text(sub):
    c = sub.LineColor
    return "{},{},{}".format(c.Red, c.Green, c.Blue) if c and c.IsValid else "-"


def usage_counts():
    counts = defaultdict(int)
    for ce in FilteredElementCollector(doc).OfClass(CurveElement):
        try:
            counts[ce.LineStyle.Id.IntegerValue] += 1
        except Exception:
            pass
    return counts


def print_list():
    counts = usage_counts()
    rows = []
    for sub in sorted(lines_category().SubCategories, key=lambda s: s.Name.lower()):
        gs = sub.GetGraphicsStyle(PROJ)
        rows.append([sub.Name, sub.GetLineWeight(PROJ), color_text(sub), pattern_name(sub),
                     counts.get(gs.Id.IntegerValue, 0)])
    output.print_md("## Line styles ({})".format(len(rows)))
    output.print_table(table_data=rows, columns=["Name", "Weight", "RGB", "Pattern", "Lines using it"])


def ask_lists():
    form = WF.Form()
    form.Text = "Rename Line Styles"
    form.Width, form.Height = 760, 520
    form.StartPosition = WF.FormStartPosition.CenterScreen

    def box(x, label):
        lbl = WF.Label()
        lbl.Text = label
        lbl.Left, lbl.Top, lbl.Width = x, 10, 340
        tb = WF.TextBox()
        tb.Multiline = True
        tb.AcceptsReturn = True
        tb.WordWrap = False
        tb.ScrollBars = WF.ScrollBars.Both
        tb.Left, tb.Top, tb.Width, tb.Height = x, 32, 350, 380
        form.Controls.Add(lbl)
        form.Controls.Add(tb)
        return tb

    old_tb = box(12, "Old names (one per line):")
    new_tb = box(376, "New names (same order):")

    ok = WF.Button()
    ok.Text = "Rename"
    ok.Left, ok.Top, ok.Width = 560, 430, 90
    ok.DialogResult = WF.DialogResult.OK
    cancel = WF.Button()
    cancel.Text = "Cancel"
    cancel.Left, cancel.Top, cancel.Width = 660, 430, 80
    cancel.DialogResult = WF.DialogResult.Cancel
    form.Controls.Add(ok)
    form.Controls.Add(cancel)
    form.AcceptButton = None
    form.CancelButton = cancel

    if form.ShowDialog() != WF.DialogResult.OK:
        return None, None
    split = lambda t: [l.strip() for l in t.replace("\r", "").split("\n") if l.strip()]
    return split(old_tb.Text), split(new_tb.Text)


def rename_style(old_sub, new_name):
    cats = doc.Settings.Categories
    new_sub = cats.NewSubcategory(lines_category(), new_name)
    new_sub.SetLineWeight(old_sub.GetLineWeight(PROJ), PROJ)
    new_sub.LineColor = old_sub.LineColor
    pid = old_sub.GetLinePatternId(PROJ)
    if pid != ElementId.InvalidElementId:
        new_sub.SetLinePatternId(pid, PROJ)
    new_gs = new_sub.GetGraphicsStyle(PROJ)
    old_id = old_sub.GetGraphicsStyle(PROJ).Id.IntegerValue
    moved = 0
    for ce in FilteredElementCollector(doc).OfClass(CurveElement):
        if ce.LineStyle.Id.IntegerValue == old_id:
            ce.LineStyle = new_gs
            moved += 1
    doc.Delete(old_sub.Id)
    return moved


print_list()

old_names, new_names = ask_lists()
if old_names is None:
    script.exit()

if len(old_names) != len(new_names):
    forms.alert("Old names ({}) and new names ({}) must have the same number of lines.".format(
        len(old_names), len(new_names)), title=__title__, exitscript=True)

subs = dict((s.Name, s) for s in lines_category().SubCategories)
problems = []
for o, n in zip(old_names, new_names):
    if o not in subs:
        problems.append(u"Not found: {}".format(o))
    elif o.startswith("<"):
        problems.append(u"Built-in style cannot be renamed: {}".format(o))
    elif n in subs and n != o:
        problems.append(u"New name already exists: {}".format(n))
if len(set(new_names)) != len(new_names):
    problems.append("New names contain duplicates.")
if problems:
    forms.alert("\n".join(problems), title=__title__, exitscript=True)

pairs = [(o, n) for o, n in zip(old_names, new_names) if o != n]
if not pairs:
    forms.alert("Nothing to rename.", title=__title__, exitscript=True)

msg = u"Rename {} line style(s)?\n\n".format(len(pairs)) + u"\n".join(u"{}  ->  {}".format(o, n) for o, n in pairs)
if not forms.alert(msg, title=__title__, yes=True, no=True):
    script.exit()

done, failed = [], []
t = Transaction(doc, "Rename line styles")
t.Start()
for o, n in pairs:
    st = SubTransaction(doc)
    st.Start()
    try:
        moved = rename_style(subs[o], n)
        st.Commit()
        done.append([o, n, moved])
    except Exception as ex:
        st.RollBack()
        failed.append([o, n, str(ex)])
t.Commit()

output.print_md("## Renamed ({})".format(len(done)))
if done:
    output.print_table(table_data=done, columns=["Old", "New", "Lines moved"])
if failed:
    output.print_md("## Failed ({})".format(len(failed)))
    output.print_table(table_data=failed, columns=["Old", "New", "Error"])
