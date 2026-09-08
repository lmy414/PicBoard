# Build an unsigned PicBoard Windows x64 portable distribution using the system WebView2 runtime.
param([switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Push-Location $root
try {
    $package = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
    $version = [string]$package.version
    if ([string]::IsNullOrWhiteSpace($version)) { throw 'package.json version is missing' }

    if (-not $SkipBuild) {
        & npm.cmd exec -- tauri build --no-bundle
        if ($LASTEXITCODE -ne 0) { throw "Tauri release build failed ($LASTEXITCODE)" }
    }

    $exe = Join-Path $root 'src-tauri\target\release\picboard.exe'
    if (-not (Test-Path -LiteralPath $exe)) { throw "Release executable missing: $exe" }

    $name = "PicBoard-v$version-windows-x64"
    $release = Join-Path $root 'release'
    $stage = Join-Path $release $name
    $zip = Join-Path $release "$name.zip"
    $manifest = Join-Path $release "$name.manifest.json"
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
    if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
    if (Test-Path -LiteralPath $manifest) { Remove-Item -LiteralPath $manifest -Force }

    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    Copy-Item -LiteralPath $exe -Destination (Join-Path $stage 'PicBoard.exe')
    Copy-Item -LiteralPath 'LICENSE' -Destination (Join-Path $stage 'LICENSE.txt')

    $licenses = Join-Path $stage 'licenses'
    New-Item -ItemType Directory -Path $licenses -Force | Out-Null
    Copy-Item -LiteralPath 'renderer\src\third-party\bloub\LICENSE' -Destination (Join-Path $licenses 'bloub-LICENSE.txt')
    Copy-Item -LiteralPath 'renderer\src\third-party\bloub\NOTICE.md' -Destination (Join-Path $licenses 'bloub-NOTICE.md')
    & node scripts/collect-licenses.mjs $licenses
    if ($LASTEXITCODE -ne 0) { throw 'Third-party notice collection failed; no distributable archive created' }

    @"
PicBoard v$version / Windows x64 便携版

1. 将整个 ZIP 解压到稳定的本地目录。
2. 确认系统已安装 Microsoft Edge WebView2 Evergreen Runtime。
3. 运行 PicBoard.exe。

这是未签名便携应用，不是安装器，也不包含自动更新器或固定 WebView2 运行时。
开机自启动默认关闭。启用前请先固定程序目录；移动或删除程序前请先关闭自启动。
托盘菜单可打开画板、显示悬浮球或完全退出。
用户图片和设置不包含在程序目录中，请自行备份重要数据。
目录选择只修改目录偏好，不会自动移动现有图库。

为兼容旧版本，默认数据目录仍为：
%APPDATA%\quick-image-board\quick-image-board

PicBoard 源码采用 MIT License；第三方组件遵循 licenses 目录中的各自许可证。
项目主页：https://github.com/lmy414/PicBoard
"@ | Set-Content -LiteralPath (Join-Path $stage 'READ-ME.txt') -Encoding UTF8

    # Cargo crates may retain 1970 timestamps; ZIP only supports 1980 onward.
    Get-ChildItem -LiteralPath $stage -Recurse -Force | Where-Object { $_.LastWriteTime.Year -lt 1980 -or $_.LastWriteTime.Year -gt 2107 } | ForEach-Object { $_.LastWriteTime = Get-Date }
    Compress-Archive -LiteralPath $stage -DestinationPath $zip -CompressionLevel Optimal

    $bytes = (Get-Item -LiteralPath $zip).Length
    $files = @(Get-ChildItem -LiteralPath $stage -File -Recurse | ForEach-Object {
        [pscustomobject]@{
            path = $_.FullName.Substring($stage.Length + 1)
            bytes = $_.Length
            sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
        }
    })
    $report = [pscustomobject]@{
        product = 'PicBoard'
        version = $version
        platform = 'windows-x64'
        createdAt = (Get-Date).ToString('o')
        archive = [IO.Path]::GetFileName($zip)
        archiveBytes = $bytes
        archiveSha256 = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash
        distributionLimitBytes = 50000000
        withinLimit = ($bytes -lt 50000000)
        webview2Bundled = $false
        signed = $false
        skipBuild = [bool]$SkipBuild
        files = $files
    }
    $report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifest -Encoding UTF8
    $report | ConvertTo-Json -Depth 5
    if ($bytes -ge 50000000) { throw "Archive exceeds the 50 MB distribution limit: $bytes bytes; artifacts retained for analysis" }
} finally {
    Pop-Location
}
