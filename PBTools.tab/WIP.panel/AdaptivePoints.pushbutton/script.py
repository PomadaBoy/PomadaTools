# -*- coding: utf-8 -*-
__title__ = "Adaptive\nPoints"
__doc__ = """Select only the adaptive points, not the adaptive elements themselves.
- Nothing selected: click the adaptive points (only points can be picked, no Tab needed), Finish when done.
- Adaptive elements selected (e.g. with a window): the selection is replaced by their adaptive points.
  You can choose all points or only point 1, point 2, ... of every element.
Works in Revit 2023 and 2025."""

import clr
clr.AddReference("System")
from System.Collections.Generic import List

from pyrevit import revit, forms
from Autodesk.Revit.DB import AdaptiveComponentInstanceUtils, ElementId, FamilyInstance, ReferencePoint
from Autodesk.Revit.UI.Selection import ISelectionFilter, ObjectType
from Autodesk.Revit.Exceptions import OperationCanceledException

doc = revit.doc
uidoc = revit.uidoc

ALL_POINTS = "All points"


class AdaptivePointFilter(ISelectionFilter):
    """Only adaptive points can be highlighted and picked, the elements they belong to are skipped."""

    def AllowElement(self, elem):
        return isinstance(elem, ReferencePoint)

    def AllowReference(self, ref, point):
        return False


def is_adaptive(elem):
    return isinstance(elem, FamilyInstance) and AdaptiveComponentInstanceUtils.IsAdaptiveComponentInstance(elem)


def points_of(instances, choice):
    """Adaptive point ids of the instances: all of them, or only placement point number N."""
    ids = []
    for inst in instances:
        placement = list(AdaptiveComponentInstanceUtils.GetInstancePlacementPointElementRefIds(inst))
        if choice == ALL_POINTS:
            ids.extend(placement)
            ids.extend(AdaptiveComponentInstanceUtils.GetInstanceShapeHandlePointElementRefIds(inst))
        else:
            n = int(choice.split()[-1])
            if n <= len(placement):
                ids.append(placement[n - 1])
    return ids


def from_selection(selected):
    """Selected adaptive elements -> their points. None if the selection holds no adaptive elements or points."""
    instances = [e for e in selected if is_adaptive(e)]
    points = [e.Id for e in selected if isinstance(e, ReferencePoint)]
    if not instances:
        return points or None
    most = max(len(AdaptiveComponentInstanceUtils.GetInstancePlacementPointElementRefIds(i)) for i in instances)
    choice = ALL_POINTS
    if most > 1:
        choice = forms.CommandSwitchWindow.show(
            [ALL_POINTS] + ["Point {}".format(n) for n in range(1, most + 1)],
            message="{} adaptive element(s) selected. Which points?".format(len(instances)))
        if not choice:
            return []
    return points + points_of(instances, choice)


def pick_points():
    try:
        with forms.WarningBar(title="Click adaptive points - only points are picked. Finish when done, Esc to cancel"):
            refs = uidoc.Selection.PickObjects(ObjectType.Element, AdaptivePointFilter(),
                                               "Click adaptive points, then Finish")
    except OperationCanceledException:
        return []
    return [r.ElementId for r in refs]


def main():
    selected = [doc.GetElement(i) for i in uidoc.Selection.GetElementIds()]
    ids = from_selection(selected) if selected else None
    if ids is None:
        ids = pick_points()
    if not ids:
        return
    unique = dict((str(i), i) for i in ids)
    uidoc.Selection.SetElementIds(List[ElementId](list(unique.values())))


main()
