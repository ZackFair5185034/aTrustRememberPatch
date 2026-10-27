// 单项 spawn 测试：argv[2] = 测试名，结果追加写入 argv[3] 日志文件
// 用文件而非 stdout 记录，以便捕获进程硬崩溃前的最后一步
const { spawnSync, execFileSync, execFile } = require("child_process");
const fs = require("fs");
const PS_ABS = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const CMD_ABS = "C:\\Windows\\System32\\cmd.exe";

const name = process.argv[2];
const log = process.argv[3] || "C:\\Users\\51962\\.minimax\\sessions\\mvs_a5d5870b15864231a1e5aafebe44ca24\\workspace\\aTrustRememberPatch\\diag-one.log";
const out = (s) => { try { fs.appendFileSync(log, s + "\n"); } catch (e) {} };

out("[" + name + "] begin pid=" + process.pid + " node=" + process.version);

function syncTest(label, file, args, opts) {
  try {
    const r = spawnSync(file, args, Object.assign({ encoding: "utf8", timeout: 10000, windowsHide: true }, opts || {}));
    out(label + " => status=" + r.status + " err=" + (r.error ? (r.error.code + "|" + r.error.message) : "none") +
      " out=" + JSON.stringify(String(r.stdout || "").trim().slice(0, 50)));
  } catch (e) {
    out(label + " => THROW " + (e.code || "") + "|" + String(e.message || "").slice(0, 100));
  }
}

try {
  switch (name) {
    case "ps_rel":
      syncTest("ps_rel", "powershell.exe", ["-NoProfile", "-Command", "Write-Output 1"]);
      break;
    case "ps_abs":
      syncTest("ps_abs", PS_ABS, ["-NoProfile", "-Command", "Write-Output 1"]);
      break;
    case "cmd_rel":
      syncTest("cmd_rel", "cmd.exe", ["/c", "echo hi"]);
      break;
    case "cmd_abs":
      syncTest("cmd_abs", CMD_ABS, ["/c", "echo hi"]);
      break;
    case "whoami":
      syncTest("whoami", "C:\\Windows\\System32\\whoami.exe", []);
      break;
    case "explorer":
      syncTest("explorer", "C:\\Windows\\explorer.exe", ["/?"]);
      break;
    case "node":
      syncTest("node", "D:\\nodejs\\node-v24.12.0\\node.exe", ["-e", "console.log('hi')"]);
      break;
    case "efs_sync":
      try {
        const o = execFileSync(PS_ABS, ["-NoProfile", "-NonInteractive", "-Command", "Write-Output EFS_OK"],
          { encoding: "utf8", timeout: 15000, windowsHide: true });
        out("efs_sync => OK " + JSON.stringify(String(o).trim()));
      } catch (e) {
        out("efs_sync => FAIL " + (e.code || "") + "|" + String(e.message || "").slice(0, 120));
      }
      break;
    case "efs_async":
      execFile(PS_ABS, ["-NoProfile", "-Command", "Write-Output ASYNC_OK"],
        { encoding: "utf8", timeout: 15000, windowsHide: true },
        (e, so, se) => out("efs_async => " + (e ? "FAIL " + (e.code || "") + "|" + String(e.message).slice(0, 100) + "|stderr=" + String(se).slice(0, 100) : "OK " + JSON.stringify(String(so).trim()))));
      break;
    case "spawn_async":
      require("child_process").spawn(PS_ABS, ["-NoProfile", "-Command", "Write-Output SPAWN_ASYNC_OK"], { windowsHide: true })
        .on("error", (e) => out("spawn_async => ERROR " + (e.code || "") + "|" + String(e.message).slice(0, 100)))
        .on("exit", (c) => out("spawn_async => exit code=" + c))
        .stdout.on("data", (d) => out("spawn_async => stdout " + String(d).trim()));
      break;
    case "exec_shell":
      require("child_process").exec("echo hi", (e, so, se) => out("exec_shell => " + (e ? "FAIL " + (e.code || "") + "|" + String(e.message).slice(0, 100) : "OK " + JSON.stringify(String(so).trim()))));
      break;
    default:
      out("unknown test " + name);
  }
} catch (e) {
  out("outer THROW " + (e.code || "") + "|" + String(e.message || "").slice(0, 120));
}
out("[" + name + "] end");
