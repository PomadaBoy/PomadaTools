# -*- coding: utf-8 -*-
__title__ = "Pipe from\nLines"
__doc__ = """Select connected model lines (a single route, no branches) and create a pipe run along them.
Asks for pipe type, system, diameter, level and optional flex pipe type.
Checks every corner against standard PVC bend angles and what the pipe type's elbows can do,
suggests a fix for each problem corner (snap to bend / flex pipe / keep / leave open), then builds."""

import math

import clr
clr.AddReference("System")
from System.Collections.Generic import List

from pyrevit import revit, forms, script
from Autodesk.Revit.DB import (BuiltInParameter, Element, FailureProcessingResult, FailureSeverity,
                               FilteredElementCollector, IFailuresPreprocessor, Level, Line, ModelCurve,
                               RoutingPreferenceRuleGroupType, SubTransaction, Transaction, Transform,
                               UnitTypeId, UnitUtils, XYZ)
from Autodesk.Revit.DB.Plumbing import FlexPipe, FlexPipeType, Pipe, PipeType, PipingSystemType
from Autodesk.Revit.UI.Selection import ISelectionFilter, ObjectType
from Autodesk.Revit.Exceptions import OperationCanceledException

doc = revit.doc
uidoc = revit.uidoc
output = script.get_output()

# Real PVC (KG/HT) bend angles. A corner is "standard" if within ANGLE_TOL of one of these.
PVC_BENDS = (15.0, 30.0, 45.0, 67.5, 87.5)
ANGLE_TOL = 1.0          # degrees
COLLINEAR_TOL = 0.5      # degrees - smaller deflections are merged into one straight pipe
GAP_TOL_MM = 1.0         # max gap between line ends that still counts as connected
FLEX_LEG_MM = 300.0      # min length taken from each pipe when a corner is bridged by flex pipe
FLEX_LEG_DIAMETERS = 5.0 # ... or this many diameters, whichever is larger
PROBE_LEG_MM = 2000.0    # pipe length used when testing which bend angles the elbow family accepts

NO_FLEX = "<no flex pipes>"


def mm(v):
    return UnitUtils.ConvertToInternalUnits(v, UnitTypeId.Millimeters)


def to_mm(v):
    return UnitUtils.ConvertFromInternalUnits(v, UnitTypeId.Millimeters)


def id_int(eid):
    return eid.Value if hasattr(eid, "Value") else eid.IntegerValue


def ename(e):
    try:
        return e.Name
    except Exception:
        return Element.Name.__get__(e)


class ModelLineFilter(ISelectionFilter):
    def AllowElement(self, e):
        return isinstance(e, ModelCurve)

    def AllowReference(self, ref, pt):
        return False


class SwallowWarnings(IFailuresPreprocessor):
    def PreprocessFailures(self, accessor):
        for f in accessor.GetFailureMessages():
            if f.GetSeverity() == FailureSeverity.Warning:
                accessor.DeleteWarning(f)
        return FailureProcessingResult.Continue


def start_transaction(name):
    t = Transaction(doc, name)
    t.Start()
    opts = t.GetFailureHandlingOptions()
    opts.SetFailuresPreprocessor(SwallowWarnings())
    t.SetFailureHandlingOptions(opts)
    return t


# ---------------- 1. route from selected lines ----------------

def get_model_curves():
    picked = [doc.GetElement(i) for i in uidoc.Selection.GetElementIds()]
    picked = [e for e in picked if isinstance(e, ModelCurve)]
    if picked:
        return picked
    try:
        refs = uidoc.Selection.PickObjects(ObjectType.Element, ModelLineFilter(),
                                           "Select the connected model lines of the pipe route, then Finish")
    except OperationCanceledException:
        return []
    return [doc.GetElement(r) for r in refs]


def order_curves(curves):
    """Sort curves into one connected chain, reversing where needed. Returns oriented curves."""
    tol = mm(GAP_TOL_MM)
    nodes = []          # XYZ per node
    ends = []           # (node at end0, node at end1) per curve

    def node_of(p):
        for i, n in enumerate(nodes):
            if n.DistanceTo(p) <= tol:
                return i
        nodes.append(p)
        return len(nodes) - 1

    for c in curves:
        ends.append((node_of(c.GetEndPoint(0)), node_of(c.GetEndPoint(1))))

    degree = [0] * len(nodes)
    for a, b in ends:
        degree[a] += 1
        degree[b] += 1
    if any(d > 2 for d in degree):
        forms.alert("The lines branch (three or more meet at one point).\n"
                    "This tool handles a single route only.", exitscript=True)
    open_ends = [i for i, d in enumerate(degree) if d == 1]
    if not open_ends:
        forms.alert("The lines form a closed loop. Select an open route.", exitscript=True)
    if len(open_ends) > 2:
        forms.alert("The lines are not all connected (gap larger than {} mm somewhere).\n"
                    "Fix the gaps or select one continuous route.".format(GAP_TOL_MM), exitscript=True)

    ordered = []
    used = set()
    node = open_ends[0]
    while len(ordered) < len(curves):
        for i, (a, b) in enumerate(ends):
            if i in used or node not in (a, b):
                continue
            used.add(i)
            c = curves[i]
            if a == node:
                ordered.append(c)
                node = b
            else:
                ordered.append(c.CreateReversed())
                node = a
            break
        else:
            break
    return ordered


def make_pieces(curves):
    """Line -> straight piece, anything else -> curved piece (built as flex pipe)."""
    pieces = []
    for c in curves:
        if isinstance(c, Line):
            p0, p1 = c.GetEndPoint(0), c.GetEndPoint(1)
            d = (p1 - p0).Normalize()
            if pieces and pieces[-1]["kind"] == "line" and \
                    math.degrees(pieces[-1]["t1"].AngleTo(d)) < COLLINEAR_TOL:
                pieces[-1]["p1"] = p1        # merge collinear lines into one pipe
                continue
            pieces.append({"kind": "line", "p0": p0, "p1": p1, "t0": d, "t1": d})
        else:
            pts = list(c.Tessellate())
            t0 = c.ComputeDerivatives(0.0, True).BasisX.Normalize()
            t1 = c.ComputeDerivatives(1.0, True).BasisX.Normalize()
            pieces.append({"kind": "curve", "pts": pts, "p0": pts[0], "p1": pts[-1], "t0": t0, "t1": t1})
    return pieces


def nearest_bend(angle):
    return min(PVC_BENDS, key=lambda b: abs(b - angle))


def make_corners(pieces):
    corners = []
    for i in range(len(pieces) - 1):
        a, b = pieces[i], pieces[i + 1]
        ang = math.degrees(a["t1"].AngleTo(b["t0"]))
        kind = "elbow" if a["kind"] == "line" and b["kind"] == "line" else "direct"
        corners.append({"index": i + 1, "after": i, "point": a["p1"], "angle": ang, "kind": kind,
                        "bend": nearest_bend(ang), "revit_ok": None, "error": "", "action": None})
    return corners


# ---------------- 2. settings dialog ----------------

def by_name(elements):
    items = {}
    for e in elements:
        n = ename(e)
        if n in items:
            n = "{} [{}]".format(n, id_int(e.Id))
        items[n] = e
    return items


def ask(items, prompt, title, default=None):
    names = sorted(items.keys())
    if not names:
        return None
    pick = forms.ask_for_one_item(names, default=default or names[0], prompt=prompt, title=title)
    if pick is None:
        script.exit()
    return items[pick]


def pipe_sizes(pipe_type):
    """Nominal sizes from all segments in the pipe type's routing preferences: {label: nominal}."""
    rpm = pipe_type.RoutingPreferenceManager
    sizes = {}
    for i in range(rpm.GetNumberOfRules(RoutingPreferenceRuleGroupType.Segments)):
        seg = doc.GetElement(rpm.GetRule(RoutingPreferenceRuleGroupType.Segments, i).MEPPartId)
        if seg is None:
            continue
        for s in seg.GetSizes():
            if not s.UsedInSizeLists:
                continue
            label = "DN {:g}   (OD {:.1f} mm)".format(round(to_mm(s.NominalDiameter), 1), to_mm(s.OuterDiameter))
            sizes[label] = s.NominalDiameter
    return sizes


def ask_settings(route_z):
    pipe_types = by_name(FilteredElementCollector(doc).OfClass(PipeType))
    systems = by_name(FilteredElementCollector(doc).OfClass(PipingSystemType))
    if not pipe_types or not systems:
        forms.alert("The project needs at least one Pipe Type and one Piping System Type.", exitscript=True)

    pvc = [n for n in sorted(pipe_types) if "pvc" in n.lower()]
    pipe_type = ask(pipe_types, "Pipe type:", "Pipe from Lines (1/5)", pvc[0] if pvc else None)
    system = ask(systems, "Piping system:", "Pipe from Lines (2/5)")

    sizes = pipe_sizes(pipe_type)
    if not sizes:
        forms.alert("Pipe type '{}' has no sizes in its routing preferences segments.\n"
                    "Edit the pipe type > Routing Preferences > Segments.".format(ename(pipe_type)),
                    exitscript=True)
    labels = sorted(sizes, key=lambda k: sizes[k])
    size_label = forms.ask_for_one_item(labels, default=labels[0], prompt="Pipe diameter:",
                                        title="Pipe from Lines (3/5)")
    if size_label is None:
        script.exit()

    levels = sorted(FilteredElementCollector(doc).OfClass(Level), key=lambda l: l.Elevation)
    level_items = by_name(levels)
    default_level = None
    for l in levels:                     # highest level at or below the route start
        if l.Elevation <= route_z + mm(1):
            default_level = l
    if default_level is None and levels:
        default_level = levels[0]
    level = ask(level_items, "Reference level:", "Pipe from Lines (4/5)",
                ename(default_level) if default_level else None)

    flex_items = by_name(FilteredElementCollector(doc).OfClass(FlexPipeType))
    flex_names = [NO_FLEX] + sorted(flex_items)
    pick = forms.ask_for_one_item(flex_names, default=flex_names[1] if len(flex_names) > 1 else NO_FLEX,
                                  prompt="Flex pipe type (for arcs/splines and corners no bend fits):",
                                  title="Pipe from Lines (5/5)")
    if pick is None:
        script.exit()
    flex_type = flex_items.get(pick)

    return {"pipe_type": pipe_type, "system": system, "diameter": sizes[size_label], "label": size_label,
            "level": level, "flex_type": flex_type}


# ---------------- 3. pipe creation helpers ----------------

def create_pipe(s, p0, p1):
    p = Pipe.Create(doc, s["system"].Id, s["pipe_type"].Id, s["level"].Id, p0, p1)
    p.get_Parameter(BuiltInParameter.RBS_PIPE_DIAMETER_PARAM).Set(s["diameter"])
    return p


def create_flex(s, pts, t0, t1):
    f = FlexPipe.Create(doc, s["system"].Id, s["flex_type"].Id, s["level"].Id, t0, t1, List[XYZ](pts))
    try:
        f.get_Parameter(BuiltInParameter.RBS_PIPE_DIAMETER_PARAM).Set(s["diameter"])
    except Exception:
        pass
    return f


def connector_at(elem, pt):
    best, dist = None, None
    for c in elem.ConnectorManager.Connectors:
        d = c.Origin.DistanceTo(pt)
        if dist is None or d < dist:
            best, dist = c, d
    return best


def try_elbow(pipe_a, pipe_b, pt):
    """Place an elbow in a sub-transaction. Returns (fitting or None, error text)."""
    st = SubTransaction(doc)
    st.Start()
    try:
        fit = doc.Create.NewElbowFitting(connector_at(pipe_a, pt), connector_at(pipe_b, pt))
        doc.Regenerate()
        st.Commit()
        return fit, ""
    except Exception as ex:
        st.RollBack()
        return None, str(ex).split("\n")[0]


# ---------------- 4. probing (always rolled back) ----------------

def probe_route(s, pieces, corners):
    """Try each elbow on the real geometry, then undo everything."""
    t = start_transaction("Pipe from Lines - probe")
    try:
        pipes = {}
        for i, p in enumerate(pieces):
            if p["kind"] == "line":
                pipes[i] = create_pipe(s, p["p0"], p["p1"])
        doc.Regenerate()
        for c in corners:
            if c["kind"] != "elbow":
                continue
            fit, err = try_elbow(pipes[c["after"]], pipes[c["after"] + 1], c["point"])
            c["revit_ok"] = fit is not None
            c["error"] = err
    finally:
        t.RollBack()


def probe_bends(s, origin):
    """Which standard PVC angles can this pipe type's elbow make at this diameter?"""
    ok = set()
    leg = mm(PROBE_LEG_MM)
    t = start_transaction("Pipe from Lines - probe bends")
    try:
        for ang in PVC_BENDS:
            r = math.radians(ang)
            d2 = XYZ(math.cos(r), math.sin(r), 0)
            st = SubTransaction(doc)
            st.Start()
            try:
                a = create_pipe(s, origin - XYZ.BasisX * leg, origin)
                b = create_pipe(s, origin, origin + d2 * leg)
                doc.Regenerate()
                doc.Create.NewElbowFitting(connector_at(a, origin), connector_at(b, origin))
                doc.Regenerate()
                ok.add(ang)
            except Exception:
                pass
            finally:
                st.RollBack()
    finally:
        t.RollBack()
    return ok


# ---------------- 5. decide what to do at each corner ----------------

def corner_options(c, s, supported):
    opts = []
    if c["bend"] in supported:
        opts.append(("snap", "Snap to {:g}° bend (rotates the rest of the route)".format(c["bend"])))
    if c["revit_ok"]:
        opts.append(("keep", "Keep {:.1f}° elbow as drawn (not a standard PVC bend)".format(c["angle"])))
    if s["flex_type"] is not None:
        opts.append(("flex", "Bridge with flex pipe"))
    opts.append(("open", "Leave open (no fitting)"))
    return opts


def status_text(c):
    if c["kind"] == "direct":
        return "Pipe ↔ flex, connected directly"
    std = abs(c["angle"] - c["bend"]) <= ANGLE_TOL
    if c["revit_ok"] and std:
        return "OK - {:g}° bend".format(c["bend"])
    if c["revit_ok"]:
        return "Not a standard PVC bend (nearest {:g}°)".format(c["bend"])
    return "Elbow cannot be placed: {}".format(c["error"] or "unknown reason")


def is_problem(c):
    return c["kind"] == "elbow" and not (c["revit_ok"] and abs(c["angle"] - c["bend"]) <= ANGLE_TOL)


def print_corner_table(corners, title):
    output.print_md("### {}".format(title))
    rows = [[c["index"], "{:.2f}°".format(c["angle"]), status_text(c), c.get("note") or c["action"] or ""]
            for c in corners]
    output.print_table(rows, columns=["Corner", "Angle", "Check", "Action"])


def decide(corners, s, supported):
    problems = [c for c in corners if is_problem(c)]
    for c in corners:
        if c["kind"] == "elbow" and not is_problem(c):
            c["action"] = "elbow"
        elif c["kind"] == "direct":
            c["action"] = "direct"
    if not problems:
        return
    for c in problems:                       # default suggestion = first option
        c["action"] = corner_options(c, s, supported)[0][0]
    print_corner_table(corners, "Corner check (suggested actions)")

    choice = forms.CommandSwitchWindow.show(
        ["Use suggestions", "Decide per corner", "Cancel"],
        message="{} of {} corners need attention - see the output window.".format(len(problems), len(corners)))
    if choice is None or choice == "Cancel":
        script.exit()
    if choice == "Decide per corner":
        for c in problems:
            opts = corner_options(c, s, supported)
            labels = [o[1] for o in opts]
            pick = forms.CommandSwitchWindow.show(
                labels, message="Corner {}: {:.2f}° - {}".format(c["index"], c["angle"], status_text(c)))
            if pick is None:
                script.exit()
            c["action"] = opts[labels.index(pick)][0]
    for c in problems:
        if c["action"] == "keep":
            c["action"] = "elbow"


def apply_snaps(pieces, corners):
    """Rotate everything after a snapped corner so the deflection equals the bend angle."""
    for c in corners:
        if c["action"] != "snap":
            continue
        a, b = pieces[c["after"]], pieces[c["after"] + 1]
        d1, d2 = a["t1"], b["t0"]
        axis = d1.CrossProduct(d2)
        if axis.GetLength() < 1e-9:
            axis = XYZ.BasisZ.CrossProduct(d1)
            if axis.GetLength() < 1e-9:
                axis = XYZ.BasisX
        delta = math.radians(c["bend"] - c["angle"])
        tf = Transform.CreateRotationAtPoint(axis.Normalize(), delta, c["point"])
        for p in pieces[c["after"] + 1:]:
            p["p0"], p["p1"] = tf.OfPoint(p["p0"]), tf.OfPoint(p["p1"])
            p["t0"], p["t1"] = tf.OfVector(p["t0"]), tf.OfVector(p["t1"])
            if p["kind"] == "curve":
                p["pts"] = [tf.OfPoint(q) for q in p["pts"]]
        for later in corners:
            if later["index"] > c["index"]:
                later["point"] = tf.OfPoint(later["point"])
        c["note"] = "snapped {:.2f}° → {:g}° (route after it rotated)".format(c["angle"], c["bend"])
        c["angle"] = c["bend"]
        c["revit_ok"], c["error"] = True, ""
        c["action"] = "elbow"


# ---------------- 6. build ----------------

def flex_leg(s, pieces, c):
    a, b = pieces[c["after"]], pieces[c["after"] + 1]
    want = max(mm(FLEX_LEG_MM), FLEX_LEG_DIAMETERS * s["diameter"])
    return min(want, 0.4 * a["p0"].DistanceTo(a["p1"]), 0.4 * b["p0"].DistanceTo(b["p1"]))


def bezier(p0, ctrl, p1, n=8):
    pts = []
    for k in range(n + 1):
        t = float(k) / n
        pts.append(p0 * ((1 - t) ** 2) + ctrl * (2 * t * (1 - t)) + p1 * (t ** 2))
    return pts


def build(s, pieces, corners):
    created, problems = [], []
    by_after = dict((c["after"], c) for c in corners)
    t = start_transaction("Pipe from Lines")
    try:
        # trim straight pieces where a corner becomes flex pipe
        ends = []
        for i, p in enumerate(pieces):
            p0, p1 = p["p0"], p["p1"]
            if p["kind"] == "line":
                before, after = by_after.get(i - 1), by_after.get(i)
                if before and before["action"] == "flex":
                    p0 = p0 + p["t0"] * flex_leg(s, pieces, before)
                if after and after["action"] == "flex":
                    p1 = p1 - p["t1"] * flex_leg(s, pieces, after)
            ends.append((p0, p1))

        elems = []
        for i, p in enumerate(pieces):
            p0, p1 = ends[i]
            if p["kind"] == "line":
                e = create_pipe(s, p0, p1)
            else:
                e = create_flex(s, p["pts"], p["t0"], p["t1"])
            elems.append(e)
            created.append(e)
        doc.Regenerate()

        for c in corners:
            i = c["after"]
            a, b = elems[i], elems[i + 1]
            if c["action"] == "elbow":
                fit, err = try_elbow(a, b, c["point"])
                if fit is not None:
                    created.append(fit)
                else:
                    problems.append("Corner {}: elbow failed - {}".format(c["index"], err))
            elif c["action"] == "flex":
                pa, pb = ends[i][1], ends[i + 1][0]
                f = create_flex(s, bezier(pa, c["point"], pb), pieces[i]["t1"], pieces[i + 1]["t0"])
                created.append(f)
                doc.Regenerate()
                for pipe, pt in ((a, pa), (b, pb)):
                    try:
                        connector_at(pipe, pt).ConnectTo(connector_at(f, pt))
                    except Exception as ex:
                        problems.append("Corner {}: flex not connected - {}".format(c["index"], ex))
            elif c["action"] == "direct":
                try:
                    connector_at(a, c["point"]).ConnectTo(connector_at(b, c["point"]))
                except Exception as ex:
                    problems.append("Corner {}: pipe/flex not connected - {}".format(c["index"], ex))
            elif c["action"] == "open":
                problems.append("Corner {}: left open as requested".format(c["index"]))
        t.Commit()
    except Exception:
        t.RollBack()
        raise
    return created, problems


# ---------------- main ----------------

def main():
    elems = get_model_curves()
    if not elems:
        return
    curves = order_curves([e.GeometryCurve for e in elems])
    pieces = make_pieces(curves)
    corners = make_corners(pieces)

    s = ask_settings(pieces[0]["p0"].Z)
    if s["flex_type"] is None and any(p["kind"] == "curve" for p in pieces):
        forms.alert("The route contains arcs or splines. Pick a flex pipe type for them,\n"
                    "or redraw the curves as straight lines.", exitscript=True)

    try:
        probe_route(s, pieces, corners)
    except Exception as ex:
        forms.alert("Could not create pipes along the lines:\n{}\n\n"
                    "Check that no line is shorter than the pipe type allows.".format(ex), exitscript=True)
    supported = probe_bends(s, pieces[0]["p0"])
    decide(corners, s, supported)
    apply_snaps(pieces, corners)

    created, problems = build(s, pieces, corners)

    output.print_md("## Pipe from Lines - result")
    output.print_md("**Pipe type:** {}  |  **System:** {}  |  **Size:** {}  |  **Level:** {}".format(
        ename(s["pipe_type"]), ename(s["system"]), s["label"], ename(s["level"])))
    output.print_md("**PVC bends this pipe type can place at this size:** {}".format(
        ", ".join("{:g}°".format(a) for a in sorted(supported)) or "none"))
    if corners:
        print_corner_table(corners, "Corners")
    output.print_md("**Created {} elements:** {}".format(len(created), output.linkify([e.Id for e in created])))
    if problems:
        output.print_md("### Needs attention")
        for p in problems:
            output.print_md("- " + p)
    else:
        output.print_md("All corners connected.")


main()
