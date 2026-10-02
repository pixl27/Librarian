using System;
using System.Collections;
using System.Collections.Generic;
using BepInEx;
using BepInEx.Configuration;
using Photon.Pun;
using Photon.Realtime;
using Steamworks;
using HarmonyLib;
using UnityEngine;

namespace PeakJoinFriend
{
    /// <summary>
    /// Rejoindre la partie d'un ami sans passer par l'overlay Steam.
    ///
    /// PEAK 2.1 filtre les arrivants côté hôte. Dans GameUtils::OnPlayerEnteredRoom :
    ///
    ///     if (!NetCode.Matchmaking.PlayerIsInLobby(joueur.UserId))
    ///     {
    ///         Debug.LogError(... "is not in our Steam lobby. That's too sussy to allow. Kicking them.");
    ///         NetCode.Session.Kick(joueur.UserId);
    ///         return;                                  // avant la ligne suivante
    ///     }
    ///     GameHandler.GetService&lt;PersistentPlayerDataService&gt;().SyncToPlayer(joueur);
    ///
    /// D'où l'écran noir (le return saute SyncToPlayer) puis la déconnexion
    /// (« Got DisconnectMessage. Code: 104 Msg: "kicked" », envoyée par le
    /// serveur Photon, donc irrefusable côté client).
    ///
    /// Deux façons de satisfaire ce test, et une seule marche entre applications
    /// différentes.
    ///
    /// 1. Le lobby Steam. Y être vraiment. C'est la voie propre, celle d'une
    ///    invitation, mais les lobbys Steam sont cloisonnés par application :
    ///    sous Spacewar (480) on ne peut pas entrer dans un lobby de PEAK
    ///    (3527290). Utilisable seulement si les deux machines tournent sous le
    ///    même AppID.
    ///
    /// 2. L'identifiant présenté — une piste qui paraissait juste et qui ne
    ///    l'est pas. Le test lit :
    ///
    ///        bool PlayerIsInLobby(string userId)
    ///        {
    ///            if (!ulong.TryParse(userId, out id)) return false;
    ///            for (i &lt; SteamMatchmaking.GetNumLobbyMembers(lobby))
    ///                if (new CSteamID(id) == GetLobbyMemberByIndex(lobby, i)) return true;
    ///            return false;
    ///        }
    ///
    ///    Il ne vérifie pas que l'identifiant est le nôtre, seulement qu'il
    ///    appartient à un membre du lobby — et l'hôte est membre du sien. Se
    ///    présenter sous son SteamID64 devait donc faire répondre oui à sa
    ///    propre question. Rien ne s'y opposait côté client : LoadUserID pose
    ///    AuthType = None (255), donc aucune validation, et l'état de jeu est
    ///    indexé par ActorNumber, qui reste distinct.
    ///
    ///    C'est le serveur Photon qui refuse, et il l'a dit clairement :
    ///
    ///        Failed to join Photon Room, code: 32746, message: Join failed:
    ///        UserId '…' already joined the specified game (JoinMode=0).
    ///
    ///    32746 = ErrorCode.JoinFailedFoundActiveJoiner. L'unicité du UserId
    ///    parmi les acteurs actifs est imposée quoi qu'il arrive — CheckUserOnJoin
    ///    n'était pas la bonne porte. Et l'hôte étant par définition actif dans
    ///    sa room, son identifiant est toujours déjà pris. Il faudrait un SteamID
    ///    à la fois membre de son lobby et absent de sa room : chez un hôte seul,
    ///    cet ensemble est vide.
    ///
    /// Reste donc le lobby Steam, et il n'est pas fermé : l'invitation de l'hôte
    /// arrive bien dans notre session, son lobby est donc dans notre application.
    /// Ce qui échouait, c'est un identifiant de lobby périmé — il change quand
    /// l'hôte recrée sa partie, et Steam répond alors « Failed to fetch lobby
    /// data ». D'où la règle de ce plugin : relire son lobby au moment du clic,
    /// et garder celui de la dernière invitation reçue, qui est la valeur la plus
    /// fraîche qu'on puisse obtenir.
    ///
    /// Tout se passe chez nous. L'hôte joue en version d'origine.
    /// </summary>
    [BepInPlugin(GUID, "PEAK — Rejoindre un ami", "0.8.0")]
    public class Plugin : BaseUnityPlugin, ILobbyCallbacks, IMatchmakingCallbacks
    {
        public const string GUID = "librarian.peak.joinfriend";
        private const uint SPACEWAR = 480;
        private const uint PEAK = 3527290;

        private ConfigEntry<KeyCode> _hotkey;
        private static ConfigEntry<bool> _ignoreKick;
        private static ConfigEntry<bool> _welcomeAll;
        private static ConfigEntry<string> _forgePrefix;
        private static ConfigEntry<bool> _refuseKickFrame;
        private Harmony _harmony;
        private bool _open;
        private string _manualId = "";
        private string _status = "";
        private Rect _win = new Rect(60, 60, 780, 500);
        private Vector2 _scroll;
        private bool _busy;

        /// <summary>
        /// L'identifiant présenté à Photon à la prochaine authentification, ou
        /// null pour le nôtre. Statique parce que le patch de LoadUserID le lit.
        /// </summary>
        private static string _presentedId;

        /// <summary>
        /// Vrai pendant la coupure volontaire de Photon, le temps de se
        /// réauthentifier. Le patch de OnDisconnected s'en sert pour ne pas
        /// laisser le jeu croire à un incident.
        /// </summary>
        private static bool _reauthenticating;

        private readonly List<FriendEntry> _friends = new List<FriendEntry>();
        private string _foundRoom;
        private string _region = "";
        private Callback<FriendRichPresenceUpdate_t> _richPresence;
        private Callback<GameLobbyJoinRequested_t> _invite;
        private Callback<LobbyEnter_t> _lobbyEnter;
        private Callback<LobbyDataUpdate_t> _lobbyData;
        private ulong _invitedLobby;
        private ulong _probed;
        private string _probedData = "";
        private string _invitedBy;

        private class FriendEntry
        {
            public string SteamId;
            public string Name;
            public uint AppId;        // l'app sous laquelle Steam le voit (0 = ne joue pas)
            public bool SameApp;      // même app que nous : ses lobbys nous sont visibles
            public ulong Lobby;       // son lobby Steam, s'il en publie un de joignable
            public string RichRoom;   // la room lue dans sa rich presence Steam
            public string Room;       // la room que Photon nous a répondue
            public bool Searched;
            public string Keys;       // ses clés de rich presence, pour diagnostic
            public string State;      // Status_Airport, Status_Tropics… d'après steam_display

            public string BestRoom { get { return !string.IsNullOrEmpty(RichRoom) ? RichRoom : Room; } }

            /// <summary>
            /// Vrai tant qu'il est encore là où l'on sait arriver. Le join charge
            /// « Airport » en dur : seul le lobby Steam transporte le nom de la
            /// scène (CurrentScene), la rich presence ne le donne pas. Entrer
            /// dans une room dont la scène est ailleurs mettrait le client dans
            /// un décor qui n'est pas celui de la partie.
            /// </summary>
            public bool InAirport
            {
                get
                {
                    return string.IsNullOrEmpty(State)
                        || State == "Status_Airport" || State == "Status_MainMenu";
                }
            }
        }

        private void Awake()
        {
            _hotkey = Config.Bind("Général", "Touche", KeyCode.F7,
                "Ouvre et ferme la fenêtre « Rejoindre un ami ».");
            _ignoreKick = Config.Bind("Général", "IgnorerLeKick", true,
                "Ignore l'ordre d'expulsion envoyé par l'hôte quand il clique sur Kick "
                + "(Player::RPC_GetKicked → KickedState), qui s'exécute côté client. "
                + "Ne protège pas de l'expulsion automatique : PlayerHandler::KickRoutine "
                + "enchaîne avec ISessionAPI::Kick, et cette déconnexion-là descend du "
                + "serveur Photon.");

            _forgePrefix = Config.Bind("Rejoindre", "PrefixeIdentifiant", "0",
                "Préfixe numérique ajouté devant le SteamID64 de l'hôte pour former "
                + "l'identifiant qu'on lui présente. Vide = ne rien forger. "
                + "Essayer dans l'ordre : 0, puis 00.");
            _refuseKickFrame = Config.Bind("Rejoindre", "RefuserLaTrame104", true,
                "Refuse la trame DisconnectMessage code 104 « kicked » envoyée par le "
                + "serveur Photon. C'est notre client qui exécute la coupure, donc elle "
                + "se décline chez nous. Les autres codes passent normalement.");
            _welcomeAll = Config.Bind("Général", "AccepterTousLesArrivants", true,
                "Quand c'est toi qui héberges, accueille les joueurs absents de ton lobby Steam "
                + "au lieu de les expulser. GameUtils::OnPlayerEnteredRoom interroge "
                + "PlayerIsInLobby et expulse si la réponse est non ; ce contrôle tourne sur la "
                + "machine de l'hôte, donc sur la tienne quand tu héberges. Le désactiver rend "
                + "PEAK jouable entre deux AppID différents — Photon, lui, ne les distingue pas. "
                + "Il faut que celui qui héberge ait ce réglage, et que celui qui rejoint ait le "
                + "plugin pour entrer dans la room.");

            Logger.LogInfo("Prêt. " + _hotkey.Value + " pour ouvrir la fenêtre.");
            PhotonNetwork.AddCallbackTarget(this);

            // Gardé dans un champ : un Callback ramassé par le GC ne se déclenche
            // plus, et Steamworks.NET ne le retient pas pour nous.
            try
            {
                _richPresence = Callback<FriendRichPresenceUpdate_t>.Create(OnRichPresence);
                _invite = Callback<GameLobbyJoinRequested_t>.Create(OnInvite);
                _lobbyEnter = Callback<LobbyEnter_t>.Create(OnLobbyEnter);
                _lobbyData = Callback<LobbyDataUpdate_t>.Create(OnLobbyData);
            }
            catch (Exception e) { Logger.LogWarning("Callbacks Steam indisponibles : " + e.Message); }

            try
            {
                _harmony = new Harmony(GUID);
                _harmony.PatchAll(typeof(KickPatch));
                _harmony.PatchAll(typeof(UserIdPatch));
                _harmony.PatchAll(typeof(DisconnectNoticePatch));
                _harmony.PatchAll(typeof(WelcomePatch));
                Logger.LogInfo("Patchs posés : RPC_GetKicked, LoadUserID, OnDisconnected, PlayerIsInLobby.");
            }
            catch (Exception e) { Logger.LogWarning("Patch impossible : " + e.Message); }
        }

        private void OnDestroy()
        {
            PhotonNetwork.RemoveCallbackTarget(this);
            try { _harmony?.UnpatchSelf(); } catch { }
        }

        /// <summary>
        /// L'identité présentée à Photon se décide ici, au dernier moment.
        ///
        /// LoadUserID est appelée par ConnectToNetwork juste avant
        /// ConnectUsingSettings, et c'est la seule occasion : une fois la
        /// connexion faite, le UserId est figé pour la session. D'où le
        /// détour par une reconnexion plutôt qu'une écriture directe dans
        /// PhotonNetwork.AuthValues.
        /// </summary>
        [HarmonyPatch(typeof(Peak.Network.NetworkingUtilities), "LoadUserID")]
        private static class UserIdPatch
        {
            [HarmonyPostfix]
            private static void Postfix(ref AuthenticationValues __result)
            {
                if (__result == null || string.IsNullOrEmpty(_presentedId)) return;
                __result.UserId = _presentedId;
                Debug.Log("[JoinFriend] UserId présenté à Photon : " + _presentedId);
            }
        }

        /// <summary>
        /// Accueillir les arrivants au lieu de les expulser.
        ///
        /// C'est la moitié du problème que j'avais négligée. Le contrôle
        /// s'exécute chez l'**hôte** :
        ///
        ///     if (!NetCode.Matchmaking.PlayerIsInLobby(joueur.UserId)) { Kick; return; }
        ///
        /// Donc quand c'est nous qui hébergeons, il tourne sur notre machine — et
        /// une vérification qui tourne chez nous nous appartient. Ce prefix la
        /// fait répondre oui, et plus personne n'est expulsé pour ne pas être
        /// dans notre lobby Steam.
        ///
        /// Ce que ça débloque : Photon ignore totalement l'AppID Steam. Depuis
        /// une session 480 on a retrouvé un hôte sous 3527290 dans sa room
        /// (« FindFriends → IsOnline=True IsInRoom=True Room=1920dbd0-… »). Les
        /// deux clients partagent donc bien l'espace de matchmaking Photon ; seul
        /// ce test les séparait. L'hôte qui porte ce patch peut accueillir
        /// n'importe qui, quel que soit son AppID — et l'invité n'a besoin de
        /// rien d'autre que de savoir le nom de la room, ce que FindFriends donne.
        ///
        /// Le prix : le plugin doit être des deux côtés. Celui qui héberge pour
        /// ne pas kicker, celui qui rejoint pour entrer dans la room. Aucun des
        /// deux n'a plus besoin de partager l'application de l'autre.
        /// </summary>
        [HarmonyPatch(typeof(Peak.Network.SteamLobbyAPI), "PlayerIsInLobby")]
        private static class WelcomePatch
        {
            [HarmonyPrefix]
            private static bool Prefix(string __0, ref bool __result)
            {
                if (_welcomeAll == null || !_welcomeAll.Value) return true;
                Debug.Log("[JoinFriend] Arrivée de " + __0
                    + " — contrôle du lobby Steam ignoré, on l'accueille.");
                __result = true;
                return false;   // la vérification d'origine ne s'exécute pas
            }
        }

        /// <summary>
        /// Ne pas annoncer un incident quand la coupure vient de nous.
        ///
        /// NetworkConnector::OnDisconnected sort tout seul quand la cause vaut
        /// DisconnectByClientLogic (17), donc un PhotonNetwork.Disconnect() ne
        /// devrait rien afficher. Mais une reconnexion qui trébuche repasse ici
        /// avec une autre cause, et alors le jeu fait deux choses gênantes :
        /// il ouvre « MODAL_DISCONNECTEDPHOTON » (« veuillez vous reconnecter »)
        /// et il rappelle ChangeConnectionState&lt;DefaultConnectionState&gt;, ce qui
        /// efface le JoinSpecificRoomState qu'on est en train de préparer. Le
        /// résultat visible est un écran noir : la scène se charge sans état de
        /// connexion derrière elle.
        ///
        /// Pendant notre fenêtre, on avale donc l'événement ; la routine de join
        /// gère l'échec elle-même et remet l'identité d'origine.
        /// </summary>
        [HarmonyPatch(typeof(NetworkConnector), "OnDisconnected")]
        private static class DisconnectNoticePatch
        {
            [HarmonyPrefix]
            private static bool Prefix(DisconnectCause cause)
            {
                if (!_reauthenticating) return true;
                Debug.Log("[JoinFriend] Déconnexion " + cause + " pendant la réauthentification — "
                    + "avis du jeu ignoré.");
                return false;
            }
        }

        /// <summary>
        /// Refuser la trame de coupure, quand elle vaut 104 « kicked ».
        ///
        /// Le serveur Photon envoie une trame DisconnectMessage (msgType 5). Elle
        /// n'est pas une coupure en soi : IProtocol sait la désérialiser et ne
        /// sait pas la produire, et la branche qui la reçoit dans
        /// PeerBase::DeserializeMessageAndCallback n'écrit aucun état de peer.
        /// C'est LoadBalancingClient::OnDisconnectMessageReceived qui, à la
        /// lecture, appelle Disconnect(DisconnectByDisconnectMessage). Autrement
        /// dit l'ordre vient du serveur mais l'exécution est chez nous — donc
        /// déclinable.
        ///
        /// Sélectif, et pas par prudence de façade : avaler toutes les trames
        /// laisserait le client en « Joined » fantôme lors d'un arrêt légitime du
        /// serveur. Seul 104 est refusé, le reste passe.
        ///
        /// Ce que ça peut donner : si le serveur nous a seulement dit de partir,
        /// on reste acteur — et CharacterSpawner::HostUpdate, chez l'hôte, envoie
        /// RPC_NewPlayerSpawn toutes les deux secondes à tout acteur sans
        /// personnage, sans jamais consulter PlayerIsInLobby. On naîtrait donc
        /// sans sa coopération. S'il nous a aussi retiré de la room, la socket
        /// survit pour rien : le seul juge est l'arrivée de ce RPC, pas
        /// PhotonNetwork.InRoom qui ne lit que l'état local.
        /// </summary>
        [HarmonyPatch(typeof(Photon.Realtime.LoadBalancingClient), "OnDisconnectMessageReceived")]
        private static class KickFramePatch
        {
            [HarmonyPrefix]
            private static bool Prefix(object __0)
            {
                short code = 0;
                string msg = "";
                try
                {
                    var t = __0.GetType();
                    var fc = t.GetField("Code") ?? t.GetField("code");
                    var fm = t.GetField("DebugMessage") ?? t.GetField("debugMessage");
                    if (fc != null) code = Convert.ToInt16(fc.GetValue(__0));
                    if (fm != null) msg = Convert.ToString(fm.GetValue(__0));
                }
                catch { }

                Debug.Log("[JoinFriend] Trame de coupure reçue : code=" + code + " message=« " + msg + " »");
                if (_refuseKickFrame == null || !_refuseKickFrame.Value || code != 104) return true;

                Debug.LogWarning("[JoinFriend] Trame 104 « kicked » refusée — on reste. "
                    + "Le juge est l'arrivée de RPC_NewPlayerSpawn, pas InRoom.");
                return false;   // Disconnect(DisconnectByDisconnectMessage) n'a pas lieu
            }
        }

        /// <summary>
        /// Le Kick manuel de PEAK n'est pas imposé par le serveur : l'hôte envoie
        /// un RPC, et c'est la machine du destinataire qui bascule en KickedState.
        /// Refuser d'exécuter l'ordre est donc une décision purement locale.
        ///
        /// À ne pas confondre avec l'expulsion automatique, qui passe par
        /// ISessionAPI::Kick et redescend du serveur Photon en DisconnectMessage :
        /// aucun patch client ne peut la refuser. C'est pour celle-là que
        /// l'identifiant présenté existe.
        /// </summary>
        // global:: pour lever l'ambiguïté avec Photon.Realtime.Player : le RPC
        // appartient au Player du jeu, celui d'Assembly-CSharp.
        [HarmonyPatch(typeof(global::Player))]
        private static class KickPatch
        {
            [HarmonyPrefix]
            [HarmonyPatch("RPC_GetKicked")]
            private static bool Prefix()
            {
                if (_ignoreKick == null || !_ignoreKick.Value) return true;
                Debug.LogWarning("[JoinFriend] Ordre d'expulsion reçu — ignoré.");
                return false;   // la méthode d'origine ne s'exécute pas
            }
        }

        private void Update()
        {
            if (Input.GetKeyDown(_hotkey.Value))
            {
                _open = !_open;
                if (_open) RefreshSteamFriends();
            }
        }

        // ── Steam ────────────────────────────────────────────────────────────

        /// <summary>
        /// L'AppID sous lequel cette session Steam tourne réellement.
        ///
        /// C'est la seule valeur qui compte pour les lobbys : Steam les cloisonne
        /// par application. Sous Spacewar la réponse est 480, et il faut la
        /// prendre telle quelle — la « corriger » en 3527290 ferait croire à une
        /// incompatibilité avec les amis qui, eux aussi, tournent sous 480.
        /// </summary>
        private static uint RunningAppId()
        {
            if (_appIdSource == null) ResolveAppId();
            return _appId;
        }

        private static uint _appId;
        private static string _appIdSource;

        /// <summary>
        /// Les deux sources, comparées et tracées une fois pour toutes.
        ///
        /// Elles ont divergé, et ça a coûté un essai : le plugin annonçait
        /// « app 3527290 » alors que le jeu tournait bel et bien sous 480
        /// (« Setting breakpad minidump AppID = 480 » dans Player.log, proxy
        /// Spacewar en place, steam_appid.txt à 480). Un ami sous 3527290 passait
        /// donc pour « même application », et c'est le chemin du jeu qui était
        /// proposé au lieu de l'appel direct. Quand deux sources se contredisent,
        /// il faut d'abord le voir.
        /// </summary>
        private static void ResolveAppId()
        {
            uint api = 0, file = 0;
            try { if (SteamAPI.IsSteamRunning()) api = SteamUtils.GetAppID().m_AppId; }
            catch { }
            try
            {
                string p = System.IO.Path.Combine(Application.dataPath, "..", "steam_appid.txt");
                if (System.IO.File.Exists(p)) uint.TryParse(System.IO.File.ReadAllText(p).Trim(), out file);
            }
            catch { }

            // steam_appid.txt est ce que SteamAPI_Init a réellement lu au
            // démarrage ; il fait donc foi quand les deux ne s'accordent pas.
            if (file != 0) { _appId = file; _appIdSource = "steam_appid.txt"; }
            else if (api != 0) { _appId = api; _appIdSource = "SteamUtils.GetAppID()"; }
            else { _appId = PEAK; _appIdSource = "repli"; }

            Debug.Log("[JoinFriend] AppID : " + _appId + " (source " + _appIdSource
                + " ; GetAppID=" + api + ", fichier=" + file + ")");
        }

        private const int ACCOUNT_INDIVIDUAL = 1;   // EAccountType.k_EAccountTypeIndividual
        private const int ACCOUNT_CHAT = 8;         // EAccountType.k_EAccountTypeChat — les lobbys

        /// <summary>
        /// Le type de compte encodé dans un CSteamID, bits 52 à 55.
        ///
        /// Un joueur et un lobby ne se distinguent pas à l'œil : ce sont deux
        /// entiers de 17 chiffres. Ils se distinguent dans leurs bits, et c'est
        /// ce qui permet de refuser un SteamID de joueur là où on attend un
        /// lobby — au lieu de le transmettre à Steam et de récolter une modale
        /// d'échec incompréhensible.
        /// </summary>
        private static int AccountType(ulong steamId)
        {
            return (int)((steamId >> 52) & 0xF);
        }

        private static string AppLabel(uint app)
        {
            if (app == 0) return "—";
            if (app == SPACEWAR) return "480 (Spacewar)";
            if (app == PEAK) return "3527290 (PEAK)";
            return app.ToString();
        }

        /// <summary>
        /// Les amis Steam, l'app sous laquelle chacun joue, et le lobby qu'il
        /// publie. L'API amis est liée au compte, pas à l'application : elle
        /// répond normalement même quand la session tourne sous Spacewar.
        /// </summary>
        private void RefreshSteamFriends()
        {
            _friends.Clear();
            _status = "";
            try
            {
                if (!SteamAPI.IsSteamRunning()) { _status = "Steam n'est pas lancé."; return; }

                uint me = RunningAppId();
                int n = SteamFriends.GetFriendCount(EFriendFlags.k_EFriendFlagImmediate);

                // Tracé avant la boucle, et pas seulement après : un gel ici ne
                // laissait aucune trace, et c'est exactement ce qu'il fallait
                // pouvoir lire pour savoir si F7 s'est figé ou n'a rien trouvé.
                float started = Time.realtimeSinceStartup;
                Logger.LogInfo("Rafraîchissement : " + n + " contacts, app " + me);

                for (int i = 0; i < n; i++)
                {
                    CSteamID id = SteamFriends.GetFriendByIndex(i, EFriendFlags.k_EFriendFlagImmediate);
                    FriendGameInfo_t info;
                    bool playing = SteamFriends.GetFriendGamePlayed(id, out info);
                    uint app = playing ? info.m_gameID.AppID().m_AppId : 0u;
                    _friends.Add(new FriendEntry
                    {
                        SteamId = id.m_SteamID.ToString(),
                        Name = SteamFriends.GetFriendPersonaName(id),
                        AppId = app,
                        SameApp = playing && app == me,
                        Lobby = info.m_steamIDLobby.m_SteamID,
                    });
                    // Une seule demande, et seulement pour ceux qu'on pourrait
                    // rejoindre : la liste d'amis entière n'a pas à partir en
                    // requêtes réseau à chaque F7.
                    if (app == PEAK || app == SPACEWAR)
                    {
                        FriendEntry added = _friends[_friends.Count - 1];
                        ReadRichPresence(added);
                        RequestRichPresence(added);
                        Logger.LogInfo("  en jeu : " + added.Name + " app=" + added.AppId
                            + " lobby=" + added.Lobby + " état=" + (added.State ?? "—")
                            + " room=" + (added.RichRoom ?? "—"));
                    }
                }
                _friends.Sort((a, b) =>
                {
                    int ra = Rank(a), rb = Rank(b);
                    return ra != rb ? ra - rb
                        : string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase);
                });
                _status = _friends.Count + " contacts. Nous sommes sous " + AppLabel(me) + ".";
                Logger.LogInfo("Rafraîchissement terminé en "
                    + Mathf.RoundToInt((Time.realtimeSinceStartup - started) * 1000f) + " ms.");
            }
            catch (Exception e)
            {
                _status = "Steam : " + e.Message;
                Logger.LogError("Rafraîchissement interrompu : " + e);
            }
        }

        /// <summary>
        /// Demander à Steam la rich presence d'un ami, et lire ce qui est déjà là.
        ///
        /// C'est la réponse à « peut-on savoir soi-même où il est ». PEAK publie
        /// sa room Photon dans sa propre rich presence : SteamRichPresence::SetState
        /// fait, dès qu'il est dans une room et pas en hors-ligne,
        ///
        ///     SteamFriends.SetRichPresence("steam_player_group", PhotonNetwork.CurrentRoom.Name);
        ///
        /// Cette valeur voyage par les serveurs Steam, comme la ligne « en jeu »
        /// de la liste d'amis. On peut donc lire son nom de room sans rien
        /// demander à Photon — et surtout sans dépendre de son UserId : que le
        /// sien soit son SteamID64 ou le GUID de repli de GetBestUserID ne change
        /// rien, on ne le cherche plus, on lit ce qu'il publie.
        ///
        /// Lire seulement, jamais demander : voir RequestRichPresence pour la
        /// raison, elle n'est pas anodine.
        /// </summary>
        private static void ReadRichPresence(FriendEntry f)
        {
            try
            {
                CSteamID id = new CSteamID(ulong.Parse(f.SteamId));

                string room = SteamFriends.GetFriendRichPresence(id, "steam_player_group");
                f.RichRoom = string.IsNullOrEmpty(room) ? null : room;

                // steam_display vaut "#" + RichPresenceState : Status_MainMenu,
                // Status_Airport, puis Status_Shore, Status_Tropics… au fur et à
                // mesure de l'ascension. C'est ce qui nous dit si la scène est
                // encore celle qu'on sait charger.
                string display = SteamFriends.GetFriendRichPresence(id, "steam_display");
                f.State = string.IsNullOrEmpty(display) ? null : display.TrimStart('#');

                int n = SteamFriends.GetFriendRichPresenceKeyCount(id);
                if (n <= 0) { f.Keys = null; return; }
                var sb = new System.Text.StringBuilder();
                for (int i = 0; i < n; i++)
                {
                    string k = SteamFriends.GetFriendRichPresenceKeyByIndex(id, i);
                    if (i > 0) sb.Append("  ");
                    sb.Append(k).Append('=').Append(SteamFriends.GetFriendRichPresence(id, k));
                }
                f.Keys = sb.ToString();
            }
            catch (Exception e) { f.Keys = "erreur : " + e.Message; }
        }

        /// <summary>
        /// Réclamer à Steam la rich presence d'un ami qui joue à une autre
        /// application que la nôtre. Sa réponse arrive en
        /// FriendRichPresenceUpdate_t.
        ///
        /// Séparé de la lecture, et ce n'est pas une coquetterie : appeler ceci
        /// depuis le gestionnaire de FriendRichPresenceUpdate_t crée une boucle
        /// sans fin — la demande provoque la réponse, qui provoque la demande —
        /// et le jeu se fige. C'est exactement le gel au F7 de la 0.5.0.
        /// Une demande par rafraîchissement, jamais depuis un callback.
        /// </summary>
        private static void RequestRichPresence(FriendEntry f)
        {
            try { SteamFriends.RequestFriendRichPresence(new CSteamID(ulong.Parse(f.SteamId))); }
            catch { /* sans réponse on garde ce qui est en cache */ }
        }

        private void OnRichPresence(FriendRichPresenceUpdate_t e)
        {
            FriendEntry f = _friends.Find(x => x.SteamId == e.m_steamIDFriend.m_SteamID.ToString());
            if (f == null) return;
            ReadRichPresence(f);   // lecture seule : surtout pas de nouvelle demande ici
            if (!string.IsNullOrEmpty(f.RichRoom))
                Logger.LogInfo("Rich presence de " + f.Name + " → room " + f.RichRoom
                    + "   [" + (f.Keys ?? "") + "]");
        }

        /// <summary>
        /// Relire l'état Steam d'un seul ami, à l'instant.
        ///
        /// Un identifiant de lobby vieillit vite : entre deux essais, celui de
        /// l'hôte avait déjà changé (…012128 puis …544263), et c'est pour ça que
        /// Steam répondait « Failed to fetch lobby data » — on lui réclamait un
        /// lobby détruit. Toute tentative de join relit donc d'abord.
        /// </summary>
        private void RefreshOne(FriendEntry f)
        {
            try
            {
                CSteamID id = new CSteamID(ulong.Parse(f.SteamId));
                FriendGameInfo_t info;
                bool playing = SteamFriends.GetFriendGamePlayed(id, out info);
                f.AppId = playing ? info.m_gameID.AppID().m_AppId : 0u;
                f.SameApp = playing && f.AppId == RunningAppId();
                f.Lobby = info.m_steamIDLobby.m_SteamID;
                ReadRichPresence(f);
                Logger.LogInfo("Relecture de " + f.Name + " : app=" + f.AppId + " lobby=" + f.Lobby
                    + " état=" + (f.State ?? "—") + " room=" + (f.RichRoom ?? "—"));
            }
            catch (Exception e) { Logger.LogWarning("Relecture impossible : " + e.Message); }
        }

        /// <summary>
        /// Capter l'invitation Steam au moment où elle arrive.
        ///
        /// PEAK la traite déjà (SteamLobbyHandler::CheckForSteamInviteAndConnect),
        /// mais si son TryJoinLobby échoue le identifiant est perdu. Le garder
        /// permet de réessayer, et surtout de le lire : c'est la donnée la plus
        /// fraîche qu'on puisse avoir sur le lobby de l'hôte.
        /// </summary>
        private void OnInvite(GameLobbyJoinRequested_t e)
        {
            _invitedLobby = e.m_steamIDLobby.m_SteamID;
            _invitedBy = e.m_steamIDFriend.m_SteamID.ToString();
            Logger.LogInfo("Invitation reçue : lobby " + _invitedLobby + " de " + _invitedBy);
        }

        /// <summary>
        /// La réponse de Steam à une entrée de lobby, mot pour mot.
        ///
        /// PEAK a son propre gestionnaire, qui se contente de ranger le résultat.
        /// Celui-ci existe pour lire le code de refus : c'est la seule façon de
        /// savoir si Steam interdit vraiment un lobby d'une autre application, ou
        /// s'il refusait pour une autre raison. Les deux gestionnaires reçoivent
        /// l'événement — Steamworks.NET tient une liste par type de callback.
        /// </summary>
        private void OnLobbyEnter(LobbyEnter_t e)
        {
            _status = "Réponse de Steam au lobby " + e.m_ulSteamIDLobby + " : "
                    + EnterResponse(e.m_EChatRoomEnterResponse);
            Logger.LogInfo(_status + " (locked=" + e.m_bLocked + ")");
        }

        /// <summary>
        /// Sonder le lobby d'un ami sans chercher à y entrer.
        ///
        /// JoinLobby et RequestLobbyData sont deux opérations distinctes, et
        /// c'est la seconde que PEAK utilise en recevant une invitation
        /// (SteamLobbyAPI::ConsumePendingJoin). Un « ce lobby n'existe pas » au
        /// join ne dit pas si le lobby est invisible ou seulement fermé : cette
        /// requête-ci répond à la question, et si elle aboutit elle rend en prime
        /// PhotonRegion et CurrentScene — la scène qui nous manque pour rejoindre
        /// une partie déjà commencée.
        /// </summary>
        private void ProbeLobby(FriendEntry f)
        {
            ulong lobby = (_invitedLobby != 0UL && _invitedBy == f.SteamId) ? _invitedLobby : f.Lobby;
            if (lobby == 0UL) { _status = f.Name + " ne publie aucun lobby à sonder."; return; }
            _probed = lobby;
            bool sent = SteamMatchmaking.RequestLobbyData(new CSteamID(lobby));
            _status = "Sonde envoyée sur le lobby " + lobby + (sent ? "" : " — Steam a refusé la requête");
            Logger.LogInfo("RequestLobbyData(" + lobby + ") renvoie " + sent + " (app de " + f.Name + " : " + f.AppId
                + ", nous " + RunningAppId() + ")");
        }

        /// <summary>
        /// La réponse à la sonde. Les clés livrées sont ce que l'hôte a publié :
        /// PhotonRegion, CurrentScene, PeakVersion… c'est-à-dire tout ce dont on
        /// a besoin pour rejoindre correctement.
        /// </summary>
        private void OnLobbyData(LobbyDataUpdate_t e)
        {
            if (_probed != 0UL && e.m_ulSteamIDLobby != _probed) return;
            var id = new CSteamID(e.m_ulSteamIDLobby);
            if (e.m_bSuccess == 0)
            {
                _status = "Lobby " + e.m_ulSteamIDLobby + " : Steam n'a pas pu livrer ses données "
                        + "(il est hors de notre application, ou il n'existe plus).";
                Logger.LogInfo(_status);
                return;
            }
            int n = SteamMatchmaking.GetLobbyDataCount(id);
            var sb = new System.Text.StringBuilder();
            for (int i = 0; i < n; i++)
            {
                string k, v;
                if (SteamMatchmaking.GetLobbyDataByIndex(id, i, out k, 255, out v, 8192))
                    sb.Append(k).Append('=').Append(v).Append("  ");
            }
            _probedData = sb.ToString();
            _status = "Lobby " + e.m_ulSteamIDLobby + " LISIBLE — " + n + " clés : " + _probedData;
            Logger.LogInfo(_status);
        }

        /// <summary>EChatRoomEnterResponse, en clair.</summary>
        private static string EnterResponse(uint code)
        {
            switch (code)
            {
                case 1: return "1 Succès — tu es dans le lobby";
                case 2: return "2 Ce lobby n'existe pas";
                case 3: return "3 Non autorisé (c'est le refus attendu entre applications)";
                case 4: return "4 Lobby plein";
                case 5: return "5 Erreur";
                case 6: return "6 Banni";
                case 7: return "7 Compte limité";
                case 10: return "10 Un membre t'a bloqué";
                case 11: return "11 Tu as bloqué un membre";
                case 15: return "15 Trop de tentatives, ralentis";
                default: return code + " (code inattendu)";
            }
        }

        /// <summary>
        /// Entrer dans un lobby sans passer par le filtre de PEAK.
        ///
        /// TryJoinLobby commence par RequestLobbyData, et abandonne si Steam ne
        /// livre pas les métadonnées — c'est là que ça calait pour un lobby
        /// d'une autre application. Mais RequestLobbyData et JoinLobby sont deux
        /// opérations distinctes : rien ne prouve que la seconde soit refusée
        /// parce que la première l'a été. C'est la dernière porte non essayée,
        /// et si elle s'ouvre tout le reste suit — devenir membre du lobby fait
        /// répondre oui à PlayerIsInLobby chez l'hôte, et le SteamLobbyHandler du
        /// jeu prend le relais tout seul dans OnLobbyEnter.
        /// </summary>
        private void JoinLobbyDirect(FriendEntry f)
        {
            if (PhotonNetwork.InRoom && !PhotonNetwork.OfflineMode)
            {
                _status = "Tu es déjà dans une partie — quitte-la d'abord.";
                return;
            }
            try
            {
                Logger.LogInfo("JoinLobby direct : " + f.Lobby + " (" + f.Name
                    + ", app " + f.AppId + " ; nous " + RunningAppId() + ")");
                SteamMatchmaking.JoinLobby(new CSteamID(f.Lobby));
                _status = "Entrée demandée dans le lobby de " + f.Name + "… réponse dans un instant.";
            }
            catch (Exception e)
            {
                _status = "JoinLobby a échoué : " + e.Message;
                Logger.LogError(_status);
            }
        }

        private static int Rank(FriendEntry f)
        {
            if (!string.IsNullOrEmpty(f.BestRoom)) return 0;          // on sait où il est
            if (f.SameApp && f.Lobby != 0UL) return 1;                // joignable par le lobby
            if (f.AppId == PEAK || f.AppId == SPACEWAR) return 2;     // joue à PEAK, sous une app ou l'autre
            return f.AppId != 0 ? 3 : 4;
        }

        /// <summary>
        /// Entrer par le lobby Steam — la voie propre, quand elle est ouverte.
        ///
        /// TryJoinLobby est ce que PEAK appelle en recevant une invitation :
        /// RequestLobbyData, comparaison de PeakVersion, puis JoinLobby. Ensuite
        /// OnLobbyEnter lit PhotonRegion et CurrentScene dans les données du
        /// lobby, réclame le nom de la room par le chat du lobby, remplit
        /// JoinSpecificRoomState et charge la scène.
        /// </summary>
        private void JoinSteamLobby(FriendEntry f)
        {
            if (f.Lobby == 0UL)
            {
                _status = f.Name + " ne publie aucun lobby joignable — son lobby est en "
                        + "« Invite Only », le défaut de PEAK. Essaie « Rejoindre » ci-contre.";
                return;
            }
            if (PhotonNetwork.InRoom && !PhotonNetwork.OfflineMode)
            {
                _status = "Tu es déjà dans une partie — quitte-la d'abord.";
                return;
            }
            try
            {
                SteamLobbyHandler handler = GameHandler.GetService<SteamLobbyHandler>();
                if (handler == null) { _status = "SteamLobbyHandler introuvable."; return; }
                Logger.LogInfo("TryJoinLobby " + f.Lobby + " (" + f.Name + ")");
                handler.TryJoinLobby(new CSteamID(f.Lobby));
                _status = "Entrée dans le lobby de " + f.Name + "… le jeu prend le relais.";
                _open = false;
            }
            catch (Exception e)
            {
                _status = "TryJoinLobby a échoué : " + e.Message;
                Logger.LogError(_status + " | " + e);
            }
        }

        // ── Photon ───────────────────────────────────────────────────────────

        /// <summary>Le UserId que ce client a présenté à Photon.</summary>
        private static string LocalUserId()
        {
            try
            {
                if (PhotonNetwork.AuthValues != null && !string.IsNullOrEmpty(PhotonNetwork.AuthValues.UserId))
                    return PhotonNetwork.AuthValues.UserId;
                if (PhotonNetwork.LocalPlayer != null) return PhotonNetwork.LocalPlayer.UserId;
            }
            catch { }
            return null;
        }

        /// <summary>Le SteamID64 du compte connecté, tel que le jeu le lirait.</summary>
        private static string LocalSteamId()
        {
            try
            {
                if (!SteamAPI.IsSteamRunning() || !SteamUser.BLoggedOn()) return null;
                return SteamUser.GetSteamID().m_SteamID.ToString();
            }
            catch { return null; }
        }

        /// <summary>
        /// Se réauthentifier auprès de Photon sous un autre identifiant.
        ///
        /// Le UserId est fixé à la connexion : il faut donc couper et refaire,
        /// en repassant par ConnectToNetwork pour que le jeu reconstruise
        /// lui-même ses réglages (version, région, pseudo). Le patch de
        /// LoadUserID glisse l'identifiant voulu au passage.
        /// </summary>
        private IEnumerator Reauthenticate(string userId)
        {
            _presentedId = userId;
            _reauthenticating = true;
            try
            {
                Logger.LogInfo("Réauthentification sous « " + (userId ?? "notre identifiant") + " » ; état "
                    + PhotonNetwork.NetworkClientState);

                PhotonNetwork.Disconnect();
                float t = 0f;
                while (PhotonNetwork.IsConnected && t < 10f) { t += Time.unscaledDeltaTime; yield return null; }
                if (PhotonNetwork.IsConnected)
                {
                    Logger.LogWarning("Photon ne se coupe pas (" + PhotonNetwork.NetworkClientState + ").");
                    yield break;
                }

                // Le jeu se reconnecte parfois de lui-même ; ne pas lui marcher dessus.
                if (!Peak.Network.NetworkingUtilities.ConnectToNetwork())
                    Logger.LogWarning("ConnectToNetwork a refusé (" + PhotonNetwork.NetworkClientState + ").");

                t = 0f;
                while (!PhotonNetwork.IsConnectedAndReady && t < 25f) { t += Time.unscaledDeltaTime; yield return null; }
                Logger.LogInfo("Réauthentification terminée : état " + PhotonNetwork.NetworkClientState
                    + ", région " + (PhotonNetwork.CloudRegion ?? "?")
                    + ", identifiant " + (LocalUserId() ?? "—"));
            }
            finally { _reauthenticating = false; }
        }

        /// <summary>
        /// Rejoindre, en préférant le lobby Steam et en refusant l'impasse.
        ///
        /// L'emprunt de l'identifiant de l'hôte est mort, et le serveur Photon
        /// l'a dit sans ambiguïté :
        ///
        ///     Failed to join Photon Room, code: 32746, message: Join failed:
        ///     UserId '…' already joined the specified game (JoinMode=0).
        ///
        /// 32746 est ErrorCode.JoinFailedFoundActiveJoiner. Photon impose
        /// l'unicité du UserId parmi les acteurs actifs d'une room, et cela ne
        /// dépend pas de CheckUserOnJoin — c'était la mauvaise porte. Or l'hôte
        /// est par définition dans sa propre room : son identifiant est donc
        /// toujours déjà pris. Aucun ordre d'appel n'y change quelque chose.
        ///
        /// Il faudrait un SteamID à la fois membre de son lobby et absent de sa
        /// room. Chez un hôte seul, cet ensemble est vide.
        ///
        /// Reste le lobby Steam, la voie propre — et le log montre qu'elle n'est
        /// pas fermée : son invitation est bien arrivée dans notre session 480,
        /// donc son lobby est dans notre application. Elle a échoué sur un lobby
        /// périmé (« Failed to fetch lobby data », son identifiant avait changé
        /// entre deux essais). D'où cette règle : relire son lobby au moment du
        /// clic, jamais s'appuyer sur une valeur qui a vieilli.
        /// </summary>
        private IEnumerator JoinRoutine(FriendEntry f)
        {
            _busy = true;
            try
            {
                if (PhotonNetwork.OfflineMode)
                {
                    _status = "Tu es en mode hors-ligne. Reviens au menu et choisis le mode en ligne.";
                    yield break;
                }
                if (PhotonNetwork.InRoom)
                {
                    _status = "Tu es déjà dans une partie — quitte-la d'abord.";
                    yield break;
                }

                // 0. Le lobby d'abord, et relu à l'instant. C'est le seul chemin
                //    qui fait de nous un vrai membre, donc le seul que le contrôle
                //    de l'hôte accepte sans qu'on ait à mentir sur notre identité.
                RefreshOne(f);

                // Une invitation n'est pas qu'un message : pour un lobby « Invite
                // Only » — le défaut de PEAK — elle est ce qui nous y donne droit.
                // Composer un identifiant lu sur un profil et entrer sur
                // invitation sont deux gestes différents, et Steam ne les traite
                // pas pareil. Cet identifiant-là passe donc avant, et sans
                // condition sur l'application : c'est le seul cas où l'hôte nous
                // a explicitement ouvert sa porte.
                if (_invitedLobby != 0UL && _invitedBy == f.SteamId)
                {
                    Logger.LogInfo("Lobby d'invitation pour " + f.Name + " : " + _invitedLobby
                        + " (relu par Steam : " + f.Lobby + ")");
                    f.Lobby = _invitedLobby;
                    JoinSteamLobby(f);
                    yield break;
                }
                if (f.Lobby != 0UL && f.SameApp)
                {
                    Logger.LogInfo("Lobby frais pour " + f.Name + " : " + f.Lobby);
                    JoinSteamLobby(f);
                    yield break;
                }
                // 1. Pas de lobby atteignable. Reste la room Photon — sous notre
                //    propre identité, cette fois. Photon, lui, ignore
                //    complètement l'AppID Steam : c'est prouvé, depuis une
                //    session 480 on a retrouvé un hôte sous 3527290 dans sa room
                //    (« IsOnline=True IsInRoom=True Room=1920dbd0-… »). Le seul
                //    obstacle était le contrôle de l'hôte, et c'est du code qui
                //    tourne chez lui : s'il a ce plugin, il ne kicke plus.
                // Piste A — l'asymétrie des deux comparaisons.
                //
                // Chez l'hôte, SteamLobbyAPI::PlayerIsInLobby fait
                // UInt64::TryParse(userId) puis compare des CSteamID : la
                // comparaison est NUMÉRIQUE, et TryParse accepte les zéros de
                // tête comme des chiffres ordinaires. « 076561… » vaut donc
                // 76561… et l'hôte se reconnaît lui-même dans son propre lobby :
                // le portillon répond oui, le kick n'est jamais levé.
                //
                // Chez Photon, l'unicité imposée par CheckUserOnJoin — que PUN
                // active sans condition dans RoomOptionsToOpParameters — compare
                // des CHAÎNES. « 076561… » n'est pas « 76561… », donc pas de
                // 32746, contrairement à l'identifiant nu essayé auparavant.
                //
                // Une seule inconnue demeure, et elle n'est pas lisible d'ici :
                // si le comparateur du Photon Cloud normalise le nombre, le
                // 32746 réapparaîtra et il faudra essayer « 00 ».
                string forge = (_forgePrefix != null ? (_forgePrefix.Value ?? "") : "");
                string wanted = string.IsNullOrEmpty(forge) ? null : forge + f.SteamId;
                if (wanted != _presentedId)
                {
                    _status = wanted == null
                        ? "Retour à notre identifiant…"
                        : "Présentation de l'identifiant « " + wanted + " »…";
                    yield return Reauthenticate(wanted);
                }

                float t = 0f;
                while (!PhotonNetwork.IsConnectedAndReady && t < 20f) { t += Time.unscaledDeltaTime; yield return null; }
                if (!PhotonNetwork.IsConnectedAndReady)
                {
                    _status = "Photon n'est pas prêt (" + PhotonNetwork.NetworkClientState + ").";
                    yield break;
                }

                _foundRoom = null;
                _status = "Recherche de " + f.Name + " sur Photon…";
                if (!PhotonNetwork.FindFriends(new[] { f.SteamId }))
                {
                    _status = "Photon a refusé la requête — voir le log.";
                    yield break;
                }
                t = 0f;
                while (_foundRoom == null && t < 10f) { t += Time.unscaledDeltaTime; yield return null; }

                if (string.IsNullOrEmpty(_foundRoom))
                {
                    _status = "Photon ne trouve pas " + f.Name + " sur " + (PhotonNetwork.CloudRegion ?? "?")
                            + " : il est au menu, en hors-ligne, ou sur une autre région.";
                    Logger.LogInfo(_status);
                    yield break;
                }

                // Charger « Airport » alors qu'il est ailleurs mettrait le client
                // dans le mauvais décor : seul le lobby Steam transporte le nom
                // de la scène, et on ne l'a pas.
                if (!f.InAirport)
                {
                    _status = f.Name + " a quitté l'aéroport (" + f.State + ") — on ne sait charger "
                            + "que « Airport ». Attends qu'il relance une partie.";
                    Logger.LogInfo(_status);
                    yield break;
                }

                string region = string.IsNullOrEmpty(_region) ? PhotonNetwork.CloudRegion : _region.Trim();
                Logger.LogInfo("Room trouvée : " + _foundRoom + " (région " + region
                    + ") — entrée sous notre propre identifiant " + (LocalUserId() ?? "—"));
                _status = "Entrée dans " + _foundRoom + "… s'il n'a pas le plugin, il te kickera.";
                Join(_foundRoom, region);

                // Vingt secondes d'observation, parce que le transport est UDP :
                // un serveur qui cesse de répondre ne se signale pas tout de
                // suite, il expire vers dix secondes. Et le vrai juge n'est pas
                // l'état local — c'est l'arrivée d'un personnage, que l'hôte
                // envoie de lui-même toutes les deux secondes à qui n'en a pas.
                float obs = 0f, next = 0f;
                while (obs < 20f)
                {
                    obs += Time.unscaledDeltaTime;
                    if (obs >= next)
                    {
                        next += 1f;
                        int chars = 0;
                        try { chars = PlayerHandler.GetAllPlayerCharacters().Count; } catch { }
                        Logger.LogInfo("t=" + Mathf.RoundToInt(obs)
                            + "s état=" + PhotonNetwork.NetworkClientState
                            + " joueurs=" + (PhotonNetwork.CurrentRoom != null
                                ? PhotonNetwork.CurrentRoom.PlayerCount.ToString() : "—")
                            + " personnages=" + chars
                            + " identifiant=" + (LocalUserId() ?? "—"));
                    }
                    yield return null;
                }
                yield break;

            }
            finally { _busy = false; }
        }

        public void OnFriendListUpdate(List<FriendInfo> list)
        {
            if (list == null) return;
            foreach (FriendInfo f in list)
            {
                FriendEntry e = _friends.Find(x => x.SteamId == f.UserId);
                if (e != null) { e.Searched = true; e.Room = f.IsInRoom ? f.Room : null; }
                Logger.LogInfo("FindFriends → UserId=" + f.UserId + " IsOnline=" + f.IsOnline
                    + " IsInRoom=" + f.IsInRoom + " Room=" + (f.Room ?? "(aucune)")
                    + " région=" + (PhotonNetwork.CloudRegion ?? "?"));
                if (f.IsInRoom && !string.IsNullOrEmpty(f.Room)) _foundRoom = f.Room;
                // Trois réponses très différentes, à ne pas confondre : absent de
                // Photon, présent mais au menu, présent et dans une room.
                if (!_busy)
                    _status = f.UserId + " → " + (f.IsInRoom && !string.IsNullOrEmpty(f.Room)
                        ? "dans la room " + f.Room
                        : f.IsOnline ? "connecté à Photon, mais au menu"
                                     : "inconnu de Photon sur " + (PhotonNetwork.CloudRegion ?? "?"));
            }
        }

        /// <summary>
        /// Entrer dans la room par le chemin du jeu, pas par-dessus lui.
        ///
        /// Copié sur SteamLobbyHandler::HandleMessage, ce que PEAK fait en
        /// recevant le nom de room par le chat du lobby : remplir l'état, puis
        /// charger la scène. Le reste — connexion à la région, JoinRoom, spawn,
        /// synchronisation — appartient à NetworkConnector et se déroule seul.
        ///
        /// "Airport" est le repli du jeu lui-même quand l'hôte ne précise pas de
        /// scène ; une partie déjà lancée en demanderait une autre, que seul le
        /// lobby Steam transporte.
        /// </summary>
        private void Join(string room, string region)
        {
            try
            {
                var machine = GameHandler.GetService<ConnectionService>().StateMachine;
                var state = machine.SwitchState<JoinSpecificRoomState>(false);
                state.RoomName = room;
                state.RegionToJoin = region;

                var screen = LoadingScreenHandler.Instance;
                screen.Load(LoadingScreen.LoadingScreenType.Basic, null,
                    new IEnumerator[] { screen.LoadSceneProcess("Airport", false, true, 3f) });

                Logger.LogInfo("Join : room=" + room + " region=" + region + " scene=Airport"
                    + " userId=" + (LocalUserId() ?? "—"));
                _status = "Chargement vers " + room + "…";
                _open = false;
            }
            catch (Exception e)
            {
                _status = "Échec du join : " + e.Message;
                Logger.LogError(_status + " | " + e);
            }
        }

        public void OnJoinedRoom() { _status = "Dans la partie."; _open = false; }
        /// <summary>
        /// 32746 mérite son propre message : c'est la réponse qui a condamné
        /// l'emprunt d'identité, et elle est facile à lire de travers.
        /// </summary>
        public void OnJoinRoomFailed(short code, string msg)
        {
            _status = code == 32746
                ? "Photon refuse : cet identifiant est déjà celui d'un joueur actif de la room "
                  + "(JoinFailedFoundActiveJoiner). L'emprunt est impossible, il faut le lobby Steam."
                : "Échec (" + code + ") : " + msg;
            Logger.LogWarning("OnJoinRoomFailed " + code + " : " + msg);
            // Ne pas rester authentifié sous l'identifiant de quelqu'un d'autre.
            if (!string.IsNullOrEmpty(_presentedId)) StartCoroutine(Reauthenticate(null));
        }
        public void OnJoinRandomFailed(short code, string msg) { }
        public void OnCreatedRoom() { }
        public void OnCreateRoomFailed(short code, string msg) { }
        public void OnLeftRoom() { }
        public void OnJoinedLobby() { }
        public void OnLeftLobby() { }
        public void OnRoomListUpdate(List<RoomInfo> l) { }
        public void OnLobbyStatisticsUpdate(List<TypedLobbyInfo> l) { }

        // ── Fenêtre ──────────────────────────────────────────────────────────

        private void OnGUI()
        {
            if (!_open) return;
            _win = GUILayout.Window(GUID.GetHashCode(), _win, DrawWindow, "Rejoindre un ami");
        }

        private static bool InSteamLobby()
        {
            try
            {
                SteamLobbyHandler h = GameHandler.GetService<SteamLobbyHandler>();
                return h != null && h.InSteamLobby();
            }
            catch { return false; }
        }

        private void DrawWindow(int id)
        {
            uint me = RunningAppId();
            GUILayout.Label("App : " + AppLabel(me)
                + "    Lobby Steam : " + (InSteamLobby() ? "oui" : "non")
                + "    Photon : " + PhotonNetwork.NetworkClientState
                + " / région " + (string.IsNullOrEmpty(PhotonNetwork.CloudRegion) ? "?" : PhotonNetwork.CloudRegion)
                + (PhotonNetwork.OfflineMode ? "  [HORS-LIGNE]" : "")
                + (PhotonNetwork.InRoom ? "  [dans une room]" : "  [au menu]"));

            string presented = LocalUserId();
            string real = LocalSteamId();
            bool spoofed = !string.IsNullOrEmpty(_presentedId);
            GUILayout.Label("Identifiant présenté : " + (presented ?? "—")
                + (spoofed ? "   ← emprunté (le tien : " + (real ?? "—") + ")" : "   (le tien)"));

            GUILayout.Space(6);
            GUILayout.BeginHorizontal();
            if (GUILayout.Button("Rafraîchir", GUILayout.Width(120))) RefreshSteamFriends();
            if (spoofed && GUILayout.Button("Reprendre mon identité", GUILayout.Width(190)))
                StartCoroutine(Reauthenticate(null));
            // Le lobby de la dernière invitation reçue : la donnée la plus fraîche
            // qu'on ait, et celle que PEAK jette quand son propre essai échoue.
            if (_invitedLobby != 0UL && GUILayout.Button("Invitation (" + _invitedLobby + ")",
                    GUILayout.Width(210)))
                JoinSteamLobby(new FriendEntry
                {
                    Name = "l'invitation de " + (_invitedBy ?? "?"),
                    Lobby = _invitedLobby,
                    SameApp = true,
                });
            GUILayout.Label("Région :", GUILayout.Width(55));
            _region = GUILayout.TextField(_region ?? "", GUILayout.Width(45));
            GUILayout.Label("ID :", GUILayout.Width(30));
            _manualId = GUILayout.TextField(_manualId ?? "", GUILayout.Width(150));
            if (GUILayout.Button("Lobby", GUILayout.Width(60)))
            {
                ulong entered;
                if (!ulong.TryParse((_manualId ?? "").Trim(), out entered))
                    _status = "Ce n'est pas un identifiant Steam.";
                else if (AccountType(entered) == ACCOUNT_INDIVIDUAL)
                    // La confusion est trop facile pour la laisser passer : un
                    // SteamID64 se parse comme un ulong, PEAK demande alors les
                    // données d'un lobby qui n'existe pas, et OnLobbyDataUpdate
                    // revient en échec avec sa modale.
                    _status = "C'est le SteamID d'un joueur, pas un lobby. Pour un joueur, "
                            + "utilise « Sonder » ou le bouton « Rejoindre » de sa ligne.";
                else if (AccountType(entered) != ACCOUNT_CHAT)
                    _status = "Cet identifiant n'est ni un joueur ni un lobby (type "
                            + AccountType(entered) + ").";
                else
                    JoinSteamLobby(new FriendEntry { Name = "ce lobby", Lobby = entered, SameApp = true });
            }
            // Savoir si Photon voit quelqu'un, sans rien tenter : le test le plus
            // court quand un ami « en jeu » revient introuvable.
            if (GUILayout.Button("Sonder", GUILayout.Width(70)))
            {
                string probe = (_manualId ?? "").Trim();
                _foundRoom = null;
                if (!PhotonNetwork.IsConnectedAndReady)
                    _status = "Photon n'est pas prêt (" + PhotonNetwork.NetworkClientState + ").";
                else if (probe == LocalUserId())
                    _status = "Photon retire ton propre identifiant de la requête — cherche quelqu'un d'autre.";
                else if (!PhotonNetwork.FindFriends(new[] { probe }))
                    _status = "Photon a refusé la requête.";
                else
                    _status = "Sondage de " + probe + " sur " + (PhotonNetwork.CloudRegion ?? "?")
                            + "… réponse dans le log.";
            }
            GUILayout.EndHorizontal();

            GUILayout.Space(6);
            _scroll = GUILayout.BeginScrollView(_scroll, GUILayout.Height(260));
            foreach (FriendEntry f in _friends)
            {
                bool plays = f.AppId == PEAK || f.AppId == SPACEWAR;
                bool known = !string.IsNullOrEmpty(f.BestRoom);
                GUILayout.BeginHorizontal();
                GUILayout.Label((known ? "▶ " : plays ? "· " : "   ") + f.Name, GUILayout.Width(160));
                GUILayout.Label(AppLabel(f.AppId), GUILayout.Width(105));
                // Où il en est, d'après steam_display. « Airport » est le seul
                // endroit où ce chemin sait arriver.
                GUILayout.Label(string.IsNullOrEmpty(f.State) ? "" : f.State.Replace("Status_", ""),
                    GUILayout.Width(75));

                // Même application : le chemin du jeu, avec sa vérification de
                // version. Application différente : l'appel direct, qui saute le
                // RequestLobbyData sur lequel PEAK abandonne. « Lobby ! » signale
                // qu'on sort du cadre prévu.
                // Les deux, toujours, dès qu'un lobby existe. Faire dépendre le
                // choix de notre propre AppID a déjà masqué l'appel direct une
                // fois : autant ne plus rien décider à la place de l'essai.
                GUI.enabled = !_busy && f.Lobby != 0UL;
                if (GUILayout.Button("Lobby", GUILayout.Width(60))) JoinSteamLobby(f);
                if (GUILayout.Button("direct", GUILayout.Width(60))) JoinLobbyDirect(f);
                // Lire son lobby sans y entrer : RequestLobbyData n'est pas
                // JoinLobby, et un « n'existe pas » à l'un ne dit rien de l'autre.
                if (GUILayout.Button("lire", GUILayout.Width(50))) ProbeLobby(f);

                // « Rejoindre » ne l'est pas : l'AppID ne sert qu'à trier la liste.
                // Seul l'aéroport le grise, faute de savoir charger la bonne scène.
                GUI.enabled = !_busy && f.InAirport;
                if (GUILayout.Button("Rejoindre", GUILayout.Width(100))) StartCoroutine(JoinRoutine(f));
                GUI.enabled = true;

                // D'où vient l'information compte autant qu'elle : « steam » veut
                // dire qu'on n'a eu besoin de rien lui demander.
                GUILayout.Label(known
                        ? (string.IsNullOrEmpty(f.RichRoom) ? "photon: " : "steam: ")
                          + f.BestRoom.Substring(0, Math.Min(13, f.BestRoom.Length))
                        : f.Searched ? "au menu" : "",
                    GUILayout.Width(150));
                GUILayout.EndHorizontal();
            }
            GUILayout.EndScrollView();

            GUILayout.Space(4);
            GUILayout.Label(_status);
            GUILayout.Label("« Lobby » quand vous êtes sous le même AppID et qu'il publie son lobby. "
                + "« Rejoindre » sinon : sa room est lue dans sa rich presence Steam, "
                + "Photon n'est qu'un repli. La région ne voyage pas — force-la si le join échoue.");
            GUI.DragWindow();
        }
    }
}
