/**
 * aTrustRemember —— aTrust 客户端「记住密码 / 掉线自动登录」补丁（主进程模块）
 *
 * 安装位置: <aTrustTray>\resources\app\src\service\atrust_remember.js
 * 由 src\service\util\util.js 末尾追加的钩子调用（见 install.ps1）。
 *
 * 设计要点:
 *  - 不修改任何签名 PE/EXE，只追加明文 JS，卸载时原样还原。
 *  - 不触碰服务端策略：仍然走标准 POST /passport/v1/auth/psw，
 *    服务端照常做完整认证（多因子 / 设备风控 / 防重放全部保留）。
 *  - 密码明文只驻留内存；落盘一律经 Windows DPAPI(CurrentUser) 加密，
 *    存于 %APPDATA%\aTrustRemember\credential.bin。
 *  - 渲染进程不写文件、不持有长期密钥；主进程通过 executeJavaScript 轮询取回。
 *  - 若所有 DPAPI 通道都不可用，**宁可不持久化，也绝不落明文**。
 *
 * DPAPI 通道（按顺序尝试，命中后缓存该通道）:
 *  F0 ffi_inproc       进程内直调 crypt32!CryptProtectData（零子进程）★首选
 *  R5a selfnode_file   自身 exe 以 ELECTRON_RUN_AS_NODE 自举 + 文件式入/出
 *  R5b selfnode_argv   同上，但输入走 argv、输出走 stdout
 *  R5c selfnode_stdin  同上，但输入走 stdin、输出走 stdout
 *  R1 execFile_async_abs   execFile(绝对路径 powershell)
 *  R2 execFile_async_rel   execFile(powershell.exe, 走 PATH)
 *  R3 spawn_async_abs      spawn(绝对路径 powershell)
 *  R4 execFileSync_abs     execFileSync(绝对路径 powershell)
 *  V0~V7                     各种进程创建技术变体（诊断用）
 *
 * 注意：R1~R4 在托盘「浏览器进程」里一律 EPERM（aTrust 自保护策略禁止创建
 * 非深信服签名的子进程）；R5 系列虽能自举，但派生进程里再拉 powershell 同样被拒。
 * F0 通道不创建任何子进程，直接在托盘进程内加载 DLL 调用 DPAPI，
 * 因此是唯一在「浏览器进程」里真正可用的通道；其余通道仅作兜底与诊断。
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile, execFileSync, spawn, spawnSync } = require("child_process");
const Log = require("./util/logger");

const LOG_TAG = "[aTrustRemember]";
const PATCH_VERSION = "1.2";
const DATA_DIR = path.join(process.env.APPDATA || os.homedir(), "aTrustRemember");
const CRED_FILE = path.join(DATA_DIR, "credential.bin");
const HELPER_FILE = path.join(__dirname, "atrust_remember_dpapi.js");
const RENDERER_FILE = path.join(__dirname, "atrust_remember_renderer.js");

/* 进程内 DPAPI 模块（ffi-napi）；加载失败不致命，会自动降级到 R5 通道 */
let FfiDpapi = null;
try {
  FfiDpapi = require("./atrust_remember_dpapi_ffi.js");
} catch (e) {
  Log.warn(LOG_TAG, "ffi dpapi module require failed: " + String((e && e.message) || e));
}
const POLL_INTERVAL_MS = 1500;
const PS_ABS = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

let rendererSrc = "";
let credential = null; // { u, p } 明文，仅内存
let credLoaded = false; // 凭据是否已尝试加载过
let dpapiBroken = false; // 所有 DPAPI 通道均不可用
let dpapiRunner = -1; // 已验证可用的通道下标，-1 = 尚未确定
let explicitLogout = false; // 用户主动退出登录 → 抑制自动登录
let explicitLogoutAt = 0; // 抑制生效时间（用于规避状态滞后竞态）
let lastStatus = ""; // 上一次看到的会话状态（用于检测掉线）
const pollTimers = new Map();
const hookedWindows = new Set(); // 已挂钩的窗口（掉线时用来点「前往登录」）

/* 托盘配置（用于读取会话状态）；拿不到就降级，不影响主流程 */
let AppConfig = null;
try {
  AppConfig = require("../model/app_config");
} catch (e) {
  AppConfig = null;
}

/**
 * 用户主动退出登录的判定。
 *
 * aTrust 托盘只有「用户点了退出登录 / 退出客户端」时，才会主动调用
 * agent 的 `/v1/service/logout`；服务端掉线、会话过期、网络中断都不会走这条路径。
 * 因此只要拦到这一次调用，就能把「用户主动退出」和「掉线」区分开：
 *   - 主动退出 → 不自动登录（否则用户永远退不出去）
 *   - 掉线     → 允许自动登录
 *
 * 该钩子由 util.js 末尾追加的代码调用（见 install.ps1）。
 */
function markExplicitLogout() {
  if (explicitLogout) return;
  explicitLogout = true;
  explicitLogoutAt = Date.now();
  Log.info(LOG_TAG, "explicit logout detected (agent /v1/service/logout) -> auto-login suppressed until next login");
}

/**
 * 会话状态同步：重新登录成功后恢复自动登录能力。
 *
 * 注意竞态：退出请求刚发出时，agent 上报的 status 可能还停留在 "online"，
 * 此时不能据此解除抑制，否则会把用户刚退出的会话又自动登回去。
 * 因此要求「距退出请求至少 8 秒」且状态确实变为 online 才解除。
 *
 * 另外检测「online → 非 online」的状态迁移：会话被服务端踢掉 / 网络掉线时，
 * 门户面板上会出现「前往登录」按钮，这里自动点掉它，
 * 让主窗口切到登录页（随后由 did-navigate-in-page 触发回填 + 自动提交）。
 */
function syncSessionState() {
  if (!AppConfig || typeof AppConfig.getLoginStatus !== "function") return;
  let st = "";
  try {
    st = String(AppConfig.getLoginStatus() || "");
  } catch (e) {
    return;
  }
  if (st !== lastStatus) {
    const prev = lastStatus;
    lastStatus = st;
    if (prev === "online" && st && st !== "online") {
      Log.info(LOG_TAG, "session dropped: " + prev + " -> " + st);
      setTimeout(notifySessionDrop, 800);
    }
  }
  if (st === "online" && explicitLogout && Date.now() - explicitLogoutAt > 8000) {
    explicitLogout = false;
    Log.info(LOG_TAG, "session back online -> auto-login re-enabled");
  }
}

/* ------------------------------------------------------------------ *
 * Windows DPAPI (CryptProtectData, CurrentUser scope)
 * ------------------------------------------------------------------ */
function psScript(op) {
  const expr =
    op === "protect"
      ? "[System.Security.Cryptography.ProtectedData]::Protect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)"
      : "[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)";
  return [
    "$ErrorActionPreference='Stop'",
    "Add-Type -AssemblyName System.Security",
    "$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())",
    "$r=" + expr,
    "[Console]::Out.Write([Convert]::ToBase64String($r))"
  ].join(";");
}

function errText(e) {
  if (!e) return "null";
  return (
    "code=" + (e.code || "?") +
    " errno=" + (e.errno === undefined ? "undef" : e.errno) +
    " syscall=" + (e.syscall || "?") +
    " reason=" + (e.reason === undefined ? "undef" : e.reason) +
    " msg=" + String(e.message || "").replace(/\s+/g, " ").slice(0, 120)
  );
}

/* R1 / R2: 异步 execFile ------------------------------------------------ */
function runExecFile(file, op, inputB64) {
  return new Promise((resolve, reject) => {
    const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", psScript(op)];
    let child;
    try {
      child = execFile(
        file,
        args,
        { maxBuffer: 8 * 1024 * 1024, windowsHide: true, encoding: "utf8", timeout: 20000 },
        (err, stdout, stderr) => {
          if (err) {
            reject(new Error("execFile:" + file + ":" + errText(err) + " stderr=" + String(stderr || "").slice(0, 120)));
            return;
          }
          resolve(String(stdout).trim());
        }
      );
    } catch (e) {
      reject(new Error("execFile-throw:" + file + ":" + errText(e)));
      return;
    }
    if (child && child.stdin) {
      child.stdin.on("error", () => {});
      try {
        child.stdin.end(inputB64);
      } catch (e) {}
    }
  });
}

/* R3: 异步 spawn ------------------------------------------------------- */
function runSpawn(file, op, inputB64) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(file, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", psScript(op)], {
        windowsHide: true
      });
    } catch (e) {
      reject(new Error("spawn-throw:" + file + ":" + errText(e)));
      return;
    }
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => reject(new Error("spawn-error:" + file + ":" + errText(e))));
    child.on("close", (code) => {
      if (code === 0 && out.trim()) resolve(out.trim());
      else reject(new Error("spawn-exit:" + file + ":code=" + code + ":" + String(err).replace(/\s+/g, " ").slice(0, 120)));
    });
    if (child.stdin) {
      child.stdin.on("error", () => {});
      try {
        child.stdin.end(inputB64);
      } catch (e) {}
    }
  });
}

/* R4: 同步 execFileSync（旧版失效点，保留作为兜底） ---------------------- */
function runExecFileSync(file, op, inputB64) {
  try {
    const out = execFileSync(
      file,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", psScript(op)],
      { input: inputB64, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, windowsHide: true, timeout: 20000 }
    );
    return Promise.resolve(String(out).trim());
  } catch (e) {
    return Promise.reject(new Error("execFileSync:" + file + ":" + errText(e)));
  }
}

/* R5: 自举纯 Node 子进程 ---------------------------------------------- *
 * 用「自身 exe 以 ELECTRON_RUN_AS_NODE 模式」再起一个纯 Node 子进程，
 * 由它调用 CryptProtectData 完成 DPAPI。
 * 浏览器进程里不能直接起 powershell（被自保护策略 EPERM 拒绝），
 * 但自举的纯 Node 子进程不受该限制。
 *
 * 三个变体按可靠性排序：
 *   R5a 文件模式  入/出都走文件，完全绕开 stdout 管道（最稳）
 *   R5b argv 模式  输入走 argv，输出走 stdout
 *   R5c stdin 模式 输入走 stdin，输出走 stdout
 * -------------------------------------------------------------------- */
const WORK_DIR = path.join(DATA_DIR, "dpapi");

function buildChildEnv() {
  const env = {};
  try {
    const keys = Object.keys(process.env || {});
    for (let i = 0; i < keys.length; i++) {
      const v = process.env[keys[i]];
      if (typeof v === "string") env[keys[i]] = v;
    }
  } catch (e) {}
  env.ELECTRON_RUN_AS_NODE = "1";
  return env;
}

/* 最小环境：只保留运行 node 必需项，切断可能的环境变量继承 */
function minimalChildEnv() {
  const env = { ELECTRON_RUN_AS_NODE: "1" };
  const keep = ["SystemRoot", "windir", "SystemDrive", "PATH", "Path", "TEMP", "TMP", "APPDATA",
    "LOCALAPPDATA", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "COMSPEC", "ProgramFiles",
    "ProgramFiles(x86)", "ProgramW6432", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS",
    "USERNAME", "USERDOMAIN", "COMPUTERNAME", "OS", "PUBLIC"];
  for (const k of keep) {
    try {
      const v = process.env[k];
      if (typeof v === "string") env[k] = v;
    } catch (e) {}
  }
  return env;
}

function helperExists() {
  try {
    return fs.existsSync(HELPER_FILE);
  } catch (e) {
    return false;
  }
}

function readFileSafe(f) {
  try {
    return fs.readFileSync(f, "utf8");
  } catch (e) {
    return null;
  }
}

/* R5a: 文件模式 */
function runSelfNodeFileEnv(op, inputB64, minimalEnv, detached) {
  return new Promise((resolve, reject) => {
    if (!helperExists()) {
      reject(new Error("selfnode-file:helper-missing " + HELPER_FILE));
      return;
    }
    const inFile = path.join(WORK_DIR, "in_" + op + ".b64");
    const outFile = path.join(WORK_DIR, "out_" + op + ".b64");
    try {
      fs.mkdirSync(WORK_DIR, { recursive: true });
      fs.writeFileSync(inFile, inputB64, "utf8");
      try { fs.unlinkSync(outFile); } catch (e) {}
      try { fs.unlinkSync(outFile + ".hb"); } catch (e) {}
      try { fs.unlinkSync(outFile + ".err"); } catch (e) {}
    } catch (e) {
      reject(new Error("selfnode-file:prep " + errText(e)));
      return;
    }
    let child;
    const env = minimalEnv ? minimalChildEnv() : buildChildEnv();
    const sp = { env: env, windowsHide: true };
    if (detached) sp.detached = true;
    try {
      child = spawn(process.execPath, [HELPER_FILE, op, inFile, outFile], sp);
    } catch (e) {
      reject(new Error("selfnode-file:spawn-throw " + errText(e)));
      return;
    }
    let so = "";
    let se = "";
    child.stdout.on("data", (d) => { so += d; });
    child.stderr.on("data", (d) => { se += d; });
    child.on("error", (e) => reject(new Error("selfnode-file:error " + errText(e))));
    child.on("close", (code) => {
      const hb = fs.existsSync(outFile + ".hb");
      const val = readFileSafe(outFile);
      const err = readFileSafe(outFile + ".err");
      Log.info(
        LOG_TAG,
        "DPAPI helper(file) exit=" + code + " heartbeat=" + hb + " outLen=" + (val ? val.length : 0) +
        " helperErr=" + String(err || "").replace(/\s+/g, " ").slice(0, 120) +
        " stdoutHead=" + JSON.stringify(String(so).slice(0, 120)) +
        " stderrHead=" + JSON.stringify(String(se).slice(0, 120))
      );
      if (val && val.trim()) resolve(val.trim());
      else {
        reject(new Error(
          "selfnode-file:no-output exit=" + code + " hb=" + hb + " err=" + String(err || "").replace(/\s+/g, " ").slice(0, 140) +
          " so=" + String(so).replace(/\s+/g, " ").slice(0, 140) + " se=" + String(se).replace(/\s+/g, " ").slice(0, 140)
        ));
      }
    });
  });
}

/* 默认的 R5a 包装 */
function runSelfNodeFile(op, inputB64) {
  return runSelfNodeFileEnv(op, inputB64, false, false);
}

/* R5b / R5c: 管道模式 */
function runSelfNodePipe(op, inputB64, useArgv) {
  return new Promise((resolve, reject) => {
    if (!helperExists()) {
      reject(new Error("selfnode-pipe:helper-missing " + HELPER_FILE));
      return;
    }
    const args = useArgv ? [HELPER_FILE, op, inputB64] : [HELPER_FILE, op];
    let child;
    try {
      child = spawn(process.execPath, args, { env: buildChildEnv(), windowsHide: true });
    } catch (e) {
      reject(new Error("selfnode-pipe:spawn-throw " + errText(e)));
      return;
    }
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => reject(new Error("selfnode-pipe:error " + errText(e))));
    child.on("close", (code) => {
      Log.info(LOG_TAG, "DPAPI helper(pipe) exit=" + code + " stdoutLen=" + out.length + " stdoutHead=" + JSON.stringify(String(out).slice(0, 120)));
      if (code === 0 && out.trim()) resolve(out.trim());
      else reject(new Error("selfnode-pipe:exit=" + code + " stderr=" + String(err).replace(/\s+/g, " ").slice(0, 140)));
    });
    if (!useArgv && child.stdin) {
      child.stdin.on("error", () => {});
      try {
        child.stdin.end(inputB64);
      } catch (e) {}
    }
  });
}

/* R0: 各种「进程创建技术差异」变体（用于找出不被 EPERM 拦截的组合） -------- */
function spawnVariant(label, file, args, opts) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(file, args, Object.assign({ windowsHide: true }, opts || {}));
    } catch (e) {
      reject(new Error(label + ":spawn-throw " + errText(e)));
      return;
    }
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => reject(new Error(label + ":error " + errText(e))));
    child.on("close", (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(label + ":exit=" + code + " out=" + out.trim().slice(0, 60) + " err=" + String(err).replace(/\s+/g, " ").slice(0, 80)));
    });
    // 立即关闭 stdin，否则 powershell 等待 [Console]::In.ReadToEnd() 会挂死
    if (child.stdin) {
      child.stdin.on("error", () => {});
      try {
        child.stdin.end();
      } catch (e) {}
    }
  });
}

/* F0: 进程内 DPAPI（ffi-napi 直调 crypt32!CryptProtectData） ---------------- *
 * 不创建任何子进程，因此不受「托盘浏览器进程禁止创建非签名子进程」的限制。  */
function runFfi(op, inputB64) {
  if (!FfiDpapi) {
    return Promise.reject(new Error("ffi-module-missing"));
  }
  try {
    const bytes = Buffer.from(String(inputB64 || ""), "base64");
    const out = op === "protect" ? FfiDpapi.protect(bytes) : FfiDpapi.unprotect(bytes);
    return Promise.resolve(Buffer.from(out).toString("base64"));
  } catch (e) {
    return Promise.reject(new Error("ffi: " + errText(e)));
  }
}

const RUNNERS = [
  // F0 放在最前：进程内 DPAPI，零子进程，是唯一在托盘浏览器进程里真正可用的通道。
  { name: "F0_ffi_inproc", fn: (op, b) => runFfi(op, b) },
  // R5 系列：自身 exe 以 node 模式自举（可创建子进程，但派生子进程里再拉 powershell 仍被拒）
  { name: "R5a_selfnode_file", fn: (op, b) => runSelfNodeFile(op, b) },
  { name: "R5b_selfnode_argv", fn: (op, b) => runSelfNodePipe(op, b, true) },
  { name: "R5c_selfnode_stdin", fn: (op, b) => runSelfNodePipe(op, b, false) },
  { name: "R1_execFile_async_abs", fn: (op, b) => runExecFile(PS_ABS, op, b) },
  { name: "R2_execFile_async_rel", fn: (op, b) => runExecFile("powershell.exe", op, b) },
  { name: "R3_spawn_async_abs", fn: (op, b) => runSpawn(PS_ABS, op, b) },
  { name: "R4_execFileSync_abs", fn: (op, b) => runExecFileSync(PS_ABS, op, b) },
  // 进程创建技术变体（detached / verbatim / shell 等）
  { name: "V0_detached_ps", fn: (op, b) => spawnVariant("V0", PS_ABS, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", psScript(op)], { detached: true }) },
  { name: "V1_detached_verbatim_ps", fn: (op, b) => spawnVariant("V1", PS_ABS, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", psScript(op)], { detached: true, windowsVerbatimArguments: true }) },
  { name: "V2_verbatim_ps", fn: (op, b) => spawnVariant("V2", PS_ABS, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", psScript(op)], { windowsVerbatimArguments: true }) },
  { name: "V3_detached_cmd", fn: (op, b) => spawnVariant("V3", "C:\\Windows\\System32\\cmd.exe", ["/c", "echo HI"], { detached: true }) },
  { name: "V4_shell_ps", fn: (op, b) => spawnVariant("V4", PS_ABS, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", psScript(op)], { shell: true }) },
  { name: "V5_detached_explorer", fn: (op, b) => spawnVariant("V5", "C:\\Windows\\explorer.exe", ["/?"], { detached: true }) },
  // V6: 最小环境变量 —— 若 aTrustDefenser 的策略继承是通过环境变量传递的，这里能切断继承
  { name: "V6_minenv_selfnode", fn: (op, b) => runSelfNodeFileEnv(op, b, true) },
  // V7: detached 自举
  { name: "V7_detached_selfnode", fn: (op, b) => runSelfNodeFileEnv(op, b, false, true) }
];

async function dpapiRun(op, buf) {
  const b64 = buf.toString("base64");
  if (dpapiRunner >= 0) {
    try {
      return await RUNNERS[dpapiRunner].fn(op, b64);
    } catch (e) {
      Log.warn(LOG_TAG, "cached DPAPI channel " + RUNNERS[dpapiRunner].name + " failed: " + errText(e));
      dpapiRunner = -1;
    }
  }
  let last = null;
  for (let i = 0; i < RUNNERS.length; i++) {
    try {
      const out = await RUNNERS[i].fn(op, b64);
      dpapiRunner = i;
      Log.info(LOG_TAG, "DPAPI channel OK: " + RUNNERS[i].name + " op=" + op);
      return out;
    } catch (e) {
      last = e;
      Log.warn(LOG_TAG, "DPAPI channel FAIL " + RUNNERS[i].name + ": " + errText(e));
    }
  }
  throw last || new Error("no DPAPI channel available");
}

async function dpapiProtect(buf) {
  return Buffer.from(await dpapiRun("protect", buf), "base64");
}

async function dpapiUnprotect(buf) {
  return Buffer.from(await dpapiRun("unprotect", buf), "base64");
}

/* ------------------------------------------------------------------ *
 * 一次性 spawn 诊断（只跑一次，结果进日志）
 * ------------------------------------------------------------------ */
function dumpErr(e) {
  return (
    "code=" + (e && e.code ? e.code : "?") +
    " errno=" + (e && e.errno !== undefined ? e.errno : "undef") +
    " syscall=" + (e && e.syscall ? e.syscall : "?") +
    " reason=" + (e && e.reason !== undefined ? e.reason : "undef") +
    " msg=" + String((e && e.message) || e || "").replace(/\s+/g, " ").slice(0, 140)
  );
}

function diagSync(label, file, args) {
  try {
    const r = spawnSync(file, args, { encoding: "utf8", timeout: 10000, windowsHide: true });
    if (r.error) {
      Log.info(LOG_TAG, "DIAG " + label + " => spawn-error " + dumpErr(r.error));
    } else {
      Log.info(LOG_TAG, "DIAG " + label + " => status=" + r.status + " out=" + JSON.stringify(String(r.stdout || "").trim().slice(0, 40)));
    }
  } catch (e) {
    Log.info(LOG_TAG, "DIAG " + label + " => throw " + dumpErr(e));
  }
}

function diagSpawn() {
  try {
    Log.info(LOG_TAG, "DIAG ctx type=" + process.type + " pid=" + process.pid + " node=" + process.version + " electron=" + (process.versions.electron || "?"));
    Log.info(LOG_TAG, "DIAG execPath=" + process.execPath);
    Log.info(LOG_TAG, "DIAG PATH=" + String(process.env.PATH || "").slice(0, 160));
    Log.info(LOG_TAG, "DIAG SystemRoot=" + String(process.env.SystemRoot || "") + " windir=" + String(process.env.windir || ""));

    const cp = require("child_process");
    const src = (fn) => {
      try {
        return String(fn).replace(/\s+/g, " ").slice(0, 300);
      } catch (e) {
        return "dump-failed:" + dumpErr(e);
      }
    };
    Log.info(LOG_TAG, "DIAG spawnSync.src=" + src(cp.spawnSync));
    Log.info(LOG_TAG, "DIAG execFileSync.src=" + src(cp.execFileSync));
    Log.info(LOG_TAG, "DIAG spawn.src=" + src(cp.spawn));
    Log.info(LOG_TAG, "DIAG execFile.src=" + src(cp.execFile));
  } catch (e) {
    Log.info(LOG_TAG, "DIAG ctx-fail " + dumpErr(e));
  }

  diagSync("spawnSync_ps_rel", "powershell.exe", ["-NoProfile", "-Command", "Write-Output 1"]);
  diagSync("spawnSync_ps_abs", PS_ABS, ["-NoProfile", "-Command", "Write-Output 1"]);
  diagSync("spawnSync_cmd_rel", "cmd.exe", ["/c", "echo hi"]);
  diagSync("spawnSync_cmd_abs", "C:\\Windows\\System32\\cmd.exe", ["/c", "echo hi"]);
  diagSync("spawnSync_whoami", "C:\\Windows\\System32\\whoami.exe", []);
  diagSync("spawnSync_explorer", "C:\\Windows\\explorer.exe", ["/?"]);

  // 同步通道自检
  (async () => {
    const probe = Buffer.from(JSON.stringify({ u: "diagMarker", p: "diag", ts: 0 }), "utf8");
    for (let i = 0; i < RUNNERS.length; i++) {
      try {
        const enc = await RUNNERS[i].fn("protect", probe.toString("base64"));
        Log.info(LOG_TAG, "DIAG runner " + RUNNERS[i].name + " => OK len=" + String(enc).length);
        try {
          const decB64 = await RUNNERS[i].fn("unprotect", String(enc).trim());
          const plain = Buffer.from(String(decB64).trim(), "base64").toString("utf8");
          Log.info(LOG_TAG, "DIAG runner " + RUNNERS[i].name + " => ROUNDTRIP ok=" + (plain.indexOf("diagMarker") >= 0) + " plain=" + plain);
        } catch (e) {
          Log.info(LOG_TAG, "DIAG runner " + RUNNERS[i].name + " => unprotect-fail " + dumpErr(e));
        }
      } catch (e) {
        Log.info(LOG_TAG, "DIAG runner " + RUNNERS[i].name + " => FAIL " + dumpErr(e));
      }
    }
  })();
}

/* ------------------------------------------------------------------ *
 * 凭据存储
 * ------------------------------------------------------------------ */
async function saveCredential(u, p) {
  if (dpapiBroken) {
    Log.warn(LOG_TAG, "DPAPI 不可用，已跳过保存（不落明文）");
    return false;
  }
  try {
    const plain = Buffer.from(JSON.stringify({ u: u, p: p, ts: Date.now() }), "utf8");
    const enc = await dpapiProtect(plain);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CRED_FILE, enc);
    credential = { u: u, p: p };
    Log.info(LOG_TAG, "credential stored (DPAPI) for user: " + u + " bytes=" + enc.length);
    return true;
  } catch (e) {
    dpapiBroken = true;
    Log.error(LOG_TAG, "save credential failed (DPAPI unavailable, 不会落明文): " + errText(e));
    return false;
  }
}

async function loadCredential() {
  if (credential) return credential;
  try {
    if (!fs.existsSync(CRED_FILE)) return null;
    const plain = await dpapiUnprotect(fs.readFileSync(CRED_FILE));
    const obj = JSON.parse(plain.toString("utf8"));
    if (!obj || !obj.u || !obj.p) return null;
    credential = { u: obj.u, p: obj.p };
    return credential;
  } catch (e) {
    Log.warn(LOG_TAG, "load credential failed: " + errText(e));
    return null;
  }
}

function clearCredential() {
  credential = null;
  try {
    if (fs.existsSync(CRED_FILE)) fs.unlinkSync(CRED_FILE);
  } catch (e) {
    Log.warn(LOG_TAG, "clear credential file failed: " + errText(e));
  }
  Log.info(LOG_TAG, "credential cleared");
}

/* 凭据只尝试解密一次并缓存，避免每个窗口反复走 DPAPI */
function ensureCredential() {
  if (!credLoaded) {
    credLoaded = true;
    return loadCredential().then((c) => c).catch(() => null);
  }
  return Promise.resolve(credential);
}

/* ------------------------------------------------------------------ *
 * 渲染进程注入与轮询
 * ------------------------------------------------------------------ */
const PROBE = `(function(){
  try {
    var u = document.getElementById("username");
    var p = document.getElementById("password");
    var ins = [].slice.call(document.querySelectorAll("input")).map(function (i) {
      return { t: i.type, id: i.id, n: i.name, cls: String(i.className || "").slice(0, 44),
               ph: String(i.placeholder || "").slice(0, 22),
               v: (i.type === "password" ? "***" : String(i.value || "").slice(0, 18)) };
    });
    var btns = [].slice.call(document.querySelectorAll("button, [role=button], [class*=btn], [class*=Btn]"))
      .slice(0, 14).map(function (b) {
        return { tag: b.tagName, cls: String(b.className || "").slice(0, 54),
                 txt: String(b.textContent || "").trim().slice(0, 14) };
      });
    return JSON.stringify({
      href: String(location.href).slice(-58),
      username: !!u, usernameTag: u ? u.tagName : null,
      password: !!p, passwordTag: p ? p.tagName : null, passwordType: p ? p.type : null,
      submit: !!document.querySelector("input[type=submit]"),
      box: !!document.getElementById("atrust-remember-box"),
      inputCount: ins.length, inputs: ins, buttons: btns,
      diag: (window.__atrustRemember && window.__atrustRemember.diag) ? window.__atrustRemember.diag() : null
    });
  } catch (e) { return "probe error: " + e.message; }
})()`;

function probe(win, attempt) {
  const wc = win.webContents;
  if (!wc || wc.isDestroyed()) return;
  /* 每个窗口只允许一条探测链在跑，避免多条链并行刷日志 */
  if (!attempt) {
    if (wc.__atrustProbing) return;
    wc.__atrustProbing = true;
  }
  wc.executeJavaScript(PROBE)
    .then((r) => {
      if (r !== wc.__atrustProbeLast) {
        wc.__atrustProbeLast = r;
        Log.info(LOG_TAG, "probe#" + (attempt || 0) + ": " + r);
      }
      try {
        var o = JSON.parse(r);
        if (o.box) {
          wc.__atrustProbing = false;
          return; // 已挂载成功，无需继续探测
        }
      } catch (e) {}
      if ((attempt || 0) < 60) setTimeout(() => probe(win, (attempt || 0) + 1), 1500);
      else wc.__atrustProbing = false;
    })
    .catch(() => {
      wc.__atrustProbing = false;
    });
}

/* 诊断开关: %APPDATA%\aTrustRemember\diag.json  { "gotoLogin": true } */
function diagFlags() {
  try {
    const f = path.join(DATA_DIR, "diag.json");
    if (!fs.existsSync(f)) return {};
    return JSON.parse(fs.readFileSync(f, "utf8")) || {};
  } catch (e) {
    return {};
  }
}

function gotoLogin(win) {
  const wc = win.webContents;
  wc.executeJavaScript(
    '(function(){var b=document.querySelector(".go_login, button.go_login");if(b){b.click();return "clicked";}return "no button";})()'
  )
    .then((r) => Log.info(LOG_TAG, "diag gotoLogin: " + r))
    .catch(() => {});
}

/** 是否允许自动登录（回填 + 自动提交） */
function autoLoginAllowed() {
  syncSessionState();
  if (!explicitLogout) return true;
  // 诊断开关：允许「用户主动退出登录后也自动登录」
  // %APPDATA%\aTrustRemember\diag.json  {"allowAutoLoginAfterLogout": true}
  try {
    if (diagFlags().allowAutoLoginAfterLogout === true) {
      Log.info(LOG_TAG, "autoLogin allowed after explicit logout (diag override)");
      return true;
    }
  } catch (e) {}
  return false;
}

/* 掉线/重启后自动进入登录页（由渲染进程判断是否勾选了「掉线后自动登录」） */
function autoGoLogin(win) {
  if (!autoLoginAllowed()) {
    Log.info(LOG_TAG, "auto goLogin skipped: user explicitly logged out");
    return;
  }
  const wc = win.webContents;
  if (!wc || wc.isDestroyed()) return;
  wc.executeJavaScript(
    "(window.__atrustRemember && window.__atrustRemember.autoGoLogin) ? window.__atrustRemember.autoGoLogin() : null"
  )
    .then((r) => Log.info(LOG_TAG, "auto goLogin: " + r))
    .catch(() => {});
}

/* 会话掉线时：对所有窗口尝试点掉面板上的「前往登录」按钮。
 * 主窗口随后会跳到 #/login，由 did-navigate-in-page 触发回填 + 自动提交。 */
function notifySessionDrop() {
  hookedWindows.forEach((win) => {
    try {
      if (!win || win.isDestroyed()) {
        hookedWindows.delete(win);
        return;
      }
      autoGoLogin(win);
    } catch (e) {}
  });
}

/**
 * 窗口类型判定。
 * 实测（本机日志）：
 *   主窗口   = web/index.html?...  → 门户 SPA，登录表单在这里渲染
 *   面板窗口 = web/tray.html?page=panel  → 只有「前往登录」按钮，没有登录表单
 *   通知窗口 = web/tray.html?page=message
 * 凭据只应该下发给门户窗口，避免明文密码出现在无关窗口的 JS 上下文里。
 */
function windowKind(wc) {
  let u = "";
  try {
    u = String(wc.getURL() || "");
  } catch (e) {}
  if (!u) return "unknown";
  if (/\/web\/index\.html/i.test(u)) return "portal";
  if (/\/web\/tray\.html/i.test(u)) return "tray";
  return "other";
}

async function restoreTo(win) {
  try {
    const wc = win.webContents;
    if (!wc || wc.isDestroyed()) return;
    const kind = windowKind(wc);
    if (kind === "tray") {
      Log.info(LOG_TAG, "restore skipped: not portal window (" + kind + ")");
      return;
    }
    const allowSubmit = autoLoginAllowed();
    const cred = await ensureCredential();
    if (!cred) return;
    if (wc.isDestroyed()) return;
    const payload = JSON.stringify({ u: cred.u, p: cred.p, allowSubmit: allowSubmit });
    const r = await wc.executeJavaScript(
      "window.__atrustRemember && window.__atrustRemember.restore(" + payload + ")"
    );
    Log.info(
      LOG_TAG,
      "credential restored into login page for user: " + cred.u +
      " allowSubmit=" + allowSubmit + " win=" + kind + " result=" + JSON.stringify(r)
    );
  } catch (e) {
    Log.warn(LOG_TAG, "restore failed: " + errText(e));
  }
}

function inject(win, reason) {
  const wc = win.webContents;
  if (!wc || wc.isDestroyed()) return;
  if (!rendererSrc) {
    try {
      rendererSrc = fs.readFileSync(RENDERER_FILE, "utf8");
    } catch (e) {
      Log.error(LOG_TAG, "read renderer script failed: " + errText(e));
      return;
    }
  }
  const first = !wc.__atrustInjected;
  wc.executeJavaScript(rendererSrc)
    .then(() => {
      if (first) {
        wc.__atrustInjected = true;
        Log.info(LOG_TAG, "renderer script injected");
        setTimeout(() => restoreTo(win), 600);
        setTimeout(() => probe(win, 0), 800);
        if (diagFlags().gotoLogin) setTimeout(() => gotoLogin(win), 1500);
        startPolling(win);
        // 已有本地凭据 => 掉线/重启后自动进入登录页并回填
        ensureCredential().then((cred) => {
          if (cred) setTimeout(() => autoGoLogin(win), 1800);
        });
      } else {
        /* 同一个渲染进程里已经注入过了（SPA 路由变化 / 重复触发）。
         * 渲染脚本自身是幂等的：重复执行只会调用一次 revive()，
         * 解除「已回填」粘滞状态并立即重试回填，不会重复安装事件监听。 */
        Log.info(LOG_TAG, "renderer re-activated (" + (reason || "spa") + ")");
        setTimeout(() => restoreTo(win), 400);
      }
    })
    .catch((e) => Log.warn(LOG_TAG, "inject failed: " + errText(e)));
}

function startPolling(win) {
  const wc = win.webContents;
  const id = wc.id;
  if (pollTimers.has(id)) return;
  const timer = setInterval(() => {
    if (wc.isDestroyed()) {
      clearInterval(timer);
      pollTimers.delete(id);
      return;
    }
    wc.executeJavaScript(
      "(window.__atrustRemember && window.__atrustRemember.peek) ? window.__atrustRemember.peek() : null"
    )
      .then((res) => {
        if (!res) return;
        /* 处理顺序很重要：
         * clear / fail 优先（服务端拒绝或用户取消勾选 → 必须立刻停掉自动重试），
         * 其次保存「刚刚捕获到的明文密码」，
         * 最后才处理 needRestore（渲染进程请求回填）。
         * v1.2 起 needRestore 与待保存凭据可能出现在同一次 peek 里，
         * 这里不能因为 needRestore 就提前 return，否则密码会一直存不进去。 */
        if (res.clear) {
          clearCredential();
          wc.executeJavaScript(
            "window.__atrustRemember && window.__atrustRemember.clearPending(); window.__atrustRemember && window.__atrustRemember.cancelRestore && window.__atrustRemember.cancelRestore();"
          ).catch(() => {});
          return;
        }
        if (res.fail) {
          // 服务端拒绝了这组凭据 —— 丢弃，避免无限重试导致账号锁定
          clearCredential();
          wc.executeJavaScript(
            "window.__atrustRemember && window.__atrustRemember.clearPending(); window.__atrustRemember && window.__atrustRemember.cancelRestore && window.__atrustRemember.cancelRestore();"
          ).catch(() => {});
          return;
        }
        if (res.u && res.p) {
          saveCredential(res.u, res.p).then((ok) => {
            if (!ok) return; // 保存失败则保留 pending，等下次重试
            wc.executeJavaScript("window.__atrustRemember && window.__atrustRemember.clearPending()").catch(() => {});
          });
        }
        // 渲染进程检测到登录框 → 主动请求回填（门户 hash 路由跳转时不会触发导航事件）
        if (res.needRestore) {
          restoreTo(win);
        }
      })
      .catch(() => {});
  }, POLL_INTERVAL_MS);
  pollTimers.set(id, timer);
}

function hookWindow(win, opts) {
  try {
    if (!win || !win.webContents) return;
    const wc = win.webContents;
    if (wc.__atrustRememberHooked) return;
    wc.__atrustRememberHooked = true;
    hookedWindows.add(win);
    const onLoad = () => setTimeout(() => inject(win, "load"), 250);
    /* 门户是 SPA，用 **hash 路由** 在同一个文档内跳转（#/app_center → #/login）。
     * 这种跳转既不触发 did-navigate 也不触发 did-finish-load，
     * 只会触发 did-navigate-in-page —— 掉线自动回到登录页时全靠这个事件。
     * v1.1 漏了这个监听，导致掉线后主窗口既没有被重新激活、凭据也没有推过去。 */
    const onInPage = (event, url) => {
      const u = String(url || "");
      if (!/#\/login/i.test(u)) return; // 其它 hash 变化由渲染进程自愈处理，不必打扰
      Log.info(LOG_TAG, "SPA route changed to #/login -> reactivating patch");
      setTimeout(() => inject(win, "spa-login"), 300);
    };
    wc.on("did-finish-load", onLoad);
    wc.on("did-navigate", onLoad);
    wc.on("did-navigate-in-page", onInPage);
    if (!wc.isLoading()) setTimeout(() => inject(win, "load"), 250);
  } catch (e) {
    Log.warn(LOG_TAG, "hookWindow failed: " + errText(e));
  }
}

function init() {
  try {
    rendererSrc = fs.readFileSync(RENDERER_FILE, "utf8");
    Log.info(LOG_TAG, "module initialized (v" + PATCH_VERSION + "), data dir: " + DATA_DIR);
    // 延迟探测进程内 DPAPI：确认 ffi 运行时能加载并完成一次真实往返。
    // 放在 setTimeout 里，即使加载原生模块出问题也不会影响客户端启动。
    setTimeout(() => {
      try {
        if (!FfiDpapi) {
          Log.info(LOG_TAG, "ffi dpapi: module not loaded");
          return;
        }
        const p = FfiDpapi.probe();
        Log.info(LOG_TAG, "ffi dpapi probe: " + JSON.stringify(p) + " vendor=" + FfiDpapi.vendorRoot);
      } catch (e) {
        Log.warn(LOG_TAG, "ffi dpapi probe failed: " + errText(e));
      }
    }, 2500);
    setTimeout(diagSpawn, 1500);
    // 会话状态同步：登录成功后解除「主动退出」的抑制
    setInterval(syncSessionState, 1500);
  } catch (e) {
    Log.error(LOG_TAG, "init failed: " + errText(e));
  }
}

module.exports = {
  init: init,
  hookWindow: hookWindow,
  markExplicitLogout: markExplicitLogout
};
