// Verify the exact DPAPI code path used by atrust_remember.js (Node execFileSync + stdin)
const { execFileSync } = require("child_process");

const PS_PROTECT = [
  "$ErrorActionPreference='Stop'",
  "Add-Type -AssemblyName System.Security",
  "$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())",
  "$r=[System.Security.Cryptography.ProtectedData]::Protect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "[Console]::Out.Write([Convert]::ToBase64String($r))"
].join(";");

const PS_UNPROTECT = [
  "$ErrorActionPreference='Stop'",
  "Add-Type -AssemblyName System.Security",
  "$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())",
  "$r=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "[Console]::Out.Write([Convert]::ToBase64String($r))"
].join(";");

function runPS(script, inputB64) {
  const out = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { input: inputB64, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, windowsHide: true }
  );
  return String(out).trim();
}

const plain = Buffer.from(JSON.stringify({ u: "testuser", p: "P@ssw0rd!中文", ts: 123 }), "utf8");
const enc = Buffer.from(runPS(PS_PROTECT, plain.toString("base64")), "base64");
console.log("encrypted bytes:", enc.length);
console.log("ciphertext contains plaintext?", enc.includes(Buffer.from("P@ssw0rd")));
const dec = Buffer.from(runPS(PS_UNPROTECT, enc.toString("base64")), "base64");
const obj = JSON.parse(dec.toString("utf8"));
console.log("decrypted:", JSON.stringify(obj));
console.log("ROUNDTRIP OK =", obj.p === "P@ssw0rd!中文" && obj.u === "testuser");
