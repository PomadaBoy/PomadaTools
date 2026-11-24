using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;

namespace RevitThreeExport
{
    public sealed class ExportResult
    {
        public bool Cancelled;
        public string OutputPath;
        public string Document;
        public string View;
        public int Elements;
        public int LinkElements;
        /// <summary>Reinforcement elements left out (ExportOptions.IncludeRebar off).</summary>
        public int SkippedRebar;
        public int Triangles;
        public int Vertices;
        public int Materials;
        public long FileBytes;
        public long GlbBytes;
        public double Seconds;
        public double[] SizeMetres = { 0, 0, 0 };
        public readonly Dictionary<string, int> PerCategory = new Dictionary<string, int>();
        public readonly List<string> Warnings = new List<string>();

        public string Summary()
        {
            var c = CultureInfo.InvariantCulture;
            var sb = new StringBuilder();
            if (Cancelled)
            {
                sb.Append("Export cancelled after ").Append(Seconds.ToString("0.0", c)).Append(" s.");
                return sb.ToString();
            }
            sb.AppendLine(string.Format(c, "{0:N0} elements, {1:N0} triangles, {2} materials", Elements, Triangles, Materials));
            if (LinkElements > 0) sb.AppendLine(string.Format(c, "{0:N0} of the elements are from linked models", LinkElements));
            if (SkippedRebar > 0) sb.AppendLine(string.Format(c, "{0:N0} reinforcement elements left out", SkippedRebar));
            sb.AppendLine(string.Join(", ", PerCategory.OrderByDescending(kv => kv.Value).ThenBy(kv => kv.Key, StringComparer.CurrentCulture)
                .Select(kv => kv.Key + " " + kv.Value.ToString(c))));
            sb.AppendLine(string.Format(c, "{0:0.0} MB file ({1:0.0} MB model), {2:0.0} s", FileBytes / 1048576.0, GlbBytes / 1048576.0, Seconds));
            foreach (var w in Warnings.Take(10)) sb.AppendLine("Warning: " + w);
            if (Warnings.Count > 10) sb.AppendLine(string.Format(c, "... and {0} more warnings", Warnings.Count - 10));
            return sb.ToString().TrimEnd();
        }
    }
}
