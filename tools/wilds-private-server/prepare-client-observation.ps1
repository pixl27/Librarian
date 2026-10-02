<#
Prepare l'installation locale deja auditee pour un export de metadonnees.
Ne lance aucun jeu, ne charge aucune DLL et ne modifie aucun pilote.
Les empreintes sont intentionnellement propres a l'etat observe le 22/09/2026.
Un changement inattendu provoque un arret avant toute ecriture dans le jeu.
#>
[CmdletBinding()]
param(
    [string]$GamePath = 'E:\Games\steam\steamapps\common\Monster_Hunter_Wilds'
)
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$gameRoot = (Resolve-Path -LiteralPath $GamePath).Path
$auditRoot = Join-Path $repoRoot 'audits\2026-09-22\wilds-private-server'
$exporter = Join-Path $PSScriptRoot 'librarian_network_metadata.lua'
$installedExporter = Join-Path $gameRoot 'reframework\autorun\librarian_network_metadata.lua'
$expected = [ordered]@{
    'PartyWin.dll' = 'A21133686BB40DA44B5FE49C9EE5571553FAD0CF9CB4EE5D25BE7549415EA341'
    'PartyWin_o.dll' = '037CAFB5B3682A4EAB8D55A72ED79BBE8D2A73EAC524AD65377217AC67B9F222'
    'winhttp.dll' = '5BC705632F50258275CDB37DB4AC6A02D210D1DBD5F29156F10777588D48E68B'
    'winhttp_o.dll' = 'B78C1EBC5A3F5BD325442709753F471A79EB2F4B579DFFCC5FCD29F0E414984B'
    'librarian_http.ini' = 'A5EE8C27873EF7284A6D08E83472BFF183D8B0C4B9138F734719D4B1D7ADC168'
    'librarian_http.log' = 'B15374D7990E9B12F3E0320EF481BF90FC097D895865A3CFD931790AFDD65B30'
    'librarian_party.log' = 'D7383477EB5B4316D9303E853A594210F2812D27B69FEC819253F76E874151BC'
    'reframework\autorun\librarian_rebe_state.lua' = 'C4B1BBD36AEADA5559A23C293CB22873D210C7AB13F51155F6C0FA4E0B40EF54'
}
function Hash([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash }
function AssertIdle {
    if (@(Get-Process -Name MonsterHunterWilds,Librarian -ErrorAction SilentlyContinue).Count) {
        throw 'Fermer Wilds et Librarian avant de preparer cet export.'
    }
}
AssertIdle
if (Test-Path -LiteralPath $installedExporter) { throw 'Un exporteur est deja installe ; aucun remplacement implicite.' }
if (-not (Test-Path -LiteralPath $exporter -PathType Leaf)) { throw 'Exporteur source absent.' }
$candidateReport = Get-Content -LiteralPath (Join-Path $auditRoot 'network-type-candidates.json') -Raw | ConvertFrom-Json
if ((Hash (Join-Path $gameRoot 'MonsterHunterWilds.exe')) -ne $candidateReport.source.sha256) {
    throw 'Executable different de celui audite.'
}
foreach ($name in $expected.Keys) {
    $target = [IO.Path]::GetFullPath((Join-Path $gameRoot $name))
    if (-not $target.StartsWith($gameRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Chemin hors installation.' }
    $item = Get-Item -LiteralPath $target
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Lien inattendu : $name" }
    if ((Hash $target) -ne $expected[$name]) { throw "Fichier modifie depuis l'audit : $name" }
}
$partySignature = Get-AuthenticodeSignature -LiteralPath (Join-Path $gameRoot 'PartyWin_o.dll')
$httpSignature = Get-AuthenticodeSignature -LiteralPath (Join-Path $env:SystemRoot 'System32\winhttp.dll')
if ($partySignature.Status -ne 'Valid' -or $partySignature.SignerCertificate.Subject -notmatch 'Microsoft Corporation') {
    throw 'Signature de la bibliotheque Party originale non valide.'
}
if ($httpSignature.Status -ne 'Valid') { throw 'Signature WinHTTP systeme non valide.' }

# Une sauvegarde unique et verifiee avant le premier changement.
$backup = Join-Path $auditRoot ('client-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $backup | Out-Null
foreach ($name in $expected.Keys) {
    $destination = Join-Path $backup $name
    $parent = Split-Path -Parent $destination
    if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent | Out-Null }
    Copy-Item -LiteralPath (Join-Path $gameRoot $name) -Destination $destination
    if ((Hash $destination) -ne $expected[$name]) { throw "Sauvegarde invalide : $name" }
}
$unchanged = @{}
Get-ChildItem -LiteralPath $gameRoot -File | Where-Object {
    $_.Extension -in '.dll','.exe','.ini' -and -not $expected.Contains($_.Name)
} | ForEach-Object { $unchanged[$_.FullName] = Hash $_.FullName }
$state = Join-Path $gameRoot '.DepotDownloader\online-mode.json'
if (Test-Path -LiteralPath $state) { $unchanged[$state] = Hash $state }
AssertIdle

try {
    Copy-Item -LiteralPath (Join-Path $backup 'PartyWin_o.dll') -Destination (Join-Path $gameRoot 'PartyWin.dll') -Force
    foreach ($name in $expected.Keys) {
        if ($name -ne 'PartyWin.dll') { Remove-Item -LiteralPath (Join-Path $gameRoot $name) }
    }
    Copy-Item -LiteralPath $exporter -Destination $installedExporter
    if ((Hash (Join-Path $gameRoot 'PartyWin.dll')) -ne $expected['PartyWin_o.dll']) { throw 'Echec de restauration Party.' }
    if ((Hash $installedExporter) -ne (Hash $exporter)) { throw 'Echec de copie exporteur.' }
    foreach ($name in $expected.Keys) {
        if ($name -ne 'PartyWin.dll' -and (Test-Path -LiteralPath (Join-Path $gameRoot $name))) { throw "Ancienne sonde restante : $name" }
    }
    foreach ($path in $unchanged.Keys) {
        if ((Hash $path) -ne $unchanged[$path]) { throw "Fichier hors perimetre modifie : $path" }
    }
} catch {
    $failure = $_
    foreach ($name in $expected.Keys) {
        Copy-Item -LiteralPath (Join-Path $backup $name) -Destination (Join-Path $gameRoot $name) -Force
    }
    if (Test-Path -LiteralPath $installedExporter) { Remove-Item -LiteralPath $installedExporter }
    throw $failure
}
$receipt = [ordered]@{
    at = (Get-Date).ToString('o'); gamePath = $gameRoot; backupPath = $backup
    before = $expected; installedExporter = $installedExporter; exporterSha256 = Hash $installedExporter
    partySha256 = Hash (Join-Path $gameRoot 'PartyWin.dll')
    partySignature = (Get-AuthenticodeSignature -LiteralPath (Join-Path $gameRoot 'PartyWin.dll')).Status.ToString()
    removedSyntheticHttpProbe = $true; unchangedFileCount = $unchanged.Count
    unchangedFiles = $unchanged; gameLaunched = $false; runtimeExportVerified = $false
}
$receiptPath = Join-Path $backup 'receipt.json'
$receipt | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $receiptPath -Encoding UTF8
Write-Output "Preparation verifiee. Recu : $receiptPath"
