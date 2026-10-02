using System;
using System.Collections;

namespace PhotonJoin
{
    public sealed class ForgeResult
    {
        public bool Ok;
        public string UserId = "";
        public string Error = "";
        public bool Collides;      // l'identifiant présenté est exactement celui de l'hôte
        public string Warning = "";
    }

    /// <summary>
    /// Qui le client prétend être auprès de Photon.
    ///
    /// C'est le levier central. Beaucoup de jeux vérifient chez l'hôte que
    /// l'arrivant appartient bien à leur salon de plateforme, et le font en
    /// convertissant l'identifiant Photon en identifiant natif — donc en
    /// nombre. Photon, lui, impose l'unicité des identifiants en comparant des
    /// chaînes. Les deux contrôles ne lisent pas la même chose, et un préfixe
    /// qui ne change pas la valeur numérique satisfait le premier sans
    /// déclencher le second.
    ///
    /// C'est ce qui a été observé en partie réelle sur PEAK. Rien ici ne
    /// suppose PEAK : la stratégie est nommée dans le profil du jeu.
    /// </summary>
    public static class Identity
    {
        public static ForgeResult Forge(GameProfile p, string hostId, string currentId)
        {
            var r = new ForgeResult();
            if (p == null) { r.Error = "Aucun profil."; return r; }
            hostId = hostId ?? "";
            currentId = currentId ?? "";

            switch (p.IdentityStrategy)
            {
                case "keep":
                    r.Ok = true;
                    r.UserId = currentId;
                    break;

                case "prefix-host":
                    if (string.IsNullOrEmpty(p.IdentityPrefix))
                    {
                        r.Error = "identity.prefix est vide : l'identifiant présenté serait celui de l'hôte, "
                                + "et Photon refuserait l'entrée pour cause d'identifiant déjà pris.";
                        break;
                    }
                    if (string.IsNullOrEmpty(hostId))
                    {
                        r.Error = "L'identifiant de l'hôte est inconnu : impossible de le préfixer.";
                        break;
                    }
                    r.UserId = p.IdentityPrefix + hostId;
                    if (r.UserId == hostId)
                    {
                        r.Error = "Le préfixe ne change pas l'identifiant : Photon y verrait une collision.";
                        break;
                    }
                    r.Ok = true;
                    break;

                case "mirror-host":
                    if (string.IsNullOrEmpty(hostId)) { r.Error = "L'identifiant de l'hôte est inconnu."; break; }
                    r.UserId = hostId;
                    r.Collides = true;
                    r.Warning = "Identifiant identique à celui de l'hôte : à réserver aux jeux qui n'imposent "
                              + "pas l'unicité côté Photon. Sinon l'entrée sera refusée.";
                    r.Ok = true;
                    break;

                case "custom":
                    if (string.IsNullOrEmpty(p.IdentityCustom)) { r.Error = "identity.custom est vide."; break; }
                    r.UserId = p.IdentityCustom
                        .Replace("$host", hostId)
                        .Replace("$self", currentId);
                    if (r.UserId == hostId && !string.IsNullOrEmpty(hostId))
                    {
                        r.Error = "L'identifiant demandé est exactement celui de l'hôte : Photon y verrait une collision. "
                                + "Utiliser mirror-host si c'est délibéré.";
                        break;
                    }
                    r.Ok = true;
                    break;

                default:
                    r.Error = "Stratégie d'identité inconnue : " + p.IdentityStrategy;
                    break;
            }

            if (r.Ok && string.IsNullOrEmpty(r.UserId))
            {
                r.Ok = false;
                r.Error = "L'identifiant calculé est vide.";
            }
            return r;
        }
    }

    /// <summary>
    /// Réécrire l'identifiant présenté, ce que PUN n'autorise qu'entre deux
    /// connexions : le serveur retient l'identifiant reçu à l'authentification,
    /// et l'écrire à chaud ne change rien.
    ///
    /// Exprimé en énumérateur pour que le greffon le fasse tourner en coroutine
    /// et que l'hôte de test le fasse avancer pas à pas.
    /// </summary>
    public sealed class Reauth
    {
        public string Wanted = "";
        public bool Done;
        public bool Ok;
        public string Error = "";
        public Action<string> Trace;
        public double Timeout = 12.0;
        public Func<double> Now = DefaultClock;

        private static double DefaultClock()
        {
            return DateTime.UtcNow.Ticks / (double)TimeSpan.TicksPerSecond;
        }

        private void Say(string what) { if (Trace != null) Trace(what); }

        private void Fail(string why) { Error = why; Ok = false; Done = true; Say("échec:" + why); }

        public IEnumerator Run(PhotonBinding b)
        {
            Done = false; Ok = false; Error = "";

            if (b == null || !b.Bound) { Fail("Photon n'est pas lié."); yield break; }
            if (string.IsNullOrEmpty(Wanted)) { Fail("Aucun identifiant à présenter."); yield break; }

            if (b.LocalUserId() == Wanted && b.IsConnectedNow())
            {
                Say("déjà-présenté");
                Ok = true; Done = true;
                yield break;
            }

            if (b.IsConnectedNow())
            {
                if (b.MDisconnect == null) { Fail("PhotonNetwork.Disconnect est introuvable."); yield break; }
                Say("déconnexion");
                b.MDisconnect.Invoke(null, null);

                var until = Now() + Timeout;
                while (b.IsConnectedNow())
                {
                    if (Now() > until) { Fail("La déconnexion n'a pas abouti."); yield break; }
                    yield return null;
                }
            }

            if (!WriteUserId(b, Wanted)) { Fail("AuthenticationValues.UserId n'est pas accessible en écriture."); yield break; }
            Say("identifiant-écrit:" + Wanted);

            if (b.MConnect == null) { Fail("Aucun moyen de reconnexion n'a été trouvé."); yield break; }
            Say("reconnexion");
            var args = b.MConnect.GetParameters().Length == 0 ? null : new object[] { null };
            b.MConnect.Invoke(null, args);

            var deadline = Now() + Timeout;
            while (!b.IsConnectedNow())
            {
                if (Now() > deadline) { Fail("La reconnexion n'a pas abouti."); yield break; }
                yield return null;
            }

            if (b.LocalUserId() != Wanted)
            {
                Fail("Le serveur n'a pas retenu l'identifiant demandé (" + b.LocalUserId() + ").");
                yield break;
            }

            Say("terminé");
            Ok = true; Done = true;
        }

        /// <summary>Écrire l'identifiant, en créant l'objet d'authentification s'il manque.</summary>
        public static bool WriteUserId(PhotonBinding b, string userId)
        {
            if (b == null || !b.AuthValues.Exists || b.TAuthValues == null || !b.AUserId.Exists) return false;

            var current = b.AuthValues.Get(null);
            if (current == null)
            {
                try { current = Activator.CreateInstance(b.TAuthValues); }
                catch { return false; }
                if (!b.AuthValues.Set(null, current)) return false;
            }
            return b.AUserId.Set(current, userId);
        }
    }
}
