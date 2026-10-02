using System;
using System.Collections;
using System.Collections.Generic;
using System.Reflection;

namespace PhotonJoin
{
    /// <summary>
    /// La jonction complète, du nom d'un ami à l'entrée en salle.
    ///
    /// Les quatre pièces — identité, découverte, entrée, bouclier — ne valent
    /// que dans cet ordre : se présenter avant de chercher, parce que Photon
    /// retient l'identifiant à l'authentification ; chercher avant d'entrer,
    /// parce que le nom de salle n'existe pas avant ; et garder le bouclier
    /// armé pendant tout le trajet, parce que la coupure arrive après l'entrée,
    /// pas avant.
    ///
    /// Exprimée en énumérateur : le greffon la fait tourner en coroutine, un
    /// hôte de test la fait avancer pas à pas.
    /// </summary>
    public sealed class JoinPipeline
    {
        public PhotonBinding Binding;
        public GameProfile Profile;
        public IEnumerable<Assembly> Assemblies;

        /// <summary>L'identifiant Photon de l'ami à rejoindre.</summary>
        public string FriendId = "";
        /// <summary>L'identifiant natif de l'hôte, quand la stratégie d'identité en a besoin.</summary>
        public string HostId = "";

        public double FindTimeout = 8.0;
        public double EnterTimeout = 15.0;
        public Func<double> Now = DefaultClock;
        public Action<string> Trace;

        public bool Done;
        public bool Ok;
        public string Error = "";
        public string Status = "";
        public string Room = "";
        public string Region = "";
        public string PresentedId = "";

        private static double DefaultClock()
        {
            return DateTime.UtcNow.Ticks / (double)TimeSpan.TicksPerSecond;
        }

        private void Say(string status)
        {
            Status = status;
            if (Trace != null) Trace(status);
        }

        private void Fail(string why)
        {
            Error = why;
            Ok = false;
            Done = true;
            Say("échec : " + why);
        }

        public IEnumerator Run()
        {
            Done = false; Ok = false; Error = ""; Room = ""; Region = "";

            if (Binding == null || !Binding.Bound) { Fail("Photon n'est pas lié dans ce jeu."); yield break; }
            if (Profile == null) { Fail("Aucun profil."); yield break; }
            if (string.IsNullOrEmpty(FriendId)) { Fail("Aucun ami désigné."); yield break; }

            // 1. L'identité présentée.
            var forge = Identity.Forge(Profile, string.IsNullOrEmpty(HostId) ? FriendId : HostId, Binding.LocalUserId());
            if (!forge.Ok) { Fail(forge.Error); yield break; }
            PresentedId = forge.UserId;
            if (!string.IsNullOrEmpty(forge.Warning)) Say("avertissement : " + forge.Warning);

            if (forge.UserId != Binding.LocalUserId())
            {
                Say("réauthentification sous " + forge.UserId);
                var reauth = new Reauth { Wanted = forge.UserId, Now = Now, Trace = Trace };
                var step = reauth.Run(Binding);
                while (step.MoveNext()) yield return step.Current;
                if (!reauth.Ok) { Fail("Réauthentification : " + reauth.Error); yield break; }
            }
            else Say("identité inchangée");

            // 2. La salle de l'ami.
            string findError;
            Say("recherche de l'ami");
            if (!Discovery.Request(Binding, new[] { FriendId }, out findError)) { Fail(findError); yield break; }

            FriendTarget target = null;
            var findUntil = Now() + FindTimeout;
            while (true)
            {
                var t = Discovery.Resolve(Binding, FriendId);
                if (t.Joinable) { target = t; break; }
                if (Now() > findUntil)
                {
                    Fail(t.Online
                        ? "L'ami est en ligne mais dans aucune partie."
                        : "Photon ne voit pas cet ami : identifiant erroné, ami hors ligne, ou autre région.");
                    yield break;
                }
                yield return null;
            }

            Room = target.Room;
            Region = Discovery.RegionFor(Binding, Profile);
            Say("salle " + Room + " en " + Region);

            // 3. L'entrée.
            var entry = Entry.Enter(Binding, Profile, Room, Region, Assemblies);
            if (!entry.Ok) { Fail("Entrée (" + entry.Strategy + ") : " + entry.Error); yield break; }
            Say("entrée demandée : " + entry.Trace);

            var enterUntil = Now() + EnterTimeout;
            while (!Binding.InRoomNow())
            {
                if (Now() > enterUntil) { Fail("La salle n'a pas été rejointe dans le temps imparti."); yield break; }
                yield return null;
            }

            Ok = true;
            Done = true;
            Say("en salle");
        }
    }
}
