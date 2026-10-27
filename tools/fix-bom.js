// 给 .ps1 文件加 UTF-8 BOM（PowerShell 5.1 无 BOM 时按 ANSI/GBK 解析中文会报错）
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname);
for (const f of ["install.ps1", "uninstall.ps1"]) {
  const p = path.join(dir, f);
  const buf = fs.readFileSync(p);
  const hasBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  if (!hasBom) {
    fs.writeFileSync(p, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), buf]));
    console.log("BOM added:", f, "->", fs.statSync(p).size, "bytes");
  } else {
    console.log("BOM already present:", f);
  }
}
