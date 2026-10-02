using System;
using System.Collections.Generic;
using System.Reflection;

namespace FakePhoton
{
    /// <summary>
    /// Le journal des appels que les faux Photon écrivent et que l'hôte de test
    /// relit. Il vit dans une assemblée à part pour que les deux faux puissent
    /// l'utiliser sans se connaître.
    /// </summary>
    public static class FakeLog
    {
        public static readonly List<string> Calls = new List<string>();
        public static void Add(string entry) { Calls.Add(entry); }
        public static void Reset() { Calls.Clear(); }
        public static string Joined() { return string.Join(" | ", Calls); }
        public static bool Has(string entry) { return Calls.Contains(entry); }
        public static int IndexOf(string entry) { return Calls.IndexOf(entry); }
    }

    /// <summary>
    /// La surface de pilotage commune aux deux faux. Elle n'expose que des types
    /// du socle : l'hôte de test peut donc manipuler un Photon sans jamais
    /// nommer un type Photon, ce qui évite l'ambiguïté entre les deux
    /// assemblées qui définissent chacune leur PhotonNetwork.
    /// </summary>
    public interface IFakePhoton
    {
        string Label { get; }
        Assembly Assembly { get; }
        void Reset();
        void SetState(string state);
        string GetState();
        void SetAuth(string userId);
        string AuthUserId();
        void SetFriends(string[] ids, bool[] online, bool[] inRoom, string[] rooms);
        void EnterRoom(string name);
        string CurrentRoomName();
        void FireDisconnect(short code, string text);
        /// <summary>Ce que la prochaine tentative d'entrée en salle doit répondre.</summary>
        void SetJoinResult(bool ok);
        /// <summary>Un serveur qui ne repond plus : Disconnect et Connect sont journalises sans effet.</summary>
        void SetUnresponsive(bool stuck);
    }
}
