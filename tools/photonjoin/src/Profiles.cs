using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;

namespace PhotonJoin
{
    /// <summary>
    /// Ce qu'un jeu particulier exige, décrit en JSON plutôt qu'en C#.
    ///
    /// C'est la pièce qui rend le moteur générique utile : la mécanique de
    /// jonction est la même partout, mais les noms — le type qui porte le
    /// chemin d'entrée, la touche, la façon de se présenter — changent d'un
    /// titre à l'autre. Les mettre dans un fichier permet d'instruire un jeu
    /// inconnu sans recompiler quoi que ce soit.
    /// </summary>
    public sealed class GameProfile
    {
        public const int CurrentSchema = 1;

        public int Schema = CurrentSchema;
        public string Id = "";
        public string Name = "";
        public string Notes = "";

        public string MatchAppId = "";
        public string MatchProduct = "";
        public List<string> MatchTypes = new List<string>();

        public string Hotkey = "F7";
        public string Friends = "steam";               // steam | manual

        public string IdentityStrategy = "keep";       // keep | prefix-host | mirror-host | custom
        public string IdentityPrefix = "";
        public string IdentityCustom = "";

        public string EntryStrategy = "raw";           // raw | native | rejoin
        public string NativeType = "";
        public string NativeInstance = "";
        public string NativeInvoke = "";
        public List<KeyValuePair<string, string>> NativeFields = new List<KeyValuePair<string, string>>();
        public string Region = "$current";              // $current | littéral

        public bool ShieldDisconnectMessage = true;
        public List<int> ShieldCodes = new List<int> { 104 };
        public List<string> ShieldKickRpc = new List<string>();

        public bool IsDefault;
        public string Source = "";

        public override string ToString()
        {
            return (string.IsNullOrEmpty(Name) ? Id : Name)
                 + " [identité " + IdentityStrategy + ", entrée " + EntryStrategy + "]";
        }
    }

    public sealed class ProfileReadResult
    {
        public GameProfile Profile;
        public readonly List<string> Errors = new List<string>();
        public bool Ok { get { return Errors.Count == 0; } }
        public string Message { get { return string.Join(" ; ", Errors.ToArray()); } }
    }

    public static class ProfileStore
    {
        private static readonly string[] Strategies = { "keep", "prefix-host", "mirror-host", "custom" };
        private static readonly string[] Entries = { "raw", "native", "rejoin" };
        private static readonly string[] FriendSources = { "steam", "manual" };

        /// <summary>
        /// Le profil qu'un jeu reçoit quand personne ne l'a encore décrit.
        ///
        /// Il ne tente rien d'astucieux : identité inchangée, entrée par l'appel
        /// PUN direct, bouclier armé sur la trame d'expulsion. C'est le
        /// comportement qui a le plus de chances de fonctionner sur un jeu
        /// simple, et le point de départ que la sonde propose d'affiner.
        /// </summary>
        public static GameProfile Default()
        {
            return new GameProfile
            {
                Id = "defaut",
                Name = "Profil par défaut",
                IsDefault = true,
                Hotkey = "F7",
                Friends = "steam",
                IdentityStrategy = "keep",
                EntryStrategy = "raw",
                Region = "$current",
                ShieldDisconnectMessage = true,
                ShieldCodes = new List<int> { 104 },
                Notes = "Aucun profil ne correspond à ce jeu. La sonde propose une ébauche à compléter.",
            };
        }

        /// <summary>Lire un profil déjà analysé, en signalant chaque champ fautif.</summary>
        public static ProfileReadResult FromJson(object root, string source)
        {
            var res = new ProfileReadResult();
            var p = new GameProfile { Source = source ?? "" };

            if (Json.Obj(root) == null)
            {
                res.Errors.Add("racine : un objet JSON est attendu");
                return res;
            }

            p.Schema = Json.Int(root, "schema", 0);
            if (p.Schema != GameProfile.CurrentSchema)
                res.Errors.Add("schema : " + p.Schema + " n'est pas la version attendue (" + GameProfile.CurrentSchema + ")");

            p.Id = Json.Str(root, "id", "");
            if (!IsSlug(p.Id)) res.Errors.Add("id : identifiant vide ou non conforme (minuscules, chiffres, point, tiret, souligné)");

            p.Name = Json.Str(root, "name", "");
            if (string.IsNullOrEmpty(p.Name)) res.Errors.Add("name : nom lisible manquant");

            p.Notes = Json.Str(root, "notes", "");

            var match = Json.Get(root, "match");
            p.MatchAppId = Json.Str(match, "appId", "");
            p.MatchProduct = Json.Str(match, "product", "");
            var types = Json.Arr(match, "types");
            if (types != null) foreach (var t in types) { var s = t as string; if (!string.IsNullOrEmpty(s)) p.MatchTypes.Add(s); }
            if (match != null && string.IsNullOrEmpty(p.MatchAppId) && string.IsNullOrEmpty(p.MatchProduct) && p.MatchTypes.Count == 0)
                res.Errors.Add("match : aucun critère de reconnaissance — appId, product ou types");

            p.Hotkey = Json.Str(root, "hotkey", "F7");
            if (string.IsNullOrEmpty(p.Hotkey)) res.Errors.Add("hotkey : touche vide");

            p.Friends = Json.Str(root, "friends", "steam");
            if (Array.IndexOf(FriendSources, p.Friends) < 0)
                res.Errors.Add("friends : « " + p.Friends + " » inconnu (steam, manual)");

            var identity = Json.Get(root, "identity");
            p.IdentityStrategy = Json.Str(identity, "strategy", "keep");
            p.IdentityPrefix = Json.Str(identity, "prefix", "");
            p.IdentityCustom = Json.Str(identity, "custom", "");
            if (Array.IndexOf(Strategies, p.IdentityStrategy) < 0)
                res.Errors.Add("identity.strategy : « " + p.IdentityStrategy + " » inconnue (" + string.Join(", ", Strategies) + ")");
            if (p.IdentityStrategy == "prefix-host" && string.IsNullOrEmpty(p.IdentityPrefix))
                res.Errors.Add("identity.prefix : vide alors que la stratégie prefix-host en exige un — sans préfixe, l'identifiant présenté serait celui de l'hôte");
            if (p.IdentityStrategy == "custom" && string.IsNullOrEmpty(p.IdentityCustom))
                res.Errors.Add("identity.custom : vide alors que la stratégie custom en exige un");

            var entry = Json.Get(root, "entry");
            p.EntryStrategy = Json.Str(entry, "strategy", "raw");
            if (Array.IndexOf(Entries, p.EntryStrategy) < 0)
                res.Errors.Add("entry.strategy : « " + p.EntryStrategy + " » inconnue (" + string.Join(", ", Entries) + ")");
            p.Region = Json.Str(entry, "region", "$current");

            var native = Json.Get(entry, "native");
            p.NativeType = Json.Str(native, "type", "");
            p.NativeInstance = Json.Str(native, "instance", "");
            p.NativeInvoke = Json.Str(native, "invoke", "");
            var fields = Json.Obj(Json.Get(native, "fields"));
            if (fields != null)
                foreach (var kv in fields)
                    p.NativeFields.Add(new KeyValuePair<string, string>(kv.Key, Convert.ToString(kv.Value, CultureInfo.InvariantCulture)));

            if (p.EntryStrategy == "native")
            {
                if (string.IsNullOrEmpty(p.NativeType))
                    res.Errors.Add("entry.native.type : absent alors que la stratégie native l'exige");
                if (string.IsNullOrEmpty(p.NativeInvoke))
                    res.Errors.Add("entry.native.invoke : absent alors que la stratégie native l'exige");
            }

            var shield = Json.Get(root, "shield");
            if (shield != null)
            {
                p.ShieldDisconnectMessage = Json.Bool(shield, "disconnectMessage", true);
                var codes = Json.Arr(shield, "codes");
                if (codes != null)
                {
                    p.ShieldCodes = new List<int>();
                    for (var i = 0; i < codes.Count; i++)
                    {
                        if (codes[i] is double) p.ShieldCodes.Add((int)(double)codes[i]);
                        else res.Errors.Add("shield.codes[" + i + "] : un entier est attendu");
                    }
                }
                var rpc = Json.Arr(shield, "kickRpc");
                if (rpc != null) foreach (var r in rpc) { var s = r as string; if (!string.IsNullOrEmpty(s)) p.ShieldKickRpc.Add(s); }
            }

            res.Profile = res.Ok ? p : null;
            return res;
        }

        public static ProfileReadResult FromText(string text, string source)
        {
            object root;
            string error;
            if (!Json.TryParse(text, out root, out error))
            {
                var bad = new ProfileReadResult();
                bad.Errors.Add("json : " + error);
                return bad;
            }
            return FromJson(root, source);
        }

        public static string ToJson(GameProfile p)
        {
            var match = new Dictionary<string, object>(StringComparer.Ordinal);
            if (!string.IsNullOrEmpty(p.MatchAppId)) match["appId"] = p.MatchAppId;
            if (!string.IsNullOrEmpty(p.MatchProduct)) match["product"] = p.MatchProduct;
            if (p.MatchTypes.Count > 0) match["types"] = p.MatchTypes.Cast<object>().ToList();

            var identity = new Dictionary<string, object>(StringComparer.Ordinal) { { "strategy", p.IdentityStrategy } };
            if (!string.IsNullOrEmpty(p.IdentityPrefix)) identity["prefix"] = p.IdentityPrefix;
            if (!string.IsNullOrEmpty(p.IdentityCustom)) identity["custom"] = p.IdentityCustom;

            var entry = new Dictionary<string, object>(StringComparer.Ordinal)
            {
                { "strategy", p.EntryStrategy },
                { "region", p.Region },
            };
            if (p.EntryStrategy == "native" || !string.IsNullOrEmpty(p.NativeType))
            {
                var fields = new Dictionary<string, object>(StringComparer.Ordinal);
                foreach (var kv in p.NativeFields) fields[kv.Key] = kv.Value;
                entry["native"] = new Dictionary<string, object>(StringComparer.Ordinal)
                {
                    { "type", p.NativeType },
                    { "instance", p.NativeInstance },
                    { "fields", fields },
                    { "invoke", p.NativeInvoke },
                };
            }

            var shield = new Dictionary<string, object>(StringComparer.Ordinal)
            {
                { "disconnectMessage", p.ShieldDisconnectMessage },
                { "codes", p.ShieldCodes.Select(c => (object)(double)c).ToList() },
            };
            if (p.ShieldKickRpc.Count > 0) shield["kickRpc"] = p.ShieldKickRpc.Cast<object>().ToList();

            var root = new Dictionary<string, object>(StringComparer.Ordinal)
            {
                { "schema", (double)p.Schema },
                { "id", p.Id },
                { "name", p.Name },
                { "match", match },
                { "hotkey", p.Hotkey },
                { "friends", p.Friends },
                { "identity", identity },
                { "entry", entry },
                { "shield", shield },
            };
            if (!string.IsNullOrEmpty(p.Notes)) root["notes"] = p.Notes;

            return Json.Write(root, 2) + "\n";
        }

        /// <summary>
        /// Choisir le profil d'un jeu parmi ceux d'un dossier.
        ///
        /// L'AppID prime, puis le nom de produit, puis la présence d'un type
        /// nommé dans le profil — ce dernier critère est le seul qui fonctionne
        /// pour un jeu lancé hors de Steam.
        /// </summary>
        public static GameProfile Choose(IEnumerable<GameProfile> profiles, string appId, string product, Func<string, bool> hasType, out string note)
        {
            var all = profiles == null ? new List<GameProfile>() : profiles.Where(p => p != null).ToList();

            foreach (var p in all)
                if (!string.IsNullOrEmpty(appId) && p.MatchAppId == appId)
                { note = "profil « " + p.Id + " » retenu sur l'AppID " + appId + "."; return p; }

            foreach (var p in all)
                if (!string.IsNullOrEmpty(product) && !string.IsNullOrEmpty(p.MatchProduct)
                    && string.Equals(p.MatchProduct, product, StringComparison.OrdinalIgnoreCase))
                { note = "profil « " + p.Id + " » retenu sur le nom du produit."; return p; }

            if (hasType != null)
                foreach (var p in all)
                    foreach (var t in p.MatchTypes)
                        if (hasType(t))
                        { note = "profil « " + p.Id + " » retenu sur la présence du type " + t + "."; return p; }

            note = "aucun profil ne correspond ; profil par défaut appliqué.";
            var d = Default();
            d.MatchAppId = appId ?? "";
            d.MatchProduct = product ?? "";
            return d;
        }

        /// <summary>Lire tous les profils d'un dossier, en ignorant ceux qui sont invalides mais en le disant.</summary>
        public static List<GameProfile> LoadFolder(string dir, List<string> problems)
        {
            var list = new List<GameProfile>();
            if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir)) return list;

            string[] files;
            try { files = Directory.GetFiles(dir, "*.json"); }
            catch (Exception e) { if (problems != null) problems.Add(dir + " : " + e.Message); return list; }

            Array.Sort(files, StringComparer.OrdinalIgnoreCase);
            foreach (var f in files)
            {
                string text;
                try { text = File.ReadAllText(f); }
                catch (Exception e) { if (problems != null) problems.Add(Path.GetFileName(f) + " : " + e.Message); continue; }

                var read = FromText(text, Path.GetFileName(f));
                if (read.Ok) list.Add(read.Profile);
                else if (problems != null) problems.Add(Path.GetFileName(f) + " : " + read.Message);
            }
            return list;
        }

        private static bool IsSlug(string s)
        {
            if (string.IsNullOrEmpty(s)) return false;
            foreach (var c in s)
            {
                var ok = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '.' || c == '-' || c == '_';
                if (!ok) return false;
            }
            return true;
        }
    }
}
