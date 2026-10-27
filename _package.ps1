<#
  aTrustRemember —— 打包 + 同步到桌面
  用法: powershell -NoProfile -ExecutionPolicy Bypass -File _package.ps1 [-Version 1.2] [-Desktop '<目标目录>']
  说明: 打包时排除 .git / *.log / install-output.log 等运行期产物；-Desktop 缺省为当前用户桌面
#>
param(
    [string]$Version = '1.2',
    [string]$Desktop = ''
)
if ([string]::IsNullOrWhiteSpace($Desktop)) { $Desktop = [Environment]::GetFolderPath('Desktop') }
$ErrorActionPreference = 'Stop'

$ws     = Split-Path -Parent $PSScriptRoot
$pkgDir = Join-Path $ws 'aTrustRememberPatch'
if (-not (Test-Path $pkgDir)) { throw "找不到包目录: $pkgDir" }

$ExcludeDirs  = @('.git', '.omc', '.vscode')
$ExcludeFiles = @('setup.log', 'install-output.log', 'uninstall-output.log')

function Get-PackageFiles {
    param([string]$Root)
    $list = New-Object System.Collections.Generic.List[object]
    foreach ($f in Get-ChildItem -LiteralPath $Root -Recurse -File -Force) {
        $rel = $f.FullName.Substring($Root.Length + 1)
        $parts = $rel -split '\\'
        if ($parts | Where-Object { $ExcludeDirs -contains $_ }) { continue }
        if ($ExcludeFiles -contains $f.Name) { continue }
        $list.Add([pscustomobject]@{ Full = $f.FullName; Rel = $rel; Size = $f.Length })
    }
    return $list
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression

$files = Get-PackageFiles -Root $pkgDir
$total = ($files | Measure-Object Size -Sum).Sum
Write-Host ("打包 {0} 个文件, {1:N0} 字节" -f $files.Count, $total)

$zipName = "aTrustRememberPatch-v$Version.zip"
$zipPath = Join-Path $ws $zipName
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

$zip = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($f in $files) {
        # 包内路径统一用 aTrustRememberPatch\... 前缀，解压后即得一个干净目录
        $entryName = "aTrustRememberPatch/" + ($f.Rel -replace '\\', '/')
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $zip, $f.Full, $entryName, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
} finally {
    $zip.Dispose()
}
Write-Host ("已生成: {0}  ({1:N0} 字节)" -f $zipPath, (Get-Item $zipPath).Length)

# ---- 同步到桌面 ----
if (Test-Path $Desktop) {
    $dstDir = Join-Path $Desktop "aTrustRememberPatch-v$Version"
    if (Test-Path $dstDir) { Remove-Item $dstDir -Recurse -Force }
    New-Item -ItemType Directory -Path $dstDir | Out-Null
    foreach ($f in $files) {
        $target = Join-Path $dstDir $f.Rel
        $parent = Split-Path -Parent $target
        if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
        Copy-Item -LiteralPath $f.Full -Destination $target -Force
    }
    Write-Host ("已同步目录: {0}" -f $dstDir)

    $dstZip = Join-Path $Desktop $zipName
    Copy-Item -LiteralPath $zipPath -Destination $dstZip -Force
    Write-Host ("已同步压缩包: {0}" -f $dstZip)

    # 机制分析报告一并带过去（如果有）
    $rep = Join-Path $ws 'aTrust-掉线自动登录机制分析报告.md'
    if (Test-Path $rep) {
        Copy-Item -LiteralPath $rep -Destination (Join-Path $Desktop 'aTrust-掉线自动登录机制分析报告.md') -Force
        Write-Host '已同步机制分析报告'
    }
} else {
    Write-Host ("桌面目录不存在，跳过同步: {0}" -f $Desktop)
}

Write-Host '完成。'
