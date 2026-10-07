# -*- coding: utf-8 -*-
__title__ = "Remove Parameters\nfrom CSV"
__doc__ = """Deletes every parameter listed in a Parameter Audit CSV.
Export the CSV with Parameter Audit, delete the rows you want to KEEP,
then pick the file here. A warning window lists everything before deletion."""

import clr
clr.AddReference("System.Windows.Forms")
clr.AddReference("System.Drawing")
import System
import System.Windows.Forms as WF
import System.Drawing as SD
from collections import defaultdict

from pyrevit import revit, forms, script
from Autodesk.Revit.DB import (FilteredElementCollector, InstanceBinding, SharedParameterElement,
                               StorageType, ElementId, FamilyInstance, LabelUtils,
                               Transaction, SubTransaction)

doc = revit.doc
output = script.get_output()

WARNING_TEXT = u"""THIS CANNOT BE UNDONE AFTER YOU SAVE. Make a backup copy of the model first.

Deleting a parameter can cause these problems:
 - All values stored in it are lost on every element (rows in red below still have values).
 - Schedules lose the field; sorting, grouping and filters that use it are removed.
 - View filters lose the rule, so elements may suddenly show or hide differently.
 - Tags, labels, keynotes and family formulas that read it show empty or '?'.
 - Dynamo scripts, add-ins (SOFiSTiK, 5D / iTWO, BBT, Trimble Connect) and IFC / export
   mappings that rely on the parameter stop working.
 - Re-adding a shared parameter later will NOT bring the values back.
 - In a central model you must own the parameters; sync right after and inform the team.

Shared parameters defined only inside families can be removed here only when no element uses
them. Otherwise edit the family itself; those rows are marked 'Skipped'."""


def has_value(p):
    if not p.HasValue:
        return False
    st = p.StorageType
    if st == StorageType.String:
        s = p.AsString()
        return s is not None and s.strip() != u""
    if st == StorageType.ElementId:
        return p.AsElementId() != ElementId.InvalidElementId
    return True


# ---------------------------------------------------------------- CSV

def read_text(path):
    data = System.IO.File.ReadAllBytes(path)
    try:
        text = System.Text.UTF8Encoding(False, True).GetString(data)
    except Exception:
        # Excel "CSV (semicolon)" is saved in the system ANSI code page
        text = System.Text.Encoding.Default.GetString(data)
    return text.lstrip(u"﻿")


def split_row(line, sep):
    cells, cur, quoted, i = [], [], False, 0
    while i < len(line):
        ch = line[i]
        if quoted:
            if ch == u'"':
                if i + 1 < len(line) and line[i + 1] == u'"':
                    cur.append(u'"')
                    i += 1
                else:
                    quoted = False
            else:
                cur.append(ch)
        elif ch == u'"':
            quoted = True
        elif ch == sep:
            cells.append(u"".join(cur).strip())
            cur = []
        else:
            cur.append(ch)
        i += 1
    cells.append(u"".join(cur).strip())
    return cells


def row_cells(line, excel_wrapped):
    line = line.replace(u"﻿", u"").rstrip(u",; \t")
    if excel_wrapped:
        return [c.strip() for c in line.replace(u'"', u"").split(u";")]
    cells = split_row(line, u";")
    return cells if len(cells) > 1 else split_row(line, u",")


def read_csv(path):
    lines = [l for l in read_text(path).replace(u"\r", u"").split(u"\n") if l.strip()]
    if not lines:
        return []
    # A ';' file opened in Excel with a ',' list separator lands in one column; saved again,
    # every row is re-split at its commas and the header gets padded with trailing commas.
    first = lines[0].strip()
    excel_wrapped = u";" in first and first.endswith(u",")
    header = [h.lower() for h in row_cells(lines[0], excel_wrapped)]

    def col(*names):
        for n in names:
            if n in header:
                return header.index(n)
        return None

    i_name, i_src, i_kind = col(u"parameter"), col(u"source"), col(u"instance/type")
    if i_name is None:
        forms.alert("The CSV has no 'Parameter' column.\nUse a file exported by Parameter Audit.",
                    title="Remove Parameters", exitscript=True)
    rows = []
    for line in lines[1:]:
        cells = row_cells(line, excel_wrapped)
        get = lambda i: cells[i] if i is not None and i < len(cells) else u""
        if not get(i_name):
            continue
        guid = u""
        for c in cells:
            if c.upper().startswith(u"GUID "):
                guid = c[5:].strip().lower()
        rows.append({"name": get(i_name), "source": get(i_src), "kind": get(i_kind), "guid": guid})
    return rows


# ---------------------------------------------------------------- model

def bound_definitions():
    result = []
    it = doc.ParameterBindings.ForwardIterator()
    while it.MoveNext():
        d, binding = it.Key, it.Current
        kind = u"Instance" if isinstance(binding, InstanceBinding) else u"Type"
        source = u"Shared" if isinstance(doc.GetElement(d.Id), SharedParameterElement) else u"Project"
        result.append((d, kind, source, list(binding.Categories)))
    return result


def count_bound(d, kind, cats, cache):
    total = filled = 0
    for c in cats:
        key = (c.Id.IntegerValue, kind)
        if key not in cache:
            col = FilteredElementCollector(doc).OfCategoryId(c.Id)
            col = col.WhereElementIsElementType() if kind == u"Type" else col.WhereElementIsNotElementType()
            cache[key] = list(col)
        for e in cache[key]:
            p = e.get_Parameter(d)
            if p is None:
                continue
            total += 1
            if has_value(p):
                filled += 1
    return total, filled


def count_family_shared(guids):
    stats = defaultdict(lambda: [0, 0])
    if not guids:
        return stats
    elems = list(FilteredElementCollector(doc).OfClass(FamilyInstance)) + \
        list(FilteredElementCollector(doc).WhereElementIsElementType())
    for e in elems:
        for g in guids:
            p = e.get_Parameter(g)
            if p is None:
                continue
            stats[g][0] += 1
            if has_value(p):
                stats[g][1] += 1
    return stats


def match(csv_rows):
    """Returns (targets, not_found). Each target is one parameter element to delete."""
    bound = bound_definitions()
    bound_ids = set(d.Id.IntegerValue for d, _, _, _ in bound)
    family_sp = dict((s.GuidValue.ToString().lower(), s)
                     for s in FilteredElementCollector(doc).OfClass(SharedParameterElement)
                     if s.Id.IntegerValue not in bound_ids)

    targets, seen, not_found, fam_rows = [], set(), [], []
    for r in csv_rows:
        if r["guid"] or r["source"].lower().startswith(u"shared (family"):
            fam_rows.append(r)
            continue
        hits = [b for b in bound if b[0].Name == r["name"]
                and (not r["source"] or b[2] == r["source"])
                and (not r["kind"] or b[1] == r["kind"])]
        if not hits:
            not_found.append(r["name"])
        for d, kind, source, cats in hits:
            if d.Id.IntegerValue in seen:
                continue
            seen.add(d.Id.IntegerValue)
            try:
                group = LabelUtils.GetLabelForGroup(d.GetGroupTypeId())
            except Exception:
                group = u""
            targets.append({"id": d.Id, "name": d.Name, "source": source, "kind": kind,
                            "group": group, "def": d, "cats": cats})

    for r in fam_rows:
        sp = family_sp.get(r["guid"]) if r["guid"] else None
        if sp is None and not r["guid"]:
            same = [s for s in family_sp.values() if s.Name == r["name"]]
            sp = same[0] if len(same) == 1 else None
        if sp is None or sp.Id.IntegerValue in seen:
            if sp is None:
                not_found.append(r["name"])
            continue
        seen.add(sp.Id.IntegerValue)
        targets.append({"id": sp.Id, "name": sp.Name, "source": u"Shared (family only)", "kind": u"",
                        "group": u"", "guid": sp.GuidValue})

    # live counts, the CSV may be older than the model
    cache = {}
    fam_stats = count_family_shared([t["guid"] for t in targets if "guid" in t])
    for t in targets:
        if "guid" in t:
            t["total"], t["filled"] = fam_stats[t["guid"]]
            t["skip"] = t["total"] > 0
        else:
            t["total"], t["filled"] = count_bound(t["def"], t["kind"], t["cats"], cache)
            t["skip"] = False
    targets.sort(key=lambda t: (t["skip"], t["filled"] == 0, t["name"].lower()))
    return targets, not_found


# ---------------------------------------------------------------- warning window

def confirm(targets, not_found, csv_path):
    form = WF.Form()
    form.Text = u"Remove Parameters - WARNING"
    form.Width, form.Height = 980, 760
    form.StartPosition = WF.FormStartPosition.CenterScreen
    form.MinimizeBox = False

    head = WF.Label()
    head.Text = u"⚠  The parameters below will be PERMANENTLY DELETED from '{}'".format(doc.Title)
    head.Font = SD.Font(form.Font.FontFamily, 12, SD.FontStyle.Bold)
    head.ForeColor = SD.Color.DarkRed
    head.Left, head.Top, head.Width, head.Height = 12, 10, 940, 26
    form.Controls.Add(head)

    warn = WF.TextBox()
    warn.Multiline = True
    warn.ReadOnly = True
    warn.ScrollBars = WF.ScrollBars.Vertical
    warn.BackColor = SD.Color.FromArgb(255, 243, 205)
    warn.Text = WARNING_TEXT.replace(u"\n", u"\r\n")
    warn.Left, warn.Top, warn.Width, warn.Height = 12, 40, 940, 200
    warn.Anchor = WF.AnchorStyles.Top | WF.AnchorStyles.Left | WF.AnchorStyles.Right
    form.Controls.Add(warn)

    lv = WF.ListView()
    lv.View = WF.View.Details
    lv.CheckBoxes = True
    lv.FullRowSelect = True
    lv.GridLines = True
    lv.Left, lv.Top, lv.Width, lv.Height = 12, 250, 940, 360
    lv.Anchor = WF.AnchorStyles.Top | WF.AnchorStyles.Bottom | WF.AnchorStyles.Left | WF.AnchorStyles.Right
    for text, width in ((u"Parameter", 300), (u"Source", 140), (u"Inst/Type", 70), (u"Group", 150),
                        (u"Elements", 70), (u"With value", 75), (u"Note", 110)):
        lv.Columns.Add(text, width)
    for t in targets:
        note = u"Skipped - edit family" if t["skip"] else (u"HAS VALUES" if t["filled"] else u"")
        item = WF.ListViewItem(t["name"])
        for v in (t["source"], t["kind"], t["group"], str(t["total"]), str(t["filled"]), note):
            item.SubItems.Add(v)
        item.Tag = t
        if t["skip"]:
            item.ForeColor = SD.Color.Gray
        else:
            item.Checked = True
            if t["filled"]:
                item.BackColor = SD.Color.FromArgb(255, 205, 205)
        lv.Items.Add(item)
    form.Controls.Add(lv)

    info = WF.Label()
    info.Left, info.Top, info.Width, info.Height = 12, 616, 940, 20
    info.Anchor = WF.AnchorStyles.Bottom | WF.AnchorStyles.Left | WF.AnchorStyles.Right
    form.Controls.Add(info)

    agree = WF.CheckBox()
    agree.Text = u"I have a backup and understand the risks listed above"
    agree.Left, agree.Top, agree.Width = 12, 645, 500
    agree.Anchor = WF.AnchorStyles.Bottom | WF.AnchorStyles.Left
    form.Controls.Add(agree)

    ok = WF.Button()
    ok.Text = u"Delete"
    ok.Left, ok.Top, ok.Width, ok.Height = 750, 680, 100, 30
    ok.Anchor = WF.AnchorStyles.Bottom | WF.AnchorStyles.Right
    ok.ForeColor = SD.Color.DarkRed
    ok.DialogResult = WF.DialogResult.OK
    ok.Enabled = False
    cancel = WF.Button()
    cancel.Text = u"Cancel"
    cancel.Left, cancel.Top, cancel.Width, cancel.Height = 860, 680, 90, 30
    cancel.Anchor = WF.AnchorStyles.Bottom | WF.AnchorStyles.Right
    cancel.DialogResult = WF.DialogResult.Cancel
    form.Controls.Add(ok)
    form.Controls.Add(cancel)
    form.CancelButton = cancel

    def checked_items():
        return [i.Tag for i in lv.Items if i.Checked]

    def refresh(*args):
        sel = checked_items()
        with_values = len([t for t in sel if t["filled"]])
        text = u"{} selected for deletion, {} of them still have values.".format(len(sel), with_values)
        if not_found:
            text += u"   {} CSV row(s) not found in the model (see output window).".format(len(not_found))
        info.Text = text
        ok.Enabled = agree.Checked and len(sel) > 0

    def block_skipped(sender, e):
        if e.Index < lv.Items.Count and lv.Items[e.Index].Tag["skip"]:
            e.NewValue = WF.CheckState.Unchecked

    lv.ItemCheck += block_skipped
    lv.ItemChecked += refresh
    agree.CheckedChanged += refresh
    refresh()

    if form.ShowDialog() != WF.DialogResult.OK:
        return None
    return checked_items()


# ---------------------------------------------------------------- run

if doc.IsFamilyDocument:
    forms.alert("Open a project, not a family.", title="Remove Parameters", exitscript=True)

csv_path = forms.pick_file(file_ext="csv", title="Pick the Parameter Audit CSV")
if not csv_path:
    script.exit()

csv_rows = read_csv(csv_path)
if not csv_rows:
    forms.alert("The CSV has no parameter rows.", title="Remove Parameters", exitscript=True)

with forms.ProgressBar(title="Matching parameters...", indeterminate=True):
    targets, not_found = match(csv_rows)

output.print_md(u"# Remove Parameters - {}".format(doc.Title))
output.print_md(u"CSV: `{}` ({} rows)".format(csv_path, len(csv_rows)))
if not_found:
    output.print_md(u"## Not found in model ({}) - already deleted or renamed?".format(len(not_found)))
    output.print_table(table_data=[[n] for n in sorted(set(not_found))], columns=["Parameter"])

if not targets:
    forms.alert("None of the parameters in the CSV exist in this model.", title="Remove Parameters",
                exitscript=True)

selected = confirm(targets, not_found, csv_path)
if not selected:
    output.print_md(u"Cancelled - nothing was deleted.")
    script.exit()

done, failed = [], []
t = Transaction(doc, "Remove parameters from CSV")
t.Start()
for p in selected:
    st = SubTransaction(doc)
    st.Start()
    try:
        doc.Delete(p["id"])
        st.Commit()
        done.append([p["name"], p["source"], p["kind"], p["filled"]])
    except Exception as ex:
        st.RollBack()
        failed.append([p["name"], p["source"], str(ex)])
t.Commit()

output.print_md(u"## Deleted ({})".format(len(done)))
if done:
    output.print_table(table_data=done, columns=["Parameter", "Source", "Inst/Type", "Elements that had a value"])
if failed:
    output.print_md(u"## Failed ({})".format(len(failed)))
    output.print_table(table_data=failed, columns=["Parameter", "Source", "Error"])
output.print_md(u"_Ctrl+Z in Revit undoes this as long as the model is not saved. "
                u"Check schedules and view filters, then save / sync._")
