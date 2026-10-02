using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;

namespace PhotonJoin
{
    /// <summary>
    /// Un membre atteint sans savoir s'il est champ ou propriété, public ou non.
    ///
    /// PUN a déplacé plusieurs fois la frontière entre les deux entre 2.0 et 2.4 :
    /// FriendInfo.UserId est un champ public dans les versions anciennes, une
    /// propriété à écriture interne dans les récentes. Un liant qui choisit l'un
    /// des deux se casse sur la moitié des jeux, ce qui est exactement ce qu'on
    /// cherche à éviter ici.
    /// </summary>
    public sealed class Slot
    {
        private readonly FieldInfo _field;
        private readonly PropertyInfo _prop;

        public string Name { get; private set; }

        private Slot(string name, FieldInfo f, PropertyInfo p) { Name = name; _field = f; _prop = p; }

        /// <summary>Le membre absent, pour que rien ne soit jamais nul.</summary>
        public static readonly Slot None = new Slot("?", null, null);

        public bool Exists { get { return _field != null || _prop != null; } }

        public Type Type
        {
            get
            {
                if (_field != null) return _field.FieldType;
                if (_prop != null) return _prop.PropertyType;
                return null;
            }
        }

        public bool CanWrite
        {
            get
            {
                if (_field != null) return !_field.IsInitOnly && !_field.IsLiteral;
                if (_prop != null) return _prop.GetSetMethod(true) != null;
                return false;
            }
        }

        public object Get(object target)
        {
            if (_field != null) return _field.GetValue(target);
            if (_prop != null)
            {
                var getter = _prop.GetGetMethod(true);
                if (getter == null) return null;
                return getter.Invoke(getter.IsStatic ? null : target, null);
            }
            return null;
        }

        public bool Set(object target, object value)
        {
            try
            {
                if (_field != null) { _field.SetValue(target, value); return true; }
                if (_prop != null)
                {
                    var setter = _prop.GetSetMethod(true);
                    if (setter == null) return false;
                    setter.Invoke(setter.IsStatic ? null : target, new[] { value });
                    return true;
                }
            }
            catch { }
            return false;
        }

        private const BindingFlags Any =
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.FlattenHierarchy;

        public static Slot Find(Type owner, bool isStatic, params string[] names)
        {
            var missing = new Slot(names.Length > 0 ? names[0] : "?", null, null);
            if (owner == null) return missing;
            var flags = Any | (isStatic ? BindingFlags.Static : BindingFlags.Instance);

            foreach (var name in names)
            {
                for (var t = owner; t != null; t = t.BaseType)
                {
                    var p = t.GetProperty(name, flags);
                    if (p != null) return new Slot(name, null, p);
                    var f = t.GetField(name, flags);
                    if (f != null) return new Slot(name, f, null);
                }
            }
            return missing;
        }

        /// <summary>Le premier membre dont le type est assignable à <paramref name="wanted"/>.</summary>
        public static Slot FindByType(Type owner, bool isStatic, Type wanted)
        {
            if (owner == null || wanted == null) return new Slot("?", null, null);
            var flags = Any | (isStatic ? BindingFlags.Static : BindingFlags.Instance);
            foreach (var p in owner.GetProperties(flags))
                if (wanted.IsAssignableFrom(p.PropertyType)) return new Slot(p.Name, null, p);
            foreach (var f in owner.GetFields(flags))
                if (wanted.IsAssignableFrom(f.FieldType)) return new Slot(f.Name, f, null);
            return new Slot("?", null, null);
        }
    }

    /// <summary>
    /// Tout ce que le greffon sait de Photon, découvert au démarrage sur les
    /// assemblées réellement chargées par le jeu.
    ///
    /// Rien ici n'est compilé contre PUN : c'est la condition pour qu'un seul
    /// binaire serve tous les jeux. La contrepartie est qu'une absence se
    /// diagnostique au lieu de se traduire en TypeLoadException dans un jeu
    /// qu'on ne peut pas déboguer.
    /// </summary>
    public sealed class PhotonBinding
    {
        public bool Bound;
        public string Diagnostic = "";
        public readonly List<string> Missing = new List<string>();
        public string PunVersion = "";
        public string Flavour = "";

        public Type TPhotonNetwork, TClient, TAuthValues, TFriendInfo, TRoom, TRoomInfo, TClientState, TDisconnectMessage;

        // Statiques de PhotonNetwork
        public Slot NetworkClientState = Slot.None, NetworkingClient = Slot.None, AuthValues = Slot.None,
                    CurrentRoom = Slot.None, Friends = Slot.None, CloudRegion = Slot.None,
                    NickName = Slot.None, InRoom = Slot.None, IsConnected = Slot.None,
                    IsMasterClient = Slot.None, LocalPlayer = Slot.None;

        public MethodInfo MFindFriends, MJoinRoom, MRejoinRoom, MDisconnect, MConnect, MLeaveRoom;

        // Membres de FriendInfo
        public Slot FUserId = Slot.None, FIsOnline = Slot.None, FIsInRoom = Slot.None, FRoom = Slot.None;

        // Membre de AuthenticationValues
        public Slot AUserId = Slot.None;

        // Sur LoadBalancingClient : la trame de coupure
        public MethodInfo MOnDisconnectMessage;
        public Slot DmCode = Slot.None, DmDebugMessage = Slot.None;

        private static IEnumerable<Type> TypesOf(Assembly a)
        {
            try { return a.GetTypes(); }
            catch (ReflectionTypeLoadException e)
            {
                // Courant sous Unity : une assemblée référence un module absent.
                // Les types déjà résolus restent exploitables.
                return e.Types == null ? new Type[0] : e.Types.Where(t => t != null).ToArray();
            }
            catch { return new Type[0]; }
        }

        private static Type Pick(IList<Type> pool, params string[] fullNames)
        {
            foreach (var wanted in fullNames)
            {
                foreach (var t in pool) if (t.FullName == wanted) return t;
            }
            // Repli sur le nom court : certains jeux fusionnent Photon dans
            // Assembly-CSharp en changeant l'espace de noms.
            foreach (var wanted in fullNames)
            {
                var shortName = wanted.Substring(wanted.LastIndexOf('.') + 1);
                foreach (var t in pool) if (t.Name == shortName) return t;
            }
            return null;
        }

        private static MethodInfo Method(Type owner, string name, params Type[][] shapes)
        {
            if (owner == null) return null;
            const BindingFlags flags = BindingFlags.Public | BindingFlags.NonPublic
                                     | BindingFlags.Static | BindingFlags.Instance | BindingFlags.FlattenHierarchy;
            var named = owner.GetMethods(flags).Where(m => m.Name == name).ToList();
            if (named.Count == 0) return null;

            foreach (var shape in shapes)
            {
                foreach (var m in named)
                {
                    var ps = m.GetParameters();
                    if (ps.Length != shape.Length) continue;
                    var ok = true;
                    for (var i = 0; i < shape.Length && ok; i++)
                        if (shape[i] != null && !shape[i].IsAssignableFrom(ps[i].ParameterType)) ok = false;
                    if (ok) return m;
                }
            }
            return shapes.Length == 0 ? named[0] : null;
        }

        /// <summary>
        /// Lier Photon depuis un ensemble d'assemblées.
        ///
        /// Le greffon passe AppDomain.CurrentDomain.GetAssemblies(). L'hôte de
        /// test passe des assemblées fabriquées pour l'occasion : c'est ce qui
        /// permet de prouver que la liaison ne connaît aucun jeu par cœur.
        /// </summary>
        public static PhotonBinding Bind(IEnumerable<Assembly> assemblies)
        {
            var b = new PhotonBinding();
            if (assemblies == null) { b.Diagnostic = "Aucune assemblée fournie."; return b; }

            var pool = new List<Type>();
            foreach (var a in assemblies)
            {
                if (a == null) continue;
                pool.AddRange(TypesOf(a));
            }

            b.TPhotonNetwork = Pick(pool, "Photon.Pun.PhotonNetwork", "PhotonNetwork");
            if (b.TPhotonNetwork == null)
            {
                b.Diagnostic = "PhotonNetwork est introuvable : ce jeu n'embarque pas PUN.";
                b.Missing.Add("PhotonNetwork");
                return b;
            }
            b.Flavour = b.TPhotonNetwork.FullName == "Photon.Pun.PhotonNetwork" ? "PUN2" : "PUN";

            var pn = b.TPhotonNetwork;
            b.NetworkClientState = Slot.Find(pn, true, "NetworkClientState", "connectionStateDetailed", "NetworkingClientState");
            b.NetworkingClient   = Slot.Find(pn, true, "NetworkingClient", "networkingPeer", "Client");
            b.AuthValues         = Slot.Find(pn, true, "AuthValues", "authValues");
            b.CurrentRoom        = Slot.Find(pn, true, "CurrentRoom", "room");
            b.Friends            = Slot.Find(pn, true, "Friends", "friends");
            b.CloudRegion        = Slot.Find(pn, true, "CloudRegion", "cloudRegion");
            b.NickName           = Slot.Find(pn, true, "NickName", "playerName");
            b.InRoom             = Slot.Find(pn, true, "InRoom", "inRoom");
            b.IsConnected        = Slot.Find(pn, true, "IsConnected", "connected");
            b.IsMasterClient     = Slot.Find(pn, true, "IsMasterClient", "isMasterClient");
            b.LocalPlayer        = Slot.Find(pn, true, "LocalPlayer", "player");

            var version = Slot.Find(pn, true, "PunVersion", "versionPUN");
            if (version.Exists) { var v = version.Get(null); b.PunVersion = v == null ? "" : v.ToString(); }

            var str = typeof(string);
            var strArr = typeof(string[]);
            b.MFindFriends = Method(pn, "FindFriends", new[] { strArr });
            b.MJoinRoom    = Method(pn, "JoinRoom", new[] { str }, new[] { str, (Type)null });
            b.MRejoinRoom  = Method(pn, "RejoinRoom", new[] { str });
            b.MDisconnect  = Method(pn, "Disconnect", new Type[0]);
            b.MLeaveRoom   = Method(pn, "LeaveRoom", new Type[0], new[] { typeof(bool) });
            b.MConnect     = Method(pn, "ConnectUsingSettings", new Type[0], new[] { (Type)null })
                          ?? Method(pn, "ConnectToRegion", new[] { str });

            // Les types satellites se déduisent d'abord des membres trouvés :
            // c'est plus fiable qu'un nom, puisque c'est le jeu lui-même qui
            // les a écrits dans sa signature.
            b.TClient = b.NetworkingClient.Exists ? b.NetworkingClient.Type : null;
            b.TClient = b.TClient ?? Pick(pool, "Photon.Realtime.LoadBalancingClient", "LoadBalancingClient");

            b.TAuthValues = b.AuthValues.Exists ? b.AuthValues.Type : null;
            b.TAuthValues = b.TAuthValues ?? Pick(pool, "Photon.Realtime.AuthenticationValues", "AuthenticationValues");

            b.TRoom = b.CurrentRoom.Exists ? b.CurrentRoom.Type : null;
            b.TRoom = b.TRoom ?? Pick(pool, "Photon.Realtime.Room", "Room");
            b.TRoomInfo = Pick(pool, "Photon.Realtime.RoomInfo", "RoomInfo");
            b.TClientState = b.NetworkClientState.Exists ? b.NetworkClientState.Type : null;
            b.TClientState = b.TClientState ?? Pick(pool, "Photon.Realtime.ClientState", "ClientState");

            b.TFriendInfo = ElementOf(b.Friends.Type) ?? Pick(pool, "Photon.Realtime.FriendInfo", "FriendInfo");

            b.FUserId   = Slot.Find(b.TFriendInfo, false, "UserId", "userId", "Name");
            b.FIsOnline = Slot.Find(b.TFriendInfo, false, "IsOnline", "isOnline");
            b.FIsInRoom = Slot.Find(b.TFriendInfo, false, "IsInRoom", "isInRoom");
            b.FRoom     = Slot.Find(b.TFriendInfo, false, "Room", "room", "RoomName");

            b.AUserId = Slot.Find(b.TAuthValues, false, "UserId", "userId");

            b.MOnDisconnectMessage = Method(b.TClient, "OnDisconnectMessageReceived");
            if (b.MOnDisconnectMessage != null)
            {
                var ps = b.MOnDisconnectMessage.GetParameters();
                if (ps.Length == 1) b.TDisconnectMessage = ps[0].ParameterType;
            }
            b.TDisconnectMessage = b.TDisconnectMessage ?? Pick(pool, "Photon.Realtime.DisconnectMessage", "DisconnectMessage");
            b.DmCode         = Slot.Find(b.TDisconnectMessage, false, "Code", "code");
            b.DmDebugMessage = Slot.Find(b.TDisconnectMessage, false, "DebugMessage", "debugMessage", "Message");

            Require(b, b.MFindFriends != null, "PhotonNetwork.FindFriends(string[])");
            Require(b, b.MJoinRoom != null, "PhotonNetwork.JoinRoom(string)");
            Require(b, b.AuthValues.Exists, "PhotonNetwork.AuthValues");
            Require(b, b.TAuthValues != null && b.AUserId.Exists && b.AUserId.CanWrite, "AuthenticationValues.UserId (accessible en écriture)");
            Require(b, b.TFriendInfo != null && b.FUserId.Exists, "FriendInfo.UserId");
            Require(b, b.NetworkClientState.Exists || b.IsConnected.Exists, "un état de connexion lisible");

            b.Bound = b.Missing.Count == 0;
            b.Diagnostic = b.Bound
                ? b.Flavour + (string.IsNullOrEmpty(b.PunVersion) ? "" : " " + b.PunVersion) + " lié."
                : "Photon trouvé mais incomplet — manque : " + string.Join(", ", b.Missing.ToArray());
            return b;
        }

        private static void Require(PhotonBinding b, bool ok, string what)
        {
            if (!ok) b.Missing.Add(what);
        }

        /// <summary>Le type d'élément d'une liste ou d'un tableau, s'il s'agit de l'un des deux.</summary>
        private static Type ElementOf(Type t)
        {
            if (t == null) return null;
            if (t.IsArray) return t.GetElementType();
            if (t.IsGenericType)
            {
                var args = t.GetGenericArguments();
                if (args.Length == 1) return args[0];
            }
            foreach (var i in t.GetInterfaces())
                if (i.IsGenericType && i.GetGenericTypeDefinition() == typeof(IEnumerable<>))
                    return i.GetGenericArguments()[0];
            return null;
        }

        // ---- Lectures courantes, exprimées une fois pour toutes -------------

        public string ClientStateName()
        {
            if (!NetworkClientState.Exists) return IsConnectedNow() ? "Connected" : "Disconnected";
            var v = NetworkClientState.Get(null);
            return v == null ? "?" : v.ToString();
        }

        public bool IsConnectedNow()
        {
            if (IsConnected.Exists)
            {
                var v = IsConnected.Get(null);
                if (v is bool) return (bool)v;
            }
            var s = NetworkClientState.Exists ? NetworkClientState.Get(null) : null;
            if (s == null) return false;
            var n = s.ToString();
            return n != "Disconnected" && n != "PeerCreated" && n != "Disconnecting";
        }

        public bool InRoomNow()
        {
            if (InRoom.Exists) { var v = InRoom.Get(null); if (v is bool) return (bool)v; }
            return CurrentRoom.Exists && CurrentRoom.Get(null) != null;
        }

        public string CurrentRegion()
        {
            if (!CloudRegion.Exists) return "";
            var v = CloudRegion.Get(null);
            return v == null ? "" : v.ToString();
        }

        public string LocalUserId()
        {
            if (!AuthValues.Exists || !AUserId.Exists) return "";
            var av = AuthValues.Get(null);
            if (av == null) return "";
            var v = AUserId.Get(av);
            return v == null ? "" : v.ToString();
        }

        public IEnumerable<object> FriendList()
        {
            if (!Friends.Exists) yield break;
            var raw = Friends.Get(null) as IEnumerable;
            if (raw == null) yield break;
            foreach (var f in raw) if (f != null) yield return f;
        }

        public string FriendUserId(object f) { var v = FUserId.Get(f); return v == null ? "" : v.ToString(); }
        public bool FriendOnline(object f) { var v = FIsOnline.Get(f); return v is bool && (bool)v; }
        public bool FriendInRoom(object f) { var v = FIsInRoom.Get(f); return v is bool && (bool)v; }
        public string FriendRoom(object f) { var v = FRoom.Get(f); return v == null ? "" : v.ToString(); }
    }
}
