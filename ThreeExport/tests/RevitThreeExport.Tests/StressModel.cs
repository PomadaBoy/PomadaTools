using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using RevitThreeExport.Core;
using Xunit;

namespace RevitThreeExport.Tests
{
    /// <summary>
    /// A big steel hall for speed work (tests/out/stress.html): about 30,000 elements, most
    /// of them bolts and nuts placed many times, like a steel model with its connections,
    /// and reinforcement in the footings. The viewer's bench script and batching tests use it.
    /// Written as the exporter writes a model: each element with its own origin (and turned
    /// like a family instance where it is), so repeated parts share one mesh, and type
    /// parameters once per type in the root's "types".
    /// </summary>
    public static class StressModel
    {
        private static readonly CultureInfo C = CultureInfo.InvariantCulture;

        private const int Nx = 16, Ny = 12;          // bays
        private const double Span = 6.0, Height = 8.0;
        private const int BoltsPerPlate = 16;

        private static readonly (string Name, int[] Rgb, long Id)[] Mats =
        {
            ("Čelik S355", new[] { 70, 110, 160 }, 510001),
            ("Vijci 8.8 – pocinkovano", new[] { 165, 168, 172 }, 510002),
            ("Beton C30/37", new[] { 180, 180, 175 }, 510003),
            ("Armatura B500B", new[] { 125, 70, 55 }, 510004),
        };
        private const int Steel = 0, Zinc = 1, Concrete = 2, Rebar = 3;

        public static GlbScene Build()
        {
            var origin = new[] { 7000.0, 3000.0, 0.0 };
            var scene = new GlbScene
            {
                Name = "Čelična hala",
                Generator = "RevitThreeExport tests",
                Origin = origin,
                RootExtras = new JsonObject
                {
                    { "source", "Revit" }, { "document", "Čelična hala" }, { "view", "Export" },
                    { "viewId", 4343L }, { "exportedAt", "2026-11-26 12:00" },
                },
            };
            foreach (var m in Mats)
                scene.Materials.Add(new GlbMaterial { Name = m.Name, Rgb = m.Rgb, RevitMaterialId = m.Id });

            var b = new Builder(scene, origin);
            for (var i = 0; i <= Nx; i++)
                for (var j = 0; j <= Ny; j++)
                {
                    double x = i * Span, y = j * Span;
                    b.Footing(x, y);
                    b.Column(x, y);
                    // an end plate on each side of the column top that has a beam, each with its bolts
                    if (i < Nx) b.Connection(x + 0.2, y, 0);
                    if (i > 0) b.Connection(x - 0.2, y, 180);
                    if (j < Ny) b.Connection(x, y + 0.2, 90);
                    if (j > 0) b.Connection(x, y - 0.2, 270);
                    if (i < Nx) b.Beam(x, y, x + Span, y);
                    if (j < Ny) b.Beam(x, y, x, y + Span);
                }
            // purlins on the roof
            for (var i = 0; i < Nx; i++)
                for (var k = 1; k < 4; k++)
                    b.Beam(i * Span + k * Span / 4, 0, i * Span + k * Span / 4, Ny * Span, purlin: true);
            // handrails along the long sides, finely tessellated like Revit's round sections
            for (var k = 0; k < 4; k++)
                b.Handrail(-1.0 - (k % 2) * 0.4, 0.9 + (k / 2) * 0.2);

            scene.Elements.AddRange(b.Elements
                .OrderBy(e => e.Category, StringComparer.Ordinal)
                .ThenBy(e => (long)e.Extras["id"]));
            scene.RootExtras["types"] = b.Types;
            return scene;
        }

        private sealed class Builder
        {
            private readonly GlbScene _scene;
            private readonly double[] _o;
            private long _id = 2000000;
            private static readonly double[] Zero = { 0, 0, 0 };
            public readonly List<GlbElement> Elements = new List<GlbElement>();
            public readonly JsonObject Types = new JsonObject();

            /// <summary>The element's own origin at (x, y, z), turned deg about Z: its geometry is drawn around 0.</summary>
            private void Place(GlbElement e, double x, double y, double z, double deg = 0)
            {
                e.Origin = new[] { x - _o[0], y - _o[1], z - _o[2] };
                if (deg == 0) return;
                double a = deg * Math.PI / 180, c = Math.Round(Math.Cos(a), 12), s = Math.Round(Math.Sin(a), 12);
                e.Basis = new[] { c, s, 0, -s, c, 0, 0, 0, 1 };
            }

            public Builder(GlbScene scene, double[] origin) { _scene = scene; _o = origin; }

            private GlbElement Element(string category, string family, string type, string level, int material, double length, double volume)
            {
                var id = _id++;
                var e = new GlbElement { Category = category, NodeName = category + " – " + type + " [" + id + "]", MeshName = id.ToString(C) };
                e.Primitives.Add(new GlbPrimitive { Material = material });
                var ps = new JsonObject
                {
                    { "Category", category }, { "Family", family }, { "Type", type }, { "Family and Type", family + ": " + type },
                    { "Level", level }, { "Phase Created", "New Construction" }, { "Structural Material", Mats[material].Name },
                    { "Length", length.ToString("0", C) + " mm" }, { "Volume", volume.ToString("0.000", C) + " m³" },
                    { "Type Id", (type.Aggregate(0, (h, ch) => (h * 31 + ch) % 5000) + 3000).ToString(C) },
                };
                if (id % 13 == 0) ps["Mark"] = "P-" + (id % 10000).ToString(C);
                var tp = new JsonObject
                {
                    { "Family Name", family }, { "Type Name", type }, { "Manufacturer", "Pomada Steel" },
                    { "Assembly Code", category == "Structural Connections" ? "B2010" : "B1010" },
                    { "Type Comments", "Stress test type " + type },
                };
                e.Extras = new JsonObject
                {
                    { "id", id }, { "uniqueId", "00000000-0000-4000-9000-" + id.ToString("x12", C) },
                    { "category", category }, { "family", family }, { "type", type }, { "level", level },
                    { "volume_m3", Math.Round(volume, 6) },
                    { "materials", new List<object> { Mats[material].Name } },
                    { "params", ps },
                    { "paramNumbers", new JsonObject { { "Length", Math.Round(length, 6) }, { "Volume", Math.Round(volume, 9) } } },
                    { "typeRef", (string)ps["Type Id"] },
                };
                if (!Types.ContainsKey((string)ps["Type Id"]))
                    Types[(string)ps["Type Id"]] = new JsonObject { { "params", tp }, { "numbers", new JsonObject() } };
                Elements.Add(e);
                return e;
            }

            private GlbPrimitive Prim(GlbElement e) => e.Primitives[0];

            public void Footing(double x, double y)
            {
                var f = Element("Structural Foundations", "Footing-Rectangular", "Temelj 150x150x80", "Temelji", Concrete, 1500, 1.8);
                Place(f, x, y, 0);
                Shapes.Box(Prim(f), -0.75, -0.75, -0.8, 0.75, 0.75, 0, Zero);
                // a rebar set: two layers of eight bars each way
                var r = Element("Structural Rebar", "Rebar Bar", "Ø16 B500B", "Temelji", Rebar, 1400, 0.0045);
                Place(r, x, y, 0);
                for (var layer = 0; layer < 2; layer++)
                    for (var k = 0; k < 8; k++)
                    {
                        var t = -0.65 + k * 1.3 / 7;
                        var z = -0.72 + layer * 0.64;
                        Shapes.Tube(Prim(r), new[] { -0.7, t, z }, new[] { 0.7, t, z }, 0.008, 8, Zero, segments: 6);
                        Shapes.Tube(Prim(r), new[] { t, -0.7, z + 0.02 }, new[] { t, 0.7, z + 0.02 }, 0.008, 8, Zero, segments: 6);
                    }
            }

            public void Column(double x, double y)
            {
                var c = Element("Structural Columns", "HEB", "HEB 300", "Temelji", Steel, Height * 1000, 0.012 * Height);
                Place(c, x, y, 0);
                Shapes.ISection(Prim(c), new[] { 0.0, 0, 0 }, new[] { 0.0, 0, Height }, 0.3, 0.3, 0.019, 0.011, Zero);
            }

            public void Beam(double x0, double y0, double x1, double y1, bool purlin = false)
            {
                var len = Math.Sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0));
                var e = Element("Structural Framing", purlin ? "IPE" : "HEA", purlin ? "IPE 160" : "HEA 400", "Krov", Steel, len * 1000, (purlin ? 0.002 : 0.016) * len);
                double z = purlin ? Height + 0.47 : Height - 0.2;
                double h = purlin ? 0.16 : 0.39, w = purlin ? 0.082 : 0.3;
                // drawn along local X from its start, turned to its direction
                Place(e, x0, y0, z - h / 2, Math.Atan2(y1 - y0, x1 - x0) * 180 / Math.PI);
                Shapes.ISection(Prim(e), new[] { 0.0, 0, 0 }, new[] { len, 0, 0 }, h, w, purlin ? 0.0074 : 0.019, purlin ? 0.005 : 0.011, Zero, vertical: false);
            }

            /// <summary>A round handrail pipe along the hall at y, height z: 19,200 triangles.</summary>
            public void Handrail(double y, double z)
            {
                var len = Nx * Span;
                var e = Element("Railings", "Ograda", "Cev Ø60", "Temelji", Steel, len * 1000, Math.PI * 0.03 * 0.03 * len);
                Place(e, 0, y, z);
                Shapes.Tube(Prim(e), new[] { 0.0, 0, 0 }, new[] { len, 0, 0 }, 0.03, 24, Zero, segments: 400);
            }

            /// <summary>An end plate facing direction deg (0 = +X) at the column top, with its bolts and nuts.</summary>
            public void Connection(double x, double y, double deg)
            {
                double a = deg * Math.PI / 180, ux = Math.Cos(a), uy = Math.Sin(a);   // plate normal
                double vx = -uy, vy = ux;                                              // along the plate
                // each part is a family instance: drawn in its own axes (local X = the plate's
                // normal), turned by deg, so all plates, bolts and nuts share three meshes
                var plate = Element("Structural Connections", "Čeona ploča", "Ploča 300x450x20", "Krov", Steel, 450, 0.0027);
                var pc = new[] { x, y, Height - 0.2 };
                Place(plate, pc[0], pc[1], pc[2], deg);
                Shapes.OrientedBox(Prim(plate), Zero, new[] { 1.0, 0, 0 }, new[] { 0.0, 1, 0 }, 0.02, 0.3, 0.45, Zero);
                for (var k = 0; k < BoltsPerPlate; k++)
                {
                    double s = (k % 2 == 0 ? -1 : 1) * 0.1, zz = -0.19 + (k / 2) * 0.38 / 7;
                    var at = new[] { pc[0] + vx * s, pc[1] + vy * s, pc[2] + zz };
                    var bolt = Element("Structural Connections", "Vijak M20", "M20x80 8.8", "Krov", Zinc, 80, 0.00003);
                    Place(bolt, at[0], at[1], at[2], deg);
                    Shapes.Tube(Prim(bolt), new[] { -0.043, 0, 0 }, new[] { -0.03, 0, 0 }, 0.017, 6, Zero, caps: true);
                    Shapes.Tube(Prim(bolt), new[] { -0.03, 0, 0 }, new[] { 0.05, 0, 0 }, 0.01, 8, Zero, caps: true);
                    var nut = Element("Structural Connections", "Navrtka M20", "M20 8", "Krov", Zinc, 16, 0.00001);
                    Place(nut, at[0], at[1], at[2], deg);
                    Shapes.Tube(Prim(nut), new[] { 0.012, 0, 0 }, new[] { 0.028, 0, 0 }, 0.017, 6, Zero, caps: true);
                }
            }
        }
    }

    /// <summary>Simple solids in Revit axes (Z up), metres relative to an origin, flat-shaded like Revit's facets.</summary>
    internal static class Shapes
    {
        private static void Quad(GlbPrimitive p, double[][] c, double[] o)
        {
            var first = p.VertexCount;
            var firstIndex = p.Indices.Count;
            foreach (var v in c) p.Positions.Add((float)(v[0] - o[0]), (float)(v[1] - o[1]), (float)(v[2] - o[2]));
            p.Indices.Add(first, first + 1, first + 2);
            p.Indices.Add(first, first + 2, first + 3);
            MeshMath.AppendSmoothNormals(p, first, firstIndex);
        }

        public static void Box(GlbPrimitive p, double x0, double y0, double z0, double x1, double y1, double z1, double[] o) =>
            TestUtil.AddBox(p, x0, y0, z0, x1, y1, z1, o);

        /// <summary>A box centred on c with axes u (thickness t), v (width w) and Z (height h).</summary>
        public static void OrientedBox(GlbPrimitive p, double[] c, double[] u, double[] v, double t, double w, double h, double[] o)
        {
            var corners = new double[8][];
            for (var k = 0; k < 8; k++)
            {
                double su = (k & 1) == 0 ? -t / 2 : t / 2, sv = (k & 2) == 0 ? -w / 2 : w / 2, sz = (k & 4) == 0 ? -h / 2 : h / 2;
                corners[k] = new[] { c[0] + u[0] * su + v[0] * sv, c[1] + u[1] * su + v[1] * sv, c[2] + sz };
            }
            int[][] faces = { new[] { 0, 2, 3, 1 }, new[] { 4, 5, 7, 6 }, new[] { 0, 1, 5, 4 }, new[] { 2, 6, 7, 3 }, new[] { 0, 4, 6, 2 }, new[] { 1, 3, 7, 5 } };
            foreach (var f in faces) Quad(p, f.Select(i => corners[i]).ToArray(), o);
        }

        /// <summary>An I-section from a to b: height h, flange width w, flange tf, web tw.</summary>
        public static void ISection(GlbPrimitive p, double[] a, double[] b, double h, double w, double tf, double tw, double[] o, bool vertical = true)
        {
            if (vertical)
            {
                double x = a[0], y = a[1];
                Box(p, x - w / 2, y - h / 2, a[2], x + w / 2, y - h / 2 + tf, b[2], o);
                Box(p, x - w / 2, y + h / 2 - tf, a[2], x + w / 2, y + h / 2, b[2], o);
                Box(p, x - tw / 2, y - h / 2 + tf, a[2], x + tw / 2, y + h / 2 - tf, b[2], o);
                return;
            }
            double dx = b[0] - a[0], dy = b[1] - a[1], l = Math.Sqrt(dx * dx + dy * dy);
            var u = new[] { dx / l, dy / l, 0 };
            var v = new[] { -u[1], u[0], 0 };
            var mid = new[] { (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, a[2] };
            // web and flanges as boxes along u: OrientedBox takes thickness along its first axis
            OrientedBox(p, new[] { mid[0], mid[1], mid[2] + h / 2 - tf / 2 }, v, u, w, l, tf, o);
            OrientedBox(p, new[] { mid[0], mid[1], mid[2] - h / 2 + tf / 2 }, v, u, w, l, tf, o);
            OrientedBox(p, mid, v, u, tw, l, h - 2 * tf, o);
        }

        /// <summary>A prism of n sides around the axis a -> b (flat sides), optionally capped; segments along its length.</summary>
        public static void Tube(GlbPrimitive p, double[] a, double[] b, double r, int n, double[] o, bool caps = false, int segments = 1)
        {
            double dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2], l = Math.Sqrt(dx * dx + dy * dy + dz * dz);
            var w = new[] { dx / l, dy / l, dz / l };
            var helper = Math.Abs(w[2]) < 0.9 ? new[] { 0.0, 0, 1 } : new[] { 1.0, 0, 0 };
            var u = Norm(Cross(helper, w));
            var v = Cross(w, u);
            double[] Ring(double t, int k)
            {
                var ang = 2 * Math.PI * k / n;
                double cu = Math.Cos(ang) * r, sv = Math.Sin(ang) * r;
                return new[] { a[0] + dx * t + u[0] * cu + v[0] * sv, a[1] + dy * t + u[1] * cu + v[1] * sv, a[2] + dz * t + u[2] * cu + v[2] * sv };
            }
            for (var s = 0; s < segments; s++)
            {
                double t0 = (double)s / segments, t1 = (double)(s + 1) / segments;
                for (var k = 0; k < n; k++)
                    Quad(p, new[] { Ring(t0, k), Ring(t0, k + 1), Ring(t1, k + 1), Ring(t1, k) }, o);
            }
            if (!caps) return;
            foreach (var t in new[] { 0.0, 1.0 })
            {
                var first = p.VertexCount;
                var firstIndex = p.Indices.Count;
                for (var k = 0; k < n; k++)
                {
                    var c = Ring(t, t == 0 ? n - k : k);
                    p.Positions.Add((float)(c[0] - o[0]), (float)(c[1] - o[1]), (float)(c[2] - o[2]));
                }
                for (var k = 1; k + 1 < n; k++) p.Indices.Add(first, first + k, first + k + 1);
                MeshMath.AppendSmoothNormals(p, first, firstIndex);
            }
        }

        private static double[] Cross(double[] a, double[] b) =>
            new[] { a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0] };

        private static double[] Norm(double[] a)
        {
            var l = Math.Sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
            return new[] { a[0] / l, a[1] / l, a[2] / l };
        }
    }

    public class StressModelTests
    {
        [Fact]
        public void WritesStressGlbAndHtml()
        {
            var glb = TestUtil.WriteGlb(StressModel.Build(), out var stats);
            Assert.InRange(stats.Elements, 25000, 40000);
            // repeated parts share their mesh: about a dozen distinct shapes
            Assert.InRange(stats.Meshes, 5, 40);
            Assert.Equal(stats.Elements - stats.Meshes, stats.SharedElements);
            var dir = TestUtil.OutDir;
            File.WriteAllBytes(Path.Combine(dir, "stress.glb"), glb);
            using (var fs = new FileStream(Path.Combine(dir, "stress.html"), FileMode.Create, FileAccess.Write))
                HtmlPackager.Write(fs, HtmlPackager.LoadTemplate(), "Čelična hala", s => s.Write(glb, 0, glb.Length));
            File.WriteAllText(Path.Combine(dir, "stress.stats.json"), Json.Serialize(new JsonObject
            {
                { "elements", stats.Elements }, { "triangles", stats.Triangles }, { "vertices", stats.Vertices }, { "bytes", stats.Bytes },
                { "meshes", stats.Meshes },
                { "perCategory", stats.PerCategory.OrderBy(kv => kv.Key, StringComparer.Ordinal).ToDictionary(kv => kv.Key, kv => (object)kv.Value) },
            }));
        }
    }
}
