using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Autodesk.Revit.DB;
using RevitThreeExport.Core;

namespace RevitThreeExport
{
    /// <summary>
    /// Element metadata in the prototype's format (revit_export.py: pval, params_of,
    /// type_names). Keys: id, uniqueId, category, family, type, level, mark, comments,
    /// volume_m3, materials, params, typeParams, and link / linkInstanceId for elements
    /// from linked models.
    /// </summary>
    internal sealed class MetadataCollector
    {
        private const double Ft3 = 0.3048 * 0.3048 * 0.3048;
        public const string NoCategory = "(No category)";

        private readonly View3D _view;
        private readonly bool _typeParams;
        private readonly Options _hostOptions;
        private readonly Options _linkOptions;
        private readonly Dictionary<string, JsonObject> _typeCache = new Dictionary<string, JsonObject>();
        private readonly Dictionary<string, string[]> _typeNames = new Dictionary<string, string[]>();
        private readonly Dictionary<long, bool> _styleHidden = new Dictionary<long, bool>();

        public MetadataCollector(View3D view, bool includeTypeParameters)
        {
            _view = view;
            _typeParams = includeTypeParameters;
            _hostOptions = new Options { View = view, ComputeReferences = false, IncludeNonVisibleObjects = false };
            _linkOptions = new Options { DetailLevel = view.DetailLevel, ComputeReferences = false, IncludeNonVisibleObjects = false };
        }

        public static string CategoryOf(Element e)
        {
            try
            {
                var name = e?.Category?.Name;
                return string.IsNullOrEmpty(name) ? NoCategory : name;
            }
            catch { return NoCategory; }
        }

        public JsonObject Collect(ElementRecord rec, IList<GlbMaterial> materials)
        {
            var doc = rec.Frame.Doc;
            var e = rec.Element;
            var names = TypeNames(doc, e);
            var o = new JsonObject
            {
                { "id", rec.IdValue },
                { "uniqueId", Safe(() => e?.UniqueId) },
                { "category", CategoryOf(e) },
                { "family", names[0] },
                { "type", names[1] },
                { "level", LevelName(doc, e) },
                { "mark", Bip(doc, e, BuiltInParameter.ALL_MODEL_MARK) },
                { "comments", Bip(doc, e, BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS) },
                { "volume_m3", Math.Round(Volume(rec) * Ft3, 4) },
                {
                    "materials", rec.ByMaterial.Keys
                        .Select(i => i >= 0 && i < materials.Count ? materials[i] : new GlbMaterial())
                        .OrderBy(m => m.RevitMaterialId)
                        .Select(m => m.Name ?? "Default").ToList()
                },
                { "params", ParamsOf(doc, e) },
                { "typeParams", _typeParams ? TypeParams(doc, e) : new JsonObject() },
            };
            if (rec.Frame.IsLink)
            {
                o["link"] = rec.Frame.LinkName;
                o["linkInstanceId"] = rec.Frame.LinkInstanceId;
            }
            return o;
        }

        private static string Safe(Func<string> f)
        {
            try { return f(); } catch { return null; }
        }

        private string[] TypeNames(Document doc, Element e)
        {
            var empty = new[] { "", "" };
            if (e == null) return empty;
            ElementId typeId;
            try { typeId = e.GetTypeId(); } catch { return empty; }
            var key = doc.GetHashCode() + ":" + Ids.Of(typeId);
            if (_typeNames.TryGetValue(key, out var cached)) return cached;
            var result = empty;
            try
            {
                var t = doc.GetElement(typeId);
                if (t != null)
                {
                    var fam = (t as ElementType)?.FamilyName ?? "";
                    var tn = t.get_Parameter(BuiltInParameter.SYMBOL_NAME_PARAM)?.AsString();
                    if (string.IsNullOrEmpty(tn)) tn = t.get_Parameter(BuiltInParameter.ALL_MODEL_TYPE_NAME)?.AsString();
                    result = new[] { fam, tn ?? "" };
                }
            }
            catch { result = empty; }
            _typeNames[key] = result;
            return result;
        }

        private static string LevelName(Document doc, Element e)
        {
            try
            {
                var lid = e?.LevelId;
                if (lid == null || Ids.Of(lid) <= 0) return null;
                return doc.GetElement(lid)?.Name;
            }
            catch { return null; }
        }

        private static string Bip(Document doc, Element e, BuiltInParameter bip)
        {
            try
            {
                var p = e?.get_Parameter(bip);
                return p != null ? Pval(doc, p) : null;
            }
            catch { return null; }
        }

        /// <summary>A parameter as display text, like the prototype's pval.</summary>
        public static string Pval(Document doc, Parameter p)
        {
            try
            {
                if (!p.HasValue) return null;
                var st = p.StorageType;
                if (st == StorageType.String) return p.AsString();
                if (st == StorageType.ElementId)
                {
                    var s = p.AsValueString();
                    if (!string.IsNullOrEmpty(s)) return s;
                    var r = p.AsElementId();
                    if (Ids.Of(r) > 0)
                    {
                        var el = doc.GetElement(r);
                        if (el != null)
                        {
                            var n = Safe(() => el.Name);
                            return string.IsNullOrEmpty(n) ? Ids.Of(r).ToString(CultureInfo.InvariantCulture) : n;
                        }
                    }
                    return null;
                }
                var v = p.AsValueString();
                if (!string.IsNullOrEmpty(v)) return v;
                if (st == StorageType.Integer) return p.AsInteger().ToString(CultureInfo.InvariantCulture);
                if (st == StorageType.Double) return PyFloat(p.AsDouble());
            }
            catch { return null; }
            return null;
        }

        /// <summary>A double as Python 2's str() writes it (12 significant digits).</summary>
        private static string PyFloat(double d)
        {
            var s = d.ToString("G12", CultureInfo.InvariantCulture);
            if (s.IndexOf('.') < 0 && s.IndexOf('E') < 0 && !double.IsNaN(d) && !double.IsInfinity(d)) s += ".0";
            return s.Replace("E+", "e+").Replace("E-", "e-");
        }

        public static JsonObject ParamsOf(Document doc, Element el)
        {
            var o = new JsonObject();
            if (el == null) return o;
            ParameterSet set;
            try { set = el.Parameters; } catch { return o; }
            foreach (Parameter p in set)
            {
                string name;
                try { name = p.Definition?.Name; } catch { continue; }
                if (string.IsNullOrEmpty(name)) continue;
                var v = Pval(doc, p);
                if (!string.IsNullOrEmpty(v)) o[name] = v;
            }
            return o;
        }

        private JsonObject TypeParams(Document doc, Element e)
        {
            if (e == null) return new JsonObject();
            ElementId typeId;
            try { typeId = e.GetTypeId(); } catch { return new JsonObject(); }
            if (Ids.Of(typeId) < 0) return new JsonObject();
            var key = doc.GetHashCode() + ":" + Ids.Of(typeId);
            if (!_typeCache.TryGetValue(key, out var o))
            {
                o = ParamsOf(doc, doc.GetElement(typeId));
                _typeCache[key] = o;
            }
            return o;
        }

        /// <summary>
        /// Volume in cubic feet: the element's solids, as the prototype summed them,
        /// else the HOST_VOLUME_COMPUTED parameter.
        /// </summary>
        private double Volume(ElementRecord rec)
        {
            var e = rec.Element;
            if (e == null) return 0;
            double vol = 0;
            try
            {
                var geo = e.get_Geometry(rec.Frame.IsLink ? _linkOptions : _hostOptions);
                if (geo != null) vol = SolidVolume(geo, !rec.Frame.IsLink, 0);
            }
            catch { vol = 0; }
            if (vol <= 0)
            {
                try
                {
                    var p = e.get_Parameter(BuiltInParameter.HOST_VOLUME_COMPUTED);
                    if (p != null && p.HasValue) vol = p.AsDouble();
                }
                catch { /* no volume */ }
            }
            return vol;
        }

        private double SolidVolume(GeometryElement geo, bool checkStyles, int depth)
        {
            double vol = 0;
            if (depth > 20) return 0;
            foreach (var o in geo)
            {
                if (o is GeometryInstance gi)
                {
                    if (checkStyles && StyleHidden(o)) continue;
                    var inner = gi.GetInstanceGeometry();
                    if (inner != null) vol += SolidVolume(inner, checkStyles, depth + 1);
                }
                else if (o is Solid s)
                {
                    if (s.Faces.Size == 0 || (checkStyles && StyleHidden(o))) continue;
                    try { vol += s.Volume; } catch { /* open solid */ }
                }
            }
            return vol;
        }

        /// <summary>True if the geometry's subcategory is switched off in the view.</summary>
        private bool StyleHidden(GeometryObject g)
        {
            try
            {
                var gsid = g.GraphicsStyleId;
                var key = Ids.Of(gsid);
                if (key < 0) return false;
                if (_styleHidden.TryGetValue(key, out var hidden)) return hidden;
                hidden = false;
                var gs = _view.Document.GetElement(gsid) as GraphicsStyle;
                var cat = gs?.GraphicsStyleCategory;
                if (cat != null)
                {
                    try { hidden = _view.GetCategoryHidden(cat.Id); } catch { hidden = false; }
                }
                _styleHidden[key] = hidden;
                return hidden;
            }
            catch { return false; }
        }
    }
}
