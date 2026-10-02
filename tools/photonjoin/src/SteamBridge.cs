using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;

namespace PhotonJoin
{
    public sealed class SteamFriend
    {
        public ulong Id;
        public string Name = "";
        public bool Online;
        public string IdText { get { return Id.ToString(); } }
        public override string ToString() { return Name + " (" + Id + ")"; }
    }

    /// <summary>
    /// Les amis Steam, quand le jeu embarque Steamworks.NET.
    ///
    /// Le greffon ne référence pas Steamworks : beaucoup de jeux Unity ne
    /// l'embarquent pas, et une référence compilée rendrait le binaire
    /// inutilisable chez eux. Tout passe donc par réflexion, et l'absence de
    /// Steamworks est un cas normal — l'interface bascule alors sur la saisie
    /// manuelle de l'identifiant, ce qui suffit puisque l'identifiant Photon
    /// d'un ami est justement ce qu'on lui demande de recopier.
    /// </summary>
    public static class SteamBridge
    {
        private const int FriendFlagImmediate = 4;

        private static Type Find(IEnumerable<Assembly> assemblies, string fullName)
        {
            return Entry.FindType(assemblies, fullName);
        }

        public static bool Available(IEnumerable<Assembly> assemblies)
        {
            return Find(assemblies, "Steamworks.SteamFriends") != null
                && Find(assemblies, "Steamworks.CSteamID") != null;
        }

        /// <summary>La source d'amis réellement utilisable, quoi que demande le profil.</summary>
        public static string ResolveSource(GameProfile p, IEnumerable<Assembly> assemblies)
        {
            var wanted = p == null ? "steam" : (p.Friends ?? "steam");
            if (wanted != "steam") return "manual";
            return Available(assemblies) ? "steam" : "manual";
        }

        public static string LocalSteamId(IEnumerable<Assembly> assemblies)
        {
            var tUser = Find(assemblies, "Steamworks.SteamUser");
            if (tUser == null) return "";
            var m = tUser.GetMethod("GetSteamID", BindingFlags.Public | BindingFlags.Static);
            if (m == null) return "";
            try
            {
                var id = m.Invoke(null, null);
                return IdOf(id).ToString();
            }
            catch { return ""; }
        }

        public static List<SteamFriend> Friends(IEnumerable<Assembly> assemblies, out string error)
        {
            error = "";
            var list = new List<SteamFriend>();

            var tFriends = Find(assemblies, "Steamworks.SteamFriends");
            var tId = Find(assemblies, "Steamworks.CSteamID");
            if (tFriends == null || tId == null) { error = "Steamworks n'est pas présent dans ce jeu."; return list; }

            var tFlags = Find(assemblies, "Steamworks.EFriendFlags");
            object flags = tFlags != null && tFlags.IsEnum ? Enum.ToObject(tFlags, FriendFlagImmediate) : (object)FriendFlagImmediate;

            var mCount = Pick(tFriends, "GetFriendCount", 1);
            var mByIndex = Pick(tFriends, "GetFriendByIndex", 2);
            var mName = Pick(tFriends, "GetFriendPersonaName", 1);
            var mState = Pick(tFriends, "GetFriendPersonaState", 1);
            if (mCount == null || mByIndex == null || mName == null)
            {
                error = "Steamworks est présent mais sa liste d'amis n'a pas la forme attendue.";
                return list;
            }

            int count;
            try { count = Convert.ToInt32(mCount.Invoke(null, new[] { flags })); }
            catch (Exception e) { error = "Lecture du nombre d'amis impossible : " + Unwrap(e).Message; return list; }

            for (var i = 0; i < count; i++)
            {
                try
                {
                    var id = mByIndex.Invoke(null, new object[] { i, flags });
                    var f = new SteamFriend
                    {
                        Id = IdOf(id),
                        Name = Convert.ToString(mName.Invoke(null, new[] { id })) ?? "",
                    };
                    if (mState != null)
                    {
                        var st = Convert.ToString(mState.Invoke(null, new[] { id })) ?? "";
                        f.Online = st.IndexOf("Offline", StringComparison.OrdinalIgnoreCase) < 0;
                    }
                    if (f.Id != 0) list.Add(f);
                }
                catch { /* un ami illisible ne doit pas emporter la liste */ }
            }

            list.Sort((a, b) =>
            {
                if (a.Online != b.Online) return a.Online ? -1 : 1;
                return string.Compare(a.Name, b.Name, StringComparison.CurrentCultureIgnoreCase);
            });
            return list;
        }

        private static MethodInfo Pick(Type t, string name, int argCount)
        {
            return t.GetMethods(BindingFlags.Public | BindingFlags.Static)
                    .FirstOrDefault(m => m.Name == name && m.GetParameters().Length == argCount);
        }

        /// <summary>Extraire le nombre d'un CSteamID, dont le champ porte des noms variés.</summary>
        private static ulong IdOf(object cSteamId)
        {
            if (cSteamId == null) return 0;
            if (cSteamId is ulong) return (ulong)cSteamId;

            var t = cSteamId.GetType();
            var slot = Slot.Find(t, false, "m_SteamID", "steamID", "Value");
            if (slot.Exists)
            {
                var v = slot.Get(cSteamId);
                if (v != null) { try { return Convert.ToUInt64(v); } catch { } }
            }
            ulong parsed;
            return ulong.TryParse(cSteamId.ToString(), out parsed) ? parsed : 0;
        }

        private static Exception Unwrap(Exception e)
        {
            while (e.InnerException != null) e = e.InnerException;
            return e;
        }
    }
}
