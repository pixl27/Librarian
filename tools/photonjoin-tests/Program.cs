using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using FakePhoton;

namespace PhotonJoin.Tests
{
    internal static class A
    {
        public static void True(bool condition, string what)
        {
            if (!condition) throw new Exception("attendu vrai — " + what);
        }

        public static void False(bool condition, string what)
        {
            if (condition) throw new Exception("attendu faux — " + what);
        }

        public static void Eq(object got, object want, string what)
        {
            if (!Equals(got, want))
                throw new Exception(what + " : obtenu « " + Show(got) + " », attendu « " + Show(want) + " »");
        }

        public static void Has(string haystack, string needle, string what)
        {
            if (haystack == null || haystack.IndexOf(needle, StringComparison.Ordinal) < 0)
                throw new Exception(what + " : « " + needle + " » absent de « " + Trim(haystack) + " »");
        }

        public static void HasNot(string haystack, string needle, string what)
        {
            if (haystack != null && haystack.IndexOf(needle, StringComparison.Ordinal) >= 0)
                throw new Exception(what + " : « " + needle + " » présent alors qu'il ne devrait pas");
        }

        private static string Show(object o) { return o == null ? "(nul)" : o.ToString(); }
        private static string Trim(string s)
        {
            if (s == null) return "(nul)";
            return s.Length <= 400 ? s : s.Substring(0, 400) + "…";
        }
    }

    public static class Program
    {
        // ---- Repères de fichiers -------------------------------------------

        private static string Root
        {
            get { return Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..")); }
        }

        private static string ProfilesDir { get { return Path.Combine(Root, "tools", "photonjoin", "profiles"); } }
        private static string ShippedDll { get { return Path.Combine(Root, "deps", "photonjoin", "PhotonJoin.dll"); } }

        // ---- Faux Photon ----------------------------------------------------

        private static IFakePhoton Std()
        {
            var f = new FakePhoton.Standard.StandardFake();
            f.Reset();
            return f;
        }

        private static IFakePhoton Var()
        {
            var f = new FakePhoton.Variant.VariantFake();
            f.Reset();
            return f;
        }

        private static Assembly[] Asm(IFakePhoton f)
        {
            return new[] { f.Assembly, typeof(FakeLog).Assembly };
        }

        private static Assembly[] NoPhoton()
        {
            return new[] { typeof(FakeLog).Assembly };
        }

        private static PhotonBinding BindOf(IFakePhoton f)
        {
            var b = PhotonBinding.Bind(Asm(f));
            A.True(b.Bound, "liaison sur le faux « " + f.Label + " » : " + b.Diagnostic);
            return b;
        }

        /// <summary>Faire tourner un énumérateur comme une coroutine, avec une horloge que l'on contrôle.</summary>
        private static int Drive(IEnumerator routine, Action<int> tick, int maxSteps)
        {
            var steps = 0;
            while (routine.MoveNext())
            {
                if (tick != null) tick(steps);
                if (++steps > maxSteps) throw new Exception("la coroutine ne se termine pas (" + maxSteps + " pas)");
            }
            return steps;
        }

        private static GameProfile PeakProfile()
        {
            var path = Path.Combine(ProfilesDir, "peak.json");
            if (!File.Exists(path)) throw new Exception("profil introuvable : " + path);
            var read = ProfileStore.FromText(File.ReadAllText(path), "peak.json");
            A.True(read.Ok, "profil peak.json : " + read.Message);
            return read.Profile;
        }

        // ---- Aiguillage ------------------------------------------------------

        public static int Main(string[] args)
        {
            var name = args.Length > 0 ? args[0] : "";
            try
            {
                switch (name)
                {
                    case "binder-standard": BinderStandard(); break;
                    case "binder-variant": BinderVariant(); break;
                    case "binder-absent": BinderAbsent(); break;

                    case "probe-report": ProbeReport(); break;
                    case "probe-stub": ProbeStub(); break;
                    case "probe-candidates": ProbeCandidates(); break;

                    case "identity-forge": IdentityForge(); break;
                    case "identity-reauth": IdentityReauth(); break;
                    case "identity-collision": IdentityCollision(); break;

                    case "discovery": DiscoveryCase(); break;
                    case "discovery-rank": DiscoveryRank(); break;
                    case "discovery-empty": DiscoveryEmpty(); break;

                    case "entry-raw": EntryRaw(); break;
                    case "entry-native": EntryNative(); break;
                    case "entry-missing": EntryMissing(); break;

                    case "shield": ShieldCase(); break;
                    case "shield-targets": ShieldTargets(); break;
                    case "shield-off": ShieldOff(); break;

                    case "profile-load": ProfileLoad(); break;
                    case "profile-default": ProfileDefault(); break;

                    case "plugin-meta": PluginMeta(); break;
                    case "overlay-nosteam": OverlayNoSteam(); break;
                    case "overlay-steam": OverlaySteam(); break;

                    case "binding-integration": BindingIntegration(); break;
                    case "join-sequence": JoinSequence(); break;
                    case "join-sequence-fail": JoinSequenceFail(); break;
                    case "surface": Surface(); break;

                    case "asmrefs": AsmRefs(args); break;

                    default:
                        Console.WriteLine("FAIL: cas inconnu « " + name + " »");
                        return 1;
                }
                return 0;
            }
            catch (Exception e)
            {
                Console.WriteLine("FAIL: " + e.Message);
                return 1;
            }
        }

        // ---- Liaison ---------------------------------------------------------

        private static void BinderStandard()
        {
            var f = Std();
            var b = BindOf(f);

            A.Eq(b.Flavour, "PUN2", "variante de PUN");
            A.Eq(b.PunVersion, "2.45", "version lue");
            A.Eq(b.TPhotonNetwork.FullName, "Photon.Pun.PhotonNetwork", "type PhotonNetwork");
            A.Eq(b.TFriendInfo.FullName, "Photon.Realtime.FriendInfo", "type FriendInfo");
            A.Eq(b.TAuthValues.FullName, "Photon.Realtime.AuthenticationValues", "type AuthenticationValues");
            A.Eq(b.FUserId.Name, "UserId", "FriendInfo.UserId");
            A.Eq(b.FIsInRoom.Name, "IsInRoom", "FriendInfo.IsInRoom");
            A.True(b.MFindFriends != null, "FindFriends trouvée");
            A.Eq(b.MJoinRoom.GetParameters().Length, 1, "arité de JoinRoom");
            A.True(b.MDisconnect != null, "Disconnect trouvée");
            A.True(b.MConnect != null, "reconnexion trouvée");
            A.True(b.MOnDisconnectMessage != null, "hameçon de trame de coupure");
            A.Eq(b.DmCode.Name, "Code", "DisconnectMessage.Code");

            // La propriété IsInRoom de FriendInfo a un accesseur interne : le
            // liant doit tout de même savoir la lire.
            f.SetState("ConnectedToMasterServer");
            A.Eq(b.ClientStateName(), "ConnectedToMasterServer", "état lisible");
            A.True(b.IsConnectedNow(), "connecté");
            f.SetAuth("42");
            A.Eq(b.LocalUserId(), "42", "identifiant local");
            A.Eq(b.CurrentRegion(), "eu", "région");
            A.False(b.InRoomNow(), "hors salle au départ");
            f.EnterRoom("SALLE");
            A.True(b.InRoomNow(), "en salle après entrée");

            f.SetFriends(new[] { "H" }, new[] { true }, new[] { true }, new[] { "SALLE" });
            A.Eq(b.FriendList().Count(), 1, "liste d'amis");

            Console.WriteLine("BINDER STANDARD OK");
        }

        private static void BinderVariant()
        {
            var f = Var();
            var b = BindOf(f);

            // Tout diffère de la forme courante, et rien de tout cela n'était
            // connu du liant à la compilation.
            A.Eq(b.Flavour, "PUN", "variante de PUN");
            A.Eq(b.PunVersion, "", "aucune version déclarée");
            A.Eq(b.TPhotonNetwork.FullName, "PhotonNetwork", "PhotonNetwork sans espace de noms");
            A.Eq(b.TFriendInfo.FullName, "FriendInfo", "FriendInfo sans espace de noms");
            A.Eq(b.FUserId.Name, "userId", "champ minuscule");
            A.Eq(b.FRoom.Name, "room", "champ room");
            A.False(b.NetworkClientState.Exists, "pas d'état détaillé");
            A.True(b.IsConnected.Exists, "booléen de connexion trouvé");
            A.Eq(b.MJoinRoom.GetParameters().Length, 2, "arité de JoinRoom");
            A.True(b.MConnect != null && b.MConnect.Name == "ConnectToRegion", "reconnexion par région");
            A.Eq(b.DmCode.Name, "code", "DisconnectMessage.code");

            f.SetState("ConnectedToMasterServer");
            A.Eq(b.ClientStateName(), "Connected", "état déduit du booléen");
            A.True(b.IsConnectedNow(), "connecté");
            f.SetAuth("xyz");
            A.Eq(b.LocalUserId(), "xyz", "identifiant local");
            A.Eq(b.CurrentRegion(), "us", "région");

            // Friends est un tableau, pas une List : le liant doit l'énumérer
            // quand même et en tirer le bon type d'élément.
            f.SetFriends(new[] { "H", "K" }, new[] { true, false }, new[] { true, false }, new[] { "R1", "" });
            A.Eq(b.FriendList().Count(), 2, "liste d'amis en tableau");
            var first = b.FriendList().First();
            A.Eq(b.FriendUserId(first), "H", "lecture de l'identifiant d'ami");
            A.True(b.FriendInRoom(first), "lecture du drapeau en-salle");
            A.Eq(b.FriendRoom(first), "R1", "lecture du nom de salle");

            Console.WriteLine("BINDER VARIANT OK");
        }

        private static void BinderAbsent()
        {
            var b = PhotonBinding.Bind(NoPhoton());
            A.False(b.Bound, "aucune liaison sans Photon");
            A.Has(b.Diagnostic, "PUN", "le diagnostic nomme ce qui manque");
            A.True(b.Missing.Contains("PhotonNetwork"), "PhotonNetwork listé comme manquant");

            // Rien ne doit lever : le greffon se charge dans des jeux qui n'ont
            // pas Photon, et il doit y rester inerte plutôt que d'exploser.
            A.Eq(b.LocalUserId(), "", "identifiant local sur liaison vide");
            A.Eq(b.CurrentRegion(), "", "région sur liaison vide");
            A.False(b.IsConnectedNow(), "non connecté");
            A.False(b.InRoomNow(), "hors salle");
            A.Eq(b.FriendList().Count(), 0, "aucun ami");
            A.Eq(b.ClientStateName(), "Disconnected", "état par défaut");

            var vide = PhotonBinding.Bind(null);
            A.False(vide.Bound, "aucune liaison sans assemblées");
            A.True(vide.Diagnostic.Length > 0, "diagnostic renseigné");

            string err;
            A.False(Discovery.Request(b, new[] { "H" }, out err), "recherche refusée");
            A.Has(err, "lié", "le refus est expliqué");
            var entry = Entry.Enter(b, ProfileStore.Default(), "SALLE", "eu", NoPhoton());
            A.False(entry.Ok, "entrée refusée");

            Console.WriteLine("BINDER ABSENT OK");
        }

        // ---- Sonde -----------------------------------------------------------

        private static void ProbeReport()
        {
            var f = Std();
            var b = BindOf(f);
            f.SetState("ConnectedToMasterServer");
            var report = Probe.Run(b, Asm(f), "480", "Faux Jeu");

            A.Has(report.Text, "PUN2", "la variante figure au rapport");
            A.Has(report.Text, "Photon.Realtime.FriendInfo", "le type réellement lié est nommé");
            A.Has(report.Text, "AppID 480", "l'application est nommée");
            A.Has(report.Text, "Steamworks: présent", "Steamworks détecté");
            A.Has(report.Text, "ConnectedToMasterServer", "l'état courant est rapporté");
            A.True(report.SteamAvailable, "Steamworks disponible");

            // Sur un jeu sans Photon, le rapport doit le dire au lieu de rester muet.
            var absent = Probe.Run(PhotonBinding.Bind(NoPhoton()), NoPhoton(), "", "Jeu Sans Photon");
            A.Has(absent.Text, "NON LIÉ", "l'absence de Photon est annoncée");
            A.Has(absent.Text, "Steamworks: absent", "absence de Steamworks annoncée");

            Console.WriteLine("PROBE REPORT OK");
        }

        private static void ProbeStub()
        {
            var f = Std();
            var b = BindOf(f);
            var report = Probe.Run(b, Asm(f), "480", "Faux Jeu");
            var stub = report.Stub;

            A.Eq(stub.Id, "faux-jeu", "identifiant dérivé du nom");
            A.Eq(stub.EntryStrategy, "native", "stratégie déduite du candidat trouvé");
            A.Eq(stub.NativeType, "FakeGame.NetworkConnector", "type du chemin d'entrée");
            A.Eq(stub.NativeInvoke, "BeginJoin", "méthode d'entrée");
            A.Eq(stub.NativeInstance, "Instance", "porteur de l'instance");
            A.True(stub.NativeFields.Any(kv => kv.Key == "RoomName" && kv.Value == "$room"), "champ de salle relié");
            A.Eq(stub.Friends, "steam", "source d'amis déduite");

            // Le seul critère qui compte : l'ébauche repasse le validateur.
            var text = ProfileStore.ToJson(stub);
            var reread = ProfileStore.FromText(text, "ébauche");
            A.True(reread.Ok, "l'ébauche est un profil valide : " + reread.Message);
            A.Eq(reread.Profile.NativeInvoke, "BeginJoin", "aller-retour JSON fidèle");
            A.Eq(reread.Profile.MatchAppId, "480", "critère de reconnaissance conservé");

            // Et une ébauche prise sur un jeu sans chemin natif reste valide.
            var v = Var();
            var stub2 = Probe.Run(BindOf(v), Asm(v), "", "Variante").Stub;
            A.Eq(stub2.EntryStrategy, "raw", "sans candidat, on reste sur l'appel direct");
            A.Eq(stub2.Friends, "manual", "sans Steamworks, saisie manuelle");
            A.True(ProfileStore.FromText(ProfileStore.ToJson(stub2), "ébauche2").Ok, "seconde ébauche valide");

            Console.WriteLine("PROBE STUB OK");
        }

        private static void ProbeCandidates()
        {
            var f = Std();
            var found = Probe.FindCandidates(Asm(f));

            A.Eq(found.Count, 1, "un seul chemin d'entrée dans le faux courant");
            var c = found[0];
            A.Eq(c.TypeName, "FakeGame.NetworkConnector", "type du candidat");
            A.Eq(c.RoomField, "RoomName", "champ de salle");
            A.Eq(c.RegionField, "RegionToJoin", "champ de région");
            A.Eq(c.InstanceMember, "Instance", "porteur de l'instance");
            A.True(c.Methods.Contains("BeginJoin"), "méthode réellement présente");
            A.False(c.Methods.Contains("JoinRoom"), "aucune méthode inventée");

            // Le témoin négatif : la variante n'a pas de chemin de jonction
            // propre, et la sonde ne doit pas en fabriquer un.
            var v = Var();
            var none = Probe.FindCandidates(Asm(v));
            A.Eq(none.Count, 0, "aucun candidat dans la variante");

            A.Eq(Probe.FindCandidates(null).Count, 0, "aucun candidat sans assemblées");

            Console.WriteLine("PROBE CANDIDATES OK");
        }

        // ---- Identité --------------------------------------------------------

        private static void IdentityForge()
        {
            const string host = "76561198393956588";

            var keep = new GameProfile { IdentityStrategy = "keep" };
            var r = Identity.Forge(keep, host, "moi");
            A.True(r.Ok, r.Error);
            A.Eq(r.UserId, "moi", "identité inchangée");
            A.False(r.Collides, "aucune collision");

            var prefix = new GameProfile { IdentityStrategy = "prefix-host", IdentityPrefix = "0" };
            r = Identity.Forge(prefix, host, "moi");
            A.True(r.Ok, r.Error);
            A.Eq(r.UserId, "0" + host, "préfixe appliqué");
            A.False(r.Collides, "le texte diffère de celui de l'hôte");
            A.True(ulong.Parse(r.UserId) == ulong.Parse(host), "la valeur numérique, elle, est la même");

            var custom = new GameProfile { IdentityStrategy = "custom", IdentityCustom = "$host-2" };
            r = Identity.Forge(custom, host, "moi");
            A.True(r.Ok, r.Error);
            A.Eq(r.UserId, host + "-2", "substitution de l'hôte");

            var self = new GameProfile { IdentityStrategy = "custom", IdentityCustom = "x$self" };
            r = Identity.Forge(self, host, "moi");
            A.Eq(r.UserId, "xmoi", "substitution de soi");

            var inconnue = new GameProfile { IdentityStrategy = "vaudou" };
            r = Identity.Forge(inconnue, host, "moi");
            A.False(r.Ok, "stratégie inconnue refusée");
            A.Has(r.Error, "vaudou", "l'erreur nomme la stratégie");

            r = Identity.Forge(prefix, "", "moi");
            A.False(r.Ok, "sans identifiant d'hôte, pas de préfixe");

            Console.WriteLine("IDENTITY FORGE OK");
        }

        private static void IdentityCollision()
        {
            const string host = "76561198393956588";

            // Un préfixe vide produirait exactement l'identifiant de l'hôte :
            // Photon compare des chaînes et refuserait l'entrée. C'est le seul
            // vrai piège de cette stratégie, et il doit se voir à la lecture du
            // profil, pas en jeu.
            var vide = new GameProfile { IdentityStrategy = "prefix-host", IdentityPrefix = "" };
            var r = Identity.Forge(vide, host, "moi");
            A.False(r.Ok, "préfixe vide refusé");
            A.Has(r.Error, "prefix", "l'erreur nomme le champ fautif");

            var copie = new GameProfile { IdentityStrategy = "custom", IdentityCustom = "$host" };
            r = Identity.Forge(copie, host, "moi");
            A.False(r.Ok, "copie exacte refusée");
            A.Has(r.Error, "mirror-host", "l'erreur indique la stratégie prévue pour ce cas");

            // mirror-host, elle, est un choix délibéré : autorisée, mais signalée.
            var mirror = new GameProfile { IdentityStrategy = "mirror-host" };
            r = Identity.Forge(mirror, host, "moi");
            A.True(r.Ok, "mirror-host autorisée");
            A.Eq(r.UserId, host, "identifiant identique à l'hôte");
            A.True(r.Collides, "la collision est signalée");
            A.True(r.Warning.Length > 0, "l'avertissement est renseigné");

            // Et le validateur de profils refuse la même faute en amont.
            var lu = ProfileStore.FromText(
                "{\"schema\":1,\"id\":\"x\",\"name\":\"X\",\"match\":{\"appId\":\"1\"},"
              + "\"identity\":{\"strategy\":\"prefix-host\",\"prefix\":\"\"},\"entry\":{\"strategy\":\"raw\"}}", "essai");
            A.False(lu.Ok, "profil au préfixe vide refusé");
            A.Has(lu.Message, "identity.prefix", "le champ fautif est nommé");

            Console.WriteLine("IDENTITY COLLISION OK");
        }

        private static void IdentityReauth()
        {
            var f = Std();
            var b = BindOf(f);
            f.SetState("ConnectedToMasterServer");
            f.SetAuth("moi");

            var t = 0.0;
            var r = new Reauth
            {
                Wanted = "076561198393956588",
                Now = () => t,
                Trace = s => FakeLog.Add("trace:" + s),
                Timeout = 5,
            };
            Drive(r.Run(b), _ => t += 0.1, 200);

            A.True(r.Ok, "réauthentification : " + r.Error);
            A.Eq(f.AuthUserId(), "076561198393956588", "identifiant présenté");

            // L'ordre est le fond du sujet : Photon retient l'identifiant reçu
            // à l'authentification, donc l'écriture doit tomber entre la
            // déconnexion et la reconnexion, jamais ailleurs.
            var iDisc = FakeLog.IndexOf("Disconnect");
            var iWrite = FakeLog.IndexOf("trace:identifiant-écrit:076561198393956588");
            var iConn = FakeLog.IndexOf("ConnectUsingSettings");
            A.True(iDisc >= 0, "déconnexion appelée");
            A.True(iWrite > iDisc, "écriture après la déconnexion");
            A.True(iConn > iWrite, "reconnexion après l'écriture");

            // Rien à faire si l'identité demandée est déjà celle qu'on présente.
            f.Reset();
            f.SetState("ConnectedToMasterServer");
            f.SetAuth("déjà");
            var r2 = new Reauth { Wanted = "déjà", Now = () => t, Timeout = 5 };
            Drive(r2.Run(b), null, 10);
            A.True(r2.Ok, "cas déjà satisfait");
            A.Eq(FakeLog.IndexOf("Disconnect"), -1, "aucune déconnexion inutile");

            // Un serveur qui ne répond plus doit produire une erreur, pas une
            // boucle : le greffon ne peut pas rester bloqué dans le jeu.
            f.Reset();
            f.SetState("ConnectedToMasterServer");
            f.SetUnresponsive(true);
            var t2 = 0.0;
            var r3 = new Reauth { Wanted = "autre", Now = () => t2, Timeout = 2 };
            Drive(r3.Run(b), _ => t2 += 0.5, 200);
            A.False(r3.Ok, "échec attendu");
            A.Has(r3.Error, "déconnexion", "l'erreur dit quelle étape a échoué");
            A.Eq(f.AuthUserId(), "76561198000000001", "l'identifiant n'a pas été écrit en aveugle");

            Console.WriteLine("IDENTITY REAUTH OK");
        }

        // ---- Découverte ------------------------------------------------------

        private static void DiscoveryCase()
        {
            var f = Std();
            var b = BindOf(f);
            f.SetState("ConnectedToMasterServer");

            string err;
            A.True(Discovery.Request(b, new[] { "H" }, out err), "demande acceptée : " + err);
            A.True(FakeLog.Has("FindFriends:H"), "FindFriends réellement appelé");

            f.SetFriends(new[] { "H" }, new[] { true }, new[] { true }, new[] { "ROOM42" });
            var t = Discovery.Resolve(b, "H");
            A.True(t.Joinable, "ami joignable");
            A.Eq(t.Room, "ROOM42", "salle lue");
            A.Eq(t.Rank, 3, "rang maximal");
            A.Eq(t.Region, "eu", "région courante");
            A.Eq(Discovery.RegionFor(b, ProfileStore.Default()), "eu", "région visée par défaut");

            var fixe = new GameProfile { Region = "sa" };
            A.Eq(Discovery.RegionFor(b, fixe), "sa", "région imposée par le profil");

            // Hors connexion, la demande n'a pas de sens et doit être refusée
            // avec une raison, pas silencieusement.
            f.SetState("Disconnected");
            A.False(Discovery.Request(b, new[] { "H" }, out err), "demande refusée hors connexion");
            A.Has(err, "connecté", "le refus est expliqué");

            f.SetState("ConnectedToMasterServer");
            A.False(Discovery.Request(b, new string[0], out err), "aucun identifiant à chercher");

            Console.WriteLine("DISCOVERY OK");
        }

        private static void DiscoveryRank()
        {
            var f = Std();
            var b = BindOf(f);
            f.SetState("ConnectedToMasterServer");

            f.SetFriends(
                new[] { "hors-ligne", "en-ligne", "en-partie" },
                new[] { false, true, true },
                new[] { false, false, true },
                new[] { "VIEILLE", "", "ROOM42" });

            var best = Discovery.Best(b, null);
            A.True(best != null, "un ami joignable trouvé");
            A.Eq(best.UserId, "en-partie", "l'ami en partie est préféré");
            A.Eq(best.Room, "ROOM42", "sa salle");

            var all = Discovery.All(b);
            A.Eq(all.Count, 3, "tous les amis rapportés");
            A.Eq(all.First(x => x.UserId == "hors-ligne").Rank, 0, "hors ligne : rang nul");
            A.Eq(all.First(x => x.UserId == "en-ligne").Rank, 1, "en ligne sans salle : rang 1");

            // Une salle héritée d'un ami hors ligne ne doit pas le rendre joignable.
            A.False(all.First(x => x.UserId == "hors-ligne").Joinable, "hors ligne, donc injoignable");

            // Restreindre la recherche à un identifiant précis doit être respecté.
            var cible = Discovery.Best(b, new[] { "en-ligne" });
            A.True(cible == null, "l'ami en ligne sans salle n'est pas retenu");

            Console.WriteLine("DISCOVERY RANK OK");
        }

        private static void DiscoveryEmpty()
        {
            var f = Std();
            var b = BindOf(f);
            f.SetState("ConnectedToMasterServer");

            A.True(Discovery.Best(b, null) == null, "aucun ami, aucun résultat");

            f.SetFriends(new[] { "a", "b" }, new[] { false, true }, new[] { false, false }, new[] { "", "" });
            A.True(Discovery.Best(b, null) == null, "ni hors ligne ni en ligne sans salle ne comptent");
            A.False(Discovery.Resolve(b, "a").Joinable, "hors ligne : injoignable");
            A.False(Discovery.Resolve(b, "b").Joinable, "en ligne sans salle : injoignable");
            A.True(Discovery.Resolve(b, "b").Online, "mais bien signalé en ligne");
            A.False(Discovery.Resolve(b, "inconnu").Joinable, "identifiant inconnu : injoignable");
            A.Eq(Discovery.Resolve(b, "inconnu").Rank, 0, "et sans rang");

            Console.WriteLine("DISCOVERY EMPTY OK");
        }

        // ---- Entrée ----------------------------------------------------------

        private static void EntryRaw()
        {
            var f = Std();
            var b = BindOf(f);
            f.SetState("ConnectedToMasterServer");

            var p = new GameProfile { EntryStrategy = "raw" };
            var r = Entry.Enter(b, p, "ROOM42", "eu", Asm(f));
            A.True(r.Ok, "entrée directe : " + r.Error);
            A.True(FakeLog.Has("JoinRoom:ROOM42"), "JoinRoom appelé");
            A.Eq(f.CurrentRoomName(), "ROOM42", "salle rejointe");

            // La même chose sur la variante, dont JoinRoom prend deux
            // paramètres : c'est le liant qui doit absorber la différence.
            var v = Var();
            var bv = BindOf(v);
            v.SetState("ConnectedToMasterServer");
            var rv = Entry.Enter(bv, p, "ROOM7", "us", Asm(v));
            A.True(rv.Ok, "entrée directe sur la variante : " + rv.Error);
            A.Eq(v.CurrentRoomName(), "ROOM7", "salle rejointe sur la variante");

            // Un refus de PUN doit remonter comme un échec, pas comme un succès.
            var f2 = Std();
            var b2 = BindOf(f2);
            f2.SetState("ConnectedToMasterServer");
            f2.SetJoinResult(false);
            var r2 = Entry.Enter(b2, p, "ROOM42", "eu", Asm(f2));
            A.False(r2.Ok, "refus de PUN remonté");
            A.Has(r2.Error, "JoinRoom", "l'erreur nomme l'appel refusé");

            Console.WriteLine("ENTRY RAW OK");
        }

        private static void EntryNative()
        {
            var f = Std();
            var b = BindOf(f);
            f.SetState("ConnectedToMasterServer");

            var p = Native("FakeGame.NetworkConnector", "Instance", "BeginJoin");
            var r = Entry.Enter(b, p, "ROOM42", "eu", Asm(f));
            A.True(r.Ok, "entrée native : " + r.Error);

            // Les champs sont écrits avant l'appel, et l'appel est celui du jeu.
            A.True(FakeLog.Has("BeginJoin:ROOM42@eu"), "le jeu a reçu salle et région avant l'appel");
            var iBegin = FakeLog.IndexOf("BeginJoin:ROOM42@eu");
            var iJoin = FakeLog.IndexOf("JoinRoom:ROOM42");
            A.True(iBegin >= 0 && iJoin > iBegin, "le chemin du jeu mène à l'entrée en salle");
            A.Eq(f.CurrentRoomName(), "ROOM42", "salle rejointe");
            A.Has(r.Trace, "RoomName=ROOM42", "la trace dit ce qui a été écrit");
            A.Has(r.Trace, "BeginJoin()", "la trace dit ce qui a été appelé");

            Console.WriteLine("ENTRY NATIVE OK");
        }

        private static void EntryMissing()
        {
            var f = Std();
            var b = BindOf(f);
            f.SetState("ConnectedToMasterServer");

            // Un profil peut nommer n'importe quoi. Chaque absence doit produire
            // un message qui nomme le membre manquant : c'est tout ce dont
            // dispose quelqu'un qui écrit un profil pour un jeu inconnu.
            var typeAbsent = Native("FakeGame.NexistePas", "Instance", "BeginJoin");
            var r = Entry.Enter(b, typeAbsent, "ROOM42", "eu", Asm(f));
            A.False(r.Ok, "type absent refusé");
            A.Has(r.Error, "FakeGame.NexistePas", "l'erreur nomme le type");

            var instanceAbsente = Native("FakeGame.NetworkConnector", "PasDInstance", "BeginJoin");
            r = Entry.Enter(b, instanceAbsente, "ROOM42", "eu", Asm(f));
            A.False(r.Ok, "porteur d'instance absent refusé");
            A.Has(r.Error, "PasDInstance", "l'erreur nomme le membre");

            var champAbsent = Native("FakeGame.NetworkConnector", "Instance", "BeginJoin");
            champAbsent.NativeFields.Clear();
            champAbsent.NativeFields.Add(new KeyValuePair<string, string>("PasUnChamp", "$room"));
            r = Entry.Enter(b, champAbsent, "ROOM42", "eu", Asm(f));
            A.False(r.Ok, "champ absent refusé");
            A.Has(r.Error, "PasUnChamp", "l'erreur nomme le champ");

            var methodeAbsente = Native("FakeGame.NetworkConnector", "Instance", "PasUneMethode");
            r = Entry.Enter(b, methodeAbsente, "ROOM42", "eu", Asm(f));
            A.False(r.Ok, "méthode absente refusée");
            A.Has(r.Error, "PasUneMethode", "l'erreur nomme la méthode");

            // Et aucune de ces fautes n'a touché au jeu.
            A.Eq(f.CurrentRoomName(), null, "aucune salle rejointe par erreur");
            A.False(FakeLog.Has("JoinRoom:ROOM42"), "aucun appel de jonction parasite");

            var sansSalle = Entry.Enter(b, ProfileStore.Default(), "", "eu", Asm(f));
            A.False(sansSalle.Ok, "sans nom de salle, rien n'est tenté");

            Console.WriteLine("ENTRY MISSING OK");
        }

        private static GameProfile Native(string type, string instance, string invoke)
        {
            var p = new GameProfile
            {
                EntryStrategy = "native",
                NativeType = type,
                NativeInstance = instance,
                NativeInvoke = invoke,
            };
            p.NativeFields.Add(new KeyValuePair<string, string>("RoomName", "$room"));
            p.NativeFields.Add(new KeyValuePair<string, string>("RegionToJoin", "$region"));
            return p;
        }

        // ---- Bouclier --------------------------------------------------------

        private static void ShieldCase()
        {
            var p = new GameProfile { ShieldDisconnectMessage = true, ShieldCodes = new List<int> { 104 } };
            A.True(Shield.ShouldSwallow(p, 104), "la trame d'expulsion est absorbée");
            A.False(Shield.ShouldSwallow(p, 0), "les autres codes passent");
            A.False(Shield.ShouldSwallow(p, 103), "un code voisin passe");
            A.False(Shield.ShouldSwallow(null, 104), "sans profil, rien n'est absorbé");

            // Lecture d'une trame réelle, sur les deux formes de type.
            foreach (var f in new[] { Std(), Var() })
            {
                var b = BindOf(f);
                var message = Activator.CreateInstance(b.TDisconnectMessage);
                b.DmCode.Set(message, (short)104);
                b.DmDebugMessage.Set(message, "kicked by host");
                A.Eq(Shield.ReadCode(b, message), 104, "code lu sur « " + f.Label + " »");
                A.Eq(Shield.ReadMessage(b, message), "kicked by host", "message lu sur « " + f.Label + " »");
                A.Has(Shield.Describe(b, message, true), "ignorée", "description quand la trame est absorbée");
                A.Has(Shield.Describe(b, message, false), "transmise", "description quand elle passe");
            }

            Console.WriteLine("SHIELD OK");
        }

        private static void ShieldTargets()
        {
            foreach (var f in new[] { Std(), Var() })
            {
                var b = BindOf(f);
                var hook = Shield.ResolveDisconnectHook(b);
                A.True(hook != null, "hameçon trouvé sur « " + f.Label + " »");
                A.Eq(hook.Name, "OnDisconnectMessageReceived", "nom de la méthode interceptée");
                A.Eq(hook.GetParameters().Length, 1, "arité de la méthode interceptée");
                A.True(hook.DeclaringType == b.TClient, "déclarée par le client Photon du jeu");
            }

            var std = Std();
            var bs = BindOf(std);
            var unresolved = new List<string>();
            var p = new GameProfile();
            p.ShieldKickRpc.Add("FakeGame.NetworkConnector:BeginJoin");
            p.ShieldKickRpc.Add("PasUnType:PasUneMethode");
            p.ShieldKickRpc.Add("FakeGame.NetworkConnector:PasUneMethode");
            p.ShieldKickRpc.Add("mal-formé");

            var found = Shield.ResolveKickRpcs(p, Asm(std), unresolved);
            A.Eq(found.Count, 1, "une seule cible réellement présente");
            A.Eq(found[0].Name, "BeginJoin", "la cible trouvée est la bonne");
            A.Eq(unresolved.Count, 3, "les trois autres sont signalées, pas inventées");
            A.Has(string.Join(" | ", unresolved), "type introuvable", "la raison est donnée");
            A.Has(string.Join(" | ", unresolved), "méthode introuvable", "la raison est donnée");
            A.Has(string.Join(" | ", unresolved), "Type:Methode", "la forme attendue est rappelée");

            Console.WriteLine("SHIELD TARGETS OK");
        }

        private static void ShieldOff()
        {
            // Le témoin négatif de « shield » : si le bouclier n'absorbait rien
            // dans les deux configurations, le contrôle précédent ne mesurerait
            // rien du tout.
            var eteint = new GameProfile { ShieldDisconnectMessage = false, ShieldCodes = new List<int> { 104 } };
            A.False(Shield.ShouldSwallow(eteint, 104), "bouclier éteint : la trame passe");

            var sansCode = new GameProfile { ShieldDisconnectMessage = true, ShieldCodes = new List<int>() };
            A.False(Shield.ShouldSwallow(sansCode, 104), "aucun code déclaré : la trame passe");

            var arme = new GameProfile { ShieldDisconnectMessage = true, ShieldCodes = new List<int> { 104 } };
            A.True(Shield.ShouldSwallow(arme, 104), "et armé, elle est absorbée");

            // Le profil livré doit effectivement armer le bouclier sur le code
            // observé en jeu.
            var peak = PeakProfile();
            A.True(peak.ShieldDisconnectMessage, "bouclier armé dans le profil livré");
            A.True(Shield.ShouldSwallow(peak, 104), "sur le code observé en partie réelle");

            Console.WriteLine("SHIELD OFF OK");
        }

        // ---- Profils ---------------------------------------------------------

        private static void ProfileLoad()
        {
            var p = PeakProfile();

            A.Eq(p.Id, "peak", "identifiant");
            A.Eq(p.MatchAppId, "3527290", "AppID de reconnaissance");
            A.True(p.MatchTypes.Contains("Peak.Network.SteamLobbyAPI"), "type de reconnaissance");

            // Le fond du profil : l'identité qui a été vérifiée en partie réelle.
            A.Eq(p.IdentityStrategy, "prefix-host", "stratégie d'identité");
            A.Eq(p.IdentityPrefix, "0", "préfixe");
            var forged = Identity.Forge(p, "76561198393956588", "moi");
            A.True(forged.Ok, forged.Error);
            A.Eq(forged.UserId, "076561198393956588", "identifiant que ce profil ferait présenter");

            // Et la limite, écrite noir sur blanc : l'entrée de PEAK ne tient
            // pas dans ce schéma, le greffon dédié reste le bon chemin.
            A.Eq(p.EntryStrategy, "raw", "stratégie d'entrée du profil de référence");
            A.Has(p.Notes, "PeakJoinFriend", "le profil renvoie vers le greffon dédié");

            var problems = new List<string>();
            var all = ProfileStore.LoadFolder(ProfilesDir, problems);
            A.Eq(problems.Count, 0, "aucun profil livré n'est invalide : " + string.Join(" | ", problems));
            A.True(all.Count >= 1, "au moins un profil livré");

            Console.WriteLine("PROFILE LOAD OK");
        }

        private static void ProfileDefault()
        {
            var peak = PeakProfile();
            var pool = new List<GameProfile> { peak };
            string note;

            var byId = ProfileStore.Choose(pool, "3527290", "", null, out note);
            A.Eq(byId.Id, "peak", "reconnaissance par AppID");
            A.Has(note, "3527290", "la note dit sur quoi le choix repose");

            var byProduct = ProfileStore.Choose(pool, "", "peak", null, out note);
            A.Eq(byProduct.Id, "peak", "reconnaissance par nom de produit, sans égard à la casse");

            var byType = ProfileStore.Choose(pool, "", "", t => t == "Peak.Network.SteamLobbyAPI", out note);
            A.Eq(byType.Id, "peak", "reconnaissance par présence d'un type");

            // Un jeu inconnu ne doit pas être refusé : il reçoit un profil
            // utilisable, c'est ce qui rend le moteur générique utile tout de
            // suite plutôt qu'après rédaction d'un fichier.
            var inconnu = ProfileStore.Choose(pool, "999999", "Autre Jeu", t => false, out note);
            A.True(inconnu.IsDefault, "profil par défaut appliqué");
            A.Eq(inconnu.EntryStrategy, "raw", "entrée directe par défaut");
            A.Eq(inconnu.IdentityStrategy, "keep", "identité inchangée par défaut");
            A.True(inconnu.ShieldDisconnectMessage, "bouclier armé par défaut");
            A.Eq(inconnu.MatchAppId, "999999", "le défaut retient tout de même le jeu visé");
            A.Has(note, "défaut", "la note l'annonce");

            var vide = ProfileStore.Choose(null, "1", "X", null, out note);
            A.True(vide.IsDefault, "sans aucun profil, le défaut s'applique");

            Console.WriteLine("PROFILE DEFAULT OK");
        }

        // ---- Surface ---------------------------------------------------------

        private static void OverlayNoSteam()
        {
            var v = Var();
            A.False(SteamBridge.Available(Asm(v)), "pas de Steamworks dans la variante");
            A.Eq(SteamBridge.ResolveSource(PeakProfile(), Asm(v)), "manual",
                 "la source bascule sur la saisie manuelle");

            string err;
            var list = SteamBridge.Friends(Asm(v), out err);
            A.Eq(list.Count, 0, "aucune liste d'amis");
            A.Has(err, "Steamworks", "l'absence est expliquée");
            A.Eq(SteamBridge.LocalSteamId(Asm(v)), "", "aucun identifiant local");

            A.False(SteamBridge.Available(null), "sans assemblées, rien n'est disponible");

            Console.WriteLine("OVERLAY NOSTEAM OK");
        }

        private static void OverlaySteam()
        {
            var f = Std();
            A.True(SteamBridge.Available(Asm(f)), "Steamworks présent");
            A.Eq(SteamBridge.LocalSteamId(Asm(f)), "76561198000000001", "identifiant local lu");

            string err;
            var list = SteamBridge.Friends(Asm(f), out err);
            A.Eq(err, "", "aucune erreur");
            A.Eq(list.Count, 2, "deux amis lus");
            A.True(list.Any(x => x.Id == 76561198393956588UL && x.Name == "Hote"), "ami attendu présent");
            A.True(list.All(x => x.Online), "état de présence lu");

            A.Eq(SteamBridge.ResolveSource(PeakProfile(), Asm(f)), "steam", "source Steam retenue");

            // Un profil qui demande la saisie manuelle doit être respecté même
            // quand Steamworks est là.
            var manuel = new GameProfile { Friends = "manual" };
            A.Eq(SteamBridge.ResolveSource(manuel, Asm(f)), "manual", "le profil prime");

            Console.WriteLine("OVERLAY STEAM OK");
        }

        private static void PluginMeta()
        {
            var dll = ShippedDll;
            if (!File.Exists(dll)) throw new Exception("binaire livré introuvable : " + dll);

            var types = Meta.TypeNames(dll);
            foreach (var wanted in new[]
                     {
                         "PhotonJoin.PhotonBinding", "PhotonJoin.Slot", "PhotonJoin.GameProfile",
                         "PhotonJoin.ProfileStore", "PhotonJoin.Identity", "PhotonJoin.Reauth",
                         "PhotonJoin.Discovery", "PhotonJoin.Entry", "PhotonJoin.Shield",
                         "PhotonJoin.Probe", "PhotonJoin.SteamBridge", "PhotonJoin.JoinPipeline",
                         "PhotonJoin.Plugin",
                     })
                A.True(types.Contains(wanted), "le binaire livré déclare " + wanted);

            var attrs = Meta.AttributesOn(dll, "PhotonJoin.Plugin");
            A.True(attrs.Any(a => a.EndsWith("BepInPlugin", StringComparison.Ordinal)),
                   "le greffon porte son attribut BepInPlugin — attributs vus : " + string.Join(", ", attrs));

            Console.WriteLine("PLUGIN META OK");
        }

        private static void Surface()
        {
            var peak = PeakProfile();
            var f = Std();
            var v = Var();

            A.Eq(peak.Hotkey, "F7", "la touche vient du profil");
            A.Eq(SteamBridge.ResolveSource(peak, Asm(f)), "steam", "source d'amis selon le jeu");
            A.Eq(SteamBridge.ResolveSource(peak, Asm(v)), "manual", "et selon ce que le jeu embarque");

            // Une touche différente dans le profil doit être celle qui compte.
            var autre = ProfileStore.FromText(
                "{\"schema\":1,\"id\":\"y\",\"name\":\"Y\",\"match\":{\"appId\":\"2\"},\"hotkey\":\"F9\","
              + "\"friends\":\"manual\",\"identity\":{\"strategy\":\"keep\"},\"entry\":{\"strategy\":\"raw\"}}", "y");
            A.True(autre.Ok, autre.Message);
            A.Eq(autre.Profile.Hotkey, "F9", "touche du second profil");
            A.Eq(SteamBridge.ResolveSource(autre.Profile, Asm(f)), "manual", "source imposée par le profil");

            // Et la stratégie d'entrée d'un profil natif pilote bien le moteur.
            var b = BindOf(f);
            f.SetState("ConnectedToMasterServer");
            var natif = Native("FakeGame.NetworkConnector", "Instance", "BeginJoin");
            A.True(Entry.Enter(b, natif, "ROOM42", "eu", Asm(f)).Ok, "entrée pilotée par le profil");
            A.True(FakeLog.Has("BeginJoin:ROOM42@eu"), "le chemin nommé par le profil a été emprunté");

            Console.WriteLine("SURFACE OK");
        }

        // ---- Intégrations ----------------------------------------------------

        private static void BindingIntegration()
        {
            // La sonde doit décrire ce que la liaison a réellement trouvé. Sur
            // la variante, cela veut dire des noms que personne n'a écrits dans
            // le moteur : s'ils apparaissent au rapport, c'est qu'ils viennent
            // bien du jeu.
            var v = Var();
            var b = BindOf(v);
            v.SetState("ConnectedToMasterServer");
            var report = Probe.Run(b, Asm(v), "", "Variante");

            A.Has(report.Text, "{ userId, isOnline, isInRoom, room }", "les membres réels de la variante");
            A.Has(report.Text, "PUN ", "la variante est annoncée comme PUN, pas PUN2");
            A.HasNot(report.Text, "Photon.Pun.PhotonNetwork", "aucun nom de la forme courante");
            A.Has(report.Text, "Steamworks: absent", "absence de Steamworks");
            A.Has(report.Text, "Chemins d'entrée trouvés : 0", "aucun chemin inventé");

            // Et sur la forme courante, les noms sont ceux de la forme courante.
            var f = Std();
            var report2 = Probe.Run(BindOf(f), Asm(f), "", "Courant");
            A.Has(report2.Text, "{ UserId, IsOnline, IsInRoom, Room }", "les membres réels de la forme courante");
            A.Has(report2.Text, "Chemins d'entrée trouvés : 1", "le chemin réellement présent");

            // L'ébauche produite dans les deux cas reste chargeable.
            A.True(ProfileStore.FromText(ProfileStore.ToJson(report.Stub), "v").Ok, "ébauche variante valide");
            A.True(ProfileStore.FromText(ProfileStore.ToJson(report2.Stub), "s").Ok, "ébauche courante valide");

            Console.WriteLine("BINDING INTEGRATION OK");
        }

        private static void JoinSequence()
        {
            const string host = "76561198393956588";
            var f = Std();
            var b = BindOf(f);
            f.SetState("ConnectedToMasterServer");
            f.SetAuth("moi");
            f.SetFriends(new[] { host }, new[] { true }, new[] { true }, new[] { "ROOM42" });

            var p = Native("FakeGame.NetworkConnector", "Instance", "BeginJoin");
            p.IdentityStrategy = "prefix-host";
            p.IdentityPrefix = "0";
            p.ShieldDisconnectMessage = true;

            var t = 0.0;
            var pipeline = new JoinPipeline
            {
                Binding = b,
                Profile = p,
                Assemblies = Asm(f),
                FriendId = host,
                HostId = host,
                Now = () => t,
                Trace = s => FakeLog.Add("étape:" + s),
            };
            Drive(pipeline.Run(), _ => t += 0.1, 400);

            A.True(pipeline.Ok, "séquence complète : " + pipeline.Error);
            A.Eq(pipeline.PresentedId, "0" + host, "identité présentée");
            A.Eq(pipeline.Room, "ROOM42", "salle retenue");
            A.Eq(pipeline.Region, "eu", "région retenue");
            A.Eq(f.CurrentRoomName(), "ROOM42", "le jeu est bien dans la salle");
            A.Eq(f.AuthUserId(), "0" + host, "le jeu présente l'identité forgée");

            // L'ordre entier, du premier au dernier appel : c'est ce qu'aucune
            // pièce ne peut prouver seule.
            var order = new[] { "Disconnect", "ConnectUsingSettings", "FindFriends:" + host, "BeginJoin:ROOM42@eu", "JoinRoom:ROOM42" };
            var last = -1;
            foreach (var step in order)
            {
                var at = FakeLog.IndexOf(step);
                A.True(at > last, "« " + step + " » attendu après l'étape précédente — journal : " + FakeLog.Joined());
                last = at;
            }

            Console.WriteLine("JOIN SEQUENCE OK");
        }

        private static void JoinSequenceFail()
        {
            var f = Std();
            var b = BindOf(f);
            f.SetState("ConnectedToMasterServer");
            f.SetAuth("moi");
            // L'ami est en ligne mais dans aucune partie : le cas le plus
            // fréquent, et celui où un message vague fait perdre le plus de temps.
            f.SetFriends(new[] { "H" }, new[] { true }, new[] { false }, new[] { "" });

            var t = 0.0;
            var pipeline = new JoinPipeline
            {
                Binding = b,
                Profile = ProfileStore.Default(),
                Assemblies = Asm(f),
                FriendId = "H",
                Now = () => t,
                FindTimeout = 2,
            };
            Drive(pipeline.Run(), _ => t += 0.5, 400);

            A.False(pipeline.Ok, "la séquence échoue");
            A.Has(pipeline.Error, "aucune partie", "l'erreur dit précisément ce qui manque");
            A.Eq(f.CurrentRoomName(), null, "aucune salle rejointe");
            A.False(FakeLog.Has("JoinRoom:"), "aucune entrée tentée à l'aveugle");
            A.True(b.IsConnectedNow(), "le client reste connecté, pas laissé entre deux états");
            A.Eq(f.GetState(), "ConnectedToMasterServer", "état inchangé");

            // Un ami que Photon ne connaît pas du tout donne un autre message.
            var f2 = Std();
            var b2 = BindOf(f2);
            f2.SetState("ConnectedToMasterServer");
            var t2 = 0.0;
            var p2 = new JoinPipeline
            {
                Binding = b2, Profile = ProfileStore.Default(), Assemblies = Asm(f2),
                FriendId = "inconnu", Now = () => t2, FindTimeout = 2,
            };
            Drive(p2.Run(), _ => t2 += 0.5, 400);
            A.False(p2.Ok, "ami inconnu : échec");
            A.Has(p2.Error, "identifiant erroné", "les causes possibles sont énoncées");

            // Et une identité impossible arrête la séquence avant tout appel réseau.
            var f3 = Std();
            var b3 = BindOf(f3);
            f3.SetState("ConnectedToMasterServer");
            var t3 = 0.0;
            var p3 = new JoinPipeline
            {
                Binding = b3,
                Profile = new GameProfile { IdentityStrategy = "prefix-host", IdentityPrefix = "" },
                Assemblies = Asm(f3), FriendId = "H", HostId = "H", Now = () => t3,
            };
            Drive(p3.Run(), _ => t3 += 0.1, 50);
            A.False(p3.Ok, "identité impossible : échec");
            A.False(FakeLog.Has("Disconnect"), "aucune déconnexion inutile");
            A.False(FakeLog.Has("FindFriends:H"), "aucune recherche lancée");

            Console.WriteLine("JOIN SEQUENCE FAIL OK");
        }

        // ---- Lecture de métadonnées -----------------------------------------

        private static void AsmRefs(string[] args)
        {
            if (args.Length < 2) throw new Exception("usage : asmrefs <chemin.dll>");
            var dll = Path.GetFullPath(args[1]);
            if (!File.Exists(dll)) throw new Exception("binaire introuvable : " + dll);

            foreach (var name in Meta.AssemblyReferences(dll)) Console.WriteLine("REF " + name);
            Console.WriteLine("ASMREFS READ");
        }
    }
}
