# Retire les points d'entree tiers identifies pour retablir un lancement Steam.
# Chaque fichier est sauvegarde et verifie avant son retrait. Aucun pilote,
# fichier d'activation, sauvegarde, archive de jeu ou reglage Windows n'est modifie.
[CmdletBinding()]
param([string]$GamePath = 'E:\Games\steam\steamapps\common\Monster_Hunter_Wilds')
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $GamePath).Path.TrimEnd('\')
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$expected = [ordered]@{
    'winmm.dll' = '320E8254BCD3AEEB4F52370AC340D908001D855F282639B21DF11D0DFEF55C16'
    'version.dll' = 'F22AAD32A90BE88B64346D6B2658E3B3F71447D7CF5CCE72952C1F2B77F0D5C7'
    'dinput8.dll' = '50297354B2E895D8DA312E0ADCDA172EEE90EFCF5CA82282135DEA1780075330'
    'steamclient64.dll' = 'D95E0F4EF8FA1EAE57C86DEA79A3006E5B9DD38CDC184FCE8A93B755D3636069'
    'GameOverlayRenderer64.dll' = 'CDA0AC0F3ED2A5DBCD00B24814491570DC4F8BDCA8DB403BFEF98938DD080A1B'
}
function Hash([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash }
function Idle {
    if (@(Get-Process -Name MonsterHunterWilds,Librarian -ErrorAction SilentlyContinue).Count) {
        throw 'Le jeu ou Librarian est encore actif.'
    }
}
Idle
$exe = Join-Path $root 'MonsterHunterWilds.exe'
$api = Join-Path $root 'steam_api64.dll'
if ((Get-AuthenticodeSignature -LiteralPath $exe).Status -ne 'Valid' -or
    (Get-AuthenticodeSignature -LiteralPath $api).Status -ne 'Valid') {
    throw 'Verifier les fichiers officiels avant cette preparation.'
}
foreach ($name in $expected.Keys) {
    $target = [IO.Path]::GetFullPath((Join-Path $root $name))
    if ((Split-Path -Parent $target) -ne $root) { throw 'Chemin hors installation.' }
    $item = Get-Item -LiteralPath $target
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Lien inattendu : $name" }
    if ((Hash $target) -ne $expected[$name]) { throw "Empreinte inattendue : $name" }
}
$preserved = @{}
Get-ChildItem -LiteralPath $root -File | Where-Object {
    $_.Extension -in '.dll','.exe','.ini' -and -not $expected.Contains($_.Name)
} | ForEach-Object { $preserved[$_.Name] = Hash $_.FullName }
$backup = Join-Path $repoRoot ('audits\2026-09-22\wilds-standard-steam-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $backup | Out-Null
foreach ($name in $expected.Keys) {
    Copy-Item -LiteralPath (Join-Path $root $name) -Destination (Join-Path $backup $name)
    if ((Hash (Join-Path $backup $name)) -ne $expected[$name]) { throw "Sauvegarde invalide : $name" }
}
$receipt = [ordered]@{
    at=(Get-Date).ToString('o'); gamePath=$root; backupPath=$backup
    expected=$expected; preserved=$preserved; removed=@(); status='backed_up'
    officialVerificationComplete=$false; successfulLaunchVerified=$false
}
$receiptPath = Join-Path $backup 'receipt.json'
$receipt | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $receiptPath -Encoding UTF8
Idle
foreach ($name in $expected.Keys) {
    if ((Hash (Join-Path $root $name)) -ne $expected[$name]) { throw "Fichier modifie pendant preparation : $name" }
    Remove-Item -LiteralPath (Join-Path $root $name)
    $receipt.removed += $name
    $receipt | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $receiptPath -Encoding UTF8
}
foreach ($name in $preserved.Keys) {
    if ((Hash (Join-Path $root $name)) -ne $preserved[$name]) { throw "Fichier hors perimetre modifie : $name" }
}
$receipt.status = 'third_party_entrypoints_isolated'
$receipt.preservedFileCount = $preserved.Count
$receipt | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $receiptPath -Encoding UTF8
[pscustomobject]@{receipt=$receiptPath;isolated=$receipt.removed;unchangedFiles=$preserved.Count} | ConvertTo-Json
