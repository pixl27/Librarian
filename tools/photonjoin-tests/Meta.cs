using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;

namespace PhotonJoin.Tests
{
    /// <summary>
    /// Lire un assembly .NET sans le charger.
    ///
    /// C'est la seule façon honnête de vérifier de quoi dépend le binaire
    /// livré : le charger le ferait résoudre ses références, ce qui échouerait
    /// hors du jeu et ne dirait rien. La table AssemblyRef, elle, est la
    /// déclaration que le compilateur a écrite, et c'est exactement la question
    /// posée — ce greffon a-t-il besoin d'une assemblée de jeu pour exister ?
    /// </summary>
    public static class Meta
    {
        public static List<string> AssemblyReferences(string dllPath)
        {
            var names = new List<string>();
            using (var stream = File.OpenRead(dllPath))
            using (var pe = new PEReader(stream))
            {
                var md = pe.GetMetadataReader();
                foreach (var handle in md.AssemblyReferences)
                    names.Add(md.GetString(md.GetAssemblyReference(handle).Name));
            }
            names.Sort(StringComparer.OrdinalIgnoreCase);
            return names;
        }

        public static List<string> TypeNames(string dllPath)
        {
            var names = new List<string>();
            using (var stream = File.OpenRead(dllPath))
            using (var pe = new PEReader(stream))
            {
                var md = pe.GetMetadataReader();
                foreach (var handle in md.TypeDefinitions)
                {
                    var t = md.GetTypeDefinition(handle);
                    var ns = md.GetString(t.Namespace);
                    var n = md.GetString(t.Name);
                    names.Add(string.IsNullOrEmpty(ns) ? n : ns + "." + n);
                }
            }
            names.Sort(StringComparer.Ordinal);
            return names;
        }

        /// <summary>Les noms des attributs posés sur un type, sans résoudre les types référencés.</summary>
        public static List<string> AttributesOn(string dllPath, string fullTypeName)
        {
            var found = new List<string>();
            using (var stream = File.OpenRead(dllPath))
            using (var pe = new PEReader(stream))
            {
                var md = pe.GetMetadataReader();
                foreach (var handle in md.TypeDefinitions)
                {
                    var t = md.GetTypeDefinition(handle);
                    var ns = md.GetString(t.Namespace);
                    var n = md.GetString(t.Name);
                    var full = string.IsNullOrEmpty(ns) ? n : ns + "." + n;
                    if (full != fullTypeName) continue;

                    foreach (var ah in t.GetCustomAttributes())
                    {
                        var attr = md.GetCustomAttribute(ah);
                        var name = AttributeName(md, attr);
                        if (name != null) found.Add(name);
                    }
                }
            }
            return found;
        }

        private static string AttributeName(MetadataReader md, CustomAttribute attr)
        {
            switch (attr.Constructor.Kind)
            {
                case HandleKind.MemberReference:
                {
                    var mr = md.GetMemberReference((MemberReferenceHandle)attr.Constructor);
                    if (mr.Parent.Kind != HandleKind.TypeReference) return null;
                    var tr = md.GetTypeReference((TypeReferenceHandle)mr.Parent);
                    var ns = md.GetString(tr.Namespace);
                    var n = md.GetString(tr.Name);
                    return string.IsNullOrEmpty(ns) ? n : ns + "." + n;
                }
                case HandleKind.MethodDefinition:
                {
                    var mdef = md.GetMethodDefinition((MethodDefinitionHandle)attr.Constructor);
                    var td = md.GetTypeDefinition(mdef.GetDeclaringType());
                    var ns = md.GetString(td.Namespace);
                    var n = md.GetString(td.Name);
                    return string.IsNullOrEmpty(ns) ? n : ns + "." + n;
                }
                default:
                    return null;
            }
        }
    }
}
