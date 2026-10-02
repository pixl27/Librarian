using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using BepInEx;
using BepInEx.Configuration;
using HarmonyLib;
using UnityEngine;

namespace PhotonJoin
{
    /// <summary>
    /// Le greffon générique : rejoindre un ami dans n'importe quel jeu Unity
    /// bâti sur Photon PUN.
    ///
    /// Tout ce qui touche à Photon passe par PhotonBinding, qui découvre les
    /// types à l'exécution ; tout ce qui est propre à un jeu vient d'un profil
    /// JSON posé à côté du greffon. Cette classe ne fait que trois choses que
    /// les autres ne peuvent pas faire : elle vit dans Unity, elle pose les
    /// correctifs Harmony, et elle dessine la fenêtre.
    ///
    /// Un seul binaire sert donc tous les jeux. C'est vérifié sur le binaire
    /// livré : sa table de références ne contient aucune assemblée de jeu.
    /// </summary>
    [BepInPlugin(Guid, "PhotonJoin — rejoindre un ami (Unity/Photon)", Version)]
    public class Plugin : BaseUnityPlugin
    {
        public const string Guid = "com.librarian.photonjoin";
        public const string Version = "1.0.0";

        internal static Plugin Instance;
        internal static ManualLogSourceProxy Log;

        private static ConfigEntry<bool> _enabled;
        private static ConfigEntry<string> _hotkey;
        private static ConfigEntry<string> _profileId;
        private static ConfigEntry<bool> _verbose;
        private static ConfigEntry<bool> _openAtStart;

        private PhotonBinding _binding;
        private GameProfile _profile;
        private readonly Overlay _overlay = new Overlay();
        private Assembly[] _assemblies = new Assembly[0];
        private Coroutine _running;
        private string _appId = "";
        private string _product = "";
        private KeyCode _key = KeyCode.F7;
        private KeyCode _probeKey = KeyCode.F8;

        // Le bouclier est statique : le correctif Harmony n'a pas d'instance.
        private static GameProfile _shieldProfile;
        private static PhotonBinding _shieldBinding;

        private void Awake()
        {
            Instance = this;
            Log = new ManualLogSourceProxy(Logger);

            _enabled = Config.Bind("général", "actif", true, "Charger le moteur de jonction.");
            _hotkey = Config.Bind("général", "touche", "", "Touche d'ouverture. Vide : celle du profil.");
            _profileId = Config.Bind("général", "profil", "", "Forcer un profil par son identifiant. Vide : reconnaissance automatique.");
            _verbose = Config.Bind("général", "journal détaillé", false, "Écrire chaque étape dans le journal.");
            // Recours pour les jeux qui ne livrent pas InputLegacyModule : sans
            // entrée clavier héritée, la touche est inopérante et la fenêtre serait
            // autrement inatteignable.
            _openAtStart = Config.Bind("général", "ouvrir au démarrage", false,
                "Ouvrir la fenêtre dès le lancement, quand la touche ne fonctionne pas dans ce jeu.");

            if (!_enabled.Value) { Log.Info("Désactivé par la configuration."); return; }

            _assemblies = AppDomain.CurrentDomain.GetAssemblies();
            _binding = PhotonBinding.Bind(_assemblies);
            Log.Info(_binding.Diagnostic);

            ReadGameIdentity();
            _profile = ChooseProfile();
            Log.Info("Profil : " + _profile + "  (" + _profile.Source + ")");

            _key = ParseKey(string.IsNullOrEmpty(_hotkey.Value) ? _profile.Hotkey : _hotkey.Value, KeyCode.F7);

            _overlay.Title = "PhotonJoin — " + _profile.Name;
            _overlay.Bound = _binding.Bound;
            _overlay.Diagnostic = _binding.Diagnostic;
            _overlay.Source = SteamBridge.ResolveSource(_profile, _assemblies);
            _overlay.OnRefresh = RefreshRows;
            _overlay.OnProbe = WriteProbe;
            _overlay.OnJoin = StartJoin;
            _overlay.OnFirstDraw = s => Log.Info(s);
            _overlay.Open = _openAtStart.Value;

            if (_binding.Bound) ApplyShield();
            RefreshSubtitle();
        }

        private void OnDestroy()
        {
            try { new Harmony(Guid).UnpatchSelf(); } catch { }
        }

        // ---- Identité du jeu -------------------------------------------------

        /// <summary>
        /// L'AppID et le nom du produit, tels qu'on peut les connaître sans rien
        /// supposer du jeu : le fichier que Steam lit lui-même, et ce que le
        /// moteur déclare.
        /// </summary>
        private void ReadGameIdentity()
        {
            try { _product = Application.productName ?? ""; } catch { _product = ""; }

            try
            {
                var root = Directory.GetParent(Application.dataPath);
                if (root != null)
                {
                    var file = Path.Combine(root.FullName, "steam_appid.txt");
                    if (File.Exists(file)) _appId = (File.ReadAllText(file) ?? "").Trim();
                }
            }
            catch { }

            Log.Info("Jeu : " + (_product.Length == 0 ? "(nom inconnu)" : _product)
                   + (_appId.Length == 0 ? "" : "  AppID " + _appId));
        }

        private string PluginFolder
        {
            get
            {
                try { return Path.GetDirectoryName(Info.Location); }
                catch { return Paths.PluginPath; }
            }
        }

        private GameProfile ChooseProfile()
        {
            var dir = Path.Combine(PluginFolder ?? "", "profiles");
            var problems = new List<string>();
            var all = ProfileStore.LoadFolder(dir, problems);
            foreach (var p in problems) Log.Warning("Profil ignoré — " + p);

            if (!string.IsNullOrEmpty(_profileId.Value))
            {
                var forced = all.FirstOrDefault(p => p.Id == _profileId.Value);
                if (forced != null) { Log.Info("Profil forcé par la configuration."); return forced; }
                Log.Warning("Profil « " + _profileId.Value + " » demandé mais introuvable dans " + dir);
            }

            string note;
            var chosen = ProfileStore.Choose(all, _appId, _product, HasType, out note);
            Log.Info(note);
            return chosen;
        }

        private bool HasType(string fullName)
        {
            return Entry.FindType(_assemblies, fullName) != null;
        }

        // ---- Bouclier --------------------------------------------------------

        private void ApplyShield()
        {
            _shieldProfile = _profile;
            _shieldBinding = _binding;

            var harmony = new Harmony(Guid);

            if (_profile.ShieldDisconnectMessage)
            {
                var hook = Shield.ResolveDisconnectHook(_binding);
                if (hook == null) Log.Warning("La trame de coupure n'est pas interceptable dans ce jeu.");
                else
                {
                    try
                    {
                        harmony.Patch(hook, prefix: new HarmonyMethod(
                            typeof(Plugin).GetMethod(nameof(DisconnectMessagePrefix), BindingFlags.Static | BindingFlags.NonPublic)));
                        Log.Info("Bouclier posé sur " + hook.DeclaringType.Name + "." + hook.Name
                               + " (codes " + string.Join(", ", _profile.ShieldCodes.Select(c => c.ToString()).ToArray()) + ").");
                    }
                    catch (Exception e) { Log.Warning("Bouclier non posé : " + e.Message); }
                }
            }

            var unresolved = new List<string>();
            foreach (var m in Shield.ResolveKickRpcs(_profile, _assemblies, unresolved))
            {
                try
                {
                    harmony.Patch(m, prefix: new HarmonyMethod(
                        typeof(Plugin).GetMethod(nameof(KickPrefix), BindingFlags.Static | BindingFlags.NonPublic)));
                    Log.Info("Expulsion neutralisée : " + m.DeclaringType.Name + "." + m.Name);
                }
                catch (Exception e) { Log.Warning("Correctif refusé sur " + m.Name + " : " + e.Message); }
            }
            foreach (var u in unresolved) Log.Warning("Cible d'expulsion introuvable — " + u);
        }

        private static bool DisconnectMessagePrefix(object __0)
        {
            var code = Shield.ReadCode(_shieldBinding, __0);
            var swallow = Shield.ShouldSwallow(_shieldProfile, code);
            if (Log != null) Log.Info(Shield.Describe(_shieldBinding, __0, swallow));
            return !swallow;
        }

        private static bool KickPrefix()
        {
            if (Log != null) Log.Info("Demande d'expulsion ignorée.");
            return false;
        }

        // ---- Interface -------------------------------------------------------

        private void Update()
        {
            if (_binding == null) return;
            if (UnityInput.KeyDown(_key))
            {
                _overlay.Open = !_overlay.Open;
                if (_overlay.Open) { RefreshSubtitle(); RefreshRows(); }
            }
            if (UnityInput.KeyDown(_probeKey)) WriteProbe();
        }

        private void OnGUI()
        {
            if (_binding != null) _overlay.Draw();
        }

        private void RefreshSubtitle()
        {
            if (_binding == null) return;
            _overlay.Subtitle = _binding.Bound
                ? _binding.Flavour + " · " + _binding.ClientStateName()
                  + " · région " + Show(_binding.CurrentRegion())
                  + " · moi : " + Show(_binding.LocalUserId())
                : _binding.Diagnostic;
        }

        private static string Show(string s) { return string.IsNullOrEmpty(s) ? "—" : s; }

        /// <summary>
        /// Remplir la liste. Deux sources possibles : les amis Steam quand le
        /// jeu embarque Steamworks, sinon rien — et dans ce cas la saisie
        /// manuelle est le chemin normal, pas un pis-aller.
        /// </summary>
        private void RefreshRows()
        {
            _overlay.Rows.Clear();
            RefreshSubtitle();
            if (!_binding.Bound) return;

            if (_overlay.Source == "steam")
            {
                string error;
                foreach (var friend in SteamBridge.Friends(_assemblies, out error))
                {
                    _overlay.Rows.Add(new OverlayRow
                    {
                        Label = friend.Name,
                        UserId = friend.IdText,
                        NativeId = friend.IdText,
                        Detail = friend.Online ? "en ligne" : "hors ligne",
                    });
                }
                if (!string.IsNullOrEmpty(error)) _overlay.Status = error;
            }

            // Ce que Photon dit des amis déjà connus complète la liste : c'est
            // la seule information qui indique une partie en cours.
            foreach (var t in Discovery.All(_binding))
            {
                var row = _overlay.Rows.FirstOrDefault(r => r.UserId == t.UserId);
                if (row == null)
                {
                    row = new OverlayRow { Label = t.UserId, UserId = t.UserId, NativeId = t.UserId };
                    _overlay.Rows.Add(row);
                }
                row.Detail = t.Joinable ? "en partie : " + t.Room : (t.Online ? "en ligne" : "hors ligne");
            }
        }

        private void WriteProbe()
        {
            try
            {
                var report = Probe.Run(_binding, _assemblies, _appId, _product);
                var path = Path.Combine(PluginFolder ?? ".", "photonjoin-sonde.txt");
                File.WriteAllText(path, report.Text);
                Log.Info("Rapport de sonde écrit : " + path);
                Log.Info(report.Text);
                _overlay.Status = "Rapport écrit : " + path;
            }
            catch (Exception e)
            {
                _overlay.Status = "Rapport impossible : " + e.Message;
                Log.Warning(_overlay.Status);
            }
        }

        // ---- Jonction --------------------------------------------------------

        private bool StartJoin(OverlayRow row)
        {
            if (row == null || string.IsNullOrEmpty(row.UserId)) { _overlay.Status = "Aucun ami désigné."; return false; }
            if (_running != null) { _overlay.Status = "Une jonction est déjà en cours."; return false; }

            _overlay.Status = "Jonction vers " + row.Label + "…";
            _running = StartCoroutine(JoinRoutine(row));
            return true;
        }

        private IEnumerator JoinRoutine(OverlayRow row)
        {
            var pipeline = new JoinPipeline
            {
                Binding = _binding,
                Profile = _profile,
                Assemblies = _assemblies,
                FriendId = row.UserId,
                HostId = string.IsNullOrEmpty(row.NativeId) ? row.UserId : row.NativeId,
                Now = () => Time.realtimeSinceStartup,
                Trace = s =>
                {
                    _overlay.Status = s;
                    if (_verbose.Value) Log.Info(s);
                },
            };

            var step = pipeline.Run();
            while (step.MoveNext()) yield return step.Current;

            _overlay.Status = pipeline.Ok
                ? "Dans la partie de " + row.Label + " (" + pipeline.Room + ")."
                : "Échec : " + pipeline.Error;
            Log.Info(_overlay.Status);
            if (pipeline.Ok) _overlay.Open = false;
            _running = null;
        }

        // ---- Petits services -------------------------------------------------

        private static KeyCode ParseKey(string name, KeyCode fallback)
        {
            if (string.IsNullOrEmpty(name)) return fallback;
            try { return (KeyCode)Enum.Parse(typeof(KeyCode), name.Trim(), true); }
            catch { return fallback; }
        }
    }

    /// <summary>
    /// L'entrée clavier, atteinte par réflexion.
    ///
    /// UnityEngine.Input vit dans InputLegacyModule, que certains jeux bâtis
    /// sur le nouveau système d'entrée ne livrent pas. Le référencer à la
    /// compilation rendrait le greffon inutilisable chez eux ; le chercher à
    /// l'exécution le rend simplement muet, ce qui est réparable par la
    /// configuration.
    /// </summary>
    internal static class UnityInput
    {
        private static MethodInfo _getKeyDown;
        private static bool _looked;

        public static bool KeyDown(KeyCode key)
        {
            if (!_looked)
            {
                _looked = true;
                try
                {
                    var t = Type.GetType("UnityEngine.Input, UnityEngine.InputLegacyModule", false)
                         ?? Type.GetType("UnityEngine.Input, UnityEngine", false);
                    if (t != null) _getKeyDown = t.GetMethod("GetKeyDown", new[] { typeof(KeyCode) });
                    if (_getKeyDown == null && Plugin.Log != null)
                        Plugin.Log.Warning("Ce jeu n'expose pas l'entrée clavier héritée : la touche d'ouverture est inopérante.");
                }
                catch { }
            }
            if (_getKeyDown == null) return false;
            try { return (bool)_getKeyDown.Invoke(null, new object[] { key }); }
            catch { return false; }
        }
    }

    /// <summary>Un journal qui reste utilisable depuis le code statique des correctifs.</summary>
    internal sealed class ManualLogSourceProxy
    {
        private readonly BepInEx.Logging.ManualLogSource _inner;
        public ManualLogSourceProxy(BepInEx.Logging.ManualLogSource inner) { _inner = inner; }
        public void Info(string message) { try { _inner.LogInfo(message); } catch { } }
        public void Warning(string message) { try { _inner.LogWarning(message); } catch { } }
        public void Error(string message) { try { _inner.LogError(message); } catch { } }
    }
}
