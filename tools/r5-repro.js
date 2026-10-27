// 完全复刻补丁里的 runSelfNode 通道，用于定位 stdout 长度异常
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const HELPER_FILE = path.join(process.env.APPDATA, "aTrustRemember", "dpapi_helper.js");
const log = process.argv[2] || path.join(__dirname, "r5-repro.log");
const out = (s) => { try { fs.appendFileSync(log, s + "\n"); } catch (e) {} };

out("parent pid=" + process.pid + " execPath=" + process.execPath + " type=" + process.type);

function runSelfNode(op, inputB64) {
  return new Promise((resolve, reject) => {
    const env = Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: "1" });
    const child = spawn(process.execPath, [HELPER_FILE, op], { env: env, windowsHide: true });
    let o = "";
    let e = "";
    child.stdout.on("data", (d) => { o += d; });
    child.stderr.on("data", (d) => { e += d; });
    child.on("error", (er) => reject(new Error("spawn-error:" + (er.code || er.message))));
    child.on("close", (code) => {
      out("  [" + op + "] close code=" + code + " stdoutLen=" + o.length + " stderr=" + JSON.stringify(String(e).slice(0, 120)));
      out("  [" + op + "] stdoutHead=" + JSON.stringify(String(o).slice(0, 120)));
      out("  [" + op + "] stdoutTail=" + JSON.stringify(String(o).slice(-60)));
      if (code === 0 && o.trim()) resolve(o.trim());
      else reject(new Error("exit=" + code + " err=" + e.slice(0, 200)));
    });
    if (child.stdin) {
      child.stdin.on("error", () => {});
      try { child.stdin.end(inputB64); } catch (x) {}
    }
  });
}

(async () => {
  const probe = Buffer.from(JSON.stringify({ u: "diagMarker", p: "diag", ts: 0 }), "utf8");
  try {
    const enc = await runSelfNode("protect", probe.toString("base64"));
    out("enc len=" + enc.length + " isB64=" + /^[A-Za-z0-9+/=]+$/.test(enc));
    const dec = await runSelfNode("unprotect", enc.trim());
    out("dec len=" + dec.length + " isB64=" + /^[A-Za-z0-9+/=]+$/.test(dec));
    const plain = Buffer.from(dec.trim(), "base64").toString("utf8");
    out("plain=[" + plain + "]");
    out("ROUNDTRIP=" + (plain.indexOf("diagMarker") >= 0));
  } catch (e) {
    out("FAILED: " + String(e && e.message));
  }
})();
