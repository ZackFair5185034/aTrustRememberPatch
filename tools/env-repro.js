// 对照实验：子进程拿到「完整 env」 vs 「残缺 env」时的表现差异
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const HELPER = path.join(process.env.APPDATA, "aTrustRemember", "dpapi_helper.js");
const EXE = process.execPath;
const log = process.argv[2];
const out = (s) => { try { fs.appendFileSync(log, s + "\n"); } catch (e) {} };

const IN = Buffer.from(JSON.stringify({ u: "diagMarker", p: "diag", ts: 0 }), "utf8").toString("base64");

function run(tag, env) {
  return new Promise((resolve) => {
    const child = spawn(EXE, [HELPER, "protect"], { env: env, windowsHide: true });
    let o = "", e = "";
    child.stdout.on("data", (d) => { o += d; });
    child.stderr.on("data", (d) => { e += d; });
    child.on("error", (er) => { out(tag + " ERROR " + (er.code || er.message)); resolve(); });
    child.on("close", (code) => {
      out(tag + " exit=" + code + " stdoutLen=" + o.length + " stderrLen=" + e.length);
      out(tag + "   stdoutHead=" + JSON.stringify(String(o).slice(0, 160)));
      out(tag + "   stderrHead=" + JSON.stringify(String(e).slice(0, 160)));
      const isB64 = /^[A-Za-z0-9+/=]+$/.test(String(o).trim());
      out(tag + "   looksBase64=" + isB64);
      resolve();
    });
    if (child.stdin) { child.stdin.on("error", () => {}); child.stdin.end(IN); }
  });
}

(async () => {
  out("exe=" + EXE);
  const full = Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: "1" });
  out("full env keyCount=" + Object.keys(full).length + " hasSystemRoot=" + ("SystemRoot" in full));
  await run("A_full_env", full);

  const minimal = { ELECTRON_RUN_AS_NODE: "1" };
  await run("B_minimal_env", minimal);

  const noPath = Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: "1" });
  delete noPath.PATH;
  delete noPath.Path;
  await run("C_no_path", noPath);
})();
