using System;
using System.IO;
using System.IO.Compression;
using System.Text;
using System.Text.Json;
using RevitThreeExport.Core;
using Xunit;

namespace RevitThreeExport.Tests
{
    /// <summary>A parsed .glb: the JSON chunk as a document and the BIN chunk bytes.</summary>
    internal sealed class ParsedGlb
    {
        public JsonDocument Json;
        public string JsonText;
        public byte[] Bin;
        public JsonElement Root => Json.RootElement;

        public static ParsedGlb Parse(byte[] glb)
        {
            Assert.True(glb.Length >= 20, "too short for a GLB");
            Assert.Equal(0x46546C67u, BitConverter.ToUInt32(glb, 0));
            Assert.Equal(2u, BitConverter.ToUInt32(glb, 4));
            Assert.Equal((uint)glb.Length, BitConverter.ToUInt32(glb, 8));
            var jsonLen = (int)BitConverter.ToUInt32(glb, 12);
            Assert.Equal(0x4E4F534Au, BitConverter.ToUInt32(glb, 16));
            Assert.Equal(0, jsonLen % 4);
            var text = Encoding.UTF8.GetString(glb, 20, jsonLen);
            var result = new ParsedGlb { JsonText = text, Json = JsonDocument.Parse(text) };
            var at = 20 + jsonLen;
            if (at < glb.Length)
            {
                var binLen = (int)BitConverter.ToUInt32(glb, at);
                Assert.Equal(0x004E4942u, BitConverter.ToUInt32(glb, at + 4));
                Assert.Equal(0, binLen % 4);
                Assert.Equal(glb.Length, at + 8 + binLen);
                result.Bin = new byte[binLen];
                Buffer.BlockCopy(glb, at + 8, result.Bin, 0, binLen);
            }
            return result;
        }

        public JsonElement Accessor(int i) => Root.GetProperty("accessors")[i];

        public float[] Floats(int accessor)
        {
            var acc = Accessor(accessor);
            var view = Root.GetProperty("bufferViews")[acc.GetProperty("bufferView").GetInt32()];
            var offset = view.GetProperty("byteOffset").GetInt32();
            var n = acc.GetProperty("count").GetInt32() * 3;
            var result = new float[n];
            Buffer.BlockCopy(Bin, offset, result, 0, n * 4);
            return result;
        }

        public int[] Indices(int accessor)
        {
            var acc = Accessor(accessor);
            var view = Root.GetProperty("bufferViews")[acc.GetProperty("bufferView").GetInt32()];
            var offset = view.GetProperty("byteOffset").GetInt32();
            var n = acc.GetProperty("count").GetInt32();
            var wide = acc.GetProperty("componentType").GetInt32() == 5125;
            var result = new int[n];
            for (var i = 0; i < n; i++)
                result[i] = wide ? (int)BitConverter.ToUInt32(Bin, offset + i * 4) : BitConverter.ToUInt16(Bin, offset + i * 2);
            return result;
        }
    }

    internal static class TestUtil
    {
        /// <summary>ThreeExport/tests/out, created on demand (git-ignored).</summary>
        public static string OutDir
        {
            get
            {
                var d = new DirectoryInfo(AppContext.BaseDirectory);
                while (d != null && !File.Exists(Path.Combine(d.FullName, "viewer", "build.mjs"))) d = d.Parent;
                if (d == null) throw new InvalidOperationException("ThreeExport folder not found above " + AppContext.BaseDirectory);
                var dir = Path.Combine(d.FullName, "tests", "out");
                Directory.CreateDirectory(dir);
                return dir;
            }
        }

        public static byte[] WriteGlb(GlbScene scene, out GlbStats stats)
        {
            using (var ms = new MemoryStream())
            {
                stats = GlbWriter.Write(scene, ms);
                Assert.Equal(stats.Bytes, ms.Length);
                return ms.ToArray();
            }
        }

        public static byte[] Gunzip(byte[] gz)
        {
            using (var src = new MemoryStream(gz))
            using (var z = new GZipStream(src, CompressionMode.Decompress))
            using (var dst = new MemoryStream())
            {
                z.CopyTo(dst);
                return dst.ToArray();
            }
        }

        /// <summary>The base64 text inside the model script tag of a packaged page.</summary>
        public static string ModelText(string html)
        {
            const string open = "data-encoding=\"gzip-base64\">";
            var a = html.IndexOf(open, StringComparison.Ordinal);
            Assert.True(a > 0, "model tag not found");
            a += open.Length;
            var b = html.IndexOf("</script>", a, StringComparison.Ordinal);
            return html.Substring(a, b - a);
        }

        /// <summary>Corners of each box face, counter-clockwise seen from outside.</summary>
        private static readonly int[][] BoxFaces =
        {
            new[] { 0, 3, 2, 1 },   // bottom (z0), facing -Z
            new[] { 4, 5, 6, 7 },   // top (z1), facing +Z
            new[] { 0, 1, 5, 4 },   // y0, facing -Y
            new[] { 2, 3, 7, 6 },   // y1, facing +Y
            new[] { 1, 2, 6, 5 },   // x1, facing +X
            new[] { 3, 0, 4, 7 },   // x0, facing -X
        };

        /// <summary>
        /// An axis-aligned box in Revit axes (Z up), metres, relative to origin: one
        /// chunk of 4 vertices per face, as Revit tessellates a solid face by face.
        /// <paramref name="faces"/> picks which faces to add (bit i = BoxFaces[i]).
        /// </summary>
        /// <summary>A box; rotateDeg turns it in plan about its centre (counter-clockwise).</summary>
        public static void AddBox(GlbPrimitive p, double x0, double y0, double z0, double x1, double y1, double z1,
            double[] origin = null, int faces = 0x3F, double rotateDeg = 0)
        {
            var o = origin ?? new double[3];
            double[][] c =
            {
                new[] { x0, y0, z0 }, new[] { x1, y0, z0 }, new[] { x1, y1, z0 }, new[] { x0, y1, z0 },
                new[] { x0, y0, z1 }, new[] { x1, y0, z1 }, new[] { x1, y1, z1 }, new[] { x0, y1, z1 },
            };
            if (rotateDeg != 0)
            {
                double cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, a = rotateDeg * Math.PI / 180, cos = Math.Cos(a), sin = Math.Sin(a);
                foreach (var v in c)
                {
                    double dx = v[0] - cx, dy = v[1] - cy;
                    v[0] = cx + dx * cos - dy * sin;
                    v[1] = cy + dx * sin + dy * cos;
                }
            }
            for (var f = 0; f < 6; f++)
            {
                if ((faces & (1 << f)) == 0) continue;
                var first = p.VertexCount;
                var firstIndex = p.Indices.Count;
                foreach (var k in BoxFaces[f])
                    p.Positions.Add((float)(c[k][0] - o[0]), (float)(c[k][1] - o[1]), (float)(c[k][2] - o[2]));
                p.Indices.Add(first, first + 1, first + 2);
                p.Indices.Add(first, first + 2, first + 3);
                MeshMath.AppendSmoothNormals(p, first, firstIndex);
            }
        }
    }
}
