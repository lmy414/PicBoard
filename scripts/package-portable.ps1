# Build an unsigned Windows portable distribution; uses the system WebView2 runtime.
param([switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Push-Location $root
try {
    if (-not $SkipBuild) {
        & npm.cmd exec -- tauri build --no-bundle
        if ($LASTEXITCODE -ne 0) { throw "Tauri release build failed ($LASTEXITCODE)" }
    }
    $exe = Join-Path $root 'src-tauri\target\release\quick-image-board.exe'
    if (-not (Test-Path -LiteralPath $exe)) { throw "Release executable missing: $exe" }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $name = "quick-image-board-windows-$stamp"
    $release = Join-Path $root 'release'
    $stage = Join-Path $release $name
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    Copy-Item -LiteralPath $exe -Destination (Join-Path $stage 'quick-image-board.exe')
    $licenses = Join-Path $stage 'licenses'
    New-Item -ItemType Directory -Path $licenses -Force | Out-Null
    Copy-Item -LiteralPath 'renderer\src\third-party\bloub\LICENSE' -Destination (Join-Path $licenses 'bloub-LICENSE.txt')
    Copy-Item -LiteralPath 'renderer\src\third-party\bloub\NOTICE.md' -Destination (Join-Path $licenses 'bloub-NOTICE.md')
    & node scripts/collect-licenses.mjs $licenses
    if ($LASTEXITCODE -ne 0) { throw 'Third-party notice collection failed; no distributable archive created' }
    @'
Quick Image Board / Phase 1 Windows portable

Extract this entire archive to a stable local directory and run quick-image-board.exe.
Requires the Microsoft Edge WebView2 Evergreen Runtime installed on this computer.
WebView2 and Windows system components are NOT bundled. This build is unsigned.
This Rust/Tauri application uses the library configured by its Rust host; keep backups before using preview builds.
Keep this folder in a stable location before enabling startup at login in Settings.
The startup option is off by default. Disable it before moving or deleting this folder.
The tray menu provides a full Quit action independently of the configured window-close behavior.
User image data is not bundled. Keep backups of existing libraries before using preview builds.
This package is the Phase 1 portable application, not a signed installer or an automatic updater.
Folder selection in Settings edits directory preferences only; it does not move the active library.
Default library: %APPDATA%\quick-image-board\quick-image-board (outside this application folder).
'@ | Set-Content -LiteralPath (Join-Path $stage 'READ-ME.txt') -Encoding UTF8
    # Cargo crates may retain 1970 timestamps; ZIP only supports 1980 onward.
    Get-ChildItem -LiteralPath $stage -Recurse -Force | Where-Object { $_.LastWriteTime.Year -lt 1980 -or $_.LastWriteTime.Year -gt 2107 } | ForEach-Object { $_.LastWriteTime = Get-Date }
    $zip = Join-Path $release "$name.zip"
    Compress-Archive -LiteralPath $stage -DestinationPath $zip -CompressionLevel Optimal
    $bytes = (Get-Item -LiteralPath $zip).Length
    $files = @(Get-ChildItem -LiteralPath $stage -File -Recurse | ForEach-Object {
        [pscustomobject]@{ path = $_.FullName.Substring($stage.Length + 1); bytes = $_.Length; sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash }
    })
    $report = [pscustomobject]@{
        createdAt = (Get-Date).ToString('o'); archive = $zip; archiveBytes = $bytes
        archiveSha256 = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash
        distributionLimitBytes = 50000000; withinLimit = ($bytes -lt 50000000)
        webview2Bundled = $false; signed = $false; skipBuild = [bool]$SkipBuild
        files = $files
    }
    $report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $release "$name.manifest.json") -Encoding UTF8
    $report | ConvertTo-Json -Depth 5
    if ($bytes -ge 50000000) { throw "Archive exceeds the 50 MB distribution limit: $bytes bytes; artifacts retained for analysis" }
} finally { Pop-Location }
