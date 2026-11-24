using System;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;

namespace RevitThreeExport.Core
{
    /// <summary>
    /// Writes the single-file viewer: template head, the .glb gzipped and base64
    /// encoded inside &lt;script id="model-glb"&gt;, template tail. Streams the model,
    /// so the file is never held in memory as one string.
    /// </summary>
    public static class HtmlPackager
    {
        public const string TitlePlaceholder = "__TITLE__";
        public const string ModelPlaceholder = "__MODEL_BASE64__";
        public const string ResourceName = "RevitThreeExport.viewer.html";

        private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false);

        /// <summary>The viewer template built by viewer/build.mjs, embedded in this DLL.</summary>
        public static string LoadTemplate()
        {
            using (var s = typeof(HtmlPackager).GetTypeInfo().Assembly.GetManifestResourceStream(ResourceName))
            {
                if (s == null) throw new InvalidOperationException("viewer template resource is missing: " + ResourceName);
                using (var r = new StreamReader(s, Utf8))
                    return r.ReadToEnd();
            }
        }

        public static string HtmlEscape(string s)
        {
            var sb = new StringBuilder(s.Length);
            foreach (var c in s)
            {
                switch (c)
                {
                    case '&': sb.Append("&amp;"); break;
                    case '<': sb.Append("&lt;"); break;
                    case '>': sb.Append("&gt;"); break;
                    case '"': sb.Append("&quot;"); break;
                    default: sb.Append(c); break;
                }
            }
            return sb.ToString();
        }

        /// <summary>
        /// Writes the page to <paramref name="output"/> (UTF-8, no BOM).
        /// <paramref name="writeModel"/> writes the raw .glb bytes to the stream it is given.
        /// Returns the number of .glb bytes written.
        /// </summary>
        public static long Write(Stream output, string template, string title, Action<Stream> writeModel)
        {
            var at = template.IndexOf(ModelPlaceholder, StringComparison.Ordinal);
            if (at < 0 || template.IndexOf(ModelPlaceholder, at + 1, StringComparison.Ordinal) >= 0)
                throw new ArgumentException("template must contain " + ModelPlaceholder + " exactly once");
            var t = HtmlEscape(string.IsNullOrEmpty(title) ? "Revit model" : title);
            var head = template.Substring(0, at).Replace(TitlePlaceholder, t);
            var tail = template.Substring(at + ModelPlaceholder.Length).Replace(TitlePlaceholder, t);

            var headBytes = Utf8.GetBytes(head);
            output.Write(headBytes, 0, headBytes.Length);

            long glbBytes;
            using (var b64 = new Base64Stream(output, leaveOpen: true))
            {
                using (var gz = new GZipStream(b64, CompressionLevel.Optimal, leaveOpen: true))
                using (var counter = new CountingStream(gz))
                {
                    writeModel(counter);
                    counter.Flush();
                    glbBytes = counter.Count;
                }
                b64.FlushFinalBlock();
            }

            var tailBytes = Utf8.GetBytes(tail);
            output.Write(tailBytes, 0, tailBytes.Length);
            output.Flush();
            return glbBytes;
        }

        /// <summary>Pass-through stream that counts the bytes written (does not close the inner stream).</summary>
        private sealed class CountingStream : Stream
        {
            private readonly Stream _inner;
            public long Count;

            public CountingStream(Stream inner) { _inner = inner; }

            public override void Write(byte[] buffer, int offset, int count)
            {
                _inner.Write(buffer, offset, count);
                Count += count;
            }

            public override void WriteByte(byte value)
            {
                _inner.WriteByte(value);
                Count++;
            }

            public override void Flush() => _inner.Flush();
            public override bool CanRead => false;
            public override bool CanSeek => false;
            public override bool CanWrite => true;
            public override long Length => Count;
            public override long Position { get => Count; set => throw new NotSupportedException(); }
            public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
            public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
            public override void SetLength(long value) => throw new NotSupportedException();
        }
    }
}
