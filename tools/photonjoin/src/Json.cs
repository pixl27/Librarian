using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace PhotonJoin
{
    /// <summary>
    /// Un lecteur et un écrivain JSON minimaux.
    ///
    /// Le greffon ne peut référencer ni Newtonsoft ni JsonUtility : le premier
    /// n'existe pas dans tous les jeux, le second vient d'UnityEngine et
    /// n'accepte que des classes annotées. Deux cents lignes ici valent mieux
    /// qu'une dépendance qui rendrait le binaire non universel.
    /// </summary>
    public static class Json
    {
        public static object Parse(string text)
        {
            var i = 0;
            var value = ParseValue(text, ref i);
            SkipWhite(text, ref i);
            if (i < text.Length) throw new FormatException("Texte en trop après la valeur, position " + i + ".");
            return value;
        }

        public static bool TryParse(string text, out object value, out string error)
        {
            value = null; error = null;
            try { value = Parse(text); return true; }
            catch (Exception e) { error = e.Message; return false; }
        }

        // ---- Lecture -------------------------------------------------------

        private static void SkipWhite(string s, ref int i)
        {
            while (i < s.Length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\r' || s[i] == '\n')) i++;
        }

        private static object ParseValue(string s, ref int i)
        {
            SkipWhite(s, ref i);
            if (i >= s.Length) throw new FormatException("Fin de texte inattendue.");
            var c = s[i];
            switch (c)
            {
                case '{': return ParseObject(s, ref i);
                case '[': return ParseArray(s, ref i);
                case '"': return ParseString(s, ref i);
                case 't': Expect(s, ref i, "true"); return true;
                case 'f': Expect(s, ref i, "false"); return false;
                case 'n': Expect(s, ref i, "null"); return null;
                default: return ParseNumber(s, ref i);
            }
        }

        private static void Expect(string s, ref int i, string word)
        {
            if (i + word.Length > s.Length || string.CompareOrdinal(s, i, word, 0, word.Length) != 0)
                throw new FormatException("Mot-clé attendu « " + word + " » position " + i + ".");
            i += word.Length;
        }

        private static Dictionary<string, object> ParseObject(string s, ref int i)
        {
            var map = new Dictionary<string, object>(StringComparer.Ordinal);
            i++; // {
            SkipWhite(s, ref i);
            if (i < s.Length && s[i] == '}') { i++; return map; }
            while (true)
            {
                SkipWhite(s, ref i);
                if (i >= s.Length || s[i] != '"') throw new FormatException("Nom de champ attendu position " + i + ".");
                var key = ParseString(s, ref i);
                SkipWhite(s, ref i);
                if (i >= s.Length || s[i] != ':') throw new FormatException("« : » attendu position " + i + ".");
                i++;
                map[key] = ParseValue(s, ref i);
                SkipWhite(s, ref i);
                if (i >= s.Length) throw new FormatException("Objet non refermé.");
                if (s[i] == ',') { i++; continue; }
                if (s[i] == '}') { i++; return map; }
                throw new FormatException("« , » ou « } » attendu position " + i + ".");
            }
        }

        private static List<object> ParseArray(string s, ref int i)
        {
            var list = new List<object>();
            i++; // [
            SkipWhite(s, ref i);
            if (i < s.Length && s[i] == ']') { i++; return list; }
            while (true)
            {
                list.Add(ParseValue(s, ref i));
                SkipWhite(s, ref i);
                if (i >= s.Length) throw new FormatException("Tableau non refermé.");
                if (s[i] == ',') { i++; continue; }
                if (s[i] == ']') { i++; return list; }
                throw new FormatException("« , » ou « ] » attendu position " + i + ".");
            }
        }

        private static string ParseString(string s, ref int i)
        {
            i++; // "
            var sb = new StringBuilder();
            while (true)
            {
                if (i >= s.Length) throw new FormatException("Chaîne non refermée.");
                var c = s[i++];
                if (c == '"') return sb.ToString();
                if (c != '\\') { sb.Append(c); continue; }
                if (i >= s.Length) throw new FormatException("Échappement tronqué.");
                var e = s[i++];
                switch (e)
                {
                    case '"': sb.Append('"'); break;
                    case '\\': sb.Append('\\'); break;
                    case '/': sb.Append('/'); break;
                    case 'b': sb.Append('\b'); break;
                    case 'f': sb.Append('\f'); break;
                    case 'n': sb.Append('\n'); break;
                    case 'r': sb.Append('\r'); break;
                    case 't': sb.Append('\t'); break;
                    case 'u':
                        if (i + 4 > s.Length) throw new FormatException("Échappement \\u tronqué.");
                        sb.Append((char)ushort.Parse(s.Substring(i, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture));
                        i += 4;
                        break;
                    default: throw new FormatException("Échappement inconnu « \\" + e + " ».");
                }
            }
        }

        private static object ParseNumber(string s, ref int i)
        {
            var start = i;
            if (i < s.Length && (s[i] == '-' || s[i] == '+')) i++;
            while (i < s.Length && ((s[i] >= '0' && s[i] <= '9') || s[i] == '.' || s[i] == 'e' || s[i] == 'E' || s[i] == '-' || s[i] == '+')) i++;
            if (i == start) throw new FormatException("Valeur inattendue position " + start + ".");
            var raw = s.Substring(start, i - start);
            double d;
            if (!double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out d))
                throw new FormatException("Nombre illisible « " + raw + " ».");
            return d;
        }

        // ---- Accès confortable ---------------------------------------------

        public static Dictionary<string, object> Obj(object node)
        {
            return node as Dictionary<string, object>;
        }

        public static object Get(object node, string key)
        {
            var map = node as Dictionary<string, object>;
            if (map == null) return null;
            object v;
            return map.TryGetValue(key, out v) ? v : null;
        }

        public static string Str(object node, string key, string fallback)
        {
            var v = Get(node, key);
            return v == null ? fallback : (v as string ?? Convert.ToString(v, CultureInfo.InvariantCulture));
        }

        public static bool Bool(object node, string key, bool fallback)
        {
            var v = Get(node, key);
            if (v is bool) return (bool)v;
            return fallback;
        }

        public static int Int(object node, string key, int fallback)
        {
            var v = Get(node, key);
            if (v is double) return (int)(double)v;
            return fallback;
        }

        public static List<object> Arr(object node, string key)
        {
            return Get(node, key) as List<object>;
        }

        // ---- Écriture ------------------------------------------------------

        public static string Write(object value, int indent)
        {
            var sb = new StringBuilder();
            WriteValue(sb, value, indent, 0);
            return sb.ToString();
        }

        private static void WriteValue(StringBuilder sb, object v, int indent, int depth)
        {
            if (v == null) { sb.Append("null"); return; }
            if (v is string) { WriteString(sb, (string)v); return; }
            if (v is bool) { sb.Append(((bool)v) ? "true" : "false"); return; }
            if (v is double || v is int || v is long || v is float)
            {
                var d = Convert.ToDouble(v, CultureInfo.InvariantCulture);
                sb.Append(d == Math.Floor(d) && Math.Abs(d) < 1e15
                    ? ((long)d).ToString(CultureInfo.InvariantCulture)
                    : d.ToString("R", CultureInfo.InvariantCulture));
                return;
            }

            var map = v as Dictionary<string, object>;
            if (map != null)
            {
                if (map.Count == 0) { sb.Append("{}"); return; }
                sb.Append('{');
                var first = true;
                foreach (var kv in map)
                {
                    if (!first) sb.Append(',');
                    first = false;
                    NewLine(sb, indent, depth + 1);
                    WriteString(sb, kv.Key);
                    sb.Append(':');
                    if (indent > 0) sb.Append(' ');
                    WriteValue(sb, kv.Value, indent, depth + 1);
                }
                NewLine(sb, indent, depth);
                sb.Append('}');
                return;
            }

            var list = v as List<object>;
            if (list != null)
            {
                if (list.Count == 0) { sb.Append("[]"); return; }
                sb.Append('[');
                for (var i = 0; i < list.Count; i++)
                {
                    if (i > 0) sb.Append(',');
                    NewLine(sb, indent, depth + 1);
                    WriteValue(sb, list[i], indent, depth + 1);
                }
                NewLine(sb, indent, depth);
                sb.Append(']');
                return;
            }

            WriteString(sb, Convert.ToString(v, CultureInfo.InvariantCulture));
        }

        private static void NewLine(StringBuilder sb, int indent, int depth)
        {
            if (indent <= 0) return;
            sb.Append('\n');
            sb.Append(' ', indent * depth);
        }

        private static void WriteString(StringBuilder sb, string s)
        {
            sb.Append('"');
            foreach (var c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
        }
    }
}
