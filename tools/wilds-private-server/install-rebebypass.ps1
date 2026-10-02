# Installe (ou retire) le plugin natif de bypass d'auth Rebe dans reframework/plugins.
#   install-rebebypass.ps1            copie out/rebebypass.dll dans <game>/reframework/plugins/
#   install-rebebypass.ps1 -Remove   retire le plugin
# Ne touche qu'a ce seul fichier.
[CmdletBinding()]
param(
    [string]$GamePath = 'E:\Games\steam\steamapps\common\Monster_Hunter_Wilds',
    [switch]$Remove
)
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$src = Join-Path $repo 'native\rebebypass\out\rebebypass.dll'
$dstDir = Join-Path $GamePath 'reframework\plugins'
$dst = Join-Path $dstDir 'rebebypass.dll'

if (@(Get-Process -Name MonsterHunterWilds -ErrorAction SilentlyContinue).Count) {
    throw 'Le jeu est en cours d''execution : fermez-le avant.'
}
if ($Remove) {
    if (Test-Path -LiteralPath $dst) { Remove-Item -LiteralPath $dst -Force; Write-Output 'Plugin retire.' }
    else { Write-Output 'Aucun plugin a retirer.' }
    return
}
if (-not (Test-Path -LiteralPath $src)) { throw "Plugin non construit : $src (node native/rebebypass/build.js)" }
New-Item -ItemType Directory -Force -Path $dstDir | Out-Null
Copy-Item -LiteralPath $src -Destination $dst -Force
$a = (Get-FileHash -LiteralPath $src -Algorithm SHA256).Hash
$b = (Get-FileHash -LiteralPath $dst -Algorithm SHA256).Hash
if ($a -ne $b) { throw 'Copie non verifiee.' }
Write-Output "Plugin installe : $dst ($($b.Substring(0,16)))"
