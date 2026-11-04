<#
    PageEraser — Chrome Web Store package builder

    Copies only the files the extension actually needs into dist/pkg and zips
    them. Development files (mock-chrome.js, test.html, screenshots, README,
    this script) stay out of the upload: every extra file is something a store
    reviewer has to read and rule out.

    Usage:  powershell -ExecutionPolicy Bypass -File build.ps1
#>

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$dist = Join-Path $root 'dist'
$pkg = Join-Path $dist 'pkg'

# ─── Files that ship ──────────────────────────────────────
$files = @(
    'manifest.json',
    'background.js',
    'content.js',
    'content.css',
    'shared.js',
    'modes/index.js',
    'modes/erase.js',
    'modes/xray.js',
    'modes/extract-core.js',
    'modes/extract.js',
    'locales.js',
    'popup.html',
    'popup.css',
    'popup.js',
    'privacy-policy.html',
    'audio.js',
    'clippy.js',
    'tour.js',
    'minesweeper.js',
    'LICENSE'
)
$folders = @('icons')

# ─── Read version from the manifest ───────────────────────
$manifestPath = Join-Path $root 'manifest.json'
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$version = $manifest.version
Write-Host "Building PageEraser $version" -ForegroundColor Cyan

# ─── Never package a failing build ────────────────────────
$testRunner = Join-Path $root 'tests\run.js'
if (Test-Path $testRunner) {
    Write-Host "Running test suite..." -ForegroundColor Cyan
    & node $testRunner
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: tests failed - refusing to build a package." -ForegroundColor Red
        exit 1
    }
}

# ─── Sanity checks before packaging ───────────────────────
$missing = @()
foreach ($f in $files) {
    if (-not (Test-Path (Join-Path $root $f))) { $missing += $f }
}
foreach ($d in $folders) {
    if (-not (Test-Path (Join-Path $root $d))) { $missing += "$d/" }
}
if ($missing.Count -gt 0) {
    Write-Host "ERROR: missing files:" -ForegroundColor Red
    $missing | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
    exit 1
}

# Every script the manifest references must be in the ship list, or the
# packaged extension will fail to load with a blank popup.
$referenced = @()
$referenced += $manifest.background.service_worker
$referenced += $manifest.content_scripts[0].js
$referenced += $manifest.content_scripts[0].css
foreach ($r in $referenced) {
    if ($files -notcontains $r) {
        Write-Host "ERROR: manifest references '$r' but build.ps1 does not ship it." -ForegroundColor Red
        exit 1
    }
}

$popup = Get-Content (Join-Path $root 'popup.html') -Raw
[regex]::Matches($popup, '<script\s+src="([^"]+)"') | ForEach-Object {
    $src = $_.Groups[1].Value
    if ($files -notcontains $src) {
        Write-Host "ERROR: popup.html loads '$src' but build.ps1 does not ship it." -ForegroundColor Red
        exit 1
    }
}

# ─── Stage ────────────────────────────────────────────────
if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
New-Item -ItemType Directory -Path $pkg -Force | Out-Null

foreach ($f in $files) {
    # Keep the relative path: content scripts load modes/index.js, not index.js.
    $dest = Join-Path $pkg $f
    $destDir = Split-Path -Parent $dest
    if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }
    Copy-Item (Join-Path $root $f) -Destination $dest
}
foreach ($d in $folders) {
    Copy-Item (Join-Path $root $d) -Destination $pkg -Recurse
}

# ─── Zip ──────────────────────────────────────────────────
$zipPath = Join-Path $dist "pageeraser-$version.zip"
Compress-Archive -Path (Join-Path $pkg '*') -DestinationPath $zipPath -Force

$sizeKb = [math]::Round((Get-Item $zipPath).Length / 1KB, 1)
$fileCount = (Get-ChildItem $pkg -Recurse -File).Count

Write-Host ""
Write-Host "Package ready: dist/pageeraser-$version.zip ($sizeKb KB, $fileCount files)" -ForegroundColor Green
Write-Host "Upload this file at https://chrome.google.com/webstore/devconsole"
