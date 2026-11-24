using Autodesk.Revit.DB;

namespace RevitThreeExport
{
    internal static class Ids
    {
        /// <summary>ElementId as a number: Value on Revit 2024+, IntegerValue before.</summary>
        public static long Of(ElementId id)
        {
            if (id == null) return -1;
#if REVIT2024_OR_GREATER
            return id.Value;
#else
            return id.IntegerValue;
#endif
        }
    }
}
