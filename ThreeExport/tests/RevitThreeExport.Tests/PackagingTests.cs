using System;
using System.IO;
using System.IO.Compression;
using System.Text;
using RevitThreeExport.Core;
using Xunit;

namespace RevitThreeExport.Tests
{
    public class PackagingTests
    {
        [Theory]
        [InlineData(0)]
        [InlineData(1)]
        [InlineData(2)]
        [InlineData(3)]
        [InlineData(4)]
        [InlineData(49151)]
        [InlineData(49152)]
        [InlineData(49153)]
        [InlineData(1000003)]
        public void Base64StreamMatchesConvert(int length)
        {
            var data = new byte[length];
            new Random(length).NextBytes(data);
            using (var ms = new MemoryStream())
            {
                using (var b64 = new Base64Stream(ms, leaveOpen: true))
                {
                    // odd-sized writes cross the internal block boundary
                    var at = 0;
                    var step = 1;
                    while (at < length)
                    {
                        var n = Math.Min(step, length - at);
                        b64.Write(data, at, n);
                        at += n;
                        step = step * 3 + 1;
                    }
                }
                Assert.Equal(Convert.ToBase64String(data), Encoding.ASCII.GetString(ms.ToArray()));
            }
        }

        [Fact]
        public void GzipBase64RoundTrip()
        {
            var data = new byte[300000];
            var rng = new Random(7);
            for (var i = 0; i < data.Length; i++) data[i] = (byte)(i % 251 < 200 ? i % 7 : rng.Next(256));
            string text;
            using (var ms = new MemoryStream())
            {
                using (var b64 = new Base64Stream(ms, leaveOpen: true))
                using (var gz = new GZipStream(b64, CompressionLevel.Optimal, leaveOpen: true))
                    gz.Write(data, 0, data.Length);
                text = Encoding.ASCII.GetString(ms.ToArray());
            }
            Assert.DoesNotContain("\n", text);
            var back = TestUtil.Gunzip(Convert.FromBase64String(text));
            Assert.Equal(data, back);
            Assert.True(text.Length < data.Length, "compressed text should be smaller than the input here");
        }

        private const string MiniTemplate =
            "<!doctype html>\n<title>__TITLE__</title><h1>__TITLE__</h1>" +
            "<script id=\"model-glb\" type=\"application/octet-stream\" data-encoding=\"gzip-base64\">__MODEL_BASE64__</script>" +
            "<script>app()</script>\n";

        [Fact]
        public void PackagerStreamsModelBetweenHeadAndTail()
        {
            var model = new byte[123457];
            new Random(3).NextBytes(model);
            byte[] page;
            using (var ms = new ForwardOnlyStream())
            {
                var n = HtmlPackager.Write(ms, MiniTemplate, "Most Voisavljevica <č & \"ž\">", s =>
                {
                    // write in pieces, as GlbWriter does
                    for (var i = 0; i < model.Length; i += 1000) s.Write(model, i, Math.Min(1000, model.Length - i));
                });
                Assert.Equal(model.Length, n);
                page = ms.ToArray();
            }
            Assert.False(page.Length >= 3 && page[0] == 0xEF && page[1] == 0xBB && page[2] == 0xBF, "no BOM");
            var html = new UTF8Encoding(false, true).GetString(page);
            Assert.StartsWith("<!doctype html>\n<title>Most Voisavljevica &lt;č &amp; &quot;ž&quot;&gt;</title><h1>Most Voisavljevica &lt;č", html);
            Assert.EndsWith("</script><script>app()</script>\n", html);
            Assert.DoesNotContain("__TITLE__", html);
            Assert.DoesNotContain("__MODEL_BASE64__", html);
            Assert.Equal(model, TestUtil.Gunzip(Convert.FromBase64String(TestUtil.ModelText(html))));
        }

        [Fact]
        public void PackagerRejectsTemplateWithoutPlaceholder()
        {
            Assert.Throws<ArgumentException>(() =>
                HtmlPackager.Write(new MemoryStream(), "<html></html>", "x", s => { }));
        }

        [Fact]
        public void EmbeddedTemplateHasPlaceholdersAndThreeLicence()
        {
            var t = HtmlPackager.LoadTemplate();
            Assert.Equal(2, Count(t, "__TITLE__"));
            Assert.Equal(1, Count(t, "__MODEL_BASE64__"));
            Assert.Contains("data-encoding=\"gzip-base64\">__MODEL_BASE64__</script>", t);
            Assert.Contains("Three.js Authors", t);
            Assert.Contains("SPDX-License-Identifier: MIT", t);
            // only the model tag and the app script may open/close script elements
            Assert.Equal(2, Count(t, "</script"));
        }

        private static int Count(string s, string what)
        {
            var n = 0;
            for (var i = s.IndexOf(what, StringComparison.Ordinal); i >= 0; i = s.IndexOf(what, i + what.Length, StringComparison.Ordinal)) n++;
            return n;
        }

        /// <summary>A stream that can only be written forward, like a network or file stream with no seeking.</summary>
        private sealed class ForwardOnlyStream : MemoryStream
        {
            public override bool CanSeek => false;
            public override long Seek(long offset, SeekOrigin loc) => throw new NotSupportedException();
            public override long Position { get => base.Position; set => throw new NotSupportedException(); }
        }
    }
}
