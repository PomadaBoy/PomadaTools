using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace RevitThreeExport.Core
{
    /// <summary>
    /// A JSON object that keeps its keys in insertion order. Setting an existing key
    /// replaces its value in place (like a Python or JavaScript object).
    /// </summary>
    public sealed class JsonObject : IEnumerable<KeyValuePair<string, object>>
    {
        private readonly List<KeyValuePair<string, object>> _items = new List<KeyValuePair<string, object>>();
        private readonly Dictionary<string, int> _index = new Dictionary<string, int>(StringComparer.Ordinal);

        public int Count => _items.Count;

        public object this[string key]
        {
            get { return _index.TryGetValue(key, out var i) ? _items[i].Value : null; }
            set
            {
                if (_index.TryGetValue(key, out var i))
                    _items[i] = new KeyValuePair<string, object>(key, value);
                else
                {
                    _index[key] = _items.Count;
                    _items.Add(new KeyValuePair<string, object>(key, value));
                }
            }
        }

        /// <summary>Same as the indexer; lets collection initialisers be used.</summary>
        public void Add(string key, object value) => this[key] = value;

        public bool ContainsKey(string key) => _index.ContainsKey(key);

        public IEnumerator<KeyValuePair<string, object>> GetEnumerator() => _items.GetEnumerator();
        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }

    /// <summary>
    /// Minimal JSON writer, the same output as JavaScript's JSON.stringify: non-ASCII
    /// text is written as-is (UTF-8 in the file), numbers use the invariant culture.
    /// Values: null, string, bool, integers, float/double, JsonObject, IDictionary
    /// with string keys, and any other IEnumerable (as an array).
    /// </summary>
    public static class Json
    {
        public static string Serialize(object value)
        {
            var sb = new StringBuilder();
            Write(sb, value);
            return sb.ToString();
        }

        public static void Write(StringBuilder sb, object value)
        {
            switch (value)
            {
                case null:
                    sb.Append("null");
                    return;
                case string s:
                    WriteString(sb, s);
                    return;
                case bool b:
                    sb.Append(b ? "true" : "false");
                    return;
                case int i:
                    sb.Append(i.ToString(CultureInfo.InvariantCulture));
                    return;
                case long l:
                    sb.Append(l.ToString(CultureInfo.InvariantCulture));
                    return;
                case uint ui:
                    sb.Append(ui.ToString(CultureInfo.InvariantCulture));
                    return;
                case short sh:
                    sb.Append(sh.ToString(CultureInfo.InvariantCulture));
                    return;
                case byte by:
                    sb.Append(by.ToString(CultureInfo.InvariantCulture));
                    return;
                case float f:
                    sb.Append(Number(f));
                    return;
                case double d:
                    sb.Append(Number(d));
                    return;
                case JsonObject o:
                    WriteObject(sb, o);
                    return;
                case IDictionary<string, string> ds:
                    sb.Append('{');
                    var firstDs = true;
                    foreach (var kv in ds)
                    {
                        if (!firstDs) sb.Append(',');
                        firstDs = false;
                        WriteString(sb, kv.Key);
                        sb.Append(':');
                        Write(sb, kv.Value);
                    }
                    sb.Append('}');
                    return;
                case IDictionary<string, object> dobj:
                    sb.Append('{');
                    var firstDo = true;
                    foreach (var kv in dobj)
                    {
                        if (!firstDo) sb.Append(',');
                        firstDo = false;
                        WriteString(sb, kv.Key);
                        sb.Append(':');
                        Write(sb, kv.Value);
                    }
                    sb.Append('}');
                    return;
                case IEnumerable e:
                    sb.Append('[');
                    var firstE = true;
                    foreach (var item in e)
                    {
                        if (!firstE) sb.Append(',');
                        firstE = false;
                        Write(sb, item);
                    }
                    sb.Append(']');
                    return;
                default:
                    throw new ArgumentException("Cannot write a " + value.GetType().FullName + " as JSON");
            }
        }

        private static void WriteObject(StringBuilder sb, JsonObject o)
        {
            sb.Append('{');
            var first = true;
            foreach (var kv in o)
            {
                if (!first) sb.Append(',');
                first = false;
                WriteString(sb, kv.Key);
                sb.Append(':');
                Write(sb, kv.Value);
            }
            sb.Append('}');
        }

        /// <summary>
        /// A number as JSON.stringify writes it. NaN and infinity have no JSON form and
        /// are written as null, as JavaScript does.
        /// </summary>
        public static string Number(double d)
        {
            if (double.IsNaN(d) || double.IsInfinity(d)) return "null";
            if (d == Math.Floor(d) && Math.Abs(d) < 1e15)
                return ((long)d).ToString(CultureInfo.InvariantCulture);
            return d.ToString("R", CultureInfo.InvariantCulture);
        }

        /// <summary>A float32 value, written as the double it widens to (as JavaScript sees it).</summary>
        public static string Number(float f) => Number((double)f);

        public static string Escape(string s)
        {
            var sb = new StringBuilder(s.Length + 2);
            WriteString(sb, s);
            return sb.ToString();
        }

        public static void WriteString(StringBuilder sb, string s)
        {
            sb.Append('"');
            for (var i = 0; i < s.Length; i++)
            {
                var c = s[i];
                switch (c)
                {
                    case '"': sb.Append("\\\""); continue;
                    case '\\': sb.Append("\\\\"); continue;
                    case '\b': sb.Append("\\b"); continue;
                    case '\f': sb.Append("\\f"); continue;
                    case '\n': sb.Append("\\n"); continue;
                    case '\r': sb.Append("\\r"); continue;
                    case '\t': sb.Append("\\t"); continue;
                }
                if (c < 0x20)
                {
                    AppendUnicodeEscape(sb, c);
                }
                else if (char.IsHighSurrogate(c))
                {
                    if (i + 1 < s.Length && char.IsLowSurrogate(s[i + 1]))
                    {
                        sb.Append(c).Append(s[i + 1]);
                        i++;
                    }
                    else AppendUnicodeEscape(sb, c);   // lone surrogate: not valid UTF-8, escape it
                }
                else if (char.IsLowSurrogate(c))
                {
                    AppendUnicodeEscape(sb, c);
                }
                else sb.Append(c);
            }
            sb.Append('"');
        }

        private static void AppendUnicodeEscape(StringBuilder sb, char c)
        {
            sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
        }
    }
}
