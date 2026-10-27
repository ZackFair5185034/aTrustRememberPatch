// 验收脚本：检查 %APPDATA%\aTrustRemember\credential.bin
//   1) 文件存在且非空
//   2) 是标准 DPAPI blob（AQAAANCMnd8B 开头）
//   3) 密文中不含明文口令
//   4) 用同一用户的 DPAPI 能解密回来，且内容是合法 JSON
//
// 用法：node verify-credential.js <patchDir>   （patchDir 里要有 patch/atrust_remember_dpapi_ffi.js）
const fs = require("fs");
const path = require("path");
const os = require("os");

const CRED = path.join(process.env.APPDATA || os.homedir(), "aTrustRemember", "credential.bin");

function mask(s) {
  return s.length <= 2 ? s : s[0] + "*".repeat(s.length - 2) + s[s.length - 1];
}

console.log("credential file: " + CRED);
if (!fs.existsSync(CRED)) {
  console.log("RESULT=NOT_FOUND");
  process.exit(2);
}
const raw = fs.readFileSync(CRED);
console.log("size=" + raw.length + " bytes");

const head = raw.slice(0, 8).toString("base64");
console.log("head=" + head + "  (DPAPI blob header expected: AQAAANCMnd8=)");
const isDpapi = raw.slice(0, 8).toString("base64").indexOf("AQAAANCMnd8") === 0;
console.log("isDpapiBlob=" + isDpapi);

// 明文泄漏检查：凭据 JSON 的字段名一旦出现在密文里，说明没加密
const hits = [];
for (const kw of ["password", "u\":", "p\":", "ts\":"]) {
  if (raw.indexOf(Buffer.from(kw, "utf8")) >= 0) hits.push(kw);
}
console.log("plaintextHits=" + JSON.stringify(hits));

// 解密验证
try {
  const Ffi = require(path.join(process.argv[2], "patch", "atrust_remember_dpapi_ffi.js"));
  const plain = Ffi.unprotect(raw).toString("utf8");
  const obj = JSON.parse(plain);
  console.log("decrypt=OK");
  console.log("user=" + obj.u);
  console.log("password(masked)=" + mask(String(obj.p)));
  console.log("ts=" + obj.ts);
  console.log("RESULT=OK");
  process.exit(isDpapi && hits.length === 0 ? 0 : 1);
} catch (e) {
  console.log("decrypt=FAIL " + String(e.message || e).slice(0, 200));
  console.log("RESULT=FAIL");
  process.exit(3);
}
