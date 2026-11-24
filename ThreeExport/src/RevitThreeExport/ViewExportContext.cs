using System;
using System.Collections.Generic;
using System.Diagnostics;
using Autodesk.Revit.DB;
using RevitThreeExport.Core;

namespace RevitThreeExport
{
    /// <summary>The document an element comes from: the host, or a link instance's document.</summary>
    internal sealed class DocFrame
    {
        public Document Doc;
        /// <summary>"" for the host document, else the link instance id as text.</summary>
        public string Key = "";
        public string LinkName;
        public long LinkInstanceId = -1;
        public bool IsLink => LinkName != null;
    }

    /// <summary>One exported element: where it comes from and its triangles per material.</summary>
    internal sealed class ElementRecord
    {
        public DocFrame Frame;
        public ElementId Id;
        public long IdValue;
        public string Key;
        public int Triangles;
        public bool Kept;
        public readonly GlbElement Glb = new GlbElement();
        public readonly Dictionary<int, GlbPrimitive> ByMaterial = new Dictionary<int, GlbPrimitive>();

        private Element _element;
        private bool _looked;

        public Element Element
        {
            get
            {
                if (!_looked)
                {
                    _looked = true;
                    try { _element = Frame.Doc.GetElement(Id); } catch { _element = null; }
                }
                return _element;
            }
        }

        public GlbPrimitive PrimitiveFor(int material)
        {
            if (!ByMaterial.TryGetValue(material, out var p))
            {
                p = new GlbPrimitive { Material = material };
                ByMaterial[material] = p;
                Glb.Primitives.Add(p);
            }
            return p;
        }
    }

    /// <summary>
    /// Receives the view's geometry from CustomExporter: what Revit draws in the view
    /// (visibility, filters, phases, section box, detail level, links), already
    /// tessellated. Points arrive in the local coordinates of the current instance or
    /// link, so a transform stack is kept.
    /// </summary>
    internal sealed class ViewExportContext : IExportContext
    {
        private const double Ft = 0.3048;

        private readonly Document _host;
        private readonly ExportOptions _options;
        private readonly int _hostTotal;
        private readonly Stack<Transform> _transforms = new Stack<Transform>();
        private readonly Stack<DocFrame> _docs = new Stack<DocFrame>();
        private readonly Stack<ElementRecord> _elements = new Stack<ElementRecord>();
        private readonly Dictionary<string, ElementRecord> _byKey = new Dictionary<string, ElementRecord>();
        private readonly Dictionary<string, int> _materialIndex = new Dictionary<string, int>();
        private readonly Stopwatch _clock = Stopwatch.StartNew();
        private long _lastReport = -1000;
        private int _hostVisited;

        // material most recently announced by OnMaterial, and the document it belongs to
        private DocFrame _matFrame;
        private ElementId _matId;

        public readonly List<ElementRecord> Records = new List<ElementRecord>();
        public readonly List<GlbMaterial> Materials = new List<GlbMaterial>();
        public readonly List<string> Warnings = new List<string>();
        public bool Cancelled;
        public bool HaveOrigin;
        public readonly double[] Origin = new double[3];

        public ViewExportContext(Document host, ExportOptions options, int hostElementCount)
        {
            _host = host;
            _options = options;
            _hostTotal = Math.Max(1, hostElementCount);
        }

        public bool Start()
        {
            _transforms.Push(Transform.Identity);
            _docs.Push(new DocFrame { Doc = _host });
            Report(true);
            return true;
        }

        public void Finish() { }

        public bool IsCanceled()
        {
            Report(false);
            return Cancelled;
        }

        private void Report(bool force)
        {
            if (_options.Progress == null || Cancelled) return;
            var now = _clock.ElapsedMilliseconds;
            if (!force && now - _lastReport < 100) return;
            _lastReport = now;
            try
            {
                if (!_options.Progress("Reading geometry", Math.Min(_hostVisited, _hostTotal), _hostTotal))
                    Cancelled = true;
            }
            catch (Exception ex)
            {
                Warn("progress callback failed: " + ex.Message);
            }
        }

        private void Warn(string message)
        {
            if (Warnings.Count < 200) Warnings.Add(message);
        }

        public RenderNodeAction OnViewBegin(ViewNode node) => RenderNodeAction.Proceed;

        public void OnViewEnd(ElementId elementId) { }

        public RenderNodeAction OnElementBegin(ElementId elementId)
        {
            try
            {
                var frame = _docs.Peek();
                if (!frame.IsLink)
                {
                    _hostVisited++;
                    if (!_options.IncludeLinks && _host.GetElement(elementId) is RevitLinkInstance)
                        return RenderNodeAction.Skip;
                }
                var idValue = Ids.Of(elementId);
                var key = frame.IsLink ? frame.Key + ":" + idValue : idValue.ToString(System.Globalization.CultureInfo.InvariantCulture);
                if (!_byKey.TryGetValue(key, out var rec))
                {
                    rec = new ElementRecord { Frame = frame, Id = elementId, IdValue = idValue, Key = key };
                    _byKey[key] = rec;
                }
                _elements.Push(rec);
                Report(false);
            }
            catch (Exception ex)
            {
                Warn("element " + elementId + ": " + ex.Message);
                return RenderNodeAction.Skip;
            }
            return RenderNodeAction.Proceed;
        }

        public void OnElementEnd(ElementId elementId)
        {
            // only pop our own record: OnElementEnd may also come for a skipped element
            if (_elements.Count == 0 || !_elements.Peek().Id.Equals(elementId)) return;
            var rec = _elements.Pop();
            if (rec.Triangles > 0 && !rec.Kept)
            {
                rec.Kept = true;
                Records.Add(rec);
            }
        }

        public RenderNodeAction OnInstanceBegin(InstanceNode node)
        {
            _transforms.Push(_transforms.Peek().Multiply(node.GetTransform()));
            return RenderNodeAction.Proceed;
        }

        public void OnInstanceEnd(InstanceNode node)
        {
            if (_transforms.Count > 1) _transforms.Pop();
        }

        public RenderNodeAction OnLinkBegin(LinkNode node)
        {
            var linkDoc = node.GetDocument();
            var owner = _elements.Count > 0 ? _elements.Peek() : null;
            var instanceId = owner != null ? owner.IdValue : -1;
            var name = linkDoc != null ? linkDoc.Title : "Link";
            _docs.Push(new DocFrame
            {
                Doc = linkDoc ?? _docs.Peek().Doc,
                Key = (_docs.Peek().IsLink ? _docs.Peek().Key + "/" : "") + instanceId.ToString(System.Globalization.CultureInfo.InvariantCulture),
                LinkName = name,
                LinkInstanceId = instanceId,
            });
            _transforms.Push(_transforms.Peek().Multiply(node.GetTransform()));
            return RenderNodeAction.Proceed;
        }

        public void OnLinkEnd(LinkNode node)
        {
            if (_docs.Count > 1) _docs.Pop();
            if (_transforms.Count > 1) _transforms.Pop();
        }

        public RenderNodeAction OnFaceBegin(FaceNode node) => RenderNodeAction.Proceed;

        public void OnFaceEnd(FaceNode node) { }

        public void OnRPC(RPCNode node) { }

        public void OnLight(LightNode node) { }

        public void OnMaterial(MaterialNode node)
        {
            _matFrame = _docs.Peek();
            _matId = node.MaterialId;
        }

        private int MaterialFor(ElementRecord rec)
        {
            var frame = _matFrame ?? rec.Frame;
            var id = _matId != null ? Ids.Of(_matId) : -1;
            if (id >= 0)
            {
                var i = MaterialIndex(frame, id);
                if (i >= 0) return i;
            }
            // no material: the category's material, then the default grey
            try
            {
                var cat = rec.Element?.Category;
                var catMat = cat?.Material;
                if (catMat != null)
                {
                    var i = MaterialIndex(rec.Frame, Ids.Of(catMat.Id));
                    if (i >= 0) return i;
                }
            }
            catch { /* fall through to the default */ }
            return DefaultMaterial();
        }

        private int MaterialIndex(DocFrame frame, long id)
        {
            var key = frame.Key + ":" + id.ToString(System.Globalization.CultureInfo.InvariantCulture);
            if (_materialIndex.TryGetValue(key, out var index)) return index;
            Material m = null;
            try
            {
                m = frame.Doc.GetElement(ToElementId(id)) as Material;
            }
            catch { m = null; }
            if (m == null)
            {
                _materialIndex[key] = -1;
                return -1;
            }
            var mat = new GlbMaterial { Name = m.Name, RevitMaterialId = id, Transparency = m.Transparency / 100.0 };
            try
            {
                var c = m.Color;
                if (c != null && c.IsValid) mat.Rgb = new int[] { c.Red, c.Green, c.Blue };
            }
            catch { mat.Rgb = null; }
            if (frame.IsLink) mat.MoreExtras = new JsonObject { { "link", frame.LinkName } };
            Materials.Add(mat);
            _materialIndex[key] = Materials.Count - 1;
            return Materials.Count - 1;
        }

        private int DefaultMaterial()
        {
            const string key = "default";
            if (_materialIndex.TryGetValue(key, out var index)) return index;
            Materials.Add(new GlbMaterial());
            _materialIndex[key] = Materials.Count - 1;
            return Materials.Count - 1;
        }

        private static ElementId ToElementId(long id)
        {
#if REVIT2024_OR_GREATER
            return new ElementId(id);
#else
            return new ElementId((int)id);
#endif
        }

        public void OnPolymesh(PolymeshTopology mesh)
        {
            if (_elements.Count == 0) return;
            try
            {
                AddPolymesh(_elements.Peek(), mesh);
            }
            catch (Exception ex)
            {
                Warn("element " + _elements.Peek().Key + ": " + ex.Message);
            }
        }

        private void AddPolymesh(ElementRecord rec, PolymeshTopology mesh)
        {
            var nFacets = mesh.NumberOfFacets;
            var nPoints = mesh.NumberOfPoints;
            if (nFacets == 0 || nPoints == 0) return;

            var prim = rec.PrimitiveFor(MaterialFor(rec));
            var t = _transforms.Peek();
            var isIdentity = t.IsIdentity;

            // points -> metres in the host's coordinates
            var pts = mesh.GetPoints();
            var p = new double[nPoints * 3];
            for (var i = 0; i < nPoints; i++)
            {
                var q = isIdentity ? pts[i] : t.OfPoint(pts[i]);
                p[i * 3] = q.X * Ft;
                p[i * 3 + 1] = q.Y * Ft;
                p[i * 3 + 2] = q.Z * Ft;
            }
            if (!HaveOrigin)
            {
                HaveOrigin = true;
                for (var k = 0; k < 3; k++) Origin[k] = Math.Round(p[k]);
            }

            // normals in the host's axes (rotation only)
            var normals = mesh.NumberOfNormals > 0 ? mesh.GetNormals() : null;
            var dist = mesh.DistributionOfNormals;
            double[] nrm = null;
            if (normals != null && normals.Count > 0)
            {
                nrm = new double[normals.Count * 3];
                for (var i = 0; i < normals.Count; i++)
                {
                    var v = isIdentity ? normals[i] : t.OfVector(normals[i]);
                    var l = Math.Sqrt(v.X * v.X + v.Y * v.Y + v.Z * v.Z);
                    if (l <= 0) l = 1;
                    nrm[i * 3] = v.X / l;
                    nrm[i * 3 + 1] = v.Y / l;
                    nrm[i * 3 + 2] = v.Z / l;
                }
            }

            var facets = mesh.GetFacets();
            var baseVertex = prim.VertexCount;
            var baseIndex = prim.Indices.Count;
            double ox = Origin[0], oy = Origin[1], oz = Origin[2];

            if (nrm != null && dist == DistributionOfNormals.OnEachFacet && normals.Count >= nFacets)
            {
                // flat shading: three vertices of its own per facet
                for (var f = 0; f < nFacets; f++)
                {
                    var facet = facets[f];
                    int a = facet.V1, b = facet.V2, c = facet.V3;
                    if (Flipped(p, a, b, c, nrm[f * 3], nrm[f * 3 + 1], nrm[f * 3 + 2])) { var s = b; b = c; c = s; }
                    foreach (var v in new[] { a, b, c })
                    {
                        prim.Positions.Add((float)(p[v * 3] - ox), (float)(p[v * 3 + 1] - oy), (float)(p[v * 3 + 2] - oz));
                        prim.Normals.Add((float)nrm[f * 3], (float)nrm[f * 3 + 1], (float)nrm[f * 3 + 2]);
                    }
                    var n0 = baseVertex + f * 3;
                    prim.Indices.Add(n0, n0 + 1, n0 + 2);
                }
                rec.Triangles += nFacets;
                return;
            }

            for (var i = 0; i < nPoints; i++)
                prim.Positions.Add((float)(p[i * 3] - ox), (float)(p[i * 3 + 1] - oy), (float)(p[i * 3 + 2] - oz));

            var perPoint = nrm != null && dist == DistributionOfNormals.AtEachPoint && normals.Count >= nPoints;
            var onePerFace = nrm != null && !perPoint;   // OnePerFace, or a count we can't map: use the first
            for (var f = 0; f < nFacets; f++)
            {
                var facet = facets[f];
                int a = facet.V1, b = facet.V2, c = facet.V3;
                if (perPoint || onePerFace)
                {
                    double sx, sy, sz;
                    if (perPoint)
                    {
                        sx = nrm[a * 3] + nrm[b * 3] + nrm[c * 3];
                        sy = nrm[a * 3 + 1] + nrm[b * 3 + 1] + nrm[c * 3 + 1];
                        sz = nrm[a * 3 + 2] + nrm[b * 3 + 2] + nrm[c * 3 + 2];
                    }
                    else { sx = nrm[0]; sy = nrm[1]; sz = nrm[2]; }
                    // keep the winding consistent with the normals (mirrored instances flip it)
                    if (Flipped(p, a, b, c, sx, sy, sz)) { var s = b; b = c; c = s; }
                }
                prim.Indices.Add(baseVertex + a, baseVertex + b, baseVertex + c);
            }

            if (perPoint)
            {
                for (var i = 0; i < nPoints; i++)
                    prim.Normals.Add((float)nrm[i * 3], (float)nrm[i * 3 + 1], (float)nrm[i * 3 + 2]);
            }
            else if (onePerFace)
            {
                for (var i = 0; i < nPoints; i++)
                    prim.Normals.Add((float)nrm[0], (float)nrm[1], (float)nrm[2]);
            }
            else
            {
                MeshMath.AppendSmoothNormals(prim, baseVertex, baseIndex);
            }
            rec.Triangles += nFacets;
        }

        /// <summary>True when the triangle's winding faces away from the given normal.</summary>
        private static bool Flipped(double[] p, int a, int b, int c, double nx, double ny, double nz)
        {
            double ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
            double vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2];
            double gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
            return gx * nx + gy * ny + gz * nz < 0;
        }
    }
}
