using System.Collections.Generic;
using System.Globalization;
using System.Text.Json;
using System.Threading;
using RevitThreeExport.Core;
using Xunit;

namespace RevitThreeExport.Tests
{
    public class JsonTests
    {
        [Theory]
        [InlineData("Obloga od Kulira", "\"Obloga od Kulira\"")]
        [InlineData("čćšžđ ČĆŠŽĐ", "\"čćšžđ ČĆŠŽĐ\"")]
        [InlineData("8.53 m³ · 171 m²", "\"8.53 m³ · 171 m²\"")]
        [InlineData("say \"hi\"", "\"say \\\"hi\\\"\"")]
        [InlineData("C:\\temp\\a", "\"C:\\\\temp\\\\a\"")]
        [InlineData("a\nb\r\tc\b\f", "\"a\\nb\\r\\tc\\b\\f\"")]
        [InlineData("\u0001\u001f", "\"\\u0001\\u001f\"")]
        [InlineData("</script>", "\"</script>\"")]
        [InlineData("😀", "\"😀\"")]
        [InlineData("", "\"\"")]
        public void EscapesStringsLikeJsonStringify(string input, string expected)
        {
            Assert.Equal(expected, Json.Escape(input));
        }

        [Fact]
        public void EscapesLoneSurrogates()
        {
            // built at run time: attribute strings cannot hold lone surrogates
            Assert.Equal(@"""\ud800x""", Json.Escape(new string(new[] { (char)0xD800, 'x' })));
            Assert.Equal(@"""x\udc00""", Json.Escape(new string(new[] { 'x', (char)0xDC00 })));
            Assert.Equal(@"""\udc00\ud800""", Json.Escape(new string(new[] { (char)0xDC00, (char)0xD800 })));
        }

        [Fact]
        public void NegativeZeroIsZero()
        {
            Assert.Equal("0", Json.Number(-0.0));
        }

        [Fact]
        public void EscapedStringsRoundTrip()
        {
            var samples = new[] { "čćšžđ", "m³", "\"\\/\n\t", "\u0000\u0007", "Беton", "日本", "😀 ok" };
            foreach (var s in samples)
                Assert.Equal(s, JsonSerializer.Deserialize<string>(Json.Escape(s)));
        }

        [Theory]
        [InlineData(0.0, "0")]
        [InlineData(1.0, "1")]
        [InlineData(0.85, "0.85")]
        [InlineData(8.5254, "8.5254")]
        [InlineData(-31.8133, "-31.8133")]
        [InlineData(1e-7, "1E-07")]
        [InlineData(double.NaN, "null")]
        [InlineData(double.PositiveInfinity, "null")]
        public void WritesNumbers(double value, string expected)
        {
            Assert.Equal(expected, Json.Number(value));
            if (expected != "null") Assert.Equal(value, JsonSerializer.Deserialize<double>(expected));
        }

        [Fact]
        public void FloatsWidenLikeJavaScript()
        {
            // what JSON.stringify writes for Math.fround(-31.121437)
            Assert.Equal("-31.121437072753906", Json.Number(-31.121437f));
        }

        [Fact]
        public void NumbersIgnoreTheCurrentCulture()
        {
            var old = Thread.CurrentThread.CurrentCulture;
            try
            {
                Thread.CurrentThread.CurrentCulture = new CultureInfo("sr-Latn-RS");
                Assert.Equal("[0.85,1.5,-2.25]", Json.Serialize(new[] { 0.85, 1.5, -2.25 }));
                Assert.Equal("1234567", Json.Serialize(1234567L));
            }
            finally
            {
                Thread.CurrentThread.CurrentCulture = old;
            }
        }

        [Fact]
        public void WritesObjectsInOrderAndReplacesDuplicateKeys()
        {
            var o = new JsonObject
            {
                { "id", 843064L },
                { "type", "Obloga od Kulira" },
                { "mark", null },
                { "volume_m3", 8.5254 },
                { "materials", new List<string> { "Kulir" } },
                { "params", new JsonObject { { "Volume", "8.53 m³" }, { "Area", "171 m²" } } },
            };
            o["type"] = "Obloga";   // replaced in place, order kept
            Assert.Equal(
                "{\"id\":843064,\"type\":\"Obloga\",\"mark\":null,\"volume_m3\":8.5254,\"materials\":[\"Kulir\"]," +
                "\"params\":{\"Volume\":\"8.53 m³\",\"Area\":\"171 m²\"}}",
                Json.Serialize(o));
            using (var doc = JsonDocument.Parse(Json.Serialize(o)))
                Assert.Equal("8.53 m³", doc.RootElement.GetProperty("params").GetProperty("Volume").GetString());
        }

        [Fact]
        public void WritesNestedArraysAndBooleans()
        {
            Assert.Equal("[[1,2],[true,false],[]]", Json.Serialize(new object[] { new[] { 1, 2 }, new[] { true, false }, new int[0] }));
        }
    }
}
