/**
 * aTrustRemember —— DPAPI 辅助进程（独立文件）
 *
 * 由主进程以「纯 Node 模式」拉起：
 *   spawn(process.execPath, [本文件, op, inFile, outFile], { env: { ..., ELECTRON_RUN_AS_NODE: "1" } })
 *
 * 为什么需要它：
 *   aTrust 托盘的「浏览器进程」被自保护策略禁止创建非深信服签名的子进程
 *   （powershell / cmd / whoami / explorer 一律 EPERM）；
 *   但用「自身 exe 以 ELECTRON_RUN_AS_NODE 模式」自举的纯 Node 子进程是允许的，
 *   而纯 Node 上下文里 spawn powershell 一切正常。
 *   所以 DPAPI(CryptProtectData) 必须放到这个纯 Node 子进程里做。
 *
 * 用法（三种模式，按可靠性排序）：
 *   1) 文件模式   node dpapi.js protect <inFile>  <outFile>   ← 推荐，绕开 stdout 管道
 *   2) argv 模式  node dpapi.js protect <base64>              ← 输出到 stdout
 *   3) stdin 模式 node dpapi.js protect                      ← 输出到 stdout
 *
 * 文件模式会额外写两个伴生文件，便于诊断：
 *   <outFile>.hb   心跳：证明 helper 确实以 node 模式跑起来了
 *   <outFile>.err  失败原因
 *
 * 本文件不含任何密钥或口令。
 */
"use strict";

var fs = require("fs");
var cp = require("child_process");

var PS_ABS = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

var op = process.argv[2] || "";
var a3 = process.argv[3] || "";
var a4 = process.argv[4] || "";
var fileMode = !!a4;

function dpapiExpr() {
  return op === "protect"
    ? "[System.Security.Cryptography.ProtectedData]::Protect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)"
    : "[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)";
}

function runPs(inputB64) {
  var cmd =
    "$ErrorActionPreference='Stop';" +
    "Add-Type -AssemblyName System.Security;" +
    "$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());" +
    "$r=" + dpapiExpr() + ";" +
    "[Console]::Out.Write([Convert]::ToBase64String($r))";
  var r = cp.spawnSync(
    PS_ABS,
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", cmd],
    { input: inputB64, encoding: "utf8", maxBuffer: 8388608, windowsHide: true, timeout: 20000 }
  );
  if (r.error) {
    throw new Error("ps spawn error code=" + (r.error.code || "") + " msg=" + String(r.error.message || ""));
  }
  if (r.status !== 0) {
    throw new Error("ps exit=" + r.status + " stderr=" + String(r.stderr || "").slice(0, 300));
  }
  return String(r.stdout || "").trim();
}

function finish(inputB64) {
  var out = runPs(inputB64);
  if (!out) throw new Error("empty dpapi output");
  if (fileMode) {
    fs.writeFileSync(a4, out, "utf8");
  } else {
    process.stdout.write(out);
  }
}

if (fileMode) {
  // 心跳：证明 helper 确实以 node 模式执行到了这里
  try { fs.writeFileSync(a4 + ".hb", String(Date.now()), "utf8"); } catch (e) {}
  try {
    finish(fs.readFileSync(a3, "utf8"));
  } catch (e) {
    try { fs.writeFileSync(a4 + ".err", String((e && e.message) || e), "utf8"); } catch (x) {}
    process.exit(2);
  }
} else if (a3) {
  try {
    finish(a3);
  } catch (e) {
    process.stderr.write(String((e && e.message) || e));
    process.exit(2);
  }
} else {
  var buf = "";
  process.stdin.on("data", function (d) { buf += d; });
  process.stdin.on("end", function () {
    try {
      finish(buf);
    } catch (e) {
      process.stderr.write(String((e && e.message) || e));
      process.exit(2);
    }
  });
}
