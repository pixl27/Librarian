using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;

namespace PhotonJoin
{
    public sealed class EntryResult
    {
        public bool Ok;
        public string Strategy = "";
        public string Error = "";
        public readonly List<string> Steps = new List<string>();
        public void Step(string s) { Steps.Add(s); }
        public string Trace { get { return string.Join(" → ", Steps.ToArray()); } }
    }

    /// <summary>
    /// Entrer dans la salle trouvée.
    ///
    /// L'appel PUN direct suffit aux jeux qui n'ont pas d'état de leur côté.
    /// Il ne suffit pas aux autres : un jeu bâti sur une machine à états entre
    /// bien dans la salle mais reste sur son menu, sans charger la scène, sans
    /// gestionnaire de connexion, et l'invité voit un écran noir. C'était
    /// exactement le symptôme sur PEAK, et c'est pour ça que la stratégie
    /// « native » existe : elle emprunte le chemin que le jeu emprunte
    /// lui-même quand on clique sur une invitation, en écrivant les champs
    /// qu'il attend puis en appelant sa méthode.
    ///
    /// Les noms viennent du profil ; le moteur ne connaît aucun jeu.
    /// </summary>
    public static class Entry
    {
        public static EntryResult Enter(PhotonBinding b, GameProfile p, string room, string region,
                                        IEnumerable<Assembly> assemblies)
        {
            var r = new EntryResult { Strategy = p == null ? "?" : p.EntryStrategy };
            if (b == null || !b.Bound) { r.Error = "Photon n'est pas lié."; return r; }
            if (p == null) { r.Error = "Aucun profil."; return r; }
            if (string.IsNullOrEmpty(room)) { r.Error = "Aucune salle à rejoindre."; return r; }

            switch (p.EntryStrategy)
            {
                case "raw": return Raw(b, r, room);
                case "rejoin": return Rejoin(b, r, room);
                case "native": return Native(b, p, r, room, region, assemblies);
                default: r.Error = "Stratégie d'entrée inconnue : " + p.EntryStrategy; return r;
            }
        }

        private static EntryResult Raw(PhotonBinding b, EntryResult r, string room)
        {
            if (b.MJoinRoom == null) { r.Error = "PhotonNetwork.JoinRoom est introuvable."; return r; }
            r.Step("JoinRoom(" + room + ")");
            return InvokeJoin(b.MJoinRoom, r, room);
        }

        private static EntryResult Rejoin(PhotonBinding b, EntryResult r, string room)
        {
            if (b.MRejoinRoom == null)
            {
                r.Step("RejoinRoom absent, repli sur JoinRoom");
                return Raw(b, r, room);
            }
            r.Step("RejoinRoom(" + room + ")");
            return InvokeJoin(b.MRejoinRoom, r, room);
        }

        /// <summary>Appeler une méthode de jonction dont le nombre de paramètres varie selon la version de PUN.</summary>
        private static EntryResult InvokeJoin(MethodInfo m, EntryResult r, string room)
        {
            var ps = m.GetParameters();
            var args = new object[ps.Length];
            args[0] = room;
            for (var i = 1; i < ps.Length; i++)
                args[i] = ps[i].ParameterType.IsValueType ? Activator.CreateInstance(ps[i].ParameterType) : null;

            object result;
            try { result = m.Invoke(null, args); }
            catch (Exception e) { r.Error = m.Name + " a levé : " + Unwrap(e).Message; return r; }

            if (result is bool && !(bool)result)
            {
                r.Error = m.Name + " a été refusé par PUN — le client n'est probablement pas sur le serveur maître.";
                return r;
            }
            r.Ok = true;
            return r;
        }

        /// <summary>
        /// Emprunter le chemin du jeu : écrire les champs que le profil nomme,
        /// puis appeler la méthode qu'il nomme.
        /// </summary>
        private static EntryResult Native(PhotonBinding b, GameProfile p, EntryResult r,
                                          string room, string region, IEnumerable<Assembly> assemblies)
        {
            var type = FindType(assemblies, p.NativeType);
            if (type == null)
            {
                r.Error = "Le type « " + p.NativeType + " » nommé par le profil est introuvable dans ce jeu.";
                return r;
            }
            r.Step("type " + type.FullName);

            object instance = null;
            if (!string.IsNullOrEmpty(p.NativeInstance))
            {
                var holder = Slot.Find(type, true, p.NativeInstance);
                if (!holder.Exists)
                {
                    r.Error = "Le membre « " + p.NativeType + "." + p.NativeInstance + " » nommé par le profil est introuvable.";
                    return r;
                }
                instance = holder.Get(null);
                if (instance == null)
                {
                    r.Error = "« " + p.NativeType + "." + p.NativeInstance + " » est nul : le jeu n'a pas encore créé cet objet.";
                    return r;
                }
                r.Step("instance " + p.NativeInstance);
            }

            foreach (var kv in p.NativeFields)
            {
                var slot = Slot.Find(type, instance == null, kv.Key);
                if (!slot.Exists)
                {
                    r.Error = "Le champ « " + p.NativeType + "." + kv.Key + " » nommé par le profil est introuvable.";
                    return r;
                }
                if (!slot.CanWrite)
                {
                    r.Error = "Le champ « " + p.NativeType + "." + kv.Key + " » n'est pas accessible en écriture.";
                    return r;
                }
                var value = Substitute(kv.Value, room, region, b.LocalUserId());
                if (!slot.Set(instance, Coerce(value, slot.Type)))
                {
                    r.Error = "Écriture refusée sur « " + p.NativeType + "." + kv.Key + " ».";
                    return r;
                }
                r.Step(kv.Key + "=" + value);
            }

            const BindingFlags flags = BindingFlags.Public | BindingFlags.NonPublic
                                     | BindingFlags.Static | BindingFlags.Instance | BindingFlags.FlattenHierarchy;
            var method = type.GetMethods(flags).FirstOrDefault(m => m.Name == p.NativeInvoke && m.GetParameters().Length == 0);
            if (method == null)
            {
                r.Error = "La méthode « " + p.NativeType + "." + p.NativeInvoke + "() » nommée par le profil est introuvable.";
                return r;
            }

            try { method.Invoke(method.IsStatic ? null : instance, null); }
            catch (Exception e) { r.Error = p.NativeInvoke + " a levé : " + Unwrap(e).Message; return r; }

            r.Step(p.NativeInvoke + "()");
            r.Ok = true;
            return r;
        }

        public static string Substitute(string template, string room, string region, string userId)
        {
            if (string.IsNullOrEmpty(template)) return template;
            return template
                .Replace("$room", room ?? "")
                .Replace("$region", region ?? "")
                .Replace("$userid", userId ?? "");
        }

        /// <summary>Convertir une valeur textuelle vers le type du champ visé, quand c'est possible.</summary>
        private static object Coerce(string value, Type wanted)
        {
            if (wanted == null || wanted == typeof(string)) return value;
            try
            {
                if (wanted.IsEnum) return Enum.Parse(wanted, value, true);
                if (wanted == typeof(bool)) return value == "true" || value == "1";
                if (wanted == typeof(int)) return int.Parse(value);
                if (wanted == typeof(short)) return short.Parse(value);
                if (wanted == typeof(long)) return long.Parse(value);
                if (wanted == typeof(ulong)) return ulong.Parse(value);
                if (wanted == typeof(float)) return float.Parse(value);
            }
            catch { }
            return value;
        }

        public static Type FindType(IEnumerable<Assembly> assemblies, string name)
        {
            if (assemblies == null || string.IsNullOrEmpty(name)) return null;
            Type shortMatch = null;
            foreach (var a in assemblies)
            {
                if (a == null) continue;
                Type[] types;
                try { types = a.GetTypes(); }
                catch (ReflectionTypeLoadException e) { types = e.Types == null ? new Type[0] : e.Types.Where(t => t != null).ToArray(); }
                catch { continue; }

                foreach (var t in types)
                {
                    if (t.FullName == name) return t;
                    if (shortMatch == null && t.Name == name) shortMatch = t;
                }
            }
            return shortMatch;
        }

        private static Exception Unwrap(Exception e)
        {
            while (e.InnerException != null) e = e.InnerException;
            return e;
        }
    }
}
