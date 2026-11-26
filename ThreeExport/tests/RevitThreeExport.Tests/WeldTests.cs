using RevitThreeExport.Core;
using Xunit;

namespace RevitThreeExport.Tests
{
    public class WeldTests
    {
        // a unit square in the XY plane split into two facets: points 0..3
        private static readonly double[] Square = { 10, 20, 5, 11, 20, 5, 11, 21, 5, 10, 21, 5 };

        [Fact]
        public void FacetsInOnePlaneShareTheirVertices()
        {
            var p = new GlbPrimitive();
            var w = new FlatWelder(p, Square, 10, 20, 0);
            p.Indices.Add(w.Vertex(0, 0, 0, 1), w.Vertex(1, 0, 0, 1), w.Vertex(2, 0, 0, 1));
            p.Indices.Add(w.Vertex(0, 0, 0, 1), w.Vertex(2, 0, 0, 1), w.Vertex(3, 0, 0, 1));
            Assert.Equal(4, p.VertexCount);   // was 6: three per facet
            Assert.Equal(new[] { 0, 1, 2, 0, 2, 3 }, p.Indices.Items[..6]);
            // positions exactly as given, less the origin
            Assert.Equal(new float[] { 0, 0, 5, 1, 0, 5, 1, 1, 5, 0, 1, 5 }, p.Positions.Items[..12]);
            Assert.Equal(p.Positions.Count, p.Normals.Count);
        }

        [Fact]
        public void APointOnAnEdgeGetsAVertexPerNormal()
        {
            var p = new GlbPrimitive();
            var w = new FlatWelder(p, Square, 0, 0, 0);
            // the same two triangles folded along the diagonal: different normals
            p.Indices.Add(w.Vertex(0, 0, 0, 1), w.Vertex(1, 0, 0, 1), w.Vertex(2, 0, 0, 1));
            p.Indices.Add(w.Vertex(0, 0, 1, 0), w.Vertex(2, 0, 1, 0), w.Vertex(3, 0, 1, 0));
            Assert.Equal(6, p.VertexCount);
            // a normal that differs only by rounding noise still shares
            Assert.Equal(0, w.Vertex(0, 1e-9, 0, 1 - 1e-9));
        }
    }
}
