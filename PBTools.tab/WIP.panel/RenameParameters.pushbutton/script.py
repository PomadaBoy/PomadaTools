# -*- coding: utf-8 -*-
__title__ = "Rename\nParameters"
__doc__ = """Renames several parameters at once.
Family document: family parameters. Project: global parameters.
Tick the ones to change, build new names with Find/Replace, Prefix and Suffix,
or type a new name directly, then rename them all in one go.
Project and shared parameters are listed but cannot be renamed (Revit API limit)."""

import clr
clr.AddReference("System.Windows.Forms")
clr.AddReference("System.Drawing")
import System.Windows.Forms as WF
import System.Drawing as SD

from pyrevit import revit, forms, script
from Autodesk.Revit.DB import (InstanceBinding, SharedParameterElement, LabelUtils, GlobalParametersManager,
                               Transaction, SubTransaction)

doc = revit.doc
output = script.get_output()
FORBIDDEN = u'\\:{}[]|;<>?`~'
COL_SEL, COL_OLD, COL_NEW, COL_SRC, COL_KIND, COL_GROUP, COL_NOTE = range(7)
LOCKED_COLOR = SD.Color.FromArgb(150, 150, 150)

NOTE_PROJECT = u"Rename in Manage > Project Parameters"
NOTE_SHARED = u"Shared - fixed by GUID, cannot rename"

if doc.IsFamilyDocument:
    WARNING_TEXT = u"""Revit updates formulas, dimension labels and associations that use these parameters.

What CAN break:
 - Type catalogs (.txt next to the .rfa) use the parameter NAME in their header.
 - Dynamo graphs, scripts and Excel links that look parameters up by name.
 - Projects that already contain this family keep the old name until you load it again;
   schedules / filters there only see shared parameters anyway.

Ctrl+Z undoes the rename until you save."""
    BANNER = u"Family document: family parameters can be renamed. Shared family parameters are locked (fixed by GUID)."
else:
    WARNING_TEXT = u"""Revit updates formulas and dimensions that use these global parameters.

What CAN break:
 - Dynamo graphs, scripts and Excel links that look global parameters up by name.

Ctrl+Z undoes the rename until you save."""
    BANNER = (u"Project: only GLOBAL parameters can be renamed here. Project / shared parameters are locked "
              u"(Revit API has no rename) - use Manage > Project Parameters > Modify, one at a time.")


def group_label(d):
    try:
        return LabelUtils.GetLabelForGroup(d.GetGroupTypeId())
    except Exception:
        return u""


def collect():
    items = []
    if doc.IsFamilyDocument:
        for fp in doc.FamilyManager.Parameters:
            if fp.Id.IntegerValue < 0:  # built-in family parameters
                continue
            d = fp.Definition
            items.append({"name": d.Name, "source": u"Family shared" if fp.IsShared else u"Family",
                          "kind": u"Instance" if fp.IsInstance else u"Type", "group": group_label(d),
                          "fp": fp, "note": NOTE_SHARED if fp.IsShared else u""})
    else:
        for gid in GlobalParametersManager.GetAllGlobalParameters(doc):
            gp = doc.GetElement(gid)
            items.append({"name": gp.Name, "source": u"Global", "kind": u"", "group": group_label(gp.GetDefinition()),
                          "gp": gp, "note": u""})
        it = doc.ParameterBindings.ForwardIterator()
        while it.MoveNext():
            d, binding = it.Key, it.Current
            shared = isinstance(doc.GetElement(d.Id), SharedParameterElement)
            items.append({"name": d.Name, "source": u"Shared" if shared else u"Project",
                          "kind": u"Instance" if isinstance(binding, InstanceBinding) else u"Type",
                          "group": group_label(d), "note": NOTE_SHARED if shared else NOTE_PROJECT})
    for i in items:
        i["locked"] = bool(i["note"])
    items.sort(key=lambda i: (i["locked"], i["name"].lower()))
    return items


def rename(item, new_name):
    if "fp" in item:
        doc.FamilyManager.RenameParameter(item["fp"], new_name)
    else:
        item["gp"].Name = new_name


def text(v):
    return (v or u"").strip()


def validate(grid):
    """Returns a list of problems for rows whose name changes."""
    problems = []
    final = {}
    for row in grid.Rows:
        old, new = text(row.Cells[COL_OLD].Value), text(row.Cells[COL_NEW].Value)
        final.setdefault((new if new else old).lower(), []).append(old)
        if new == old:
            continue
        if not new:
            problems.append(u"Empty new name for: {}".format(old))
        elif any(ch in new for ch in FORBIDDEN):
            problems.append(u"Not allowed character in '{}' (not allowed: {})".format(new, FORBIDDEN))
    for row in grid.Rows:
        old, new = text(row.Cells[COL_OLD].Value), text(row.Cells[COL_NEW].Value)
        if new and new != old and len(final[new.lower()]) > 1:
            problems.append(u"Name used more than once: {}".format(new))
    return sorted(set(problems))


def ask_names(items):
    form = WF.Form()
    form.Text = u"Rename Parameters - {}".format(doc.Title)
    form.Width, form.Height = 1150, 780
    form.StartPosition = WF.FormStartPosition.CenterScreen

    def label(txt, x, y):
        l = WF.Label()
        l.Text = txt
        l.Left, l.Top = x, y + 3
        l.AutoSize = True
        form.Controls.Add(l)
        return l

    def textbox(x, y, w):
        tb = WF.TextBox()
        tb.Left, tb.Top, tb.Width = x, y, w
        form.Controls.Add(tb)
        return tb

    def button(txt, x, y, w, handler):
        b = WF.Button()
        b.Text = txt
        b.Left, b.Top, b.Width, b.Height = x, y - 1, w, 25
        b.Click += handler
        form.Controls.Add(b)
        return b

    banner = WF.Label()
    banner.Text = BANNER
    banner.Left, banner.Top, banner.Width, banner.Height = 12, 8, 1110, 22
    banner.BackColor = SD.Color.FromArgb(255, 243, 205)
    banner.Padding = WF.Padding(4, 3, 4, 3)
    banner.Anchor = WF.AnchorStyles.Top | WF.AnchorStyles.Left | WF.AnchorStyles.Right
    form.Controls.Add(banner)

    label(u"Filter:", 12, 40)
    filter_tb = textbox(60, 40, 260)
    label(u"Find:", 12, 74)
    find_tb = textbox(60, 74, 150)
    label(u"Replace with:", 220, 74)
    repl_tb = textbox(305, 74, 150)
    label(u"Prefix:", 470, 74)
    prefix_tb = textbox(515, 74, 110)
    label(u"Suffix:", 635, 74)
    suffix_tb = textbox(680, 74, 110)

    grid = WF.DataGridView()
    grid.Left, grid.Top, grid.Width, grid.Height = 12, 110, 1110, 560
    grid.Anchor = WF.AnchorStyles.Top | WF.AnchorStyles.Bottom | WF.AnchorStyles.Left | WF.AnchorStyles.Right
    grid.AllowUserToAddRows = False
    grid.AllowUserToDeleteRows = False
    grid.RowHeadersVisible = False
    grid.SelectionMode = WF.DataGridViewSelectionMode.CellSelect
    grid.AutoSizeColumnsMode = WF.DataGridViewAutoSizeColumnsMode.Fill

    sel_col = WF.DataGridViewCheckBoxColumn()
    sel_col.HeaderText = u""
    sel_col.FillWeight = 5
    grid.Columns.Add(sel_col)
    for header, weight in ((u"Current name", 34), (u"New name (editable)", 34), (u"Source", 11),
                           (u"Inst/Type", 8), (u"Group", 15), (u"Note", 25)):
        c = WF.DataGridViewTextBoxColumn()
        c.HeaderText = header
        c.FillWeight = weight
        c.ReadOnly = header != u"New name (editable)"
        grid.Columns.Add(c)
    new_back = SD.Color.FromArgb(235, 245, 255)
    grid.Columns[COL_NEW].DefaultCellStyle.BackColor = new_back

    for item in items:
        idx = grid.Rows.Add(False, item["name"], item["name"], item["source"], item["kind"],
                            item["group"], item["note"])
        row = grid.Rows[idx]
        row.Tag = item
        if item["locked"]:
            row.ReadOnly = True
            row.DefaultCellStyle.ForeColor = LOCKED_COLOR
            row.Cells[COL_NEW].Style.BackColor = SD.Color.Empty
    form.Controls.Add(grid)

    info = WF.Label()
    info.Left, info.Top, info.Width = 12, 685, 800
    info.Anchor = WF.AnchorStyles.Bottom | WF.AnchorStyles.Left
    form.Controls.Add(info)

    def editable_rows():
        return [r for r in grid.Rows if not r.Tag["locked"]]

    def ticked_rows():
        return [r for r in editable_rows() if r.Visible and r.Cells[COL_SEL].Value]

    def refresh(*args):
        changes = 0
        for r in editable_rows():
            changed = text(r.Cells[COL_NEW].Value) != text(r.Cells[COL_OLD].Value)
            r.Cells[COL_NEW].Style.BackColor = SD.Color.FromArgb(255, 240, 180) if changed else new_back
            changes += changed
        info.Text = u"{} can be renamed, {} locked (gray), {} ticked, {} will be renamed (yellow).".format(
            len(editable_rows()), grid.Rows.Count - len(editable_rows()), len(ticked_rows()), changes)

    def apply_click(sender, e):
        grid.EndEdit()
        rows = ticked_rows()
        if not rows:
            forms.alert(u"Tick the parameters to change first.", title=u"Rename Parameters")
            return
        for r in rows:
            new = text(r.Cells[COL_OLD].Value)
            if find_tb.Text:
                new = new.replace(find_tb.Text, repl_tb.Text)
            r.Cells[COL_NEW].Value = prefix_tb.Text + new + suffix_tb.Text
        refresh()

    def reset_click(sender, e):
        grid.EndEdit()
        for r in ticked_rows() or editable_rows():
            r.Cells[COL_NEW].Value = r.Cells[COL_OLD].Value
        refresh()

    def set_ticks(value):
        grid.EndEdit()
        for r in editable_rows():
            if r.Visible:
                r.Cells[COL_SEL].Value = value
        refresh()

    def filter_changed(sender, e):
        grid.CurrentCell = None
        f = filter_tb.Text.strip().lower()
        for r in grid.Rows:
            r.Visible = (not f) or f in text(r.Cells[COL_OLD].Value).lower()
        refresh()

    def commit_checkbox(sender, e):
        if grid.IsCurrentCellDirty and grid.CurrentCell.ColumnIndex == COL_SEL:
            grid.CommitEdit(WF.DataGridViewDataErrorContexts.Commit)

    button(u"Tick all shown", 335, 40, 110, lambda s, e: set_ticks(True))
    button(u"Untick all", 450, 40, 90, lambda s, e: set_ticks(False))
    button(u"Apply to ticked", 805, 74, 120, apply_click)
    button(u"Reset", 930, 74, 70, reset_click)
    filter_tb.TextChanged += filter_changed
    grid.CurrentCellDirtyStateChanged += commit_checkbox
    grid.CellValueChanged += refresh

    ok = WF.Button()
    ok.Text = u"Rename"
    ok.Left, ok.Top, ok.Width, ok.Height = 930, 700, 100, 30
    ok.Anchor = WF.AnchorStyles.Bottom | WF.AnchorStyles.Right
    ok.DialogResult = WF.DialogResult.OK
    ok.Enabled = bool(editable_rows())
    cancel = WF.Button()
    cancel.Text = u"Cancel"
    cancel.Left, cancel.Top, cancel.Width, cancel.Height = 1035, 700, 90, 30
    cancel.Anchor = WF.AnchorStyles.Bottom | WF.AnchorStyles.Right
    cancel.DialogResult = WF.DialogResult.Cancel
    form.Controls.Add(ok)
    form.Controls.Add(cancel)
    form.CancelButton = cancel

    def on_closing(sender, e):
        if form.DialogResult != WF.DialogResult.OK:
            return
        grid.EndEdit()
        problems = validate(grid)
        if problems:
            forms.alert(u"\n".join(problems[:30]), title=u"Fix these names first")
            e.Cancel = True

    form.FormClosing += on_closing
    refresh()

    if form.ShowDialog() != WF.DialogResult.OK:
        return None
    return [(r.Tag, text(r.Cells[COL_NEW].Value)) for r in editable_rows()
            if text(r.Cells[COL_NEW].Value) != text(r.Cells[COL_OLD].Value)]


# ---------------------------------------------------------------- run

items = collect()
if not items:
    forms.alert(u"No user parameters in this document.", title=u"Rename Parameters", exitscript=True)

pairs = ask_names(items)
if pairs is None:
    script.exit()
if not pairs:
    forms.alert(u"No names were changed.", title=u"Rename Parameters", exitscript=True)

shown = u"\n".join(u"{}  ->  {}".format(i["name"], n) for i, n in pairs[:40])
if len(pairs) > 40:
    shown += u"\n... and {} more (full list in the output window)".format(len(pairs) - 40)
output.print_md(u"## Planned renames ({})".format(len(pairs)))
output.print_table(table_data=[[i["name"], n, i["source"]] for i, n in pairs], columns=["Old", "New", "Source"])

if not forms.alert(u"Rename {} parameter(s)?\n\n{}".format(len(pairs), shown),
                   sub_msg=WARNING_TEXT, title=u"Rename Parameters - check before renaming",
                   ok=False, yes=True, no=True, warn_icon=True):
    output.print_md(u"Cancelled - nothing was renamed.")
    script.exit()

done, failed = [], []
t = Transaction(doc, "Rename parameters")
t.Start()
for item, new_name in pairs:
    st = SubTransaction(doc)
    st.Start()
    try:
        rename(item, new_name)
        st.Commit()
        done.append([item["name"], new_name, item["source"]])
    except Exception as ex:
        st.RollBack()
        failed.append([item["name"], new_name, item["source"], unicode(ex)])
t.Commit()

output.print_md(u"## Renamed ({})".format(len(done)))
if done:
    output.print_table(table_data=done, columns=["Old", "New", "Source"])
if failed:
    output.print_md(u"## Failed ({})".format(len(failed)))
    output.print_table(table_data=failed, columns=["Old", "New", "Source", "Error"])
