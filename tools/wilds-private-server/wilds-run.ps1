# Observe / ferme Monster Hunter Wilds pendant les essais du serveur prive.
#
#   wilds-run.ps1 -Action Status    processus + derniere ligne des journaux
#   wilds-run.ps1 -Action Close     ferme la fenetre du jeu proprement (WM_SYSCOMMAND/SC_CLOSE)
#
# Le lancement n'est PAS fait ici : le jeu exige les droits administrateur (Reflex charge un
# pilote noyau), et c'est l'utilisateur qui le demarre, comme d'habitude.
#
# Fermeture : l'hyperviseur de Reflex refuse TerminateProcess, mais le jeu se ferme lui-meme
# quand sa fenetre recoit SC_CLOSE.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Status', 'Close')][string]$Action,
    [string]$GamePath = 'E:\Games\steam\steamapps\common\Monster_Hunter_Wilds'
)
$ErrorActionPreference = 'Stop'

Add-Type -Namespace W -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
'@

function Get-Game { @(Get-Process -Name MonsterHunterWilds -ErrorAction SilentlyContinue) }
function Get-GameWindow { Get-Game | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1 }

switch ($Action) {
    'Status' {
        $g = Get-Game
        if (-not $g.Count) { Write-Output 'jeu : arrete' }
        else {
            $w = Get-GameWindow
            Write-Output ("jeu : PID {0}, {1} threads, {2:N0} Mo, fenetre : {3}" -f $g[0].Id, $g[0].Threads.Count, ($g[0].WorkingSet64 / 1MB), $(if ($w) { $w.MainWindowTitle } else { '(aucune)' }))
        }
        foreach ($f in 'librarian_party.log', 'reflex.log') {
            $p = Join-Path $GamePath $f
            if (Test-Path -LiteralPath $p) { Write-Output ("{0} : {1}" -f $f, (Get-Content -LiteralPath $p -Tail 1)) }
        }
    }
    'Close' {
        $w = Get-GameWindow
        if (-not $w) { Write-Output 'Aucune fenetre a fermer.'; return }
        [void][W.Native]::PostMessage($w.MainWindowHandle, 0x0112, [IntPtr]0xF060, [IntPtr]::Zero)
        $deadline = (Get-Date).AddSeconds(60)
        while ((Get-Game).Count -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
        if ((Get-Game).Count) { Write-Output 'Le jeu ne s''est pas ferme en 60 s.'; exit 1 }
        Write-Output 'Jeu ferme.'
    }
}
