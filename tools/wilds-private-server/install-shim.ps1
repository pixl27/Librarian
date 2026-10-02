# Installe (ou retire) le shim PartyWin.dll dans l'installation de Wilds.
#
#   install-shim.ps1               sauvegarde la DLL Microsoft d'origine, pose le shim
#   install-shim.ps1 -Restore      remet la DLL d'origine
#
# Ne touche a rien d'autre que PartyWin.dll et librarian_party.ini. La DLL d'origine est
# verifiee par empreinte avant d'etre sauvegardee, et la sauvegarde est reverifiee.
[CmdletBinding()]
param(
    [string]$GamePath = 'E:\Games\steam\steamapps\common\Monster_Hunter_Wilds',
    [string]$Relay = '127.0.0.1:7777',
    [switch]$Restore
)
$ErrorActionPreference = 'Stop'

$OriginalSha = '037cafb5b3682a4eab8d55a72ed79bbe8d2a73eac524ad65377217ac67b9f222'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$shim = Join-Path $repo 'native\partyshim\out\PartyWin.dll'
$backupDir = Join-Path $repo 'audits\2026-09-28\party-backup'
$backup = Join-Path $backupDir 'PartyWin.original.dll'
$target = Join-Path $GamePath 'PartyWin.dll'
$ini = Join-Path $GamePath 'librarian_party.ini'

function Sha([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }

if (@(Get-Process -Name MonsterHunterWilds -ErrorAction SilentlyContinue).Count) {
    throw 'Le jeu est en cours d''execution : fermez-le avant de changer PartyWin.dll.'
}
if (-not (Test-Path -LiteralPath $target)) { throw "PartyWin.dll introuvable dans $GamePath" }

if ($Restore) {
    if (-not (Test-Path -LiteralPath $backup)) { throw "Aucune sauvegarde : $backup" }
    if ((Sha $backup) -ne $OriginalSha) { throw 'La sauvegarde ne correspond plus a la DLL d''origine.' }
    Copy-Item -LiteralPath $backup -Destination $target -Force
    if ((Sha $target) -ne $OriginalSha) { throw 'Restauration non verifiee.' }
    Write-Output "PartyWin.dll d'origine remise ($OriginalSha)."
    return
}

if (-not (Test-Path -LiteralPath $shim)) { throw "Shim non construit : $shim (node native/partyshim/build.js)" }
$current = Sha $target
if ($current -eq $OriginalSha) {
    New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
    Copy-Item -LiteralPath $target -Destination $backup -Force
    if ((Sha $backup) -ne $OriginalSha) { throw 'Sauvegarde non verifiee.' }
    Write-Output "Sauvegarde : $backup"
} elseif (-not (Test-Path -LiteralPath $backup) -or (Sha $backup) -ne $OriginalSha) {
    throw "PartyWin.dll actuelle ($current) n'est ni l'originale ni le shim connu, et aucune sauvegarde valide n'existe."
}

Copy-Item -LiteralPath $shim -Destination $target -Force
if ((Sha $target) -ne (Sha $shim)) { throw 'Copie du shim non verifiee.' }
if (-not (Test-Path -LiteralPath $ini)) {
    Set-Content -LiteralPath $ini -Value "[party]`r`nrelay=$Relay`r`n" -Encoding ASCII
}
Write-Output "Shim installe ($(Sha $target)); relais = $((Get-Content -LiteralPath $ini | Select-String '^relay=').Line)"
