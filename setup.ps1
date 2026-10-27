<#
  ============================================================================
  aTrustRemember —— aTrust 客户端「记住密码 / 掉线自动登录」补丁
  安装 / 卸载 一体化交互脚本
  ----------------------------------------------------------------------------
  用法:
    powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1
        → 交互菜单（安装 / 卸载 / 查看状态 / 退出），需要权限时自动 UAC 提权

    powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1 -Action install
    powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1 -Action uninstall
    powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1 -Action status
        → 无交互，供自动化 / 计划任务使用

  其它参数:
    -AppRoot "..."       指定 aTrustTray\resources\app 的非默认路径
    -NoStopTray          不停止 aTrustTray 进程（热替换）
    -KeepCredential      卸载时保留已保存的凭据

  说明:
    - 本脚本目录无关：所有路径基于 $PSScriptRoot，当前工作目录无影响。
    - 完整日志同时输出到控制台和 <脚本目录>\setup.log
    - install.ps1 / uninstall.ps1 是本脚本的薄封装，保持向后兼容。
  ============================================================================
#>
[CmdletBinding()]
param(
    [ValidateSet('menu', 'install', 'uninstall', 'status')]
    [string]$Action = 'menu',

    [string]$AppRoot = '',

    [switch]$NoStopTray,

    [switch]$KeepCredential
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# 常量与路径解析（全部基于 $PSScriptRoot，与当前工作目录无关）
# ---------------------------------------------------------------------------
$ScriptRoot = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($ScriptRoot)) {
    $ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
}

$DefaultRoot = 'C:\Program Files (x86)\Sangfor\aTrust\aTrustTray\resources\app'
if ([string]::IsNullOrWhiteSpace($AppRoot)) { $AppRoot = $DefaultRoot }

$PatchDir     = Join-Path $ScriptRoot 'patch'
$VendorSrc    = Join-Path $ScriptRoot 'vendor'
$UtilFile     = Join-Path $AppRoot 'src\service\util\util.js'
$ServiceDir   = Join-Path $AppRoot 'src\service'
$BackupDir    = Join-Path $AppRoot 'atrust_remember_backup'
$BackupFile   = Join-Path $BackupDir 'util.js.bak'
$Marker       = '/* aTrustRemember patch v1 */'
$PatchFiles   = @('atrust_remember.js', 'atrust_remember_renderer.js', 'atrust_remember_dpapi.js', 'atrust_remember_dpapi_ffi.js')
$VendorDst    = Join-Path ($env:APPDATA) 'aTrustRemember\vendor'
$CredFile     = Join-Path ($env:APPDATA) 'aTrustRemember\credential.bin'
$LogFile      = Join-Path $ScriptRoot 'setup.log'

# ---------------------------------------------------------------------------
# 日志
# ---------------------------------------------------------------------------
$script:LogStart = Get-Date

function Write-Log {
    param(
        [ValidateSet('INFO', 'OK', 'WARN', 'ERR', 'STEP', 'DONE')]
        [string]$Level = 'INFO',
        [string]$Message = ''
    )
    $ts = (Get-Date).ToString('HH:mm:ss')
    $text = "[$ts] [$Level ] $Message"

    $color = switch ($Level) {
        'OK'   { 'Green' }
        'WARN' { 'Yellow' }
        'ERR'  { 'Red' }
        'STEP' { 'Cyan' }
        'DONE' { 'Green' }
        default { 'Gray' }
    }
    Write-Host $text -ForegroundColor $color

    try {
        Add-Content -LiteralPath $LogFile -Value ("[{0}] [{1}] {2}" -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $Level, $Message) -Encoding UTF8
    } catch {
        # 日志文件不可写时不影响主流程
    }
}

function Write-Head {
    param([string]$Title)
    $line = '=' * 68
    Write-Host ''
    Write-Host $line -ForegroundColor Cyan
    Write-Host "  $Title" -ForegroundColor Cyan
    Write-Host $line -ForegroundColor Cyan
}

function Write-Sub {
    param([string]$Text)
    Write-Host "  $Text" -ForegroundColor DarkGray
}

function Invoke-Step {
    param(
        [string]$Title,
        [scriptblock]$Body
    )
    Write-Log 'STEP' "──────── $Title ────────"
    $sw = [Diagnostics.Stopwatch]::StartNew()
    try {
        $result = & $Body
        $sw.Stop()
        Write-Log 'OK' "$Title  (耗时 $($sw.ElapsedMilliseconds) ms)"
        return $result
    } catch {
        $sw.Stop()
        Write-Log 'ERR' "$Title 失败：$($_.Exception.Message)"
        throw
    }
}

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# ---------------------------------------------------------------------------
# 自提权：菜单里选了需要权限的动作后，UAC 一次，然后把动作交给提权实例
# ---------------------------------------------------------------------------
function Invoke-Elevated {
    param([string]$Act)

    $self = $MyInvocation.ScriptName
    if ([string]::IsNullOrWhiteSpace($self)) { $self = Join-Path $ScriptRoot 'setup.ps1' }

    $argStr = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -Action {1}' -f $self, $Act
    if (-not [string]::IsNullOrWhiteSpace($AppRoot)) { $argStr += ' -AppRoot "{0}"' -f $AppRoot }
    if ($NoStopTray)    { $argStr += ' -NoStopTray' }
    if ($KeepCredential) { $argStr += ' -KeepCredential' }

    Write-Log 'INFO' "需要管理员权限，正在请求 UAC 提权（请在弹窗点「是」）..."
    try {
        $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $argStr -Wait -PassThru
        Write-Log 'INFO' "提权进程已结束，退出码 = $($p.ExitCode)"
        return $p.ExitCode
    } catch {
        Write-Log 'ERR' "提权失败（UAC 被拒绝？）：$($_.Exception.Message)"
        return -1
    }
}

# ---------------------------------------------------------------------------
# 状态检测
# ---------------------------------------------------------------------------
function Get-PatchState {
    $state = [ordered]@{
        UtilExists   = (Test-Path $UtilFile)
        UtilPatched  = $false
        PatchFiles   = @()
        PatchMissing = @()
        BackupExists = (Test-Path $BackupFile)
        VendorExists = (Test-Path (Join-Path $VendorDst 'node_modules'))
        VendorSrc    = (Test-Path (Join-Path $VendorSrc 'node_modules'))
        CredExists   = (Test-Path $CredFile)
        CredSize     = 0
        CredIsDpapi  = $false
        ClientStatus = '未知'
    }

    if ($state.UtilExists) {
        try {
            $t = [IO.File]::ReadAllText($UtilFile)
            $state.UtilPatched = $t.Contains($Marker) -and $t.Contains('__atrustLogoutHooked')
        } catch { }
    }
    foreach ($f in $PatchFiles) {
        $dst = Join-Path $ServiceDir $f
        if (Test-Path $dst) { $state.PatchFiles += $f } else { $state.PatchMissing += $f }
    }
    if ($state.CredExists) {
        $state.CredSize = (Get-Item $CredFile).Length
        try {
            $raw = [IO.File]::ReadAllBytes($CredFile)
            $head = [Convert]::ToBase64String($raw[0..([Math]::Min(7, $raw.Length - 1))])
            $state.CredIsDpapi = ($head -like 'AQAAANCMnd8*')
        } catch { }
    }
    # 客户端会话状态（从托盘日志里取最近一次）
    try {
        $logDir = Join-Path ($env:APPDATA) 'Sangfor\aTrust\logs'
        $lg = Get-ChildItem $logDir -Filter 'aTrustTray.*.log' -ErrorAction SilentlyContinue |
              Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($lg) {
            $m = Select-String -Path $lg.FullName -Pattern 'update user status to (\w+)' |
                 Select-Object -Last 1
            if ($m -and $m.Matches.Count -gt 0) { $state.ClientStatus = $m.Matches[0].Groups[1].Value }
        }
    } catch { }
    return $state
}

function Show-State {
    param([switch]$AsLog)
    $s = Get-PatchState
    $lines = @()
    $lines += ('补丁文件        : {0} / {1} {2}' -f $s.PatchFiles.Count, $PatchFiles.Count, $(if ($s.PatchMissing.Count) { '缺少 ' + ($s.PatchMissing -join ', ') } else { '' }))
    $lines += ('util.js 钩子    : {0}' -f $(if ($s.UtilPatched) { '已注入' } else { '未注入' }))
    $lines += ('原始文件备份    : {0}' -f $(if ($s.BackupExists) { '存在 ' + $BackupFile } else { '不存在' }))
    $lines += ('vendor 依赖     : {0}  (源 {1})' -f $(if ($s.VendorExists) { '已部署 ' + $VendorDst } else { '未部署' }), $(if ($s.VendorSrc) { '存在' } else { '缺失' }))
    $lines += ('凭据 credential : {0}' -f $(if ($s.CredExists) { "{0} 字节, DPAPI={1}" -f $s.CredSize, $s.CredIsDpapi } else { '无' }))
    $lines += ('客户端会话状态  : {0}' -f $s.ClientStatus)

    if ($AsLog) {
        foreach ($l in $lines) { Write-Log 'INFO' $l }
    } else {
        foreach ($l in $lines) { Write-Sub $l }
    }
    return $s
}

# ---------------------------------------------------------------------------
# 安装
# ---------------------------------------------------------------------------
function Install-Patch {
    Write-Head '安装 / 重新安装'

    Invoke-Step '检查目标路径' {
        if (-not (Test-Path $UtilFile)) { throw "找不到 util.js：$UtilFile（请用 -AppRoot 指定正确的 resources\app 路径）" }
        if (-not (Test-Path $PatchDir)) { throw "找不到补丁目录：$PatchDir" }
        Write-Log 'INFO' "目标：$AppRoot"
    } | Out-Null

    Invoke-Step '校验管理员权限' {
        if (-not (Test-Admin)) { throw '需要管理员权限' }
        Write-Log 'INFO' '管理员权限 OK'
    } | Out-Null

    if (-not $NoStopTray) {
        Invoke-Step '停止 aTrustTray 进程' {
            $procs = Get-Process -Name 'aTrustTray' -ErrorAction SilentlyContinue
            if ($procs) {
                $procs | Stop-Process -Force -ErrorAction SilentlyContinue
                Start-Sleep -Milliseconds 800
                Write-Log 'INFO' "已停止 $($procs.Count) 个进程"
                Write-Log 'WARN' 'agent 通常会自动拉起；若登录界面没出现，手动运行一次 aTrustTray.exe'
            } else {
                Write-Log 'INFO' '未在运行'
            }
        } | Out-Null
    }

    Invoke-Step '备份原始 util.js' {
        if (-not (Test-Path $BackupDir)) { New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null }
        if (-not (Test-Path $BackupFile)) {
            Copy-Item $UtilFile $BackupFile -Force
            Write-Log 'INFO' "已备份 -> $BackupFile"
        } else {
            Write-Log 'INFO' "备份已存在，保持不变：$BackupFile"
        }
    } | Out-Null

    Invoke-Step '安装补丁模块（4 个 JS）' {
        foreach ($f in $PatchFiles) {
            $src = Join-Path $PatchDir $f
            if (-not (Test-Path $src)) { throw "缺少 $src" }
            Copy-Item $src (Join-Path $ServiceDir $f) -Force
            Write-Log 'INFO' "已安装 $f"
        }
    } | Out-Null

    Invoke-Step '部署进程内 DPAPI 依赖 (vendor)' {
        if (-not (Test-Path $VendorSrc)) {
            Write-Log 'WARN' "未找到 vendor 源目录，跳过；将回退到 R5 通道（本机实测被 EPERM 拦截，DPAPI 不可用）"
            return
        }
        New-Item -ItemType Directory -Path $VendorDst -Force | Out-Null
        $srcNm = Join-Path $VendorSrc 'node_modules'
        $dstNm = Join-Path $VendorDst 'node_modules'
        New-Item -ItemType Directory -Path $dstNm -Force | Out-Null
        foreach ($pkg in Get-ChildItem $srcNm -Directory) {
            $to = Join-Path $dstNm $pkg.Name
            if (Test-Path $to) { Remove-Item -Recurse -Force $to }
            Copy-Item -Path $pkg.FullName -Destination $to -Recurse -Force
            Write-Log 'INFO' "  vendor pkg: $($pkg.Name)"
        }
        foreach ($need in @('ffi-napi\prebuilds\win32-ia32', 'ref-napi\prebuilds\win32-ia32')) {
            if (-not (Test-Path (Join-Path $dstNm $need))) { throw "vendor 布局异常，缺少 $need" }
        }
        $vf = Get-ChildItem $VendorDst -Recurse -File
        Write-Log 'INFO' ("vendor -> {0} ({1} 个文件, {2:N0} 字节)" -f $VendorDst, $vf.Count, ($vf | Measure-Object Length -Sum).Sum)
        Write-Log 'INFO' 'vendor 布局校验通过'
    } | Out-Null

    Invoke-Step '注入钩子到 util.js' {
        $raw = [IO.File]::ReadAllBytes($UtilFile)
        $hasBom = ($raw.Length -ge 3 -and $raw[0] -eq 0xEF -and $raw[1] -eq 0xBB -and $raw[2] -eq 0xBF)
        $text = [Text.Encoding]::UTF8.GetString($raw)
        if ($hasBom) { $text = $text.TrimStart([char]0xFEFF) }

        # 已有旧钩子 → 先从备份还原，保证注入的钩子内容始终是最新版
        if ($text.Contains($Marker)) {
            if (Test-Path $BackupFile) {
                Write-Log 'INFO' '检测到旧钩子，先从备份还原 util.js'
                Copy-Item $BackupFile $UtilFile -Force
                $raw = [IO.File]::ReadAllBytes($UtilFile)
                $hasBom = ($raw.Length -ge 3 -and $raw[0] -eq 0xEF -and $raw[1] -eq 0xBB -and $raw[2] -eq 0xBF)
                $text = [Text.Encoding]::UTF8.GetString($raw)
                if ($hasBom) { $text = $text.TrimStart([char]0xFEFF) }
            } else {
                Write-Log 'WARN' 'util.js 含标记但没有备份，无法自动还原旧钩子'
            }
        }

        $hook = @"

$Marker
;(function () {
  try {
    var TrayUtil = module.exports;
    if (!TrayUtil.__atrustRememberPatched) {
      var orig = TrayUtil.loadWebURL;
      TrayUtil.loadWebURL = function (win, url, opts) {
        var ret = orig.apply(this, arguments);
        try { require("../atrust_remember").hookWindow(win, opts); } catch (e) {}
        return ret;
      };
      TrayUtil.__atrustRememberPatched = true;
    }
    // 捕获「用户主动退出登录」：托盘只有用户点了退出登录/退出客户端时才会
    // 主动调用 agent 的 /v1/service/logout；服务端掉线不会走这条路径。
    // 据此把「用户主动退出」与「掉线」区分开，避免用户永远退不出去。
    if (!TrayUtil.__atrustLogoutHooked && typeof TrayUtil.requestAgent === "function") {
      var origReq = TrayUtil.requestAgent;
      TrayUtil.requestAgent = function (p) {
        try {
          if (String(p || "").indexOf("/v1/service/logout") >= 0) {
            require("../atrust_remember").markExplicitLogout();
          }
        } catch (e) {}
        return origReq.apply(this, arguments);
      };
      TrayUtil.__atrustLogoutHooked = true;
    }
    require("../atrust_remember").init();
    console.log("[aTrustRemember] patch active");
  } catch (e) {
    console.error("[aTrustRemember] patch init failed:", e);
  }
})();
"@
        $enc = New-Object Text.UTF8Encoding($hasBom)
        [IO.File]::WriteAllText($UtilFile, ($text + $hook), $enc)
        Write-Log 'INFO' "钩子已追加 (BOM=$hasBom)"

        # 写入后自检：钩子必须真的落盘，否则自动回滚
        $verify = [IO.File]::ReadAllText($UtilFile)
        if (-not $verify.Contains($Marker)) {
            Copy-Item $BackupFile $UtilFile -Force
            throw '钩子写入失败（标记缺失），已还原 util.js'
        }
        if (-not $verify.Contains('__atrustLogoutHooked')) {
            Copy-Item $BackupFile $UtilFile -Force
            throw '退出登录判据钩子缺失，已还原 util.js'
        }
        Write-Log 'INFO' '钩子落盘自检通过'
    } | Out-Null

    Invoke-Step '语法自检' {
        if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
            Write-Log 'WARN' 'PATH 中没有 node，跳过语法自检'
            return
        }
        foreach ($f in $PatchFiles) {
            $chk = & node --check (Join-Path $ServiceDir $f) 2>&1
            if ($LASTEXITCODE -ne 0) { throw "$f 语法错误：$chk" }
            Write-Log 'INFO' "$f OK"
        }
        $chk = & node --check $UtilFile 2>&1
        if ($LASTEXITCODE -ne 0) {
            Copy-Item $BackupFile $UtilFile -Force
            throw "打补丁后的 util.js 语法错误，已还原：$chk"
        }
        Write-Log 'INFO' 'util.js OK'
    } | Out-Null

    Write-Log 'DONE' '安装完成'
    Write-Host ''
    Write-Host '  下一步：' -ForegroundColor Cyan
    Write-Host '    1) 启动 aTrust 客户端（托盘），打开登录窗口'
    Write-Host '    2) 登录框下方会出现「记住密码」「掉线后自动登录」两个勾选'
    Write-Host '    3) 勾选后正常登录一次 —— 密码会经 DPAPI 加密存到'
    Write-Host "       $CredFile"
    Write-Host '    4) 之后掉线 / 重启客户端会自动回填并提交登录'
    Write-Host ''
    Write-Host '  验证日志: %APPDATA%\Sangfor\aTrust\logs\aTrustTray.*.log 中搜索 [aTrustRemember]' -ForegroundColor DarkGray
}

# ---------------------------------------------------------------------------
# 卸载
# ---------------------------------------------------------------------------
function Uninstall-Patch {
    Write-Head '卸载 / 回滚'

    Invoke-Step '校验管理员权限' {
        if (-not (Test-Admin)) { throw '需要管理员权限' }
        Write-Log 'INFO' '管理员权限 OK'
    } | Out-Null

    if (-not $NoStopTray) {
        Invoke-Step '停止 aTrustTray 进程' {
            $procs = Get-Process -Name 'aTrustTray' -ErrorAction SilentlyContinue
            if ($procs) {
                $procs | Stop-Process -Force -ErrorAction SilentlyContinue
                Start-Sleep -Milliseconds 800
                Write-Log 'INFO' "已停止 $($procs.Count) 个进程"
            } else { Write-Log 'INFO' '未在运行' }
        } | Out-Null
    }

    Invoke-Step '还原 util.js' {
        if (Test-Path $BackupFile) {
            Copy-Item $BackupFile $UtilFile -Force
            Write-Log 'INFO' "已从备份还原：$BackupFile"
        } else {
            Write-Log 'WARN' '没有找到备份文件，跳过还原（钩子将保留在 util.js 中）'
        }
    } | Out-Null

    Invoke-Step '移除补丁模块' {
        foreach ($f in $PatchFiles) {
            $dst = Join-Path $ServiceDir $f
            if (Test-Path $dst) {
                Remove-Item $dst -Force
                Write-Log 'INFO' "已删除 $f"
            } else { Write-Log 'INFO' "$f 不存在，跳过" }
        }
    } | Out-Null

    Invoke-Step '移除进程内 DPAPI 依赖 (vendor)' {
        if (Test-Path $VendorDst) {
            Remove-Item $VendorDst -Recurse -Force
            Write-Log 'INFO' "已删除 $VendorDst"
        } else { Write-Log 'INFO' 'vendor 不存在，跳过' }
    } | Out-Null

    Invoke-Step '清理本地凭据' {
        if ($KeepCredential) {
            Write-Log 'WARN' "按要求保留 $CredFile"
            return
        }
        if (Test-Path $CredFile) {
            Remove-Item $CredFile -Force
            Write-Log 'INFO' "已删除 $CredFile"
        } else { Write-Log 'INFO' '无凭据文件' }
    } | Out-Null

    Write-Log 'INFO' "备份目录保留在：$BackupDir（如需彻底清除可手动删除）"
    Write-Log 'DONE' '卸载完成，客户端已恢复原状'
}

# ---------------------------------------------------------------------------
# 交互菜单
# ---------------------------------------------------------------------------
function Show-Menu {
    Write-Head 'aTrustRemember —— aTrust 客户端「记住密码 / 掉线自动登录」补丁'
    Write-Sub "脚本目录 : $ScriptRoot"
    Write-Sub "目标目录 : $AppRoot"
    Write-Sub "日志文件 : $LogFile"
    Write-Host ''
    Write-Sub '当前状态：'
    Show-State | Out-Null
    Write-Host ''
    Write-Host '  [1] 安装 / 重新安装' -ForegroundColor White
    Write-Host '  [2] 卸载 / 回滚' -ForegroundColor White
    Write-Host '  [3] 查看当前状态' -ForegroundColor White
    Write-Host '  [0] 退出' -ForegroundColor White
    Write-Host ''
}

# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
Write-Log 'INFO' "setup.ps1 启动  action=$Action  scriptRoot=$ScriptRoot"

try {
    if ($Action -eq 'menu') {
        while ($true) {
            Show-Menu
            $choice = (Read-Host '请选择操作 [1/2/3/0]').Trim()
            if ($choice -eq '1') { $Action = 'install'; break }
            if ($choice -eq '2') { $Action = 'uninstall'; break }
            if ($choice -eq '3') {
                Write-Head '当前状态'
                Show-State | Out-Null
                Write-Host ''
                $null = Read-Host '按回车返回菜单'
                continue
            }
            if ($choice -eq '0') {
                Write-Log 'INFO' '用户选择退出'
                exit 0
            }
            Write-Host '  无效输入，请重新选择' -ForegroundColor Yellow
            Start-Sleep -Milliseconds 600
        }
    }

    if ($Action -eq 'status') {
        Write-Head '当前状态'
        Show-State | Out-Null
        exit 0
    }

    # 需要权限的动作：非管理员则自提权（提权实例直接执行动作，不再显示菜单）
    if (-not (Test-Admin)) {
        $code = Invoke-Elevated $Action
        if ($code -ne 0) {
            Write-Log 'ERR' "提权执行失败（退出码 $code）"
            exit 1
        }
        Write-Log 'DONE' '已通过提权实例完成操作'
        exit 0
    }

    switch ($Action) {
        'install'   { Install-Patch }
        'uninstall' { Uninstall-Patch }
    }
    exit 0
} catch {
    Write-Log 'ERR' "未捕获异常：$($_.Exception.Message)"
    Write-Log 'ERR' $_.ScriptStackTrace
    exit 1
}
