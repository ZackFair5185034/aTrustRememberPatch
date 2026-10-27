<#
  提权安装启动器（由 Start-Process -Verb RunAs 调用）
  用法：Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path <本目录> '_launch_install.ps1')
  特点：全部路径基于 $PSScriptRoot，本脚本放到任何目录都能正常工作。
#>
$ErrorActionPreference = 'Continue'
$dir = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($dir)) { $dir = Split-Path -Parent $MyInvocation.MyCommand.Path }
$log = Join-Path $dir 'install-output.log'
try {
    $out = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $dir 'install.ps1') 2>&1 | Out-String
    $code = $LASTEXITCODE
    $out | Out-File -LiteralPath $log -Encoding utf8
    ("`n### install.ps1 exit code: $code") | Out-File -LiteralPath $log -Encoding utf8 -Append
} catch {
    ("EXCEPTION: " + $_.Exception.Message) | Out-File -LiteralPath $log -Encoding utf8
}
