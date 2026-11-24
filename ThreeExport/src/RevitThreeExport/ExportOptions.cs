using System;

namespace RevitThreeExport
{
    public sealed class ExportOptions
    {
        /// <summary>The .html file to write.</summary>
        public string OutputPath;

        /// <summary>Export the elements of loaded Revit links shown in the view.</summary>
        public bool IncludeLinks = true;

        /// <summary>Store all type parameters of each element (instance parameters are always stored).</summary>
        public bool IncludeTypeParameters = true;

        /// <summary>
        /// Called with (phase, done, total) about ten times a second. Return false to cancel.
        /// From pyRevit a plain Python function can be assigned.
        /// </summary>
        public Func<string, int, int, bool> Progress;
    }
}
