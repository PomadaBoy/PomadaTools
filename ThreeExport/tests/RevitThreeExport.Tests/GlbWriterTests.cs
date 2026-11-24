using System;
using System.IO;
using System.Linq;
using RevitThreeExport.Core;
using Xunit;

namespace RevitThreeExport.Tests
{
    public class GlbWriterTests
    {
        /// <summary>
        /// A 2 x 4 x 3 m box at a far-away origin. The top face is "Kulir", the rest is
        /// a concrete with Serbian characters in its name.
        /// </summary>
        internal static GlbScene CubeScene()
        {
            var origin = new[] { 5000.0, -3000.0, 100.0 };
            var scene = new GlbScene
            {
                Name = "Most Voisavljevica",
                Generator = "RevitThreeExport tests",
                Origin = origin,
                RootExtras = new JsonObject
                {
                    { "source", "Revit" }, { "document", "Most Voisavljevica" }, { "view", "Export" },
                    { "viewId", 677486L }, { "exportedAt", "2026-11-24 14:40" },
                },
            };
            scene.Materials.Add(new GlbMaterial { Name = "Beton - Prefabrikovana ploča C25/30 (čćšžđ)", Rgb = new[] { 0, 150, 150 }, RevitMaterialId = 452386 });
            scene.Materials.Add(new GlbMaterial { Name = "Kulir", Rgb = new[] { 91, 85, 66 }, RevitMaterialId = 842192, Transparency = 0.25 });

            var e = new GlbElement
            {
                Category = "Walls",
                NodeName = "Walls – Obloga od Kulira [843064]",
                MeshName = "843064",
                Extras = new JsonObject
                {
                    { "id", 843064L }, { "uniqueId", "b1ff38dc-ee27-43b2-ae97-7df0f0dbf02a-000cdd38" },
                    { "category", "Walls" }, { "family", "Basic Wall" }, { "type", "Obloga od Kulira" },
                    { "level", "Nula" }, { "mark", null }, { "comments", "Ivica – šđčćž" }, { "volume_m3", 8.5254 },
                    { "materials", new[] { "Beton - Prefabrikovana ploča C25/30 (čćšžđ)", "Kulir" } },
                    { "params", new JsonObject { { "Volume", "8.53 m³" }, { "Area", "171 m²" }, { "Materijal", "Kulir" } } },
                    { "typeParams", new JsonObject { { "Width", "0.0500" } } },
                },
            };
            var concrete = new GlbPrimitive { Material = 0 };
            var kulir = new GlbPrimitive { Material = 1 };
            // box from (5000, -3000, 100) to (5002, -2996, 103) in Revit metres
            TestUtil.AddBox(concrete, 5000, -3000, 100, 5002, -2996, 103, origin, faces: 0x3F & ~0x02);
            TestUtil.AddBox(kulir, 5000, -3000, 100, 5002, -2996, 103, origin, faces: 0x02);
            e.Primitives.Add(concrete);
            e.Primitives.Add(kulir);
            scene.Elements.Add(e);
            return scene;
        }

        [Fact]
        public void CubeHasTheExpectedLayout()
        {
            var glb = TestUtil.WriteGlb(CubeScene(), out var stats);
            var g = ParsedGlb.Parse(glb);
            var r = g.Root;

            Assert.Equal("2.0", r.GetProperty("asset").GetProperty("version").GetString());
            Assert.Equal(0, r.GetProperty("scene").GetInt32());
            Assert.Equal(3, r.GetProperty("nodes").GetArrayLength());   // root, category, element

            var root = r.GetProperty("nodes")[0];
            Assert.Equal("Most Voisavljevica", root.GetProperty("name").GetString());
            var x = root.GetProperty("extras");
            Assert.Equal(new[] { "source", "document", "view", "viewId", "exportedAt", "units", "upAxis", "elementCount", "revitOffsetMetres" },
                x.EnumerateObject().Select(p => p.Name).ToArray());
            Assert.Equal("m", x.GetProperty("units").GetString());
            Assert.Equal("Y", x.GetProperty("upAxis").GetString());
            Assert.Equal(1, x.GetProperty("elementCount").GetInt32());
            Assert.Equal(new[] { 5001.0, -2998.0, 101.5 }, x.GetProperty("revitOffsetMetres").EnumerateArray().Select(v => v.GetDouble()).ToArray());

            var cat = r.GetProperty("nodes")[1];
            Assert.Equal("Walls", cat.GetProperty("name").GetString());
            Assert.Equal("category", cat.GetProperty("extras").GetProperty("kind").GetString());
            Assert.Equal(2, cat.GetProperty("children")[0].GetInt32());

            var el = r.GetProperty("nodes")[2];
            Assert.Equal("Walls – Obloga od Kulira [843064]", el.GetProperty("name").GetString());
            var ex = el.GetProperty("extras");
            Assert.Equal(843064, ex.GetProperty("id").GetInt64());
            Assert.Equal("8.53 m³", ex.GetProperty("params").GetProperty("Volume").GetString());
            Assert.Equal("Ivica – šđčćž", ex.GetProperty("comments").GetString());
            Assert.Equal(System.Text.Json.JsonValueKind.Null, ex.GetProperty("mark").ValueKind);

            var mesh = r.GetProperty("meshes")[0];
            Assert.Equal("843064", mesh.GetProperty("name").GetString());
            Assert.Equal(2, mesh.GetProperty("primitives").GetArrayLength());

            Assert.Equal(1, stats.Elements);
            Assert.Equal(12, stats.Triangles);
            Assert.Equal(24, stats.Vertices);
            Assert.Equal(2, stats.Materials);
            Assert.Equal(1, stats.PerCategory["Walls"]);
        }

        [Fact]
        public void MaterialsFollowThePrototype()
        {
            var g = ParsedGlb.Parse(TestUtil.WriteGlb(CubeScene(), out _));
            var m0 = g.Root.GetProperty("materials")[0];
            Assert.Equal("Beton - Prefabrikovana ploča C25/30 (čćšžđ)", m0.GetProperty("name").GetString());
            var pbr = m0.GetProperty("pbrMetallicRoughness");
            var bc = pbr.GetProperty("baseColorFactor").EnumerateArray().Select(v => v.GetDouble()).ToArray();
            // the prototype's value for rgb (0, 150, 150)
            Assert.Equal(new[] { 0, 0.3049873140698863, 0.3049873140698863, 1 }, bc);
            Assert.Equal(0, pbr.GetProperty("metallicFactor").GetDouble());
            Assert.Equal(0.85, pbr.GetProperty("roughnessFactor").GetDouble());
            Assert.True(m0.GetProperty("doubleSided").GetBoolean());
            Assert.Equal("OPAQUE", m0.GetProperty("alphaMode").GetString());
            Assert.Equal(452386, m0.GetProperty("extras").GetProperty("revitMaterialId").GetInt64());
            Assert.Equal(new[] { 0, 150, 150 }, m0.GetProperty("extras").GetProperty("rgb").EnumerateArray().Select(v => v.GetInt32()).ToArray());

            var m1 = g.Root.GetProperty("materials")[1];
            Assert.Equal("BLEND", m1.GetProperty("alphaMode").GetString());
            Assert.Equal(0.75, m1.GetProperty("pbrMetallicRoughness").GetProperty("baseColorFactor")[3].GetDouble());
            // prototype: Kulir (91, 85, 66)
            Assert.Equal(0.10461648409110419, m1.GetProperty("pbrMetallicRoughness").GetProperty("baseColorFactor")[0].GetDouble(), 12);
        }

        [Fact]
        public void PositionsAreRecentredInGltfAxes()
        {
            var g = ParsedGlb.Parse(TestUtil.WriteGlb(CubeScene(), out _));
            var prim = g.Root.GetProperty("meshes")[0].GetProperty("primitives")[1];   // the top face
            var acc = prim.GetProperty("attributes").GetProperty("POSITION").GetInt32();
            var pos = g.Floats(acc);
            // Revit box is 2 (x) by 4 (y) by 3 (z) m: glTF x in [-1, 1], y (= Revit z) = +1.5 on top, z (= -Revit y) in [-2, 2]
            for (var i = 0; i < pos.Length; i += 3)
            {
                Assert.Equal(1.0, Math.Abs(pos[i]), 5);
                Assert.Equal(1.5, pos[i + 1], 5);
                Assert.Equal(2.0, Math.Abs(pos[i + 2]), 5);
            }
            var a = g.Accessor(acc);
            Assert.Equal(new[] { -1.0, 1.5, -2.0 }, a.GetProperty("min").EnumerateArray().Select(v => Math.Round(v.GetDouble(), 5)).ToArray());
            Assert.Equal(new[] { 1.0, 1.5, 2.0 }, a.GetProperty("max").EnumerateArray().Select(v => Math.Round(v.GetDouble(), 5)).ToArray());

            // the top face normal is Revit +Z -> glTF +Y
            var n = g.Floats(prim.GetProperty("attributes").GetProperty("NORMAL").GetInt32());
            for (var i = 0; i < n.Length; i += 3)
                Assert.Equal(new[] { 0f, 1f, 0f }, new[] { n[i], n[i + 1], n[i + 2] });
        }

        [Fact]
        public void WindingMatchesNormalsAfterAxisConversion()
        {
            var g = ParsedGlb.Parse(TestUtil.WriteGlb(CubeScene(), out _));
            foreach (var prim in g.Root.GetProperty("meshes")[0].GetProperty("primitives").EnumerateArray())
            {
                var pos = g.Floats(prim.GetProperty("attributes").GetProperty("POSITION").GetInt32());
                var nrm = g.Floats(prim.GetProperty("attributes").GetProperty("NORMAL").GetInt32());
                var idx = g.Indices(prim.GetProperty("indices").GetInt32());
                for (var t = 0; t < idx.Length; t += 3)
                {
                    int a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
                    double ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
                    double vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
                    double gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
                    Assert.True(gx * nrm[a] + gy * nrm[a + 1] + gz * nrm[a + 2] > 0, "triangle faces away from its normal");
                }
            }
        }

        [Fact]
        public void BufferViewsAreAlignedAndInsideTheBuffer()
        {
            var g = ParsedGlb.Parse(TestUtil.WriteGlb(CubeScene(), out _));
            var bufLen = g.Root.GetProperty("buffers")[0].GetProperty("byteLength").GetInt64();
            Assert.Equal(g.Bin.Length, bufLen);
            foreach (var v in g.Root.GetProperty("bufferViews").EnumerateArray())
            {
                var off = v.GetProperty("byteOffset").GetInt64();
                Assert.Equal(0, off % 4);
                Assert.True(off + v.GetProperty("byteLength").GetInt64() <= bufLen);
            }
            // the JSON chunk ends with the closing brace, then only space padding
            var body = g.JsonText.TrimEnd(' ');
            Assert.EndsWith("}", body);
            Assert.True(g.JsonText.Length - body.Length < 4);
        }

        [Fact]
        public void IndicesAreUint16UpTo65535VerticesAndUint32Above()
        {
            foreach (var (vertices, expected) in new[] { (65535, 5123), (65536, 5125) })
            {
                var scene = new GlbScene { Name = "big" };
                var e = new GlbElement { Category = "Generic Models", NodeName = "big", MeshName = "1", Extras = new JsonObject { { "id", 1L }, { "category", "Generic Models" } } };
                var p = new GlbPrimitive();
                for (var i = 0; i < vertices; i++)
                {
                    p.Positions.Add(i % 256, i / 256, 0);
                    p.Normals.Add(0, 0, 1);
                }
                for (var i = 0; i + 2 < vertices; i += 3) p.Indices.Add(i, i + 1, i + 2);
                p.Indices.Add(vertices - 1, 0, 1);
                e.Primitives.Add(p);
                scene.Elements.Add(e);
                var g = ParsedGlb.Parse(TestUtil.WriteGlb(scene, out _));
                var idxAcc = g.Root.GetProperty("meshes")[0].GetProperty("primitives")[0].GetProperty("indices").GetInt32();
                Assert.Equal(expected, g.Accessor(idxAcc).GetProperty("componentType").GetInt32());
                Assert.Equal(vertices - 1, g.Indices(idxAcc).Max());
            }
        }

        [Fact]
        public void ElementsWithoutTrianglesAreLeftOutAndCategoriesGroup()
        {
            var scene = new GlbScene { Name = "doc" };
            for (var i = 0; i < 4; i++)
            {
                var cat = i % 2 == 0 ? "Floors" : "Walls";
                var e = new GlbElement { Category = cat, NodeName = cat + " " + i, MeshName = i.ToString(), Extras = new JsonObject { { "id", (long)i + 1 }, { "category", cat } } };
                if (i != 2)
                {
                    var p = new GlbPrimitive();
                    TestUtil.AddBox(p, i, 0, 0, i + 0.5, 1, 1);
                    e.Primitives.Add(p);
                }
                scene.Elements.Add(e);
            }
            var g = ParsedGlb.Parse(TestUtil.WriteGlb(scene, out var stats));
            Assert.Equal(3, stats.Elements);
            Assert.Equal(1, stats.PerCategory["Floors"]);
            Assert.Equal(2, stats.PerCategory["Walls"]);
            var nodes = g.Root.GetProperty("nodes");
            Assert.Equal(2, nodes[0].GetProperty("children").GetArrayLength());
            Assert.Equal(3, nodes[0].GetProperty("extras").GetProperty("elementCount").GetInt32());
            // the default material (no materials in the scene) is grey 160
            var m = g.Root.GetProperty("materials")[0];
            Assert.Equal("Default", m.GetProperty("name").GetString());
            Assert.Equal(-1, m.GetProperty("extras").GetProperty("revitMaterialId").GetInt32());
        }

        [Fact]
        public void EmptySceneIsStillAValidGlb()
        {
            var g = ParsedGlb.Parse(TestUtil.WriteGlb(new GlbScene { Name = "empty" }, out var stats));
            Assert.Null(g.Bin);
            Assert.Equal(0, stats.Elements);
            Assert.False(g.Root.TryGetProperty("buffers", out _));
        }

        [Fact]
        public void RejectsBadGeometry()
        {
            var scene = CubeScene();
            scene.Elements[0].Primitives[0].Indices.Add(0, 1, 999);
            Assert.Throws<InvalidDataException>(() => TestUtil.WriteGlb(scene, out _));

            scene = CubeScene();
            scene.Elements[0].Primitives[0].Positions.Items[0] = float.NaN;
            Assert.Throws<InvalidDataException>(() => TestUtil.WriteGlb(scene, out _));
        }

        [Fact]
        public void WritesCubeForTheNodeValidators()
        {
            File.WriteAllBytes(Path.Combine(TestUtil.OutDir, "cube.glb"), TestUtil.WriteGlb(CubeScene(), out _));
        }
    }
}
