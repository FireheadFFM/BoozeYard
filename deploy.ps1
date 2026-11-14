# BoozeYard Deploy: neuestes Update-ZIP aus Downloads einspielen, committen, pushen
param(
    [string]$Message = "",
    [string]$ZipFolder = "C:\Users\flori\OneDrive\Austausch intern\#KuTreWe\BottleYard App"
)

$ErrorActionPreference = "Continue"
$repo = $PSScriptRoot
Set-Location $repo

if (-not (Test-Path (Join-Path $repo ".git"))) {
    Write-Host "Das hier ist kein Git-Ordner. Lege deploy.ps1 in C:\dev\BoozeYard ab." -ForegroundColor Red
    exit 1
}

$downloads = $ZipFolder
if (-not (Test-Path -LiteralPath $downloads)) {
    Write-Host "Ordner nicht gefunden: $downloads" -ForegroundColor Red
    exit 1
}
$zip = Get-ChildItem -LiteralPath $downloads -Filter "BoozeYard-Update*.zip" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1

if (-not $zip) {
    Write-Host "Kein BoozeYard-Update*.zip im Ordner $downloads gefunden. Liegt das ZIP dort?" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Gefunden: $($zip.Name)  ($($zip.LastWriteTime))" -ForegroundColor Cyan
$answer = Read-Host "Dieses Update einspielen und veroeffentlichen? (j/n)"
if ($answer -notin @("j", "J", "y", "Y", "")) { Write-Host "Abgebrochen."; exit 0 }

$tmp = Join-Path $env:TEMP ("boozeyard_" + [guid]::NewGuid().ToString("N"))
Expand-Archive -LiteralPath $zip.FullName -DestinationPath $tmp -Force -ErrorAction Stop

$hasSql = Test-Path (Join-Path $tmp "sql")
$hasFn = (Get-ChildItem -Path $tmp -Recurse -Filter "*.ts" -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0

Copy-Item -Path (Join-Path $tmp "*") -Destination $repo -Recurse -Force -ErrorAction Stop
Remove-Item -Path $tmp -Recurse -Force

git add .
$changes = git status --porcelain
if (-not $changes) {
    Write-Host "Keine Aenderungen gegenueber dem letzten Stand. Nichts zu veroeffentlichen." -ForegroundColor Yellow
    exit 0
}

if (-not $Message) { $Message = "Update: " + [IO.Path]::GetFileNameWithoutExtension($zip.Name) }
git commit -m $Message
if ($LASTEXITCODE -ne 0) { Write-Host "Commit fehlgeschlagen." -ForegroundColor Red; exit 1 }
git push
if ($LASTEXITCODE -ne 0) { Write-Host "Push fehlgeschlagen. Das ZIP bleibt im Update-Ordner liegen." -ForegroundColor Red; exit 1 }

# Verwendetes ZIP wegsortieren, damit es nicht doppelt eingespielt wird
$done = Join-Path $downloads "erledigt"
New-Item -ItemType Directory -Force -Path $done | Out-Null
Move-Item -LiteralPath $zip.FullName -Destination $done -Force

Write-Host ""
Write-Host "Fertig. GitHub baut die Seite jetzt (ca. 1-2 Minuten)." -ForegroundColor Green
Write-Host "Danach die App am Handy neu laden."
if ($hasSql) {
    Write-Host ""
    Write-Host "ACHTUNG: Das Update enthaelt SQL-Dateien. Diese musst du noch im Supabase SQL Editor ausfuehren." -ForegroundColor Yellow
}
if ($hasFn) {
    Write-Host ""
    Write-Host "ACHTUNG: Das Update enthaelt eine Edge Function (.ts). Sie muss in Supabase separat eingefuegt und deployt werden." -ForegroundColor Yellow
}

$open = Read-Host "GitHub-Actions im Browser oeffnen? (j/n)"
if ($open -in @("j", "J", "y", "Y")) { Start-Process "https://github.com/fireheadffm/BoozeYard/actions" }
