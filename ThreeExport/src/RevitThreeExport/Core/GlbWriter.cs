using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace RevitThreeExport.Core
{
    /// <summary>
    /// Writes a <see cref="GlbScene"/> as glTF 2.0 binary, in the layout the viewer
    /// expects (the same as the prototype's build_glb.mjs):
    ///   root node (document, extras) -> one node per category -> one node per element.
    /// One mesh per element, one primitive per material, POSITION (with min/max),
    /// NORMAL and uint16/uint32 indices. Revit (x, y, z) becomes glTF (x, z, -y),
    /// recentred on the bounding-box centre.
    /// </summary>
    public static class GlbWriter
    {
        private const int ArrayBuffer = 34962;
        private const int ElementArrayBuffer = 34963;
        private const int Float = 5126;
        private const int UnsignedShort = 5123;
        private const int UnsignedInt = 5125;

        private enum Kind { Floats, Uint16, Uint32 }

        private struct View
        {
            public Kind Kind;
            public Array Data;
            public int Count;      // number of components (floats or indices)
            public long Offset;
            public long Length;
        }

        /// <summary>
        /// sRGB 0..255 to linear 0..1, as glTF baseColorFactor wants.
        /// </summary>
        public static double ToLinear(int c)
        {
            var v = c / 255.0;
            return v <= 0.04045 ? v / 12.92 : Math.Pow((v + 0.055) / 1.055, 2.4);
        }

        /// <summary>
        /// Writes the scene to <paramref name="output"/>. Converts the scene's positions
        /// and normals to glTF axes in place, so a scene can be written only once.
        /// </summary>
        public static GlbStats Write(GlbScene scene, Stream output)
        {
            if (!BitConverter.IsLittleEndian) throw new NotSupportedException("GLB needs a little-endian machine");
            var stats = new GlbStats();

            var elements = new List<GlbElement>();
            foreach (var e in scene.Elements)
                if (e.TriangleCount > 0) elements.Add(e);

            // ---- bounding box in Revit axes, relative to scene.Origin ----
            double[] min = { double.PositiveInfinity, double.PositiveInfinity, double.PositiveInfinity };
            double[] max = { double.NegativeInfinity, double.NegativeInfinity, double.NegativeInfinity };
            foreach (var e in elements)
                foreach (var p in e.Primitives)
                {
                    var a = p.Positions.Items;
                    for (var i = 0; i < p.Positions.Count; i++)
                    {
                        var v = a[i];
                        if (float.IsNaN(v) || float.IsInfinity(v))
                            throw new InvalidDataException("non-finite vertex in " + e.NodeName);
                        var k = i % 3;
                        if (v < min[k]) min[k] = v;
                        if (v > max[k]) max[k] = v;
                    }
                }
            if (double.IsInfinity(min[0])) { min = new double[3]; max = new double[3]; }
            var ctr = new double[3];
            for (var k = 0; k < 3; k++)
            {
                ctr[k] = (min[k] + max[k]) / 2;
                stats.SizeMetres[k] = max[k] - min[k];
                stats.OffsetMetres[k] = Math.Round(scene.Origin[k] + ctr[k], 4);
            }

            // ---- Revit (x, y, z) -> glTF (x, z, -y), recentred; a rotation, so winding is kept ----
            foreach (var e in elements)
                foreach (var p in e.Primitives)
                {
                    var a = p.Positions.Items;
                    for (var i = 0; i + 2 < p.Positions.Count; i += 3)
                    {
                        double x = a[i] - ctr[0], y = a[i + 1] - ctr[1], z = a[i + 2] - ctr[2];
                        a[i] = (float)x;
                        a[i + 1] = (float)z;
                        a[i + 2] = (float)(-y);
                    }
                    var n = p.Normals.Items;
                    for (var i = 0; i + 2 < p.Normals.Count; i += 3)
                    {
                        float ny = n[i + 1], nz = n[i + 2];
                        n[i + 1] = nz;
                        n[i + 2] = -ny;
                    }
                    if (p.Normals.Count != p.Positions.Count)
                        throw new InvalidDataException("normals and positions differ in " + e.NodeName);
                    var nv = p.VertexCount;
                    var idx = p.Indices.Items;
                    for (var i = 0; i < p.Indices.Count; i++)
                        if (idx[i] < 0 || idx[i] >= nv)
                            throw new InvalidDataException("index out of range in " + e.NodeName);
                }

            // ---- glTF JSON ----
            var nodes = new List<JsonObject>();
            var meshes = new List<JsonObject>();
            var accessors = new List<JsonObject>();
            var bufferViews = new List<JsonObject>();
            var views = new List<View>();
            long binLength = 0;

            int AddView(Kind kind, Array data, int count, int target)
            {
                binLength = Align4(binLength);
                var length = (long)count * (kind == Kind.Uint16 ? 2 : 4);
                views.Add(new View { Kind = kind, Data = data, Count = count, Offset = binLength, Length = length });
                bufferViews.Add(new JsonObject
                {
                    { "buffer", 0 }, { "byteOffset", binLength }, { "byteLength", length }, { "target", target },
                });
                binLength += length;
                return bufferViews.Count - 1;
            }

            int AddAccessor(JsonObject acc)
            {
                accessors.Add(acc);
                return accessors.Count - 1;
            }

            var usedMaterials = new Dictionary<int, int>();   // scene material index -> glTF index
            var materials = new List<JsonObject>();
            int MaterialFor(int index)
            {
                if (usedMaterials.TryGetValue(index, out var gi)) return gi;
                var m = index >= 0 && index < scene.Materials.Count ? scene.Materials[index] : new GlbMaterial();
                var rgb = m.Rgb ?? new[] { 160, 160, 160 };
                var alpha = 1 - Math.Max(0, Math.Min(1, m.Transparency));
                var extras = new JsonObject { { "revitMaterialId", m.RevitMaterialId }, { "rgb", rgb } };
                if (m.MoreExtras != null)
                    foreach (var kv in m.MoreExtras) extras[kv.Key] = kv.Value;
                materials.Add(new JsonObject
                {
                    { "name", m.Name ?? "Default" },
                    {
                        "pbrMetallicRoughness", new JsonObject
                        {
                            { "baseColorFactor", new[] { ToLinear(rgb[0]), ToLinear(rgb[1]), ToLinear(rgb[2]), alpha } },
                            { "metallicFactor", 0 },
                            { "roughnessFactor", 0.85 },
                        }
                    },
                    { "doubleSided", true },
                    { "alphaMode", alpha < 1 ? "BLEND" : "OPAQUE" },
                    { "extras", extras },
                });
                usedMaterials[index] = materials.Count - 1;
                return materials.Count - 1;
            }

            var rootExtras = new JsonObject();
            foreach (var kv in scene.RootExtras) rootExtras[kv.Key] = kv.Value;
            rootExtras["units"] = "m";
            rootExtras["upAxis"] = "Y";
            rootExtras["elementCount"] = elements.Count;
            // revit_metres = (x + o[0], -z + o[1], y + o[2]) for a point (x, y, z) in this file
            rootExtras["revitOffsetMetres"] = stats.OffsetMetres;
            var rootChildren = new List<int>();
            nodes.Add(new JsonObject { { "name", scene.Name }, { "children", rootChildren }, { "extras", rootExtras } });

            var categoryChildren = new Dictionary<string, List<int>>(StringComparer.Ordinal);
            foreach (var e in elements)
            {
                var category = e.Category ?? "";
                if (!categoryChildren.TryGetValue(category, out var children))
                {
                    children = new List<int>();
                    categoryChildren[category] = children;
                    nodes.Add(new JsonObject
                    {
                        { "name", category }, { "children", children }, { "extras", new JsonObject { { "kind", "category" } } },
                    });
                    rootChildren.Add(nodes.Count - 1);
                }
                stats.PerCategory[category] = (stats.PerCategory.TryGetValue(category, out var c) ? c : 0) + 1;

                var primitives = new List<JsonObject>();
                foreach (var p in e.Primitives)
                {
                    var nv = p.VertexCount;
                    if (p.TriangleCount == 0) continue;
                    var pmin = new double[] { float.MaxValue, float.MaxValue, float.MaxValue };
                    var pmax = new double[] { float.MinValue, float.MinValue, float.MinValue };
                    var a = p.Positions.Items;
                    for (var i = 0; i < p.Positions.Count; i++)
                    {
                        var k = i % 3;
                        if (a[i] < pmin[k]) pmin[k] = a[i];
                        if (a[i] > pmax[k]) pmax[k] = a[i];
                    }
                    var position = AddAccessor(new JsonObject
                    {
                        { "bufferView", AddView(Kind.Floats, p.Positions.Items, p.Positions.Count, ArrayBuffer) },
                        { "componentType", Float }, { "count", nv }, { "type", "VEC3" },
                        { "min", pmin }, { "max", pmax },
                    });
                    var normal = AddAccessor(new JsonObject
                    {
                        { "bufferView", AddView(Kind.Floats, p.Normals.Items, p.Normals.Count, ArrayBuffer) },
                        { "componentType", Float }, { "count", nv }, { "type", "VEC3" },
                    });
                    // 65535 is the primitive-restart value for uint16, so it must not be an index
                    var wide = nv > 65535;
                    var indices = AddAccessor(new JsonObject
                    {
                        { "bufferView", AddView(wide ? Kind.Uint32 : Kind.Uint16, p.Indices.Items, p.Indices.Count, ElementArrayBuffer) },
                        { "componentType", wide ? UnsignedInt : UnsignedShort }, { "count", p.Indices.Count }, { "type", "SCALAR" },
                    });
                    primitives.Add(new JsonObject
                    {
                        { "attributes", new JsonObject { { "POSITION", position }, { "NORMAL", normal } } },
                        { "indices", indices },
                        { "material", MaterialFor(p.Material) },
                    });
                    stats.Vertices += nv;
                    stats.Triangles += p.TriangleCount;
                }
                meshes.Add(new JsonObject { { "name", e.MeshName }, { "primitives", primitives } });
                nodes.Add(new JsonObject { { "name", e.NodeName }, { "mesh", meshes.Count - 1 }, { "extras", e.Extras } });
                children.Add(nodes.Count - 1);
            }

            var binPadded = Align4(binLength);
            var gltf = new JsonObject
            {
                { "asset", new JsonObject { { "version", "2.0" }, { "generator", scene.Generator } } },
                { "scene", 0 },
                { "scenes", new[] { new JsonObject { { "name", scene.Name }, { "nodes", new[] { 0 } } } } },
                { "nodes", nodes },
            };
            if (meshes.Count > 0)
            {
                gltf["meshes"] = meshes;
                gltf["materials"] = materials;
                gltf["accessors"] = accessors;
                gltf["bufferViews"] = bufferViews;
                gltf["buffers"] = new[] { new JsonObject { { "byteLength", binPadded } } };
            }

            var json = new UTF8Encoding(false).GetBytes(Json.Serialize(gltf));
            var jsonPadded = Align4(json.Length);
            var total = 12 + 8 + jsonPadded + (meshes.Count > 0 ? 8 + binPadded : 0);
            if (total > uint.MaxValue) throw new InvalidDataException("model is larger than the 4 GB GLB limit");

            // ---- write ----
            var head = new byte[12];
            PutU32(head, 0, 0x46546C67);   // "glTF"
            PutU32(head, 4, 2);
            PutU32(head, 8, (uint)total);
            output.Write(head, 0, 12);

            WriteChunkHeader(output, (uint)jsonPadded, 0x4E4F534A);   // "JSON"
            output.Write(json, 0, json.Length);
            for (var i = json.Length; i < jsonPadded; i++) output.WriteByte(0x20);

            if (meshes.Count > 0)
            {
                WriteChunkHeader(output, (uint)binPadded, 0x004E4942);   // "BIN\0"
                var scratch = new byte[1 << 16];
                long pos = 0;
                foreach (var v in views)
                {
                    WriteZeros(output, v.Offset - pos);
                    WriteView(output, v, scratch);
                    pos = v.Offset + v.Length;
                }
                WriteZeros(output, binPadded - pos);
            }

            stats.Elements = elements.Count;
            stats.Materials = materials.Count;
            stats.Bytes = total;
            return stats;
        }

        private static void WriteView(Stream output, View v, byte[] scratch)
        {
            if (v.Kind == Kind.Uint16)
            {
                var src = (int[])v.Data;
                var n = 0;
                for (var i = 0; i < v.Count; i++)
                {
                    var x = src[i];
                    scratch[n++] = (byte)x;
                    scratch[n++] = (byte)(x >> 8);
                    if (n == scratch.Length)
                    {
                        output.Write(scratch, 0, n);
                        n = 0;
                    }
                }
                if (n > 0) output.Write(scratch, 0, n);
                return;
            }
            // float32 and uint32 (non-negative int32 has the same bytes): copy the raw memory
            var bytes = (long)v.Count * 4;
            long done = 0;
            while (done < bytes)
            {
                var n = (int)Math.Min(scratch.Length, bytes - done);
                Buffer.BlockCopy(v.Data, (int)done, scratch, 0, n);
                output.Write(scratch, 0, n);
                done += n;
            }
        }

        private static long Align4(long n) => (n + 3) & ~3L;
        private static int Align4(int n) => (n + 3) & ~3;

        private static void WriteZeros(Stream s, long n)
        {
            for (long i = 0; i < n; i++) s.WriteByte(0);
        }

        private static void WriteChunkHeader(Stream s, uint length, uint type)
        {
            var b = new byte[8];
            PutU32(b, 0, length);
            PutU32(b, 4, type);
            s.Write(b, 0, 8);
        }

        private static void PutU32(byte[] b, int at, uint v)
        {
            b[at] = (byte)v;
            b[at + 1] = (byte)(v >> 8);
            b[at + 2] = (byte)(v >> 16);
            b[at + 3] = (byte)(v >> 24);
        }
    }
}
