<#
  aTrustRemember —— 卸载 / 回滚（兼容入口，逻辑已合并到 setup.ps1）

  推荐用统一入口：
      powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1

  本文件保留是为了兼容旧用法 / 自动化调用，等价于：
      powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1 -Action uninstall
#>
[CmdletBinding()]
param(
    [string]$AppRoot = '',
    [switch]$NoStopTray,
    [switch]$KeepCredential
)

$ErrorActionPreference = 'Stop'
$setup = Join-Path $PSScriptRoot 'setup.ps1'
if (-not (Test-Path $setup)) { throw "找不到 setup.ps1：$setup" }

& $setup -Action uninstall -AppRoot $AppRoot -NoStopTray:$NoStopTray -KeepCredential:$KeepCredential
exit $LASTEXITCODE
