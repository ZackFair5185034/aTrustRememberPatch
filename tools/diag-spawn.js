// Spawn 诊断基线：在当前进程上下文里逐项测试子进程创建能力
// 用于区分「系统级封锁」 vs 「aTrustTray 进程级限制」
const { spawnSync, execFileSync, execFile } = require("child_process");
const PS_ABS = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const CMD = "C:\\Windows\\System32\\cmd.exe";

function sync(label, file, args) {
  try {
    const r = spawnSync(file, args, { encoding: "utf8", timeout: 10000, windowsHide: true });
    return label + " => status=" + r.status + " err=" + (r.error ? (r.error.code + "/" + r.error.message) : "none") +
      " out=" + JSON.stringify(String(r.stdout || "").trim().slice(0, 40));
  } catch (e) {
    return label + " => THROW " + (e.code || "") + " " + String(e.message || "").slice(0, 80);
  }
}

function syncIn(label, file, args) {
  try {
    const r = spawnSync(file, args, { encoding: "utf8", timeout: 10000, windowsHide: true, input: "aGk=" });
    return label + " => status=" + r.status + " err=" + (r.error ? (r.error.code + "/" + r.error.message) : "none") +
      " out=" + JSON.stringify(String(r.stdout || "").trim().slice(0, 40));
  } catch (e) {
    return label + " => THROW " + (e.code || "") + " " + String(e.message || "").slice(0, 80);
  }
}

console.log("=== context ===");
console.log("pid=" + process.pid + " exe=" + process.execPath + " ver=" + process.version);
console.log("=== sync tests ===");
console.log(sync("sync_ps_rel", "powershell.exe", ["-NoProfile", "-Command", "Write-Output 1"]));
console.log(sync("sync_ps_abs", PS_ABS, ["-NoProfile", "-Command", "Write-Output 1"]));
console.log(sync("sync_cmd", "cmd.exe", ["/c", "echo hi"]));
console.log(sync("sync_cmd_abs", CMD, ["/c", "echo hi"]));
console.log(sync("sync_whoami", "C:\\Windows\\System32\\whoami.exe", []));
console.log(sync("sync_notepad_missing", "C:\\Windows\\System32\\__nope__.exe", []));

console.log("=== execFileSync (旧补丁用的路径) ===");
try {
  const o = execFileSync(PS_ABS, ["-NoProfile", "-NonInteractive", "-Command", "Write-Output EFS_OK"], {
    encoding: "utf8", timeout: 15000, windowsHide: true
  });
  console.log("execFileSync_ps => OK out=" + JSON.stringify(String(o).trim()));
} catch (e) {
  console.log("execFileSync_ps => FAIL " + (e.code || "") + " " + String(e.message || "").slice(0, 120));
}

console.log("=== async execFile ===");
execFile(PS_ABS, ["-NoProfile", "-Command", "Write-Output ASYNC_OK"], { encoding: "utf8", timeout: 15000, windowsHide: true },
  (e, so, se) => {
    console.log("execFile_async_ps => " + (e ? "FAIL " + (e.code || "") + " " + String(e.message).slice(0, 120) + " stderr=" + String(se).slice(0, 120) : "OK out=" + JSON.stringify(String(so).trim())));
  });
