# -*- coding: utf-8 -*-
__title__ = "Toggle\nRef Faces"
__doc__ = """Hides all reference faces (made with Reference Faces) in the active view; click again to show them.
Only the active view changes, the faces stay in the model."""

from System.Collections.Generic import List

from pyrevit import revit, forms, script
from Autodesk.Revit.DB import BuiltInParameter, DirectShape, ElementId, FilteredElementCollector, Transaction

doc = revit.doc
view = doc.ActiveView
TITLE = "Toggle Ref Faces"
LABEL = "PB Reference Faces"


def is_reference_face(e):
    if e.ApplicationDataId == "ReferenceFaces":
        return True
    p = e.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS)
    return p is not None and p.AsString() == LABEL


faces = [e for e in FilteredElementCollector(doc).OfClass(DirectShape) if is_reference_face(e)]
if not faces:
    forms.alert("There are no reference faces in this model yet (make them with Reference Faces).",
                title=TITLE, exitscript=True)

faces = [e for e in faces if e.CanBeHidden(view)]
if not faces:
    forms.alert("Reference faces cannot be hidden in this view. Open a plan, section, elevation or 3D view.",
                title=TITLE, exitscript=True)

shown = [e.Id for e in faces if not e.IsHidden(view)]
hide = bool(shown)                       # some are visible: hide them all; all hidden: show them all
ids = List[ElementId](shown if hide else [e.Id for e in faces])

t = Transaction(doc, "Hide reference faces" if hide else "Show reference faces")
t.Start()
try:
    if hide:
        view.HideElements(ids)
    else:
        view.UnhideElements(ids)
    t.Commit()
except Exception as ex:
    t.RollBack()
    forms.alert(u"Could not change the reference faces' visibility.\n\n{}".format(ex), title=TITLE,
                exitscript=True)

script.toggle_icon(not hide)
