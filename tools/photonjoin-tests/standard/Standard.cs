// Un jeu PUN2 de forme courante : espaces de noms officiels, propriétés
// auto-implémentées, Friends en List<T>, Steamworks.NET embarqué.
//
// Rien ici n'est appelé par son nom depuis l'hôte de test : l'hôte passe
// l'assemblée au liant, et le liant doit s'y retrouver seul.

using System;
using System.Collections.Generic;
using System.Reflection;
using FakePhoton;

namespace Photon.Realtime
{
    public enum ClientState
    {
        PeerCreated, Disconnected, ConnectingToNameServer, ConnectedToNameServer,
        ConnectingToMasterServer, ConnectedToMasterServer, JoiningLobby, JoinedLobby,
        Joining, Joined, Leaving, Disconnecting
    }

    public class AuthenticationValues
    {
        public string UserId { get; set; }
    }

    public class FriendInfo
    {
        public string UserId { get; internal set; }
        public bool IsOnline { get; internal set; }
        public bool IsInRoom { get; internal set; }
        public string Room { get; internal set; }

        internal static FriendInfo Make(string id, bool online, bool inRoom, string room)
        {
            return new FriendInfo { UserId = id, IsOnline = online, IsInRoom = inRoom, Room = room };
        }
    }

    public class RoomInfo { public string Name { get; internal set; } }

    public class Room : RoomInfo
    {
        public int PlayerCount { get; internal set; }
        internal static Room Make(string name) { return new Room { Name = name, PlayerCount = 1 }; }
    }

    public struct DisconnectMessage
    {
        public short Code;
        public string DebugMessage;
    }

    public class LoadBalancingClient
    {
        protected internal virtual void OnDisconnectMessageReceived(DisconnectMessage message)
        {
            FakeLog.Add("client.OnDisconnectMessageReceived:" + message.Code);
        }
    }
}

namespace Photon.Pun
{
    using Photon.Realtime;

    public static class PhotonNetwork
    {
        public const string PunVersion = "2.45";

        public static ClientState NetworkClientState { get; set; } = ClientState.Disconnected;
        public static LoadBalancingClient NetworkingClient { get; set; } = new LoadBalancingClient();
        public static AuthenticationValues AuthValues { get; set; }
        public static Room CurrentRoom { get; set; }
        public static List<FriendInfo> Friends { get; set; }
        public static string CloudRegion { get; set; } = "eu";
        public static string NickName { get; set; } = "joueur";
        public static bool IsMasterClient { get; set; }

        public static bool InRoom { get { return CurrentRoom != null; } }

        public static bool IsConnected
        {
            get
            {
                return NetworkClientState != ClientState.Disconnected
                    && NetworkClientState != ClientState.PeerCreated
                    && NetworkClientState != ClientState.Disconnecting;
            }
        }

        internal static bool JoinResult = true;
        internal static bool Unresponsive;

        public static bool FindFriends(string[] friendsToFind)
        {
            FakeLog.Add("FindFriends:" + string.Join(",", friendsToFind ?? new string[0]));
            return true;
        }

        public static bool JoinRoom(string roomName)
        {
            FakeLog.Add("JoinRoom:" + roomName);
            if (JoinResult) { NetworkClientState = ClientState.Joining; CurrentRoom = Room.Make(roomName); NetworkClientState = ClientState.Joined; }
            return JoinResult;
        }

        public static bool RejoinRoom(string roomName)
        {
            FakeLog.Add("RejoinRoom:" + roomName);
            return JoinResult;
        }

        public static bool ConnectUsingSettings()
        {
            FakeLog.Add("ConnectUsingSettings");
            if (Unresponsive) return true;
            NetworkClientState = ClientState.ConnectedToMasterServer;
            return true;
        }

        public static void Disconnect()
        {
            FakeLog.Add("Disconnect");
            if (Unresponsive) return;
            NetworkClientState = ClientState.Disconnected;
            CurrentRoom = null;
        }

        public static bool LeaveRoom()
        {
            FakeLog.Add("LeaveRoom");
            CurrentRoom = null;
            return true;
        }
    }
}

// Le chemin de jonction propre au jeu, celui qu'un profil « natif » pilote.
namespace FakeGame
{
    public class NetworkConnector
    {
        public static NetworkConnector Instance = new NetworkConnector();
        public string RoomName;
        public string RegionToJoin;

        public void BeginJoin()
        {
            FakeLog.Add("BeginJoin:" + RoomName + "@" + RegionToJoin);
            Photon.Pun.PhotonNetwork.JoinRoom(RoomName);
        }
    }
}

// Un Steamworks.NET tel que les jeux Unity l'embarquent.
namespace Steamworks
{
    public enum EFriendFlags { k_EFriendFlagNone = 0, k_EFriendFlagImmediate = 4, k_EFriendFlagAll = 65535 }
    public enum EPersonaState { k_EPersonaStateOffline = 0, k_EPersonaStateOnline = 1, k_EPersonaStateAway = 3 }

    public struct CSteamID
    {
        public ulong m_SteamID;
        public CSteamID(ulong value) { m_SteamID = value; }
        public override string ToString() { return m_SteamID.ToString(); }
    }

    public static class SteamAPI
    {
        public static bool IsSteamRunning() { return true; }
    }

    public static class SteamUser
    {
        public static CSteamID GetSteamID() { return new CSteamID(76561198000000001UL); }
    }

    public static class SteamFriends
    {
        internal static readonly List<KeyValuePair<ulong, string>> Roster = new List<KeyValuePair<ulong, string>>
        {
            new KeyValuePair<ulong, string>(76561198393956588UL, "Hote"),
            new KeyValuePair<ulong, string>(76561198111111111UL, "Autre"),
        };

        public static int GetFriendCount(EFriendFlags flags) { return Roster.Count; }

        public static CSteamID GetFriendByIndex(int index, EFriendFlags flags)
        {
            return new CSteamID(Roster[index].Key);
        }

        public static string GetFriendPersonaName(CSteamID id)
        {
            foreach (var kv in Roster) if (kv.Key == id.m_SteamID) return kv.Value;
            return "";
        }

        public static EPersonaState GetFriendPersonaState(CSteamID id)
        {
            return EPersonaState.k_EPersonaStateOnline;
        }
    }
}

namespace FakePhoton.Standard
{
    using Photon.Pun;
    using Photon.Realtime;

    /// <summary>Le pilotage du faux « courant », vu par l'hôte de test.</summary>
    public sealed class StandardFake : IFakePhoton
    {
        public string Label { get { return "standard"; } }
        public Assembly Assembly { get { return typeof(StandardFake).Assembly; } }

        public void Reset()
        {
            FakeLog.Reset();
            PhotonNetwork.NetworkClientState = ClientState.Disconnected;
            PhotonNetwork.AuthValues = new AuthenticationValues { UserId = "76561198000000001" };
            PhotonNetwork.CurrentRoom = null;
            PhotonNetwork.Friends = new List<FriendInfo>();
            PhotonNetwork.CloudRegion = "eu";
            PhotonNetwork.JoinResult = true;
            PhotonNetwork.Unresponsive = false;
            FakeGame.NetworkConnector.Instance = new FakeGame.NetworkConnector();
        }

        public void SetState(string state)
        {
            PhotonNetwork.NetworkClientState = (ClientState)Enum.Parse(typeof(ClientState), state);
        }

        public string GetState() { return PhotonNetwork.NetworkClientState.ToString(); }

        public void SetAuth(string userId)
        {
            if (PhotonNetwork.AuthValues == null) PhotonNetwork.AuthValues = new AuthenticationValues();
            PhotonNetwork.AuthValues.UserId = userId;
        }

        public string AuthUserId()
        {
            return PhotonNetwork.AuthValues == null ? null : PhotonNetwork.AuthValues.UserId;
        }

        public void SetFriends(string[] ids, bool[] online, bool[] inRoom, string[] rooms)
        {
            var list = new List<FriendInfo>();
            for (var i = 0; i < ids.Length; i++)
                list.Add(FriendInfo.Make(ids[i], online[i], inRoom[i], rooms[i]));
            PhotonNetwork.Friends = list;
        }

        public void EnterRoom(string name)
        {
            PhotonNetwork.CurrentRoom = Room.Make(name);
            PhotonNetwork.NetworkClientState = ClientState.Joined;
        }

        public string CurrentRoomName()
        {
            return PhotonNetwork.CurrentRoom == null ? null : PhotonNetwork.CurrentRoom.Name;
        }

        public void FireDisconnect(short code, string text)
        {
            PhotonNetwork.NetworkingClient.OnDisconnectMessageReceived(
                new DisconnectMessage { Code = code, DebugMessage = text });
        }

        public void SetJoinResult(bool ok) { PhotonNetwork.JoinResult = ok; }

        public void SetUnresponsive(bool stuck) { PhotonNetwork.Unresponsive = stuck; }
    }
}
