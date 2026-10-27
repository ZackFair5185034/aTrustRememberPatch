// 提取 CSS 中匹配某个前缀的所有规则（选择器 + 声明）
const fs = require("fs");
const file = process.argv[2];
const re = new RegExp(process.argv[3]);
const css = fs.readFileSync(file, "utf8");

// 粗粒度切分：rule = selector { body }
const rules = [];
let depth = 0, start = 0, selStart = 0;
for (let i = 0; i < css.length; i++) {
  const c = css[i];
  if (c === "{") {
    if (depth === 0) selStart = start;
    depth++;
  } else if (c === "}") {
    depth--;
    if (depth === 0) {
      const sel = css.slice(selStart, i).replace(/^[\s;}]+/, "").trim();
      const body = css.slice(selStart, i);
      rules.push({ sel, body });
      start = i + 1;
    }
  }
}
const hit = rules.filter((r) => re.test(r.sel));
console.log("total rules:", rules.length, " matched:", hit.length);
for (const r of hit.slice(0, 40)) {
  console.log("  " + r.sel.slice(0, 160) + " { " + r.body.slice(r.body.indexOf("{") + 1, -1).trim().slice(0, 200) + " }");
}
