# -*- coding: utf-8 -*-
__title__ = "Toggle Abzug"
__doc__ = """Hide / show '5ding Abzug rechteckig' elements in the active view using a view filter.
Shift+Click: choose views and set Abzug hidden or visible in all of them."""

from System.Collections.Generic import List

from pyrevit import revit, forms, EXEC_PARAMS
from Autodesk.Revit.DB import (BuiltInCategory, BuiltInParameter, ElementId, ElementParameterFilter,
                               FilteredElementCollector, ParameterFilterElement,
                               ParameterFilterRuleFactory, Transaction, View, ViewType)

doc = revit.doc

FAMILY_NAME = "5ding Abzug rechteckig"
FILTER_NAME = "Abzug - 5ding Abzug rechteckig"
FILTERS_PARAM_ID = ElementId(BuiltInParameter.VIS_GRAPHICS_FILTERS)
SKIP_TYPES = (ViewType.Schedule, ViewType.DrawingSheet, ViewType.ProjectBrowser, ViewType.SystemBrowser,
              ViewType.Internal, ViewType.Undefined, ViewType.Legend, ViewType.Report)


def get_or_create_filter():
    for f in FilteredElementCollector(doc).OfClass(ParameterFilterElement):
        if f.Name == FILTER_NAME:
            return f
    pid = ElementId(BuiltInParameter.ALL_MODEL_FAMILY_NAME)
    try:
        rule = ParameterFilterRuleFactory.CreateEqualsRule(pid, FAMILY_NAME)
    except Exception:
        rule = ParameterFilterRuleFactory.CreateEqualsRule(pid, FAMILY_NAME, True)
    cats = List[ElementId]()
    cats.Add(ElementId(BuiltInCategory.OST_GenericModel))
    return ParameterFilterElement.Create(doc, FILTER_NAME, cats, ElementParameterFilter(rule))


def filter_target(view):
    """View template if it controls filters, otherwise the view itself."""
    tid = view.ViewTemplateId
    if tid != ElementId.InvalidElementId:
        tpl = doc.GetElement(tid)
        if not any(i.Equals(FILTERS_PARAM_ID) for i in tpl.GetNonControlledTemplateParameterIds()):
            return tpl
    return view


def has_filter(view, fid):
    return any(f.Equals(fid) for f in view.GetFilters())


def set_visible(view, fid, visible):
    if not has_filter(view, fid):
        view.AddFilter(fid)
    view.SetFilterVisibility(fid, visible)


def is_visible(view, fid):
    return not has_filter(view, fid) or view.GetFilterVisibility(fid)


def toggle_active_view():
    view = revit.active_view
    if view.ViewType in SKIP_TYPES or not view.AreGraphicsOverridesAllowed():
        forms.alert("Active view does not support filters.", title=__title__, exitscript=True)
    t = Transaction(doc, "Toggle Abzug")
    t.Start()
    fid = get_or_create_filter().Id
    target = filter_target(view)
    visible = not is_visible(target, fid)
    set_visible(target, fid, visible)
    t.Commit()
    where = " (via template '{}')".format(target.Name) if not target.Id.Equals(view.Id) else ""
    forms.toast("Abzug {}{}".format("shown" if visible else "hidden", where), title="PBTools")


class ViewItem(forms.TemplateListItem):
    @property
    def name(self):
        prefix = "[Template] " if self.item.IsTemplate else ""
        return u"{}{} - {}".format(prefix, self.item.ViewType, self.item.Name)


def set_in_many_views():
    views = [v for v in FilteredElementCollector(doc).OfClass(View)
             if v.ViewType not in SKIP_TYPES and (v.IsTemplate or v.AreGraphicsOverridesAllowed())]
    views.sort(key=lambda v: (not v.IsTemplate, str(v.ViewType), v.Name))
    picked = forms.SelectFromList.show([ViewItem(v) for v in views], title="Views / templates for Abzug filter",
                                       multiselect=True, button_name="Next")
    if not picked:
        return
    mode = forms.CommandSwitchWindow.show(["Hide Abzug", "Show Abzug"], message="Set Abzug in selected views:")
    if not mode:
        return
    visible = mode == "Show Abzug"

    t = Transaction(doc, "Set Abzug visibility")
    t.Start()
    fid = get_or_create_filter().Id
    targets = {}
    for v in picked:
        tgt = v if v.IsTemplate else filter_target(v)
        targets[tgt.Id.ToString()] = tgt
    failed = []
    for tgt in targets.values():
        try:
            set_visible(tgt, fid, visible)
        except Exception:
            failed.append(tgt.Name)
    t.Commit()
    msg = "Abzug {} in {} view(s)/template(s).".format("shown" if visible else "hidden", len(targets) - len(failed))
    if failed:
        msg += "\nFailed: " + ", ".join(failed)
    forms.alert(msg, title=__title__)


if EXEC_PARAMS.config_mode:
    set_in_many_views()
else:
    toggle_active_view()
