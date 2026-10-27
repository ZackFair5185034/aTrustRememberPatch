// 预演：在 util.js 副本上追加补丁钩子，验证语法与追加逻辑（不触碰系统文件）
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const SRC = "C:\\Program Files (x86)\\Sangfor\\aTrust\\aTrustTray\\resources\\app\\src\\service\\util\\util.js";
const OUT = path.join(__dirname, "_util_dryrun.js");

const MARKER = "/* aTrustRemember patch v1 */";
const HOOK = `
${MARKER}
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
    require("../atrust_remember").init();
    console.log("[aTrustRemember] patch active");
  } catch (e) {
    console.error("[aTrustRemember] patch init failed:", e);
  }
})();
`;

const raw = fs.readFileSync(SRC);
const hasBom = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
let text = raw.toString("utf8");
if (hasBom) text = text.replace(/^\uFEFF/, "");

console.log("original length:", text.length, " BOM:", hasBom);
console.log("already patched:", text.includes(MARKER));

fs.writeFileSync(OUT, text + HOOK, { encoding: "utf8" });
console.log("patched copy written:", OUT, fs.statSync(OUT).size, "bytes");

// 语法自检
try {
  execFileSync(process.execPath, ["--check", OUT], { stdio: "pipe" });
  console.log("node --check: PASS");
} catch (e) {
  console.log("node --check: FAIL");
  console.log(String(e.stderr || e.message));
}

// 追加片段自检
const hookOnly = path.join(__dirname, "_hook_only.js");
fs.writeFileSync(hookOnly, HOOK, { encoding: "utf8" });
try {
  execFileSync(process.execPath, ["--check", hookOnly], { stdio: "pipe" });
  console.log("hook fragment --check: PASS");
} catch (e) {
  console.log("hook fragment --check: FAIL", String(e.stderr || e.message));
}

// 确认原有内容一字未改
const patched = fs.readFileSync(OUT, "utf8");
console.log("original bytes preserved:", patched.startsWith(text));
console.log("tail:", JSON.stringify(patched.slice(-160)));
