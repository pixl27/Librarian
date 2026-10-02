using System;
using System.Collections.Generic;
using UnityEngine;

namespace PhotonJoin
{
    /// <summary>Une ligne de la liste : un ami Steam, ou un identifiant saisi à la main.</summary>
    public sealed class OverlayRow
    {
        public string Label = "";
        public string UserId = "";     // l'identifiant présenté à Photon
        public string NativeId = "";   // l'identifiant de plateforme, quand il diffère
        public string Detail = "";
    }

    /// <summary>
    /// La fenêtre en jeu.
    ///
    /// Volontairement en IMGUI : c'est la seule interface disponible dans
    /// n'importe quel jeu Unity sans rien connaître de sa scène, de son canevas
    /// ni de son thème. Elle n'affiche que ce que le moteur a réellement
    /// trouvé — quand Photon n'est pas lié, elle le dit au lieu de proposer un
    /// bouton qui ne ferait rien.
    /// </summary>
    public sealed class Overlay
    {
        public bool Open;
        public string Status = "";
        public string ManualId = "";
        public readonly List<OverlayRow> Rows = new List<OverlayRow>();

        public Func<OverlayRow, bool> OnJoin;
        /// <summary>Appele une seule fois, quand la fenetre a ete disposee pour de bon.</summary>
        public Action<string> OnFirstDraw;
        public Action OnRefresh;
        public Action OnProbe;

        private Rect _window = new Rect(40, 40, 460, 380);
        private Vector2 _scroll;
        private const int WindowId = 0x504A4E;   // « PJN »

        public string Title = "PhotonJoin";
        public string Subtitle = "";
        public string Source = "manual";
        public bool Bound;
        public string Diagnostic = "";

        private bool _drawn;

        public void Draw()
        {
            if (!Open) return;
            _window = GUILayout.Window(WindowId, _window, DrawWindow, Title);
            if (!_drawn && Event.current != null && Event.current.type == EventType.Repaint)
            {
                _drawn = true;
                if (OnFirstDraw != null)
                    OnFirstDraw("Fenetre dessinee : " + Rows.Count + " ligne(s), source " + Source + ".");
            }
        }

        private void DrawWindow(int id)
        {
            GUILayout.Label(Subtitle);

            if (!Bound)
            {
                GUILayout.Space(6);
                GUILayout.Label("Photon n'est pas utilisable dans ce jeu :");
                GUILayout.Label(Diagnostic);
                GUILayout.Space(6);
                if (GUILayout.Button("Écrire le rapport de sonde")) Safe(OnProbe);
                if (GUILayout.Button("Fermer")) Open = false;
                GUI.DragWindow();
                return;
            }

            GUILayout.BeginHorizontal();
            if (GUILayout.Button(Source == "steam" ? "Rafraîchir les amis" : "Rafraîchir")) Safe(OnRefresh);
            if (GUILayout.Button("Sonde")) Safe(OnProbe);
            GUILayout.EndHorizontal();

            GUILayout.Space(4);
            _scroll = GUILayout.BeginScrollView(_scroll, GUILayout.MinHeight(180));
            if (Rows.Count == 0)
            {
                GUILayout.Label(Source == "steam"
                    ? "Aucun ami listé. Rafraîchir, ou saisir un identifiant ci-dessous."
                    : "Ce jeu n'expose pas de liste d'amis. Saisir l'identifiant ci-dessous.");
            }
            foreach (var row in Rows)
            {
                GUILayout.BeginHorizontal();
                GUILayout.Label(row.Label + (string.IsNullOrEmpty(row.Detail) ? "" : "  — " + row.Detail));
                GUILayout.FlexibleSpace();
                if (GUILayout.Button("Rejoindre", GUILayout.Width(96))) Join(row);
                GUILayout.EndHorizontal();
            }
            GUILayout.EndScrollView();

            GUILayout.Space(4);
            GUILayout.Label("Identifiant de l'ami :");
            GUILayout.BeginHorizontal();
            ManualId = GUILayout.TextField(ManualId ?? "");
            if (GUILayout.Button("Rejoindre", GUILayout.Width(96)) && !string.IsNullOrEmpty(ManualId))
                Join(new OverlayRow { Label = ManualId, UserId = ManualId.Trim(), NativeId = ManualId.Trim() });
            GUILayout.EndHorizontal();

            GUILayout.Space(6);
            GUILayout.Label(Status);
            if (GUILayout.Button("Fermer")) Open = false;

            GUI.DragWindow();
        }

        private void Join(OverlayRow row)
        {
            if (OnJoin == null) return;
            try { OnJoin(row); }
            catch (Exception e) { Status = "Échec : " + e.Message; }
        }

        private void Safe(Action action)
        {
            if (action == null) return;
            try { action(); }
            catch (Exception e) { Status = "Échec : " + e.Message; }
        }
    }
}
