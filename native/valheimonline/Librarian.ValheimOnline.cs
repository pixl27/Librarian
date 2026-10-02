using System;
using System.IO;
using System.Linq;
using System.Reflection;
using BepInEx;
using BepInEx.Logging;
using HarmonyLib;

namespace Librarian.ValheimOnline
{
    [BepInPlugin("com.librarian.valheim.online", "Librarian Valheim Online", "0.1.0")]
    public sealed class Plugin : BaseUnityPlugin
    {
        private static ManualLogSource Log;
        private static MethodInfo CustomLogin;
        private static MethodInfo SteamId;
        private static int[] ArgumentMap;
        private static uint AppId;

        private void Awake()
        {
            Log = Logger;
            var harmony = new Harmony("com.librarian.valheim.online");
            try
            {
                // Bind by type and signature each launch. No game assembly is
                // patched on disk and no native address/offset is remembered.
                var game = AppDomain.CurrentDomain.GetAssemblies()
                    .Select(a => a.GetType("SteamManager", false)).FirstOrDefault(t => t != null);
                if (game == null) throw new InvalidOperationException("SteamManager unavailable");
                var accepted = game.GetField("ACCEPTED_APPIDs", BindingFlags.Public | BindingFlags.Static);
                if (accepted == null || !((uint[])accepted.GetValue(null)).Contains(892970u))
                    throw new InvalidOperationException("Not a supported Valheim Steam build");
                AppId = 892970;
                var appIdMethod = game.GetMethod("LoadAPPID", BindingFlags.NonPublic | BindingFlags.Instance, null, Type.EmptyTypes, null);
                if (appIdMethod == null || appIdMethod.ReturnType != typeof(uint))
                    throw new InvalidOperationException("LoadAPPID signature changed");
                var api = Type.GetType("PlayFab.PlayFabClientAPI, PlayFab", true);
                var original = FindLogin(api, "LoginWithSteam");
                CustomLogin = FindLogin(api, "LoginWithCustomID");
                var request = CustomLogin.GetParameters()[0].ParameterType;
                if (request.GetField("CustomId") == null || request.GetField("CreateAccount") == null)
                    throw new InvalidOperationException("PlayFab request schema changed");
                var sourceParams = original.GetParameters();
                var targetParams = CustomLogin.GetParameters();
                ArgumentMap = targetParams.Select((p, i) => i == 0 ? 0 : Array.FindIndex(sourceParams,
                    candidate => candidate.Name == p.Name && candidate.ParameterType == p.ParameterType)).ToArray();
                if (ArgumentMap.Any(i => i < 0)) throw new InvalidOperationException("PlayFab callback signature changed");
                var user = Type.GetType("Steamworks.SteamUser, com.rlabrecque.steamworks.net", true);
                SteamId = user.GetMethod("GetSteamID", BindingFlags.Public | BindingFlags.Static, null, Type.EmptyTypes, null);
                if (SteamId == null) throw new InvalidOperationException("Steam user interface changed");
                harmony.Patch(appIdMethod, new HarmonyMethod(typeof(Plugin).GetMethod("ReadAppId", BindingFlags.Static | BindingFlags.NonPublic)));
                harmony.Patch(original, new HarmonyMethod(typeof(Plugin).GetMethod("Login", BindingFlags.Static | BindingFlags.NonPublic)));
                Logger.LogInfo("Compatibility checked: App ID and PlayFab adapters installed.");
                WriteStatus("ready", "Runtime signatures verified");
            }
            catch (Exception error)
            {
                harmony.UnpatchSelf();
                Logger.LogError("Compatibility check failed: " + error.Message);
                WriteStatus("unsupported", error.Message);
            }
        }

        private static MethodInfo FindLogin(Type api, string name)
        {
            var candidates = api.GetMethods(BindingFlags.Public | BindingFlags.Static)
                .Where(m => m.Name == name && m.ReturnType == typeof(void) && m.GetParameters().Length >= 3).ToArray();
            if (candidates.Length != 1) throw new InvalidOperationException(name + " signature is ambiguous or missing");
            return candidates[0];
        }

        private static bool ReadAppId(ref uint __result)
        {
            __result = AppId;
            return false;
        }

        private static bool Login(object[] __args)
        {
            try
            {
                var requestType = CustomLogin.GetParameters()[0].ParameterType;
                var request = Activator.CreateInstance(requestType);
                requestType.GetField("CreateAccount").SetValue(request, true);
                requestType.GetField("CustomId").SetValue(request, SteamId.Invoke(null, null).ToString());
                var arguments = ArgumentMap.Select(index => __args[index]).ToArray();
                arguments[0] = request;
                CustomLogin.Invoke(null, arguments);
                Log.LogInfo("PlayFab login delegated with original success/error callbacks.");
                return false;
            }
            catch (Exception error)
            {
                Log.LogError("Login adapter failed: " + error.GetBaseException().Message);
                WriteStatus("login-adapter-error", error.GetBaseException().Message);
                return true;
            }
        }

        private static void WriteStatus(string state, string detail)
        {
            try
            {
                string directory = Path.Combine(Paths.GameRootPath, ".DepotDownloader");
                Directory.CreateDirectory(directory);
                File.WriteAllText(Path.Combine(directory, "valheim-online-runtime.txt"),
                    "version=0.1.0\nstate=" + state + "\nutc=" + DateTime.UtcNow.ToString("o") + "\ndetail=" + detail.Replace('\n', ' ') + "\n");
            }
            catch { }
        }
    }
}
