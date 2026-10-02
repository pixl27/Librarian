using System;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using Mono.Cecil;

internal static class Compatibility
{
    private static MethodDefinition Login(TypeDefinition api, string name)
    {
        var methods = api.Methods.Where(m => m.Name == name && m.IsStatic && m.ReturnType.FullName == "System.Void" && m.Parameters.Count >= 3).ToArray();
        if (methods.Length != 1) throw new Exception(name + " signature is missing or ambiguous");
        return methods[0];
    }
    public static int Main(string[] args)
    {
        try
        {
            string managed = args[0];
            using (var game = AssemblyDefinition.ReadAssembly(Path.Combine(managed, "assembly_valheim.dll")))
            using (var playfab = AssemblyDefinition.ReadAssembly(Path.Combine(managed, "PlayFab.dll")))
            using (var steam = AssemblyDefinition.ReadAssembly(Path.Combine(managed, "com.rlabrecque.steamworks.net.dll")))
            {
                var manager = game.MainModule.Types.Single(t => t.FullName == "SteamManager");
                if (!manager.Methods.Any(m => m.Name == "LoadAPPID" && !m.IsStatic && m.IsPrivate && m.Parameters.Count == 0 && m.ReturnType.FullName == "System.UInt32"))
                    throw new Exception("SteamManager.LoadAPPID signature changed");
                if (!manager.Fields.Any(f => f.Name == "ACCEPTED_APPIDs" && f.IsStatic && f.FieldType.FullName == "System.UInt32[]"))
                    throw new Exception("SteamManager app identity schema changed");
                var api = playfab.MainModule.Types.Single(t => t.FullName == "PlayFab.PlayFabClientAPI");
                var source = Login(api, "LoginWithSteam");
                var target = Login(api, "LoginWithCustomID");
                foreach (var p in target.Parameters.Skip(1))
                    if (!source.Parameters.Any(s => s.Name == p.Name && s.ParameterType.FullName == p.ParameterType.FullName))
                        throw new Exception("PlayFab callback schema changed");
                var request = playfab.MainModule.Types.Single(t => t.FullName == target.Parameters[0].ParameterType.FullName);
                if (!request.Fields.Any(f => f.Name == "CustomId" && f.FieldType.FullName == "System.String") ||
                    !request.Fields.Any(f => f.Name == "CreateAccount" && f.FieldType.FullName == "System.Nullable`1<System.Boolean>"))
                    throw new Exception("PlayFab account schema changed");
                var user = steam.MainModule.Types.Single(t => t.FullName == "Steamworks.SteamUser");
                if (!user.Methods.Any(m => m.Name == "GetSteamID" && m.IsStatic && m.Parameters.Count == 0 && m.ReturnType.FullName == "Steamworks.CSteamID"))
                    throw new Exception("Steam user interface changed");
            }
            Console.WriteLine("{\"ok\":true}");
            return 0;
        }
        catch (Exception error)
        {
            Console.WriteLine("{\"ok\":false,\"error\":\"" + error.Message.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", " ").Replace("\n", " ") + "\"}");
            return 1;
        }
    }
}
