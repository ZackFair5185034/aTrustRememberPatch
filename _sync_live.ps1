<#
  把当前补丁内容就地同步进另一个副本目录，保留目标目录下的 .git（便于看 diff），
  但排除 .git 与运行期日志。
  用法: powershell -File _sync_live.ps1 -Dst '<目标副本目录>' [-Src '<源目录，缺省为本脚本所在目录>']
#>
param(
    [string]$Src = '',
    [string]$Dst = ''
)
$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($Src)) { $Src = $PSScriptRoot }
if ([string]::IsNullOrWhiteSpace($Dst)) { throw "必须指定 -Dst（目标副本目录）" }
if (-not (Test-Path $Src)) { throw "源目录不存在: $Src" }
if (-not (Test-Path $Dst)) { throw "目标目录不存在: $Dst" }

$ExcludeDirs  = @('.git', '.omc', '.vscode', 'node_modules')
$ExcludeFiles = @('setup.log', 'install-output.log', 'uninstall-output.log')
$copied = 0
$removed = 0

# 1) 删除目标里「旧版补丁文件」（同名直接覆盖即可，先清掉不再存在的旧文件）
foreach ($f in @('patch\atrust_remember.js','patch\atrust_remember_renderer.js','patch\atrust_remember_dpapi.js','patch\atrust_remember_dpapi_ffi.js')) {
    $t = Join-Path $Dst $f
    if (Test-Path $t) { Remove-Item $t -Force; $removed++ }
}

# 2) 覆盖复制（vendor/node_modules 逐文件覆盖）
$srcRoot = (Resolve-Path $Src).Path
foreach ($f in Get-ChildItem -LiteralPath $srcRoot -Recurse -File -Force) {
    $rel = $f.FullName.Substring($srcRoot.Length + 1)
    $parts = $rel -split '\\'
    if ($parts | Where-Object { $ExcludeDirs -contains $_ }) { continue }
    if ($ExcludeFiles -contains $f.Name) { continue }
    $target = Join-Path $Dst $rel
    $parent = Split-Path -Parent $target
    if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    Copy-Item -LiteralPath $f.FullName -Destination $target -Force
    $copied++
}
Write-Host ("覆盖复制 {0} 个文件, 清理旧补丁文件 {1} 个" -f $copied, $removed)

# 3) 校验
$ok = $true
foreach ($f in @('patch\atrust_remember.js','patch\atrust_remember_renderer.js','patch\atrust_remember_dpapi.js','patch\atrust_remember_dpapi_ffi.js','setup.ps1','README.md','tools\test-renderer.js')) {
    $a = (Get-FileHash (Join-Path $Src $f) -Algorithm SHA256).Hash
    $b = (Get-FileHash (Join-Path $Dst $f) -Algorithm SHA256).Hash
    if ($a -ne $b) { $ok = $false; Write-Host ("  DIFF  {0}" -f $f) } else { Write-Host ("  MATCH {0}" -f $f) }
}
$vn = (Get-ChildItem -Recurse -File (Join-Path $Dst 'vendor\node_modules') -ErrorAction SilentlyContinue).Count
Write-Host ("  vendor/node_modules 文件数: {0}" -f $vn)
if (-not $ok) { throw '同步后校验不一致' }
Write-Host '活副本已升级为 v1.2 内容。'
