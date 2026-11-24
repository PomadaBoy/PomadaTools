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
    /// A made-up building, about 300 boxes in five categories on four levels, with
    /// parameters shaped like Revit's display strings. Used to exercise the viewer
    /// (tests/out/synthetic.html) without Revit.
    /// </summary>
    public static class SyntheticModel
    {
        private static readonly CultureInfo C = CultureInfo.InvariantCulture;

        private sealed class Mat
        {
            public string Name;
            public int[] Rgb;
            public double Transparency;
            public long Id;
        }

        private static readonly Mat[] Mats =
        {
            new Mat { Name = "Beton C25/30", Rgb = new[] { 180, 180, 175 }, Id = 452386 },
            new Mat { Name = "Čelik S355", Rgb = new[] { 70, 110, 160 }, Id = 452390 },
            new Mat { Name = "Kulir", Rgb = new[] { 91, 85, 66 }, Id = 842192 },
            new Mat { Name = "Drvo – hrast", Rgb = new[] { 160, 120, 70 }, Id = 452401 },
            new Mat { Name = "Staklo", Rgb = new[] { 150, 200, 230 }, Transparency = 0.6, Id = 452410 },
            new Mat { Name = "Crep", Rgb = new[] { 170, 70, 50 }, Id = 452420 },
            new Mat { Name = "Završni sloj – keramika", Rgb = new[] { 225, 220, 205 }, Id = 452430 },
        };

        private static readonly string[] Levels = { "Nula", "Prvi sprat", "Drugi sprat", "Treći sprat" };
        private const double StoreyHeight = 4.0;
        private const double Bay = 10.0;
        private const int Bays = 3;

        public static GlbScene Build()
        {
            var origin = new[] { 12000.0, 8000.0, 0.0 };
            var scene = new GlbScene
            {
                Name = "Sintetički model",
                Generator = "RevitThreeExport tests",
                Origin = origin,
                RootExtras = new JsonObject
                {
                    { "source", "Revit" }, { "document", "Sintetički model" }, { "view", "Export" },
                    { "viewId", 4242L }, { "exportedAt", "2026-11-24 12:00" },
                },
            };
            foreach (var m in Mats)
                scene.Materials.Add(new GlbMaterial { Name = m.Name, Rgb = m.Rgb, Transparency = m.Transparency, RevitMaterialId = m.Id });

            var elements = new List<GlbElement>();
            long nextId = 100000;
            var rng = new Random(42);
            double bx = origin[0] - 15, by = origin[1] - 15;   // building corner, Revit metres

            for (var l = 0; l < Levels.Length; l++)
            {
                var z = l * StoreyHeight;
                // floors, one per bay; top face in ceramic finish
                for (var i = 0; i < Bays; i++)
                    for (var j = 0; j < Bays; j++)
                    {
                        double x0 = bx + i * Bay, y0 = by + j * Bay;
                        elements.Add(Box(scene, nextId++, "Floors", "Floor", "Ploča 30 cm", Levels[l], origin,
                            x0, y0, z - 0.3, x0 + Bay, y0 + Bay, z, new[] { 0, 6 }, rng, (l + i + j) % 3 == 0 ? "Novi most" : "Stari most"));
                    }
                // columns at the grid points
                for (var i = 0; i <= Bays; i++)
                    for (var j = 0; j <= Bays; j++)
                    {
                        double x = bx + i * Bay, y = by + j * Bay;
                        var steel = (i + j) % 2 == 0;
                        elements.Add(Box(scene, nextId++, "Structural Columns", steel ? "HEB" : "Concrete-Rectangular-Column",
                            steel ? "HEB 300" : "50 x 50 cm", Levels[l], origin,
                            x - 0.25, y - 0.25, z, x + 0.25, y + 0.25, z + StoreyHeight - 0.3, new[] { steel ? 1 : 0 }, rng, "Novi most"));
                    }
                // perimeter walls, glass on the upper floors' south side
                for (var k = 0; k < Bays; k++)
                {
                    foreach (var side in new[] { 0, 1, 2, 3 })
                    {
                        if (l == 0 && side == 0 && k == 1) continue;   // the special wall goes here
                        double x0, y0, x1, y1;
                        switch (side)
                        {
                            case 0: x0 = bx + k * Bay; y0 = by - 0.25; x1 = x0 + Bay; y1 = by; break;
                            case 1: x0 = bx + k * Bay; y0 = by + Bays * Bay; x1 = x0 + Bay; y1 = y0 + 0.25; break;
                            case 2: x0 = bx - 0.25; y0 = by + k * Bay; x1 = bx; y1 = y0 + Bay; break;
                            default: x0 = bx + Bays * Bay; y0 = by + k * Bay; x1 = x0 + 0.25; y1 = y0 + Bay; break;
                        }
                        var glass = l > 0 && side == 0;
                        elements.Add(Box(scene, nextId++, "Walls", glass ? "Curtain Wall" : "Basic Wall",
                            glass ? "Staklena fasada" : "Zid 25 cm", Levels[l], origin,
                            x0, y0, z, x1, y1, z + StoreyHeight - 0.3, new[] { glass ? 4 : 0 }, rng, "Stari most"));
                    }
                }
                // furniture
                for (var i = 0; i < Bays; i++)
                    for (var j = 0; j < Bays; j++)
                        for (var n = 0; n < 4; n++)
                        {
                            double x0 = bx + i * Bay + 1.5 + n * 2, y0 = by + j * Bay + 3 + (n % 2) * 3;
                            elements.Add(Box(scene, nextId++, "Generic Models", n % 2 == 0 ? "Sto" : "Ormar",
                                n % 2 == 0 ? "Sto 120x80" : "Ormar visoki", Levels[l], origin,
                                x0, y0, z, x0 + 1.2, y0 + 0.8, z + (n % 2 == 0 ? 0.75 : 2.1), new[] { 3 }, rng, null));
                        }
            }
            // roof slabs over the top storey
            var top = Levels.Length * StoreyHeight;
            for (var i = 0; i < Bays; i++)
                for (var j = 0; j < Bays; j++)
                {
                    double x0 = bx + i * Bay, y0 = by + j * Bay;
                    elements.Add(Box(scene, nextId++, "Roofs", "Basic Roof", "Krov – crep", Levels[Levels.Length - 1], origin,
                        x0, y0, top - 0.3, x0 + Bay, y0 + Bay, top, new[] { 5 }, rng, "Novi most"));
                }

            // the element the prototype checklist uses: Walls / "Obloga od Kulira" / 8.53 m³ / "Nula"
            var special = Box(scene, 843064, "Walls", "Basic Wall", "Obloga od Kulira", "Nula", origin,
                bx + Bay, by - 0.05, 0, bx + Bay + 13.8, by, 12.356, new[] { 2 }, rng, "Novi most");
            special.Extras["volume_m3"] = 8.5254;
            var p = (JsonObject)special.Extras["params"];
            p["Volume"] = "8.53 m³";
            p["Area"] = "171 m²";
            p["Length"] = "13.8000";
            p["Base Offset"] = "25.0280";
            elements.Add(special);

            scene.Elements.AddRange(elements
                .OrderBy(e => e.Category, StringComparer.Create(CultureInfo.InvariantCulture, false))
                .ThenBy(e => (long)e.Extras["id"]));
            return scene;
        }

        private static GlbElement Box(GlbScene scene, long id, string category, string family, string type, string level,
            double[] origin, double x0, double y0, double z0, double x1, double y1, double z1, int[] mats, Random rng, string dilatacija)
        {
            var e = new GlbElement { Category = category, NodeName = category + " – " + type + " [" + id + "]", MeshName = id.ToString(C) };
            if (mats.Length == 1)
            {
                var prim = new GlbPrimitive { Material = mats[0] };
                TestUtil.AddBox(prim, x0, y0, z0, x1, y1, z1, origin);
                e.Primitives.Add(prim);
            }
            else
            {
                var body = new GlbPrimitive { Material = mats[0] };
                var finish = new GlbPrimitive { Material = mats[1] };
                TestUtil.AddBox(body, x0, y0, z0, x1, y1, z1, origin, faces: 0x3F & ~0x02);
                TestUtil.AddBox(finish, x0, y0, z0, x1, y1, z1, origin, faces: 0x02);
                e.Primitives.Add(body);
                e.Primitives.Add(finish);
            }
            double dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
            var volume = dx * dy * dz;
            var area = Math.Max(dx * dy, Math.Max(dx * dz, dy * dz));
            var length = Math.Max(dx, dy);
            var ps = new JsonObject
            {
                { "Category", category },
                { "Family", family },
                { "Type", type },
                { "Family and Type", family + ": " + type },
                { "Volume", volume.ToString("0.00", C) + " m³" },
                { "Area", area.ToString("0", C) + " m²" },
                { "Length", length.ToString("0.0000", C) },
                { "Base Offset", "0.0000" },
                { "Phase Created", "New Construction" },
                { "Structural", category == "Generic Models" ? "No" : "Yes" },
                { "Materijal", scene.Materials[mats[0]].Name },
                { "Faktor", (1 + rng.Next(0, 4) * 0.5).ToString("0.0", C).Replace('.', ',') },
                { "Type Id", (id % 97 + 2000).ToString(C) },
            };
            if (dilatacija != null) ps["Dilatacija"] = dilatacija;
            string mark = null, comments = null;
            if (id % 7 == 0) { mark = "M-" + (id % 1000).ToString(C); ps["Mark"] = mark; }
            if (id % 11 == 0) { comments = "Provjeriti – šđčćž"; ps["Comments"] = comments; }
            var tp = new JsonObject
            {
                { "Family Name", family },
                { "Type Name", type },
                { "Width", Math.Min(dx, dy).ToString("0.0000", C) },
                { "Function", category == "Walls" && type != "Staklena fasada" ? "Exterior" : "Interior" },
            };
            e.Extras = new JsonObject
            {
                { "id", id },
                { "uniqueId", "00000000-0000-4000-8000-" + id.ToString("x12", C) },
                { "category", category },
                { "family", family },
                { "type", type },
                { "level", level },
                { "mark", mark },
                { "comments", comments },
                { "volume_m3", Math.Round(volume, 4) },
                { "materials", mats.Select(i => scene.Materials[i]).OrderBy(m => m.RevitMaterialId).Select(m => m.Name).ToList() },
                { "params", ps },
                { "typeParams", tp },
            };
            return e;
        }
    }

    public class SyntheticModelTests
    {
        [Fact]
        public void WritesSyntheticGlbAndHtml()
        {
            var glb = TestUtil.WriteGlb(SyntheticModel.Build(), out var stats);
            Assert.InRange(stats.Elements, 250, 400);
            Assert.Equal(5, stats.PerCategory.Count);
            var dir = TestUtil.OutDir;
            File.WriteAllBytes(Path.Combine(dir, "synthetic.glb"), glb);

            var html = Path.Combine(dir, "synthetic.html");
            using (var fs = new FileStream(html, FileMode.Create, FileAccess.Write))
                HtmlPackager.Write(fs, HtmlPackager.LoadTemplate(), "Sintetički model", s => s.Write(glb, 0, glb.Length));

            var text = File.ReadAllText(html);
            Assert.Contains("<title>Sintetički model</title>", text);
            Assert.Equal(glb, TestUtil.Gunzip(Convert.FromBase64String(TestUtil.ModelText(text))));
            File.WriteAllText(Path.Combine(dir, "synthetic.stats.json"), Json.Serialize(new JsonObject
            {
                { "elements", stats.Elements }, { "triangles", stats.Triangles }, { "materials", stats.Materials },
                { "perCategory", stats.PerCategory.OrderBy(kv => kv.Key, StringComparer.Ordinal).ToDictionary(kv => kv.Key, kv => (object)kv.Value) },
            }));
        }
    }
}
