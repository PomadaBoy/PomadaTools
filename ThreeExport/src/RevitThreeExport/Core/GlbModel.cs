using System;
using System.Collections.Generic;

namespace RevitThreeExport.Core
{
    /// <summary>A growable array that exposes its backing store (no copy when writing).</summary>
    public sealed class GrowList<T> where T : struct
    {
        public T[] Items;
        public int Count;

        public GrowList(int capacity = 64)
        {
            Items = new T[Math.Max(capacity, 4)];
        }

        public void Add(T value)
        {
            if (Count == Items.Length) Grow(Count + 1);
            Items[Count++] = value;
        }

        public void Add(T a, T b, T c)
        {
            if (Count + 3 > Items.Length) Grow(Count + 3);
            Items[Count] = a;
            Items[Count + 1] = b;
            Items[Count + 2] = c;
            Count += 3;
        }

        private void Grow(int needed)
        {
            var size = Items.Length;
            while (size < needed) size = size < 1 << 20 ? size * 2 : size + (size >> 1);
            Array.Resize(ref Items, size);
        }
    }

    /// <summary>
    /// A material as the viewer needs it. Rgb is sRGB 0..255; null means the default
    /// grey (160, 160, 160).
    /// </summary>
    public sealed class GlbMaterial
    {
        public string Name = "Default";
        public int[] Rgb;
        /// <summary>0 = opaque, 1 = fully transparent.</summary>
        public double Transparency;
        public long RevitMaterialId = -1;
        /// <summary>Extra keys written after revitMaterialId and rgb in the material's extras.</summary>
        public JsonObject MoreExtras;
    }

    /// <summary>
    /// Triangles of one element in one material. Positions and normals are in Revit's
    /// axes (Z up), positions in metres relative to <see cref="GlbScene.Origin"/>.
    /// GlbWriter converts them to glTF axes in place.
    /// </summary>
    public sealed class GlbPrimitive
    {
        public int Material;
        public readonly GrowList<float> Positions = new GrowList<float>(96);
        public readonly GrowList<float> Normals = new GrowList<float>(96);
        public readonly GrowList<int> Indices = new GrowList<int>(96);

        public int VertexCount => Positions.Count / 3;
        public int TriangleCount => Indices.Count / 3;
    }

    public sealed class GlbElement
    {
        public string Category = "";
        /// <summary>glTF node name, for example "Walls – Obloga [843064]".</summary>
        public string NodeName = "";
        /// <summary>glTF mesh name, the element id as text.</summary>
        public string MeshName = "";
        /// <summary>Element metadata; three.js puts it in object.userData.</summary>
        public JsonObject Extras = new JsonObject();
        public readonly List<GlbPrimitive> Primitives = new List<GlbPrimitive>();

        /// <summary>
        /// The element's own origin, Revit metres relative to <see cref="GlbScene.Origin"/>
        /// (Revit axes). When set, the primitives' positions are relative to it (and turned by
        /// <see cref="Basis"/>): small numbers, so float32 keeps sub-micrometre precision however
        /// far the element is from the model's origin. The node gets the origin as its
        /// translation, and elements with identical geometry share one glTF mesh.
        /// Null: positions are relative to GlbScene.Origin (the older layout).
        /// </summary>
        public double[] Origin;

        /// <summary>
        /// With <see cref="Origin"/>: the element's axes in Revit axes, BasisX then BasisY then
        /// BasisZ (9 numbers): Revit point = Origin + x·BasisX + y·BasisY + z·BasisZ. Set for a
        /// turned family instance, whose positions are then its family's own geometry (the
        /// same for every instance of the type). Null: not turned.
        /// </summary>
        public double[] Basis;

        public int TriangleCount
        {
            get
            {
                var n = 0;
                foreach (var p in Primitives) n += p.TriangleCount;
                return n;
            }
        }
    }

    public sealed class GlbScene
    {
        /// <summary>Root node and scene name (the document title).</summary>
        public string Name = "Revit model";
        public string Generator = "RevitThreeExport";
        /// <summary>
        /// Root node extras. GlbWriter appends units, upAxis, elementCount and
        /// revitOffsetMetres after the keys given here.
        /// </summary>
        public JsonObject RootExtras = new JsonObject();
        /// <summary>Revit metres that the stored positions are relative to (keeps float precision).</summary>
        public double[] Origin = { 0, 0, 0 };
        public readonly List<GlbMaterial> Materials = new List<GlbMaterial>();
        /// <summary>Elements in output order (the exporter sorts by category, then id).</summary>
        public readonly List<GlbElement> Elements = new List<GlbElement>();
    }

    public sealed class GlbStats
    {
        public int Elements;
        /// <summary>Triangles and vertices of all elements (an element sharing a mesh counts it again).</summary>
        public int Triangles;
        public int Vertices;
        /// <summary>glTF meshes written, and elements that reuse another element's mesh.</summary>
        public int Meshes;
        public int SharedElements;
        public int Materials;
        public long Bytes;
        /// <summary>Model size in metres along Revit X, Y, Z.</summary>
        public double[] SizeMetres = { 0, 0, 0 };
        /// <summary>Revit metres of the glTF origin: revit = (x + o.x, -z + o.y, y + o.z).</summary>
        public double[] OffsetMetres = { 0, 0, 0 };
        public readonly Dictionary<string, int> PerCategory = new Dictionary<string, int>();
    }
}
