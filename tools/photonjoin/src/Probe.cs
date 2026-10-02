using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text;

namespace PhotonJoin
{
    /// <summary>Un chemin d'entrée possible, tel que la sonde l'a vu dans le jeu.</summary>
    public sealed class EntryCandidate
    {
        public string TypeName = "";
        public string RoomField = "";
        public string RegionField = "";
        public string InstanceMember = "";
        public readonly List<string> Methods = new List<string>();
        public int Score;

        public override string ToString()
        {
            return TypeName + " { " + RoomField
                 + (string.IsNullOrEmpty(RegionField) ? "" : ", " + RegionField)
                 + " } " + string.Join("/", Methods.ToArray());
        }
    }

    public sealed class ProbeReport
    {
        public string Text = "";
        public GameProfile Stub;
        public readonly List<EntryCandidate> Candidates = new List<EntryCandidate>();
        public bool SteamAvailable;
    }

    /// <summary>
    /// Ce qu'il faut savoir d'un jeu qu'on n'a jamais vu.
    ///
    /// Un moteur générique ne vaut que par la façon dont on instruit un titre
    /// inconnu. Plutôt que de demander à quelqu'un de décompiler le jeu, la
    /// sonde énumère ce que le moteur a réellement lié, cherche les types qui
    /// ressemblent à un chemin de jonction — un champ texte qui parle de salle
    /// et une méthode sans paramètre qui parle de rejoindre — et écrit une
    /// ébauche de profil déjà valide.
    ///
    /// Elle ne devine pas : elle ne nomme que ce qu'elle a trouvé, et le
    /// rapport dit combien de candidats existent, pour qu'un profil erroné se
    /// voie tout de suite.
    /// </summary>
    public static class Probe
    {
        private static readonly string[] IgnoredRoots =
        {
            "Photon", "ExitGames", "UnityEngine", "Unity", "System", "Microsoft", "Mono",
            "Steamworks", "PhotonJoin", "BepInEx", "HarmonyLib", "MonoMod", "TMPro", "JetBrains",
        };

        private static readonly string[] JoinVerbs = { "join", "connect", "enter" };
        private static readonly string[] InstanceNames = { "Instance", "instance", "Singleton", "Current", "current", "main" };

        public static ProbeReport Run(PhotonBinding b, IEnumerable<Assembly> assemblies, string appId, string product)
        {
            var report = new ProbeReport();
            var list = assemblies == null ? new List<Assembly>() : assemblies.Where(a => a != null).ToList();

            report.Candidates.AddRange(FindCandidates(list));
            report.SteamAvailable = SteamBridge.Available(list);
            report.Stub = BuildStub(b, report, appId, product);
            report.Text = Describe(b, report, list, appId, product);
            return report;
        }

        // ---- Recherche des chemins d'entrée --------------------------------

        public static List<EntryCandidate> FindCandidates(IEnumerable<Assembly> assemblies)
        {
            var found = new List<EntryCandidate>();
            if (assemblies == null) return found;

            const BindingFlags members = BindingFlags.Public | BindingFlags.NonPublic
                                       | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly;

            foreach (var a in assemblies)
            {
                if (a == null) continue;
                Type[] types;
                try { types = a.GetTypes(); }
                catch (ReflectionTypeLoadException e) { types = e.Types == null ? new Type[0] : e.Types.Where(t => t != null).ToArray(); }
                catch { continue; }

                foreach (var t in types)
                {
                    if (t == null || !t.IsClass || IsIgnored(t)) continue;

                    string roomField = null, regionField = null;
                    foreach (var f in t.GetFields(members))
                    {
                        if (f.FieldType != typeof(string) || f.IsInitOnly || f.IsLiteral) continue;
                        if (roomField == null && Mentions(f.Name, "room")) roomField = f.Name;
                        if (regionField == null && Mentions(f.Name, "region")) regionField = f.Name;
                    }
                    foreach (var p in t.GetProperties(members))
                    {
                        if (p.PropertyType != typeof(string) || p.GetSetMethod(true) == null) continue;
                        if (roomField == null && Mentions(p.Name, "room")) roomField = p.Name;
                        if (regionField == null && Mentions(p.Name, "region")) regionField = p.Name;
                    }
                    if (roomField == null) continue;

                    var verbs = t.GetMethods(members)
                                 .Where(m => m.GetParameters().Length == 0 && !m.IsSpecialName)
                                 .Where(m => JoinVerbs.Any(v => Mentions(m.Name, v)))
                                 .Select(m => m.Name)
                                 .Distinct()
                                 .ToList();
                    if (verbs.Count == 0) continue;

                    var c = new EntryCandidate { TypeName = t.FullName, RoomField = roomField, RegionField = regionField ?? "" };
                    c.Methods.AddRange(verbs);
                    c.InstanceMember = FindInstanceMember(t);
                    c.Score = 1 + (regionField != null ? 1 : 0) + (c.InstanceMember.Length > 0 ? 1 : 0) + verbs.Count;
                    found.Add(c);
                }
            }

            found.Sort((x, y) => y.Score.CompareTo(x.Score));
            return found;
        }

        private static string FindInstanceMember(Type t)
        {
            foreach (var name in InstanceNames)
            {
                var slot = Slot.Find(t, true, name);
                if (slot.Exists && slot.Type != null && t.IsAssignableFrom(slot.Type)) return name;
            }
            return "";
        }

        private static bool IsIgnored(Type t)
        {
            var ns = t.Namespace ?? "";
            foreach (var root in IgnoredRoots)
                if (ns == root || ns.StartsWith(root + ".", StringComparison.Ordinal)) return true;
            return false;
        }

        private static bool Mentions(string name, string word)
        {
            return name.IndexOf(word, StringComparison.OrdinalIgnoreCase) >= 0;
        }

        // ---- Ébauche de profil ---------------------------------------------

        public static GameProfile BuildStub(PhotonBinding b, ProbeReport report, string appId, string product)
        {
            var p = ProfileStore.Default();
            p.IsDefault = false;
            p.Id = Slugify(string.IsNullOrEmpty(product) ? (string.IsNullOrEmpty(appId) ? "jeu" : "app" + appId) : product);
            p.Name = string.IsNullOrEmpty(product) ? "Jeu inconnu" : product;
            p.MatchAppId = appId ?? "";
            p.MatchProduct = product ?? "";
            p.Friends = report != null && report.SteamAvailable ? "steam" : "manual";
            p.Notes = "Ébauche produite par la sonde. Vérifier la stratégie d'identité : "
                    + "elle reste « keep », qui convient aux jeux sans contrôle d'appartenance chez l'hôte.";

            var best = report == null ? null : report.Candidates.FirstOrDefault();
            if (best != null)
            {
                p.EntryStrategy = "native";
                p.NativeType = best.TypeName;
                p.NativeInstance = best.InstanceMember;
                p.NativeFields.Add(new KeyValuePair<string, string>(best.RoomField, "$room"));
                if (!string.IsNullOrEmpty(best.RegionField))
                    p.NativeFields.Add(new KeyValuePair<string, string>(best.RegionField, "$region"));
                p.NativeInvoke = best.Methods[0];
            }
            return p;
        }

        public static string Slugify(string s)
        {
            var sb = new StringBuilder();
            foreach (var c in (s ?? "").ToLowerInvariant())
            {
                if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '.' || c == '-' || c == '_') sb.Append(c);
                else if (c == ' ') sb.Append('-');
            }
            var slug = sb.ToString().Trim('-');
            return slug.Length == 0 ? "jeu" : slug;
        }

        // ---- Rapport lisible -----------------------------------------------

        private static string Describe(PhotonBinding b, ProbeReport report, List<Assembly> assemblies, string appId, string product)
        {
            var sb = new StringBuilder();
            sb.AppendLine("=== PhotonJoin — sonde ===");
            sb.AppendLine("Jeu       : " + (string.IsNullOrEmpty(product) ? "(nom inconnu)" : product)
                        + (string.IsNullOrEmpty(appId) ? "" : "  AppID " + appId));
            sb.AppendLine("Assemblées: " + assemblies.Count);

            if (b == null)
            {
                sb.AppendLine("Photon    : liaison non tentée.");
            }
            else if (!b.Bound)
            {
                sb.AppendLine("Photon    : NON LIÉ — " + b.Diagnostic);
                foreach (var m in b.Missing) sb.AppendLine("            manque " + m);
            }
            else
            {
                sb.AppendLine("Photon    : " + b.Flavour + " " + b.PunVersion + " (" + b.TPhotonNetwork.FullName + ")");
                sb.AppendLine("État      : " + b.ClientStateName() + ", région " + Show(b.CurrentRegion()));
                sb.AppendLine("Identité  : " + Show(b.LocalUserId()) + "  via " + b.TAuthValues.FullName);
                sb.AppendLine("FriendInfo: " + b.TFriendInfo.FullName
                            + "  { " + b.FUserId.Name + ", " + b.FIsOnline.Name + ", " + b.FIsInRoom.Name + ", " + b.FRoom.Name + " }");
                sb.AppendLine("Coupure   : " + (b.MOnDisconnectMessage == null ? "non interceptable" : b.MOnDisconnectMessage.Name + " sur " + b.TClient.Name));
                sb.AppendLine("Amis vus  : " + b.FriendList().Count());
            }

            sb.AppendLine("Steamworks: " + (report.SteamAvailable ? "présent" : "absent — saisie manuelle de l'identifiant"));
            sb.AppendLine();
            sb.AppendLine("Chemins d'entrée trouvés : " + report.Candidates.Count);
            var shown = 0;
            foreach (var c in report.Candidates)
            {
                sb.AppendLine("  · " + c);
                if (++shown >= 8) { sb.AppendLine("  … et " + (report.Candidates.Count - shown) + " autres."); break; }
            }
            if (report.Candidates.Count == 0)
                sb.AppendLine("  (aucun : la stratégie « raw » est le seul recours automatique)");

            sb.AppendLine();
            sb.AppendLine("Ébauche de profil :");
            sb.AppendLine(ProfileStore.ToJson(report.Stub));
            return sb.ToString();
        }

        private static string Show(string s) { return string.IsNullOrEmpty(s) ? "(vide)" : s; }
    }
}
