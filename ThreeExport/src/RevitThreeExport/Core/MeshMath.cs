using System;
using System.Collections.Generic;

namespace RevitThreeExport.Core
{
    /// <summary>
    /// Vertices of flat-shaded facets (one normal per facet): a corner that is the same Revit
    /// point with the same normal (to 1e-6) as an earlier one reuses its vertex, instead of
    /// three new vertices per facet. Positions are not changed, only shared.
    /// </summary>
    public sealed class FlatWelder
    {
        private readonly Dictionary<(int, long, long, long), int> _vertices = new Dictionary<(int, long, long, long), int>();
        private readonly GlbPrimitive _prim;
        private readonly double[] _points;
        private readonly double _ox, _oy, _oz;

        /// <param name="points">x, y, z per point, metres</param>
        /// <param name="ox">subtracted from x (likewise oy, oz) when a vertex is written</param>
        public FlatWelder(GlbPrimitive prim, double[] points, double ox, double oy, double oz)
        {
            _prim = prim;
            _points = points;
            _ox = ox; _oy = oy; _oz = oz;
        }

        /// <summary>The vertex for this point with this (unit) normal; added when new.</summary>
        public int Vertex(int point, double nx, double ny, double nz)
        {
            var key = (point, (long)Math.Round(nx * 1e6), (long)Math.Round(ny * 1e6), (long)Math.Round(nz * 1e6));
            if (_vertices.TryGetValue(key, out var v)) return v;
            v = _prim.VertexCount;
            _prim.Positions.Add((float)(_points[point * 3] - _ox), (float)(_points[point * 3 + 1] - _oy), (float)(_points[point * 3 + 2] - _oz));
            _prim.Normals.Add((float)nx, (float)ny, (float)nz);
            _vertices[key] = v;
            return v;
        }
    }

    public static class MeshMath
    {
        /// <summary>
        /// Smooth normals for the vertices [firstVertex, end) from the triangles in
        /// indices [firstIndex, end), as the prototype computed them for one Revit face:
        /// area-weighted face normals summed per vertex. Appends one normal per vertex.
        /// </summary>
        public static void AppendSmoothNormals(GlbPrimitive p, int firstVertex, int firstIndex)
        {
            var pos = p.Positions.Items;
            var nv = p.VertexCount - firstVertex;
            var acc = new double[nv * 3];
            var idx = p.Indices.Items;
            for (var i = firstIndex; i + 2 < p.Indices.Count; i += 3)
            {
                int a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
                double ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
                double vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
                double nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
                var f = firstVertex * 3;
                acc[a - f] += nx; acc[a - f + 1] += ny; acc[a - f + 2] += nz;
                acc[b - f] += nx; acc[b - f + 1] += ny; acc[b - f + 2] += nz;
                acc[c - f] += nx; acc[c - f + 1] += ny; acc[c - f + 2] += nz;
            }
            for (var i = 0; i < acc.Length; i += 3)
            {
                var l = Math.Sqrt(acc[i] * acc[i] + acc[i + 1] * acc[i + 1] + acc[i + 2] * acc[i + 2]);
                if (l > 0) p.Normals.Add((float)(acc[i] / l), (float)(acc[i + 1] / l), (float)(acc[i + 2] / l));
                else p.Normals.Add(0f, 0f, 1f);   // degenerate: point up (Revit Z, glTF Y)
            }
        }
    }
}
