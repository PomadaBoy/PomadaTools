using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using RevitThreeExport.Core;
using Xunit;

namespace RevitThreeExport.Tests
{
    /// <summary>
    /// Elements with their own origin (GlbElement.Origin / Basis): node transforms, shared
    /// meshes, and precision far from the model's origin.
    /// </summary>
    public class FrameTests
    {
        private static GlbElement Element(long id, double[] origin, double[] basis, int material = 0,
            double x0 = 0, double y0 = 0, double z0 = 0, double x1 = 1, double y1 = 2, double z1 = 3)
        {
            var e = new GlbElement
            {
                Category = "Generic Models", NodeName = "Box [" + id + "]", MeshName = id.ToString(),
                Origin = origin, Basis = basis,
                Extras = new JsonObject { { "id", id }, { "category", "Generic Models" } },
            };
            var p = new GlbPrimitive { Material = material };
            TestUtil.AddBox(p, x0, y0, z0, x1, y1, z1);
            e.Primitives.Add(p);
            return e;
        }

        private static GlbScene Scene(params GlbElement[] elements)
        {
            var s = new GlbScene { Origin = new[] { 5000.0, 3000.0, 100.0 } };
            s.Materials.Add(new GlbMaterial { Name = "A", Rgb = new[] { 200, 10, 10 } });
            s.Materials.Add(new GlbMaterial { Name = "B", Rgb = new[] { 10, 200, 10 } });
            s.Elements.AddRange(elements);
            return s;
        }

        // turned 90° about Z: local X -> Revit Y, local Y -> Revit -X
        private static readonly double[] Turn90 = { 0, 1, 0, -1, 0, 0, 0, 0, 1 };

        private static JsonElement ElementNode(ParsedGlb g, long id) =>
            g.Root.GetProperty("nodes").EnumerateArray().First(n => n.TryGetProperty("extras", out var x) && x.TryGetProperty("id", out var i) && i.GetInt64() == id);

        /// <summary>The Revit position (metres) of every vertex of an element node, as a viewer would place it.</summary>
        private static double[][] RevitPositions(ParsedGlb g, JsonElement node)
        {
            var m = new double[16];
            if (node.TryGetProperty("matrix", out var mat)) m = mat.EnumerateArray().Select(v => v.GetDouble()).ToArray();
            else
            {
                m[0] = m[5] = m[10] = m[15] = 1;
                if (node.TryGetProperty("translation", out var t))
                {
                    var tv = t.EnumerateArray().Select(v => v.GetDouble()).ToArray();
                    m[12] = tv[0]; m[13] = tv[1]; m[14] = tv[2];
                }
            }
            var off = g.Root.GetProperty("nodes")[0].GetProperty("extras").GetProperty("revitOffsetMetres").EnumerateArray().Select(v => v.GetDouble()).ToArray();
            var prim = g.Root.GetProperty("meshes")[node.GetProperty("mesh").GetInt32()].GetProperty("primitives")[0];
            var f = g.Floats(prim.GetProperty("attributes").GetProperty("POSITION").GetInt32());
            var result = new double[f.Length / 3][];
            for (var i = 0; i < f.Length; i += 3)
            {
                double x = f[i], y = f[i + 1], z = f[i + 2];
                double gx = m[0] * x + m[4] * y + m[8] * z + m[12];
                double gy = m[1] * x + m[5] * y + m[9] * z + m[13];
                double gz = m[2] * x + m[6] * y + m[10] * z + m[14];
                result[i / 3] = new[] { gx + off[0], -gz + off[1], gy + off[2] };   // glTF -> Revit
            }
            return result;
        }

        [Fact]
        public void IdenticalGeometryIsWrittenOnce()
        {
            var glb = TestUtil.WriteGlb(Scene(
                Element(1, new[] { 1.0, 2, 3 }, null),
                Element(2, new[] { 10.0, 0, 0 }, null),
                Element(3, new[] { 20.0, 0, 0 }, Turn90),
                Element(4, new[] { 30.0, 0, 0 }, null, material: 1),          // other material: its own mesh
                Element(5, new[] { 40.0, 0, 0 }, null, x1: 1.5)), out var stats);  // other shape: its own mesh
            var g = ParsedGlb.Parse(glb);
            Assert.Equal(3, g.Root.GetProperty("meshes").GetArrayLength());
            Assert.Equal(3, stats.Meshes);
            Assert.Equal(2, stats.SharedElements);
            Assert.Equal(5 * 12, stats.Triangles);   // every element counts its triangles
            int MeshOf(long id) => ElementNode(g, id).GetProperty("mesh").GetInt32();
            Assert.Equal(MeshOf(1), MeshOf(2));
            Assert.Equal(MeshOf(1), MeshOf(3));
            Assert.NotEqual(MeshOf(1), MeshOf(4));
            Assert.NotEqual(MeshOf(1), MeshOf(5));
            Assert.True(ElementNode(g, 2).TryGetProperty("translation", out _));
            Assert.True(ElementNode(g, 3).TryGetProperty("matrix", out _));
        }

        [Fact]
        public void NodeTransformsPutTheVerticesWhereRevitHasThem()
        {
            var scene = Scene(Element(1, new[] { 1.0, 2, 3 }, null), Element(3, new[] { 20.0, -4, 0.5 }, Turn90));
            var g = ParsedGlb.Parse(TestUtil.WriteGlb(scene, out _));
            var o = new[] { 5000.0, 3000.0, 100.0 };
            // element 1: Revit = scene origin + element origin + local
            var p1 = RevitPositions(g, ElementNode(g, 1));
            Assert.Contains(p1, v => Near(v, new[] { o[0] + 1, o[1] + 2, o[2] + 3 }));             // local (0, 0, 0)
            Assert.Contains(p1, v => Near(v, new[] { o[0] + 1 + 1, o[1] + 2 + 2, o[2] + 3 + 3 })); // local (1, 2, 3)
            // element 3, turned 90°: local (1, 2, 3) -> Revit (-2, 1, 3) from its origin
            var p3 = RevitPositions(g, ElementNode(g, 3));
            Assert.Contains(p3, v => Near(v, new[] { o[0] + 20, o[1] - 4, o[2] + 0.5 }));
            Assert.Contains(p3, v => Near(v, new[] { o[0] + 20 - 2, o[1] - 4 + 1, o[2] + 0.5 + 3 }));
            Assert.All(p3, v => Assert.InRange(v[0], o[0] + 18 - 1e-9, o[0] + 20 + 1e-9));
        }

        private static bool Near(double[] a, double[] b, double eps = 1e-6) =>
            Math.Abs(a[0] - b[0]) < eps && Math.Abs(a[1] - b[1]) < eps && Math.Abs(a[2] - b[2]) < eps;

        /// <summary>
        /// A box 1234.5 x 16 x 1000 mm, 20 km from another element: with its own origin its
        /// edges come back exact to the micrometre; positions relative to the model (the older
        /// layout) are off by about a millimetre out there.
        /// </summary>
        [Fact]
        public void FarElementsKeepMicrometrePrecision()
        {
            GlbScene FarScene(bool own)
            {
                var near = Element(1, own ? new[] { 0.0, 0, 0 } : null, null, x1: 1, y1: 1, z1: 1);
                var far = own
                    ? Element(2, new[] { 20000.0, 0, 0 }, null, x1: 1.2345, y1: 0.016, z1: 1)
                    : Element(2, null, null, x0: 20000, x1: 20001.2345, y1: 0.016, z1: 1);
                var s = Scene(near, far);
                s.Origin = new[] { 0.0, 0, 0 };
                return s;
            }
            double Error(bool own)
            {
                var g = ParsedGlb.Parse(TestUtil.WriteGlb(FarScene(own), out _));
                var p = RevitPositions(g, ElementNode(g, 2));
                double xs = p.Max(v => v[0]) - p.Min(v => v[0]), ys = p.Max(v => v[1]) - p.Min(v => v[1]);
                return Math.Max(Math.Abs(xs - 1.2345), Math.Abs(ys - 0.016));
            }
            Assert.True(Error(true) < 1e-6, $"own origin: {Error(true)} m");
            Assert.True(Error(false) > 1e-4, $"older layout: {Error(false)} m");
        }

        /// <summary>tests/out/far.html: the far box for the viewer's measuring test.</summary>
        [Fact]
        public void WritesFarModelForTheViewer()
        {
            var near = Element(900001, new[] { 0.0, 0, 0 }, null, x1: 1, y1: 1, z1: 1);
            var far = Element(900002, new[] { 20000.0, 0, 0 }, null, x1: 1.2345, y1: 0.016, z1: 1);
            var scene = Scene(near, far);
            scene.Name = "Daleko";
            scene.RootExtras = new JsonObject { { "document", "Daleko" }, { "view", "Export" }, { "exportedAt", "2026-11-26 12:00" } };
            var glb = TestUtil.WriteGlb(scene, out _);
            using (var fs = new FileStream(Path.Combine(TestUtil.OutDir, "far.html"), FileMode.Create, FileAccess.Write))
                HtmlPackager.Write(fs, HtmlPackager.LoadTemplate(), "Daleko", s => s.Write(glb, 0, glb.Length));
        }
    }
}
