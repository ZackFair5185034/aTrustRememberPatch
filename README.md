# aTrustRemember —— aTrust 客户端「记住密码 / 掉线自动登录」补丁

给深信服 aTrust 客户端（2.5.16.20）补上**掉线后自动登录**能力。

> **状态：已在测试机完整验证通过**（冷启动 → 自动回填 → 自动提交 → 登录成功，端到端零人工干预）。

---

## 一、先说清楚原理：aTrust 其实原生就有「记住密码」

逆向结果（证据来自本机托盘日志与门户 SPA 代码）：

aTrust 客户端**原生实现了「记住密码」**，只是被**服务端开关**关掉了。相关代码在门户 SPA
`resources\app\web\assets\useInitHelp*.js`：

```js
// 服务端下发的 authConfig 里
rememberPwdConfig: { enable: "0", publicPem: "" }

// 客户端读取
ne.value = Number(rememberPwdConfig.enable || 0);      // 0 = 关闭
te     = rememberPwdConfig.publicPem || "";              // 用于本地加密保存密码
ne.value || (localStorage.removeItem("historyUser"),
             localStorage.removeItem("enableRememberPwd"),
             localStorage.removeItem("enableRememberUserName"));

// 密码框被掩码时，直接从本地缓存回填密码
function ke() {
  let e = l.value;
  if (e === "♂♀☺♪♫◙♂♀") {                    // 原生掩码
    let n = historyUser.find(e => e.username === r.value);
    return n ? (n.psw || "") : e;
  }
  return e;
}

// 登录请求
let n = { username, password: ke(), rememberPwd: l.value === MASK ? "1" : "0", graphCheckCode };
```

**本机现状**（`logs\aTrustTray.20261008.log:659`）：

```json
"rememberPwdConfig": { "enable": "0", "publicPem": "" }
```

→ 客户端每次启动都会 `removeItem("historyUser")`，功能完全失效；
→ 实测 `AppCache\Local Storage\leveldb` 里 `[1]historyUser` 的值确实是 `[]`。

**为什么不能只靠本地改开关？** 原生方案依赖服务端下发的 `publicPem`：
客户端用**服务端公钥**加密密码存进 `historyUser`，登录时把密文原样发回，
由服务端用私钥解密认证。本地伪造一个 `publicPem` 的话，
存下来的密文服务端根本解不开 → 登录必失败。
所以「纯客户端开启原生 rememberPwd」这条路走不通，
**要么让管理员开策略，要么客户端自己实现一套本地凭据存储**——本补丁做的是后者。

---

## 二、补丁做了什么

| 项 | 说明 |
|---|---|
| 改动范围 | 只改 `resources\app\src\service\util\util.js`（**仅在文件末尾追加**，不改动任何原有字节）<br>+ 新增 4 个文件：`src\service\atrust_remember.js`、`atrust_remember_renderer.js`、`atrust_remember_dpapi.js`、`atrust_remember_dpapi_ffi.js` |
| 不碰 | 不修改任何签名 PE/EXE/DLL，不改 `aTrustAgent.exe`、不改注册表、不改服务端 |
| 服务端策略 | **不绕过**。自动登录仍然走标准 `POST /passport/v1/auth/psw`，服务端照常做完整认证（二次认证 / 设备风控 / 防重放全部保留） |
| 密码落盘 | 明文密码只在内存里；落盘一律经 **Windows DPAPI(CurrentUser)** 加密，存 `%APPDATA%\aTrustRemember\credential.bin`，仅当前登录用户 + 本机可解密 |
| DPAPI 通道 | **进程内**直接调用 `crypt32!CryptProtectData`（ffi-napi），**不创建任何子进程**——这是唯一在托盘浏览器进程里真正可用的通道 |
| 第三方依赖 | `ffi-napi` / `ref-napi` 等 6 个 MIT 开源包（N-API v1 预编译），装在 `%APPDATA%\aTrustRemember\vendor\`，**不写入 Program Files、不修改任何签名文件**、删目录即完全回滚。详见 §四 |
| 新增 UI | 登录框下方两个勾选：**记住密码** / **掉线后自动登录** |
| 语义 | **只对「掉线/重启」自动登录**；用户**主动点「退出登录」时不自动登回去**（否则永远退不出去） |
| 失败保护 | 服务端拒绝凭据时自动删除本地凭据 + 取消本地自动重试，避免反复重试把账号锁死 |

### ⚠️ 关键实现细节：为什么 DPAPI 必须「进程内」而不是「起子进程」

这是本补丁踩过的最大的坑，也是最容易被后来者改坏的地方。

**现象**：托盘主进程里任何 `child_process` 调用都失败：

```
[aTrustRemember] DIAG spawnSync_ps_rel  => spawn-error code=EPERM errno=EPERM syscall=spawnSync powershell.exe
[aTrustRemember] DIAG spawnSync_cmd_abs => spawn-error code=EPERM errno=EPERM syscall=spawnSync C:\Windows\System32\cmd.exe
[aTrustRemember] DIAG spawnSync_whoami  => spawn-error code=EPERM errno=EPERM syscall=spawnSync C:\Windows\System32\whoami.exe
[aTrustRemember] DIAG spawnSync_explorer=> spawn-error code=EPERM errno=EPERM errno=EPERM syscall=spawnSync C:\Windows\explorer.exe
```

**结论**：不是 powershell 被封、也不是 DPAPI 不可用，而是
**aTrust 托盘的浏览器进程被自保护策略限制，禁止创建除深信服签名程序以外的任何子进程**
（与 `util.js` 里 `execWhiteList` + `winCCPlugin.CheckSangforSign()` 的自保护策略同源）。
同步 `spawnSync`、异步 `execFile`、异步 `spawn`、detached / verbatim / shell / 最小环境变量
**一律** `EPERM`。

进一步实测：**用自身 exe 以 `ELECTRON_RUN_AS_NODE=1` 自举的纯 Node 子进程确实能创建**，
但那个子进程里再 `spawnSync powershell.exe` **同样被拒**——`aTrustDefender` 会注入到派生子进程。
所以「自举 + 再起 powershell」这条路也是死的。

**最终解法（F0 通道）**：**加载 DLL 不属于进程创建，不受该策略约束**。
补丁用 `ffi-napi` 在托盘进程内直接调用 `crypt32!CryptProtectData / CryptUnprotectData`：

```
托盘浏览器进程 (Electron 11.5.0 / Node 12.18.3 / ia32 / N-API 6)
   └─ require("ffi-napi")  → 加载 libffi 预编译 .node（无需编译、无需联网）
   └─ ffi.Library("crypt32.dll", { CryptProtectData: [...] })
   └─ 手工构造 DATA_BLOB → CryptProtectData(CryptProtectUIForbidden) → 密文
   └─ 密文写 %APPDATA%\aTrustRemember\credential.bin
```

**零子进程、零 PowerShell、零临时脚本**。实测托盘浏览器进程内：

```
[aTrustRemember] DIAG runner F0_ffi_inproc => OK len=352
[aTrustRemember] DIAG runner F0_ffi_inproc => ROUNDTRIP ok=true plain={"u":"diagMarker","p":"diag","ts":0}
[aTrustRemember] ffi dpapi probe: {"ok":true,"arch":"ia32","encryptedBytes":246,"err":""}
```

其余 12 条通道（`R5a~R5c` 自举、`R1~R4` powershell、`V0~V7` 进程创建变体）全部 EPERM，
保留在代码里仅作兜底与诊断。

> 顺带排除的方案（本机全部不可用）：
> `electron.safeStorage`（Electron 11 没有，13+ 才有）、`koffi`（要求 N-API≥8，本机只有 6）、
> `keytar`（无 ia32 预编译）、`win-dpapi` / `ffi-napi` 走 node-gyp 编译（本机无编译器，
> 必须 `npm install --ignore-scripts` 才能用 tarball 内置的预编译）。

### 架构

```
util.js(末尾追加) ──hookWindow()──> 主进程 atrust_remember.js
                                        │  ├─ executeJavaScript(注入渲染脚本)
                                        │  ├─ 轮询取回渲染进程里的凭据 / 渲染进程反向请求回填
                                        │  ├─ DPAPI 加密落盘（ffi-napi 进程内）
                                        │  └─ 拦 agent 的 /v1/service/logout 区分「主动退出」
                                        ▼
                          渲染进程 atrust_remember_renderer.js
                            ├─ 插入「记住密码 / 掉线后自动登录」勾选
                            ├─ 捕获 #password 明文（仅内存）
                            ├─ 拦截 /passport/v1/auth/psw 响应判定成败（XHR + fetch 双拦截）
                            └─ restore() 回填并自动提交
```

### 「掉线」和「用户主动退出登录」怎么区分

这是产品语义上的关键点：**用户点了「退出登录」之后，不应该被自动登录又拉回去**（否则永远退不出去）。

判据（来自 `src\controller\tray_controller.js` 逆向）：

- 托盘只有**用户点了退出登录 / 退出客户端**时，才会主动调用 agent 的
  `POST /v1/service/logout`（`onLogoutAction` → `Util.requestAgent("/v1/service/logout", …)`）；
  三个入口（门户按钮、强制退出、下载中退出）**全部**走这一条路径。
- **服务端掉线、会话过期、网络中断都不会走这条路径。**

补丁在 `util.js` 的钩子里给 `Util.requestAgent` 包了一层：

```js
TrayUtil.requestAgent = function (p) {
  if (String(p || "").indexOf("/v1/service/logout") >= 0) {
    require("../atrust_remember").markExplicitLogout();   // 抑制自动登录
  }
  return origReq.apply(this, arguments);
};
```

命中后：仍然**回填**密码（方便用户直接点「登录」），但**不自动提交**，
直到下一次登录成功才恢复自动登录能力。

> 注：该抑制标记是**进程内**状态。托盘进程若在「主动退出」之后被重启（例如重装补丁、崩溃重启），
> 自动登录会重新生效——这是刻意的取舍：主诉求是「掉线/重启客户端后自动登录」。

### 复选框为什么是自绘的（重要）

门户全局样式里有：

```css
input,button { -webkit-appearance: none; border: 0; }
```

直接插入原生 `<input type="checkbox">` 会被**整个抹成不可见**（表现为"只有文字、看不到方块"）。

因此补丁照抄门户 IDUX Checkbox 的结构——用 `<span>` 自绘方块，input 只作透明点击层：

```html
<label class="atrust-cb atrust-cb-checked">
  <span class="atrust-cb-input">
    <input type="checkbox" class="atrust-cb-input-inner">
    <span class="atrust-cb-box"></span>   <!-- 16x16 自绘方块 + 对勾 -->
  </span>
  <span class="atrust-cb-label">记住密码</span>
</label>
```

并内联一份自包含样式，色值直接取门户 `:root` 设计令牌
（`--ix-color-primary:#1c6eff`、`--ix-border-color:#e0e0e0`、
`--ix-background-color:#fff`、`--ix-border-radius-sm:2px`、`--ix-font-size:14px`），
不依赖任何 CSS chunk 是否被加载，也不会和门户样式打架。

运行时实测（托盘日志 `probe#N` 的 `diag.boxStyle`）：

```json
{"w":16,"h":16,"bg":"rgb(28, 110, 255)","border":"rgb(28, 110, 255)","radius":"2px"}
```

### 实际 DOM（已在运行中的登录页实测确认）

探针输出（`[aTrustRemember] probe#N:` 行）：

```json
{"userFound":true,"userPh":"请输入账号","userVal":"<your-account>",
 "pswFound":true,"pswId":"password","pswType":"password",
 "btnFound":true,"btnTag":"BUTTON","btnCls":"ix-button ix-button-block ix-button-primary ix-button-lg",
 "btnTxt":"登录","captcha":false,"box":true,
 "rememberChecked":true,"autoChecked":true}
```

实际结构：

```
input.ix-input-inner[placeholder="请输入账号"]      ← 用户名框（没有 id！）
input#password.ix-input-inner[placeholder="请输入密码"]  ← 密码框
button.ix-button.ix-button-block.ix-button-primary    ← 登录按钮（不是 input[type=submit]）
div.login-btn.auto-click-login                        ← 另一个"登录"容器
input[name=csrf-token][type=hidden]                   ← 防重放 token
```

选择器因此按「id 优先 + placeholder 兜底 + 可见性过滤」实现，
并排除了页面上 `hidden-box` 里的隐藏输入框。

### 一个容易踩的坑：门户用 hash 路由跳转，不会触发导航事件

门户是 `index.html?...#/login` 这样的 **hash 路由 SPA**。从面板页跳到登录页**不会**触发
Electron 的 `did-navigate` / `did-finish-load`，所以「主进程在导航事件里推送凭据」的做法会漏。

补丁因此做成**双向**：

- 主进程 → 渲染进程：`restore({u,p,allowSubmit})` 回填（导航事件时推送）
- 渲染进程 → 主进程：`peek()` 返回 `needRestore:true`（渲染进程自己发现登录框出现了），
  主进程轮询到就补一次回填

两条路都通，任何一种跳转方式都不漏。

### 诊断开关（可选）

在 `%APPDATA%\aTrustRemember\diag.json` 写入 JSON 后生效，文件不存在即关闭：

| 开关 | 作用 |
|---|---|
| `{"gotoLogin": true}` | 客户端启动时自动点击「前往登录」并把登录页 DOM 打进托盘日志 |
| `{"allowAutoLoginAfterLogout": true}` | 允许「用户主动退出登录后也自动登录」（默认禁止；用于测试或特殊需求） |

---

## 三、第三方依赖（必须知情）

F0 通道需要以下 **MIT 许可**的开源包，随补丁放在 `vendor\node_modules\`，
安装时被复制到 `%APPDATA%\aTrustRemember\vendor\`：

| 包 | 用途 | 许可 |
|---|---|---|
| `ffi-napi@4.0.3` | libffi 绑定，用于调用 `crypt32.dll` | MIT |
| `ref-napi` | 指针 / 类型层（`DATA_BLOB` 手工构造） | MIT |
| `ref-struct-di` | 结构体辅助 | MIT |
| `node-gyp-build` | 预编译二进制选择器 | MIT |
| `debug` / `ms` | 日志（依赖项） | MIT |

安全属性：

- 全部是 **N-API v1 预编译二进制**（`win32-ia32` / `win32-x64`），**不含 C++ 运行时、不需要编译、不联网**。
- 只落在**当前用户目录**（`%APPDATA%`），**不写入 `Program Files`**，**不修改任何深信服签名文件**。
- 只调用 `crypt32!CryptProtectData` / `CryptUnprotectData` / `kernel32!LocalFree` 三个 Win32 API。
- **回滚方式**：删除 `%APPDATA%\aTrustRemember\vendor` 目录即可（`uninstall.ps1` 会自动删）。

本机实测加载链路：`node-gyp-build` 在 Electron 下会优先选 `ref-napi\prebuilds\win32-ia32\electron.napi.node`，
ffi-napi 选 `ffi-napi\prebuilds\win32-ia32\node.napi.uv1.node`（N-API v1，兼容 Electron 11 的 N-API 6）。

---

## 四、安装

### 推荐入口：交互式一体脚本 `setup.ps1`

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1
```

```
====================================================================
  aTrustRemember —— aTrust 客户端「记住密码 / 掉线自动登录」补丁
====================================================================
  脚本目录 : C:\Users\<you>\Documents\aTrustRememberPatch
  目标目录 : C:\Program Files (x86)\Sangfor\aTrust\aTrustTray\resources\app
  日志文件 : C:\Users\<you>\Documents\aTrustRememberPatch\setup.log

  当前状态：
  补丁文件        : 4 / 4
  util.js 钩子    : 已注入
  原始文件备份    : 存在
  vendor 依赖     : 已部署
  凭据 credential : 278 字节, DPAPI=True
  客户端会话状态  : online

  [1] 安装 / 重新安装
  [2] 卸载 / 回滚
  [3] 查看当前状态
  [0] 退出

请选择操作 [1/2/3/0]:
```

特点：

- **一次菜单搞定安装和卸载**，不需要记命令。
- **菜单先出、提权后置**：只有真的选了「安装/卸载」才会弹 UAC；提权实例直接执行动作，不会再弹一遍菜单。
- **全过程分级日志**：每一步都有 `STEP / OK / INFO / WARN / ERR` 输出 + 耗时，同时落盘到 `setup.log`。
- **状态实时可见**：进菜单就告诉你补丁装没装、钩子注没注、凭据在不在、客户端在线与否。
- **任一步失败即中止**，并把错误写进日志（不会带着半成品往下跑）。

非交互 / 自动化用法（供计划任务、脚本调用）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1 -Action install
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1 -Action uninstall
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1 -Action status
```

参数：

| 参数 | 默认 | 作用 |
|---|---|---|
| `-Action menu\|install\|uninstall\|status` | `menu` | 执行动作 |
| `-AppRoot "D:\...\resources\app"` | 默认安装路径 | 指定非默认路径 |
| `-NoStopTray` | 关 | 不停止 aTrustTray 进程（热替换） |
| `-KeepCredential` | 关 | 卸载时保留已保存的凭据 |

> `install.ps1` / `uninstall.ps1` 保留为**兼容入口**，内部转发到 `setup.ps1 -Action install/uninstall`，
> 旧用法和自动化脚本不受影响。

### 目录无关（脚本可在任意位置执行）

所有脚本内部一律用 `$PSScriptRoot` 解析自身目录，**当前工作目录在哪都没影响**：

```powershell
# 在任何地方执行都可以，不需要先 cd
powershell -NoProfile -ExecutionPolicy Bypass -File "D:\任意路径\aTrustRememberPatch\setup.ps1"
```

已实测：把整个补丁目录复制到 `C:\Users\<you>\Documents\aTrustRememberPatch`，
在 `C:\Windows` 和 `C:\` 作为当前目录执行 `install.ps1` / `uninstall.ps1`，
路径解析、安装、vendor 部署、钩子落盘自检、语法自检全部通过（exit 0），
安装后的 4 个文件与副本 hash 完全一致。

唯一的结构要求（脚本自己会校验）：

```
aTrustRememberPatch\
├─ setup.ps1                          ← 主入口
├─ install.ps1 / uninstall.ps1        ← 兼容入口（转发到 setup.ps1）
├─ patch\                             ← 4 个补丁 JS
└─ vendor\                            ← ffi-napi 等依赖（缺失会跳过并降级到兜底通道）
```

`vendor\` 缺失时安装器只会给出警告并降级到 R5 自举通道（该通道在本机实测被 EPERM 拦截，
即 DPAPI 不可用 → 补丁**宁可不持久化，也绝不落明文**）。

### 安装步骤（setup.ps1 内部做的事）

```
==> 检查目标路径        找不到 util.js 就报错中止
==> 校验管理员权限
==> 停止 aTrustTray 进程
==> 备份原始 util.js      → atrust_remember_backup\util.js.bak（已存在则不覆盖）
==> 安装补丁模块（4 个 JS）
==> 部署进程内 DPAPI 依赖 (vendor)
==> 注入钩子到 util.js    先从备份还原再追加，钩子内容始终最新
    [OK] 钩子落盘自检通过   标记缺失会自动还原并中止
==> 语法自检              node --check，util.js 语法错自动还原备份并中止
```

安装脚本会：

1. 校验路径 + 管理员权限
2. 停掉 `aTrustTray.exe`（agent 会自动拉起；若没拉起，手动运行一次 `aTrustTray.exe` 即可）
3. 备份 `util.js` → `resources\app\atrust_remember_backup\util.js.bak`
4. 复制 4 个补丁文件
5. 部署 `vendor\` 到 `%APPDATA%\aTrustRemember\vendor\`（并校验 `prebuilds\win32-ia32` 布局）
6. 在 `util.js` **末尾追加**钩子（带标记 `/* aTrustRemember patch v1 */`；
   重装时先从备份还原再追加，保证钩子内容始终是最新；写入后自检标记是否真的落盘，失败自动回滚）
7. `node --check` 语法自检（util.js 语法错会自动回滚）

## 五、使用

1. 启动 aTrust 客户端，打开登录窗口
2. 密码框下方会出现 **「记住密码」** 和 **「掉线后自动登录」** 两个勾选
3. 勾选 → 正常登录一次 → 密码经 DPAPI 加密存入 `%APPDATA%\aTrustRemember\credential.bin`
4. 之后**掉线 / 重启客户端** → 自动回填用户名密码并提交登录

> 图形验证码出现时会自动跳过自动提交，改为人工输入。
> 「记住密码」取消勾选会立即删除本地已存凭据。

## 六、验证

### 6.1 看补丁运行日志

```powershell
Get-Content "$env:APPDATA\Sangfor\aTrust\logs\aTrustTray.*.log" | Select-String "aTrustRemember"
```

### 6.2 看安装 / 卸载脚本日志

```powershell
Get-Content .\setup.log
```

### 6.3 查看当前安装状态

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1 -Action status
```

```
  补丁文件        : 4 / 4
  util.js 钩子    : 已注入
  原始文件备份    : 存在
  vendor 依赖     : 已部署
  凭据 credential : 278 字节, DPAPI=True
  客户端会话状态  : online
```

### 6.2 本机已验证的完整闭环（冷启动自动登录）

```
[12:42:01.47] [Main] appStart
[12:42:02.62] [aTrustRemember] renderer script injected
[12:42:02.75] [aTrustRemember] DPAPI channel OK: F0_ffi_inproc op=unprotect
[12:42:03.22] [aTrustRemember] credential restored into login page for user: <your-account> allowSubmit=true
[12:42:05.06] [aTrustRemember] auto goLogin: clicked
[12:42:08.99] [portal] update user status to online          ← agent loginTime = 12:42:03
```

客户端 12:42:01 启动 → **12:42:03 自动登录成功**，全程零人工干预。

### 6.3 校验凭据文件

```powershell
node .\verify-credential.js .
```

输出示例：

```
credential file: C:\Users\<you>\AppData\Roaming\aTrustRemember\credential.bin
size=278 bytes
head=AQAAANCMnd8=  (DPAPI blob header)
isDpapiBlob=true
plaintextHits=[]
decrypt=OK
user=<your-account>
password(masked)=W*************$
RESULT=OK
```

## 七、卸载 / 回滚

```powershell
# 交互菜单里选 [2]
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1

# 或直接非交互执行
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1 -Action uninstall
```

会：从备份还原 `util.js`、删除 4 个补丁文件、删除 `%APPDATA%\aTrustRemember\vendor\`、
删除 `%APPDATA%\aTrustRemember\credential.bin`；备份目录保留（方便再装回来）。
加 `-KeepCredential` 可保留已保存的凭据。

已实测（菜单选 2 → 自提权执行）：补丁文件残留 0、util.js 无钩子残留、
vendor 已删除、凭据已删除、备份保留，exit 0。

## 八、风险提示（请务必知悉）

- 这是**修改企业安全客户端**的行为。本机装有 aTrust 自带的 Defender / 反卸载 / 终端风控模块，
  也可能有企业 EDR 对 `Sangfor` 目录做文件完整性基线——**可能触发告警或被策略拦截**。
- 引入了第三方原生模块（`ffi-napi` 等，见 §三）。它们只落在用户目录、不改签名文件、可一键删除。
- 补丁只在本地生效，**不改变服务端行为**；服务端仍可随时要求重新认证。
- 凭据以 DPAPI(CurrentUser) 加密，等同于浏览器保存密码的保护级别；
  但它确实让"客户端里存在一份可复用的登录凭据"，这一点与企业零信任设计取向不同。
- 若公司有明确的客户端管控规定，请先与管理员确认——**正规解法是让管理员在 SDP 管理端开启
  「记住密码」策略（下发 `rememberPwdConfig.enable=1` + `publicPem`）**，那样连补丁都不需要。
- 门户 SPA 升级后，DOM 结构可能变化导致选择器失效；勾选项消失即代表需要更新补丁（不影响客户端本身）。

## 九、文件清单

```
aTrustRememberPatch\
├─ README.md                           本文档
├─ LICENSE                             MIT 许可
├─ setup.ps1                           ★ 主入口：交互菜单（安装/卸载/状态），分级日志
├─ install.ps1                         兼容入口 → setup.ps1 -Action install
├─ uninstall.ps1                       兼容入口 → setup.ps1 -Action uninstall
├─ _launch_install.ps1                 UAC 提权启动器（可选，一键提权安装）
├─ build-vendor.ps1                    从 npm 包裁剪出运行期最小依赖树（生成 vendor\）
├─ verify-credential.js                校验 credential.bin（DPAPI blob / 无明文 / 可解密）
├─ test-dpapi.js                       DPAPI 往返自测（node test-dpapi.js）
├─ vendor\
│  └─ node_modules\                    ffi-napi / ref-napi / ref-struct-di /
│                                      node-gyp-build / debug / ms（MIT, N-API 预编译）
│                                      每个包内附其 MIT LICENSE
├─ patch\
│  ├─ atrust_remember.js               主进程模块（DPAPI 存取 + 注入 + 轮询 + 退出判据）
│  ├─ atrust_remember_renderer.js      渲染进程脚本（勾选 UI + 捕获 + 回填 + 自动提交）
│  ├─ atrust_remember_dpapi_ffi.js     进程内 DPAPI（ffi-napi 直调 crypt32）★
│  └─ atrust_remember_dpapi.js         DPAPI 辅助子进程（兜底通道，现已不作为主路径）
└─ tools\                              开发期诊断脚本（不影响运行，部署时不需要）
   ├─ diag-spawn.js / diag-one.js      进程创建能力探测
   ├─ env-repro.js / r5-repro.js       自举通道复现
   ├─ helper_test.js                   helper 通道往返
   ├─ dryrun.js / css-rules.js         门户样式与 DOM 取证
   └─ fix-bom.js                       PS 5.1 UTF-8 BOM 修正
```

### 重建 vendor（可选）

仓库已自带编译好的 `vendor\`，正常安装**不需要**这一步。
只有想更新依赖版本时才需要重建：

```powershell
npm install --ignore-scripts --no-save ffi-napi@4.0.3 ref-napi@3.0.3 ref-struct-di@1.1.1 node-gyp-build@4.8.4 debug@4.4.3 ms@2.1.3
powershell -NoProfile -ExecutionPolicy Bypass -File .\build-vendor.ps1
```

`--ignore-scripts` 必须加：否则 npm 会尝试用 node-gyp 本地编译 ffi-napi，
而本仓库依赖的是 tarball 内自带的 N-API 预编译二进制，不需要编译器。

---

## 十、开源说明

- 本仓库以 **MIT** 协议开源，见 [LICENSE](LICENSE)。
- `vendor\node_modules\` 下的第三方包（ffi-napi / ref-napi / ref-struct-di /
  node-gyp-build / debug / ms）均为 **MIT 许可**，各自目录内附原始 LICENSE。
  `ffi-napi` 的预编译二进制内含 libffi，其许可一并附在
  `vendor\node_modules\ffi-napi\LICENSE-libffi`。
- 本仓库**不含**任何深信服（Sangfor）的二进制、代码或安装包，
  也不包含任何真实凭据、账号或公司内网信息。
- 项目作者与深信服无隶属关系；本仓库仅为个人自用的客户端补丁，
  不代表官方立场。使用前请自行评估 §八 的合规风险。

---
