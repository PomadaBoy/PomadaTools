# -*- coding: utf-8 -*-
__title__ = "Parameter Audit"
__doc__ = """Lists all project, shared and family-only shared parameters in the model
and flags the ones that are not used (no element carries them) or have no value anywhere.
Shows what was removed since the last run on this model and can save the result as CSV."""

import io
import json
import os
from collections import defaultdict

import System
from pyrevit import revit, forms, script
from Autodesk.Revit.DB import (FilteredElementCollector, InstanceBinding, SharedParameterElement,
                               StorageType, ElementId, FamilyInstance, LabelUtils)

doc = revit.doc
output = script.get_output()

NOT_USED = u"NOT USED (no elements)"
NO_VALUES = u"NO VALUES"
IN_USE = u"In use"


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


def status(total, filled):
    if total == 0:
        return NOT_USED
    return NO_VALUES if filled == 0 else IN_USE


def group_label(d):
    try:
        return LabelUtils.GetLabelForGroup(d.GetGroupTypeId())
    except Exception:
        return u""


def audit_bound():
    """Project/shared parameters bound to categories. Returns rows and the bound ids."""
    cache = {}

    def elems(cat_id, kind):
        key = (cat_id.IntegerValue, kind)
        if key not in cache:
            col = FilteredElementCollector(doc).OfCategoryId(cat_id)
            col = col.WhereElementIsElementType() if kind == u"Type" else col.WhereElementIsNotElementType()
            cache[key] = list(col)
        return cache[key]

    rows, bound_ids = [], set()
    it = doc.ParameterBindings.ForwardIterator()
    while it.MoveNext():
        d, binding = it.Key, it.Current
        kind = u"Instance" if isinstance(binding, InstanceBinding) else u"Type"
        cats = list(binding.Categories)
        bound_ids.add(d.Id.IntegerValue)
        total = filled = 0
        for c in cats:
            for e in elems(c.Id, kind):
                p = e.get_Parameter(d)
                if p is None:
                    continue
                total += 1
                if has_value(p):
                    filled += 1
        source = u"Shared" if isinstance(doc.GetElement(d.Id), SharedParameterElement) else u"Project"
        rows.append({"key": u"{}|{}".format(source, d.Id.IntegerValue), "name": d.Name,
                     "source": source, "kind": kind, "group": group_label(d),
                     "total": total, "filled": filled,
                     "cats": u", ".join(sorted(c.Name for c in cats))})
    return rows, bound_ids


def audit_family_shared(bound_ids):
    """Shared parameters that live only inside loaded families."""
    sps = [s for s in FilteredElementCollector(doc).OfClass(SharedParameterElement)
           if s.Id.IntegerValue not in bound_ids]
    stats = defaultdict(lambda: [0, 0])
    elems = list(FilteredElementCollector(doc).OfClass(FamilyInstance)) + \
        list(FilteredElementCollector(doc).WhereElementIsElementType())
    guids = [s.GuidValue for s in sps]
    for e in elems:
        for g in guids:
            p = e.get_Parameter(g)
            if p is None:
                continue
            stats[g][0] += 1
            if has_value(p):
                stats[g][1] += 1
    rows = []
    for s in sps:
        total, filled = stats[s.GuidValue]
        rows.append({"key": u"Family|{}".format(s.GuidValue), "name": s.Name,
                     "source": u"Shared (family only)", "kind": u"", "group": u"",
                     "total": total, "filled": filled, "cats": u"GUID {}".format(s.GuidValue)})
    return rows


def load_previous(path):
    try:
        with io.open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def save_current(path, rows):
    try:
        with io.open(path, "w", encoding="utf-8") as f:
            f.write(unicode(json.dumps(dict((r["key"], r["name"]) for r in rows))))
    except Exception:
        pass


def save_csv(rows):
    path = forms.save_file(file_ext="csv", default_name=u"Parameter_Audit_{}".format(doc.Title))
    if not path:
        return None
    # Excel splits columns by the Windows list separator (',' or ';' depending on region)
    sep = System.Globalization.CultureInfo.CurrentCulture.TextInfo.ListSeparator or u";"

    def line(values):
        return sep.join(u'"{}"'.format(unicode(v).replace(u'"', u'""')) for v in values) + u"\n"

    with io.open(path, "w", encoding="utf-8-sig") as f:
        f.write(line([u"Status", u"Parameter", u"Source", u"Instance/Type", u"Group",
                      u"Elements carrying it", u"Elements with value", u"Categories"]))
        for r in rows:
            f.write(line([r["status"], r["name"], r["source"], r["kind"], r["group"],
                          r["total"], r["filled"], r["cats"]]))
    return path


def table(rows):
    return [[r["name"], r["source"], r["kind"], r["total"], r["filled"],
             r["cats"] if len(r["cats"]) <= 80 else r["cats"][:77] + u"..."] for r in rows]


COLUMNS = ["Parameter", "Source", "Inst/Type", "Elements", "With value", "Categories"]

with forms.ProgressBar(title="Auditing parameters...", indeterminate=True):
    bound_rows, bound_ids = audit_bound()
    rows = bound_rows + audit_family_shared(bound_ids)

for r in rows:
    r["status"] = status(r["total"], r["filled"])
rows.sort(key=lambda r: ([NOT_USED, NO_VALUES, IN_USE].index(r["status"]), r["name"].lower()))

by_status = defaultdict(list)
for r in rows:
    by_status[r["status"]].append(r)

output.print_md(u"# Parameter Audit - {}".format(doc.Title))
output.print_md(u"**{}** parameters: **{}** not used, **{}** without values, **{}** in use".format(
    len(rows), len(by_status[NOT_USED]), len(by_status[NO_VALUES]), len(by_status[IN_USE])))

data_file = script.get_document_data_file("param_audit", "json")
previous = load_previous(data_file)
if previous is not None:
    current_keys = set(r["key"] for r in rows)
    removed = sorted(name for key, name in previous.items() if key not in current_keys)
    output.print_md(u"## Removed since last run ({})".format(len(removed)))
    if removed:
        output.print_table(table_data=[[n] for n in removed], columns=["Parameter"])
save_current(data_file, rows)

name_count = defaultdict(int)
for r in bound_rows:
    name_count[r["name"]] += 1
dupes = sorted((n, c) for n, c in name_count.items() if c > 1)
if dupes:
    output.print_md(u"## Duplicate project parameter names ({})".format(len(dupes)))
    output.print_table(table_data=[[n, c] for n, c in dupes], columns=["Parameter", "Definitions"])

for st in (NOT_USED, NO_VALUES, IN_USE):
    output.print_md(u"## {} ({})".format(st, len(by_status[st])))
    if by_status[st]:
        output.print_table(table_data=table(by_status[st]), columns=COLUMNS)

output.print_md(u"_Empty = blank text or unset reference. Numeric 0 and Yes/No = No count as values. "
                u"Check schedules, filters and tags before deleting._")

if forms.alert("Save the audit as CSV?", title=__title__, yes=True, no=True):
    csv_path = save_csv(rows)
    if csv_path:
        output.print_md(u"CSV saved: `{}`".format(csv_path))
