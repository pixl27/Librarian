using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;

namespace PhotonJoin
{
    /// <summary>
    /// Encaisser la coupure.
    ///
    /// Quand l'hôte décide qu'un arrivant n'a rien à faire là, il ne ferme pas
    /// la connexion lui-même : il demande au serveur Photon de le faire, et le
    /// serveur envoie une trame de coupure que le client traduit aussitôt en
    /// déconnexion. Le joueur voit « je rejoins puis je pars ».
    ///
    /// Ignorer cette trame ne remplace pas une identité acceptable — l'hôte
    /// continuerait de refuser la synchronisation — mais elle laisse le temps
    /// aux autres pièces d'agir, et surtout elle rend le diagnostic lisible :
    /// le code et le message de la trame disent pourquoi on a été chassé.
    ///
    /// Le bouclier est déclaré dans le profil, pas ici : un jeu qui n'expulse
    /// personne n'a aucune raison de voir ses déconnexions filtrées.
    /// </summary>
    public static class Shield
    {
        /// <summary>Faut-il avaler cette trame ?</summary>
        public static bool ShouldSwallow(GameProfile p, int code)
        {
            if (p == null || !p.ShieldDisconnectMessage) return false;
            if (p.ShieldCodes == null || p.ShieldCodes.Count == 0) return false;
            return p.ShieldCodes.Contains(code);
        }

        /// <summary>La méthode du client Photon qui reçoit la trame, s'il y en a une.</summary>
        public static MethodInfo ResolveDisconnectHook(PhotonBinding b)
        {
            return b == null ? null : b.MOnDisconnectMessage;
        }

        /// <summary>
        /// Les méthodes d'expulsion que le jeu expose, nommées « Type:Methode »
        /// dans le profil. Un nom qui ne correspond à rien est signalé, jamais
        /// inventé.
        /// </summary>
        public static List<MethodInfo> ResolveKickRpcs(GameProfile p, IEnumerable<Assembly> assemblies, List<string> unresolved)
        {
            var found = new List<MethodInfo>();
            if (p == null || p.ShieldKickRpc == null) return found;

            const BindingFlags flags = BindingFlags.Public | BindingFlags.NonPublic
                                     | BindingFlags.Static | BindingFlags.Instance | BindingFlags.FlattenHierarchy;

            foreach (var entry in p.ShieldKickRpc)
            {
                var parts = (entry ?? "").Split(':');
                if (parts.Length != 2 || parts[0].Length == 0 || parts[1].Length == 0)
                {
                    if (unresolved != null) unresolved.Add(entry + " (forme attendue : Type:Methode)");
                    continue;
                }

                var type = Entry.FindType(assemblies, parts[0]);
                if (type == null)
                {
                    if (unresolved != null) unresolved.Add(entry + " (type introuvable)");
                    continue;
                }

                var m = type.GetMethods(flags).FirstOrDefault(x => x.Name == parts[1]);
                if (m == null)
                {
                    if (unresolved != null) unresolved.Add(entry + " (méthode introuvable)");
                    continue;
                }
                found.Add(m);
            }
            return found;
        }

        /// <summary>Le code d'une trame de coupure, quelle que soit la forme du type.</summary>
        public static int ReadCode(PhotonBinding b, object message)
        {
            if (b == null || message == null || !b.DmCode.Exists) return 0;
            var v = b.DmCode.Get(message);
            if (v == null) return 0;
            try { return Convert.ToInt32(v); } catch { return 0; }
        }

        public static string ReadMessage(PhotonBinding b, object message)
        {
            if (b == null || message == null || !b.DmDebugMessage.Exists) return "";
            var v = b.DmDebugMessage.Get(message);
            return v == null ? "" : v.ToString();
        }

        /// <summary>Une ligne de journal lisible pour une trame reçue.</summary>
        public static string Describe(PhotonBinding b, object message, bool swallowed)
        {
            var code = ReadCode(b, message);
            var text = ReadMessage(b, message);
            return "Trame de coupure code=" + code
                 + (string.IsNullOrEmpty(text) ? "" : " « " + text + " »")
                 + (swallowed ? " — ignorée." : " — transmise.");
        }
    }
}
