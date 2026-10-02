// Un jeu Photon de forme inhabituelle, tel qu'on en trouve quand le studio a
// fusionné les assemblées, gardé une nomenclature ancienne, ou dépouillé PUN.
//
// Tout y diffère du faux « courant » : espace de noms global, champs au lieu de
// propriétés, tableau au lieu de List, pas d'état détaillé mais un booléen,
// JoinRoom à deux paramètres, ConnectToRegion au lieu de ConnectUsingSettings,
// et aucun Steamworks. Si le liant s'en sort ici comme là-bas, c'est qu'il ne
// connaît aucun jeu par cœur.

using System;
using System.Reflection;
using FakePhoton;

public class AuthenticationValues
{
    public string UserId;
}

public class FriendInfo
{
    public string userId;
    public bool isOnline;
    public bool isInRoom;
    public string room;
}

public class RoomInfo
{
    public string name;
}

public struct DisconnectMessage
{
    public short code;
    public string debugMessage;
}

public class LoadBalancingClient
{
    public void OnDisconnectMessageReceived(DisconnectMessage message)
    {
        FakeLog.Add("client.OnDisconnectMessageReceived:" + message.code);
    }
}

public static class PhotonNetwork
{
    public static bool connected;
    public static LoadBalancingClient networkingPeer = new LoadBalancingClient();
    public static AuthenticationValues authValues;
    public static RoomInfo room;
    public static FriendInfo[] friends = new FriendInfo[0];
    public static string cloudRegion = "us";
    public static string playerName = "joueur";

    internal static bool JoinResult = true;
    internal static bool Unresponsive;

    public static bool FindFriends(string[] ids)
    {
        FakeLog.Add("FindFriends:" + string.Join(",", ids ?? new string[0]));
        return true;
    }

    // Une seule surcharge, à deux paramètres : le liant doit s'en accommoder.
    public static bool JoinRoom(string roomName, string[] expectedUsers)
    {
        FakeLog.Add("JoinRoom:" + roomName);
        if (JoinResult) { room = new RoomInfo { name = roomName }; connected = true; }
        return JoinResult;
    }

    public static bool ConnectToRegion(string region)
    {
        FakeLog.Add("ConnectToRegion:" + region);
        if (Unresponsive) return true;
        connected = true;
        return true;
    }

    public static void Disconnect()
    {
        FakeLog.Add("Disconnect");
        if (Unresponsive) return;
        connected = false;
        room = null;
    }
}

namespace FakePhoton.Variant
{
    /// <summary>Le pilotage du faux « variante », vu par l'hôte de test.</summary>
    public sealed class VariantFake : IFakePhoton
    {
        public string Label { get { return "variante"; } }
        public Assembly Assembly { get { return typeof(VariantFake).Assembly; } }

        public void Reset()
        {
            FakeLog.Reset();
            global::PhotonNetwork.connected = false;
            global::PhotonNetwork.authValues = new global::AuthenticationValues { UserId = "abcdef-0001" };
            global::PhotonNetwork.room = null;
            global::PhotonNetwork.friends = new global::FriendInfo[0];
            global::PhotonNetwork.cloudRegion = "us";
            global::PhotonNetwork.JoinResult = true;
            global::PhotonNetwork.Unresponsive = false;
        }

        public void SetState(string state)
        {
            global::PhotonNetwork.connected = state != "Disconnected" && state != "PeerCreated";
        }

        public string GetState()
        {
            return global::PhotonNetwork.connected
                ? (global::PhotonNetwork.room != null ? "Joined" : "ConnectedToMasterServer")
                : "Disconnected";
        }

        public void SetAuth(string userId)
        {
            if (global::PhotonNetwork.authValues == null)
                global::PhotonNetwork.authValues = new global::AuthenticationValues();
            global::PhotonNetwork.authValues.UserId = userId;
        }

        public string AuthUserId()
        {
            return global::PhotonNetwork.authValues == null ? null : global::PhotonNetwork.authValues.UserId;
        }

        public void SetFriends(string[] ids, bool[] online, bool[] inRoom, string[] rooms)
        {
            var list = new global::FriendInfo[ids.Length];
            for (var i = 0; i < ids.Length; i++)
                list[i] = new global::FriendInfo { userId = ids[i], isOnline = online[i], isInRoom = inRoom[i], room = rooms[i] };
            global::PhotonNetwork.friends = list;
        }

        public void EnterRoom(string name)
        {
            global::PhotonNetwork.room = new global::RoomInfo { name = name };
            global::PhotonNetwork.connected = true;
        }

        public string CurrentRoomName()
        {
            return global::PhotonNetwork.room == null ? null : global::PhotonNetwork.room.name;
        }

        public void FireDisconnect(short code, string text)
        {
            global::PhotonNetwork.networkingPeer.OnDisconnectMessageReceived(
                new global::DisconnectMessage { code = code, debugMessage = text });
        }

        public void SetJoinResult(bool ok) { global::PhotonNetwork.JoinResult = ok; }

        public void SetUnresponsive(bool stuck) { global::PhotonNetwork.Unresponsive = stuck; }
    }
}
