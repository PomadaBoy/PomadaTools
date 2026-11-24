using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.ExceptionServices;
using Autodesk.Revit.DB;
using RevitThreeExport.Core;

namespace RevitThreeExport
{
    /// <summary>
    /// Exports the elements visible in a 3D view to one self-contained HTML file
    /// (three.js viewer with the model embedded). Read-only: no transaction.
    /// </summary>
    public static class Exporter
    {
        public static string Version =>
            typeof(Exporter).GetTypeInfo().Assembly.GetName().Version.ToString(3);

        public static ExportResult Export(Document doc, View3D view, ExportOptions options)
        {
            if (doc == null) throw new ArgumentNullException(nameof(doc));
            if (view == null) throw new ArgumentNullException(nameof(view));
            if (view.IsTemplate) throw new ArgumentException("the view is a view template");
            if (options == null) throw new ArgumentNullException(nameof(options));
            if (string.IsNullOrEmpty(options.OutputPath)) throw new ArgumentException("ExportOptions.OutputPath is empty");

            var clock = Stopwatch.StartNew();
            var result = new ExportResult { OutputPath = options.OutputPath, Document = doc.Title, View = view.Name };
            var template = HtmlPackager.LoadTemplate();

            // ---- geometry ----
            var hostCount = new FilteredElementCollector(doc, view.Id).WhereElementIsNotElementType().GetElementCount();
            var ctx = new ViewExportContext(doc, options, hostCount);
            var exporter = new CustomExporter(doc, ctx) { IncludeGeometricObjects = false, ShouldStopOnError = false };
            RunExport(exporter, view);
            result.Warnings.AddRange(ctx.Warnings);
            result.SkippedRebar = ctx.SkippedRebar;
            if (ctx.Cancelled) return Cancel(result, clock);

            // ---- metadata, in output order: category, then host before links, then id ----
            var meta = new MetadataCollector(view, options.IncludeTypeParameters);
            var records = ctx.Records
                .Select(r => new { Rec = r, Category = MetadataCollector.CategoryOf(r.Element) })
                .OrderBy(x => x.Category, StringComparer.Create(CultureInfo.InvariantCulture, false))
                .ThenBy(x => x.Rec.Frame.Key, StringComparer.Ordinal)
                .ThenBy(x => x.Rec.IdValue)
                .ToList();

            var scene = new GlbScene
            {
                Name = doc.Title,
                Generator = "RevitThreeExport " + Version,
                Origin = ctx.HaveOrigin ? ctx.Origin : new double[3],
                RootExtras = new JsonObject
                {
                    { "source", "Revit" },
                    { "document", doc.Title },
                    { "view", view.Name },
                    { "viewId", Ids.Of(view.Id) },
                    { "exportedAt", DateTime.Now.ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture) },
                },
            };
            var shared = SharedCoordinates(doc);
            if (shared != null) scene.RootExtras["sharedCoordinates"] = shared;
            scene.Materials.AddRange(ctx.Materials);

            var lastReport = -1000L;
            for (var i = 0; i < records.Count; i++)
            {
                if (options.Progress != null && clock.ElapsedMilliseconds - lastReport >= 100)
                {
                    lastReport = clock.ElapsedMilliseconds;
                    if (!options.Progress("Reading parameters", i, records.Count)) return Cancel(result, clock);
                }
                var rec = records[i].Rec;
                var g = rec.Glb;
                g.Category = records[i].Category;
                try
                {
                    g.Extras = meta.Collect(rec, scene.Materials);
                }
                catch (Exception ex)
                {
                    result.Warnings.Add("parameters of " + rec.Key + ": " + ex.Message);
                    g.Extras = new JsonObject { { "id", rec.IdValue }, { "category", g.Category } };
                }
                var type = g.Extras["type"] as string;
                var family = g.Extras["family"] as string;
                g.NodeName = g.Category + " – " + (!string.IsNullOrEmpty(type) ? type : family) + " [" + rec.IdValue + "]";
                g.MeshName = rec.Frame.IsLink ? rec.Key : rec.IdValue.ToString(CultureInfo.InvariantCulture);
                if (rec.Frame.IsLink) result.LinkElements++;
                scene.Elements.Add(g);
            }

            // ---- file: write next to the target, then replace it ----
            if (options.Progress != null && !options.Progress("Writing file", 0, 1)) return Cancel(result, clock);
            var dir = Path.GetDirectoryName(Path.GetFullPath(options.OutputPath));
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            var temp = options.OutputPath + ".part";
            GlbStats stats = null;
            try
            {
                using (var fs = new FileStream(temp, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 16))
                {
                    result.GlbBytes = HtmlPackager.Write(fs, template, doc.Title, s => stats = GlbWriter.Write(scene, s));
                }
                if (File.Exists(options.OutputPath)) File.Delete(options.OutputPath);
                File.Move(temp, options.OutputPath);
            }
            catch
            {
                try { File.Delete(temp); } catch { /* leave it */ }
                throw;
            }

            result.Elements = stats.Elements;
            result.Triangles = stats.Triangles;
            result.Vertices = stats.Vertices;
            result.Materials = stats.Materials;
            result.SizeMetres = stats.SizeMetres;
            foreach (var kv in stats.PerCategory) result.PerCategory[kv.Key] = kv.Value;
            result.FileBytes = new FileInfo(options.OutputPath).Length;
            result.Seconds = clock.Elapsed.TotalSeconds;
            options.Progress?.Invoke("Done", 1, 1);
            return result;
        }

        /// <summary>
        /// The project's shared (survey) coordinates, as a map from Revit internal metres:
        /// shared = origin + x·basisX + y·basisY + z·basisZ. Null when they are the same as the
        /// internal ones, or Revit can't say.
        /// </summary>
        private static JsonObject SharedCoordinates(Document doc)
        {
            try
            {
                var location = doc.ActiveProjectLocation;
                if (location == null) return null;
                // GetTotalTransform maps shared coordinates to internal ones
                var t = location.GetTotalTransform().Inverse;
                if (t.IsIdentity) return null;
                const double ft = 0.3048;
                double[] V(XYZ v) => new[] { v.X, v.Y, v.Z };
                return new JsonObject
                {
                    { "location", location.Name },
                    { "origin", new[] { t.Origin.X * ft, t.Origin.Y * ft, t.Origin.Z * ft } },
                    { "basisX", V(t.BasisX) },
                    { "basisY", V(t.BasisY) },
                    { "basisZ", V(t.BasisZ) },
                };
            }
            catch (Autodesk.Revit.Exceptions.ApplicationException)
            {
                return null;
            }
        }

        private static ExportResult Cancel(ExportResult result, Stopwatch clock)
        {
            result.Cancelled = true;
            result.Seconds = clock.Elapsed.TotalSeconds;
            return result;
        }

        /// <summary>
        /// CustomExporter.Export takes a View on newer Revit versions and a View3D on
        /// older ones; find whichever this Revit has, so one DLL covers 2021-2024.
        /// </summary>
        private static void RunExport(CustomExporter exporter, View3D view)
        {
            var t = typeof(CustomExporter);
            var m = t.GetMethod("Export", new[] { typeof(View) }) ?? t.GetMethod("Export", new[] { typeof(View3D) });
            if (m == null) throw new MissingMethodException("CustomExporter.Export(View) is not available in this Revit version");
            try
            {
                m.Invoke(exporter, new object[] { view });
            }
            catch (TargetInvocationException ex) when (ex.InnerException != null)
            {
                ExceptionDispatchInfo.Capture(ex.InnerException).Throw();
            }
        }
    }
}
