using System;

namespace RevitThreeExport.Core
{
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
