using System;
using System.Collections;
using System.Collections.Generic;

namespace PhotonJoin
{
    public sealed class FriendTarget
    {
        public string UserId = "";
        public string Room = "";
        public string Region = "";
        public bool Online;
        public bool InRoom;
        public int Rank;
        public bool Joinable { get { return Rank > 0 && !string.IsNullOrEmpty(Room); } }

        public override string ToString()
        {
            return UserId + (Joinable ? " → " + Room + " (" + Region + ")" : " — injoignable");
        }
    }

    /// <summary>
    /// Trouver la salle d'un ami.
    ///
    /// Photon répond à OpFindFriends par une liste dont chaque entrée dit si
    /// l'ami est en ligne et, le cas échéant, le nom de la salle où il se
    /// trouve. C'est le seul mécanisme que PUN offre pour rejoindre quelqu'un
    /// sans passer par le salon de la plateforme, et c'est ce qui rend la
    /// jonction possible depuis une session qui n'a pas la même application.
    ///
    /// La réponse est régionale : un ami connecté à une autre région du nuage
    /// Photon est invisible. C'est pourquoi la région visée est celle où l'on
    /// se trouve, jamais une devinette.
    /// </summary>
    public static class Discovery
    {
        /// <summary>Demander la liste. Retourne faux si PUN a refusé la demande.</summary>
        public static bool Request(PhotonBinding b, string[] ids, out string error)
        {
            error = "";
            if (b == null || !b.Bound) { error = "Photon n'est pas lié."; return false; }
            if (b.MFindFriends == null) { error = "PhotonNetwork.FindFriends est introuvable."; return false; }
            if (ids == null || ids.Length == 0) { error = "Aucun identifiant à chercher."; return false; }
            if (!b.IsConnectedNow()) { error = "Le client n'est pas connecté au serveur maître."; return false; }

            object result;
            try { result = b.MFindFriends.Invoke(null, new object[] { ids }); }
            catch (Exception e) { error = "FindFriends a échoué : " + Unwrap(e).Message; return false; }

            if (result is bool && !(bool)result)
            {
                error = "FindFriends a été refusé : une recherche est déjà en cours, ou le client n'est pas prêt.";
                return false;
            }
            return true;
        }

        /// <summary>Lire ce que Photon a répondu à propos d'un identifiant précis.</summary>
        public static FriendTarget Resolve(PhotonBinding b, string wantedId)
        {
            var t = new FriendTarget { UserId = wantedId ?? "" };
            if (b == null || !b.Bound || string.IsNullOrEmpty(t.UserId)) return t;

            foreach (var f in b.FriendList())
            {
                if (!string.Equals(b.FriendUserId(f), t.UserId, StringComparison.Ordinal)) continue;
                Fill(b, f, t);
                return t;
            }
            return t;
        }

        /// <summary>Le meilleur ami joignable parmi plusieurs identifiants.</summary>
        public static FriendTarget Best(PhotonBinding b, IEnumerable<string> ids)
        {
            FriendTarget best = null;
            if (b == null || !b.Bound) return null;

            var wanted = new List<string>();
            if (ids != null) foreach (var id in ids) if (!string.IsNullOrEmpty(id)) wanted.Add(id);

            foreach (var f in b.FriendList())
            {
                var id = b.FriendUserId(f);
                if (wanted.Count > 0 && !wanted.Contains(id)) continue;

                var t = new FriendTarget { UserId = id };
                Fill(b, f, t);
                if (!t.Joinable) continue;
                if (best == null || t.Rank > best.Rank) best = t;
            }
            return best;
        }

        /// <summary>Tout ce que Photon dit d'un ami, y compris la région visée.</summary>
        public static List<FriendTarget> All(PhotonBinding b)
        {
            var list = new List<FriendTarget>();
            if (b == null || !b.Bound) return list;
            foreach (var f in b.FriendList())
            {
                var t = new FriendTarget { UserId = b.FriendUserId(f) };
                Fill(b, f, t);
                list.Add(t);
            }
            return list;
        }

        /// <summary>La région à viser, telle que le profil la demande.</summary>
        public static string RegionFor(PhotonBinding b, GameProfile p)
        {
            var wanted = p == null ? "$current" : (p.Region ?? "$current");
            if (wanted != "$current" && !string.IsNullOrEmpty(wanted)) return wanted;
            return b == null ? "" : b.CurrentRegion();
        }

        private static void Fill(PhotonBinding b, object friend, FriendTarget t)
        {
            t.Online = b.FriendOnline(friend);
            t.InRoom = b.FriendInRoom(friend);
            t.Room = b.FriendRoom(friend) ?? "";
            t.Region = b.CurrentRegion();

            // Un ami « en salle » avec un nom de salle est le seul cas
            // réellement joignable. Les autres sont classés, pas retenus :
            // afficher « en ligne » sans salle vaut mieux que promettre une
            // jonction qui échouera.
            if (t.Online && t.InRoom && !string.IsNullOrEmpty(t.Room)) t.Rank = 3;
            else if (t.Online && !string.IsNullOrEmpty(t.Room)) t.Rank = 2;
            else if (t.Online) t.Rank = 1;
            else t.Rank = 0;
        }

        private static Exception Unwrap(Exception e)
        {
            while (e.InnerException != null) e = e.InnerException;
            return e;
        }
    }
}
