<#
  build-vendor.ps1 —— 从本机 npm 缓存/已安装的模块中裁剪出运行期最小依赖树，
  输出到 aTrustRememberPatch\vendor\node_modules\

  依赖闭包（ffi-napi 进程内调用 Win32 DPAPI 用）：
    ffi-napi      -> ref-napi, ref-struct-di, node-gyp-build, debug
    ref-napi      -> node-gyp-build, debug
    ref-struct-di -> debug
    debug         -> ms

  布局要求：这些包之间存在裸标识符 require('ref-napi') / require('debug')，
  因此必须整体位于同一个 node_modules 目录下才能被 Node 的模块解析找到。
#>
param(
  [string]$SourceNodeModules = "",
  [string]$OutRoot = ""
)

$ErrorActionPreference = 'Stop'

$patchRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($OutRoot)) {
  $OutRoot = Join-Path $patchRoot 'vendor'
}
if ([string]::IsNullOrWhiteSpace($SourceNodeModules)) {
  $SourceNodeModules = Join-Path (Split-Path -Parent $patchRoot) '_nativetest\node_modules'
}

if (-not (Test-Path $SourceNodeModules)) {
  throw "source node_modules not found: $SourceNodeModules"
}

$target = Join-Path $OutRoot 'node_modules'
if (Test-Path $target) { Remove-Item -Recurse -Force $target }
New-Item -ItemType Directory -Path $target -Force | Out-Null

# 包名 -> 需要保留的子项
$plan = @(
  @{ name = 'ffi-napi';      items = @('lib', 'package.json', 'prebuilds') },
  @{ name = 'ref-napi';      items = @('lib', 'package.json', 'prebuilds') },
  @{ name = 'ref-struct-di'; items = @('lib', 'package.json') },
  @{ name = 'node-gyp-build';items = @('index.js', 'node-gyp-build.js', 'package.json') },
  @{ name = 'debug';         items = @('src', 'package.json') },
  @{ name = 'ms';            items = @('index.js', 'package.json') }
)

foreach ($p in $plan) {
  $src = Join-Path $SourceNodeModules $p.name
  if (-not (Test-Path $src)) { throw "missing package: $src" }
  $dst = Join-Path $target $p.name
  New-Item -ItemType Directory -Path $dst -Force | Out-Null
  foreach ($it in $p.items) {
    $s = Join-Path $src $it
    if (-not (Test-Path $s)) { Write-Output "  skip (missing): $($p.name)/$it"; continue }
    Copy-Item -Path $s -Destination $dst -Recurse -Force
  }
  # 只保留 Windows 预编译产物（aTrust 托盘为 ia32，额外留 x64 以防换机）
  $pb = Join-Path $dst 'prebuilds'
  if (Test-Path $pb) {
    Get-ChildItem $pb -Directory | Where-Object { $_.Name -notlike 'win32-*' } | ForEach-Object {
      Remove-Item -Recurse -Force $_.FullName
      Write-Output "  pruned: $($p.name)/prebuilds/$($_.Name)"
    }
  }
  Write-Output "  packed: $($p.name)"
}

# 自检：node-gyp-build 需要 prebuilds/<platform>-<arch> 这一层
foreach ($p in @('ffi-napi', 'ref-napi')) {
  $d = Join-Path $target "$p\prebuilds\win32-ia32"
  if (-not (Test-Path $d)) { throw "prebuilds layout broken for $p (missing win32-ia32)" }
  $n = (Get-ChildItem $d -File).Count
  if ($n -lt 1) { throw "no prebuilt binary for $p" }
  Write-Output "  verify: $p\prebuilds\win32-ia32 -> $n file(s)"
}

$bytes = (Get-ChildItem $OutRoot -Recurse -File | Measure-Object Length -Sum).Sum
Write-Output ("vendor ready: {0}  ({1:N0} bytes, {2} files)" -f $OutRoot, $bytes, (Get-ChildItem $OutRoot -Recurse -File).Count)
