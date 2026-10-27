/**
 * aTrustRemember —— 渲染进程逻辑回归测试（jsdom 仿真）
 *
 * 覆盖 v1.1 的致命缺陷场景：
 *   门户是 SPA，掉线后会 **重绘** 登录表单（生成新的 password 输入框元素），
 *   v1.1 的 state.applied 布尔量一旦为 true 就再也回填不了 —— 这就是
 *   「自动注销后没有自动登录」的真实原因。
 *
 * 运行:  node tools/test-renderer.js
 * 依赖:  jsdom（若不存在会明确报错）
 */
const fs = require("fs");
const path = require("path");

const RENDERER = process.argv[2] || path.join(__dirname, "..", "patch", "atrust_remember_renderer.js");
const SRC = fs.readFileSync(RENDERER, "utf8");

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log("  [PASS] " + name);
  } else {
    fail++;
    console.log("  [FAIL] " + name + (extra !== undefined ? "  --> " + extra : ""));
  }
}

/* jsdom 没有排版引擎，offsetParent 恒为 null，
 * 这里给需要「可见」的元素补上 offsetParent，模拟真实浏览器。 */
function markVisible(el) {
  const doc = el.ownerDocument;
  Object.defineProperty(el, "offsetParent", { get: () => doc.body, configurable: true });
  Object.defineProperty(el, "getClientRects", {
    value: () => [{ width: 120, height: 20 }],
    configurable: true
  });
  return el;
}

/* ------------------------------------------------------------------ *
 * 仿真的门户登录页 DOM
 * ------------------------------------------------------------------ *
 * 结构严格照抄门户登录组件（resources\app\web\assets\useInitHelp*.js）：
 *
 *   <div class="hidden-box">              ← 诱饵块，在真实表单 **之前**
 *     <input type="text"     tabindex="-1">
 *     <input type="password" tabindex="-1">
 *     <input type="hidden" name="csrf-token" value="anti-code-scan" tabindex="-1">
 *   </div>
 *   <div class="switch-login-slide">
 *     <div class="auth-password">
 *       <div>                              ← wrapper
 *         <div class="form-input-line user-input">
 *           <input class="ix-input-inner" placeholder="请输入账号">   ← 无 id
 *         </div>
 *         <div class="form-input-line rel">
 *           <input id="password" type="password" class="ix-input-inner" placeholder="请输入密码">
 *         </div>
 *       </div>
 *       <div class="login-btn auto-click-login include-box__button mb16">…</div>
 *     </div>
 *   </div>
 *
 * 诱饵 password 框在页面上「看起来是隐藏的」，但仍参与布局，
 * 因此 isVisible() 会返回 true —— v1.2 初版正是因此把 UI 插进了诱饵块，
 * 导致用户看不到「记住密码 / 掉线后自动登录」。
 */
function buildLoginDom(dom, opts) {
  const o = opts || {};
  const doc = dom.window.document;
  doc.body.innerHTML = "";

  // ---- 诱饵块（必须在真实表单之前） ----
  const decoy = doc.createElement("div");
  decoy.className = "hidden-box";
  const dText = doc.createElement("input");
  dText.type = "text";
  dText.setAttribute("tabindex", "-1");
  const dPsw = doc.createElement("input");
  dPsw.type = "password";
  dPsw.setAttribute("tabindex", "-1");
  const dCsrf = doc.createElement("input");
  dCsrf.type = "hidden";
  dCsrf.name = "csrf-token";
  dCsrf.value = "anti-code-scan";
  dCsrf.setAttribute("tabindex", "-1");
  decoy.appendChild(dText);
  decoy.appendChild(dPsw);
  decoy.appendChild(dCsrf);
  doc.body.appendChild(decoy);
  // 诱饵框仍然「有布局」（真实页面就是这样），所以标记为可见
  markVisible(dText);
  markVisible(dPsw);

  // ---- 真实登录表单 ----
  const wrap = doc.createElement("div");
  wrap.className = "switch-login-slide";
  const auth = doc.createElement("div");
  auth.className = "auth-password";
  const wrapper = doc.createElement("div");
  const userLine = doc.createElement("div");
  userLine.className = "form-input-line user-input";
  const user = doc.createElement("input");
  user.className = "ix-input-inner";
  user.setAttribute("placeholder", "请输入账号");
  markVisible(user);
  userLine.appendChild(user);
  const rel = doc.createElement("div");
  rel.className = "form-input-line rel";
  const psw = doc.createElement("input");
  psw.id = "password";
  psw.type = "password";
  psw.className = "ix-input-inner";
  psw.setAttribute("placeholder", "请输入密码");
  markVisible(psw);
  rel.appendChild(psw);
  wrapper.appendChild(userLine);
  wrapper.appendChild(rel);
  const btn = doc.createElement("div");
  btn.className = "login-btn auto-click-login include-box__button mb16";
  btn.appendChild(doc.createElement("button"));
  btn.querySelector("button").className = "ix-button ix-button-block ix-button-primary";
  btn.querySelector("button").textContent = "登录";
  markVisible(btn);
  btn.querySelector("button").addEventListener("click", function () {
    const n = parseInt(wrap.getAttribute("data-clicked") || "0", 10) || 0;
    wrap.setAttribute("data-clicked", String(n + 1));
  });
  auth.appendChild(wrapper);
  auth.appendChild(btn);
  wrap.appendChild(auth);
  doc.body.appendChild(wrap);

  if (o.captcha) {
    const cap = doc.createElement("input");
    cap.setAttribute("placeholder", "请输入验证码");
    markVisible(cap);
    auth.appendChild(cap);
  }
  return { wrap: wrap, user: user, psw: psw, btn: btn, auth: auth, decoy: decoy, dPsw: dPsw, dText: dText };
}

function newWindow() {
  const { JSDOM } = require("jsdom");
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    // 注意：不能用 file:// —— jsdom 的 opaque origin 会让 localStorage 抛 SecurityError
    url: "https://portal.local/web/index.html?host=x#/login",
    runScripts: "outside-only",
    pretendToBeVisual: true
  });
  const win = dom.window;
  win.localStorage.setItem("atrustRememberEnabled", "1");
  win.localStorage.setItem("atrustRememberAutoLogin", "1");
  win.localStorage.setItem("atrustRememberUser", "王磊");
  return dom;
}

function injectRenderer(dom) {
  dom.window.eval(SRC);
  return dom.window.__atrustRemember;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ------------------------------------------------------------------ *
 * 用例
 * ------------------------------------------------------------------ */
async function main() {
  console.log("=== aTrustRemember 渲染进程回归测试 (v1.2) ===");
  console.log("renderer: " + RENDERER);
  console.log("");

  /* --- 1. 基本回填 + 自动提交 --- */
  console.log("[1] 首次回填 + 自动提交");
  {
    const dom = newWindow();
    const form = buildLoginDom(dom);
    const api = injectRenderer(dom);
    api.restore({ u: "王磊", p: "P@ssw0rd!", allowSubmit: true });
    await sleep(1400);
    check("密码框已回填", form.psw.value === "P@ssw0rd!", form.psw.value);
    check("用户名框已回填", form.user.value === "王磊", form.user.value);
    check("登录按钮被点击（自动提交）", form.wrap.getAttribute("data-clicked") === "1", form.wrap.getAttribute("data-clicked"));
    check("复选框已渲染", !!dom.window.document.getElementById("atrust-remember-box"));
    // ★ 诱饵块断言（v1.2 初版回归点）
    const box = dom.window.document.getElementById("atrust-remember-box");
    check("★ UI 没有被插进诱饵块 .hidden-box", !!(box && !(box.closest && box.closest(".hidden-box"))));
    check("★ UI 与真实密码框同容器", !!(box && box.parentElement && box.parentElement.querySelector("#password")));
    check("★ 诱饵密码框没有被写入", form.dPsw.value === "", JSON.stringify(form.dPsw.value));
    check("★ 诱饵文本框没有被写入", form.dText.value === "", JSON.stringify(form.dText.value));
    dom.window.close();
  }

  /* --- 2. 核心回归：SPA 重绘表单后必须自动重新回填 --- */
  console.log("");
  console.log("[2] ★ 核心回归：SPA 重绘登录表单后自动重新回填");
  {
    const dom = newWindow();
    let form = buildLoginDom(dom);
    const api = injectRenderer(dom);
    api.restore({ u: "王磊", p: "P@ssw0rd!", allowSubmit: true });
    await sleep(1400);
    check("第一轮：已回填并提交", form.wrap.getAttribute("data-clicked") === "1");
    check("第一轮：密码框有值", form.psw.value === "P@ssw0rd!");

    // 门户重绘：整个表单换一批新的 DOM 元素（新的 password 输入框，值为空）
    form = buildLoginDom(dom);
    check("重绘后密码框确实是新元素且为空", form.psw.value === "");
    await sleep(1600);
    check("★ 重绘后密码框被自动重新回填", form.psw.value === "P@ssw0rd!", "value=" + JSON.stringify(form.psw.value));
    check("★ 重绘后用户名框被自动重新回填", form.user.value === "王磊", form.user.value);
    check("重绘后未立刻重复提交（20 秒冷却保护）", form.wrap.getAttribute("data-clicked") === null, form.wrap.getAttribute("data-clicked"));
    dom.window.close();
  }

  /* --- 3. peek() 在密码框为空时必须索要凭据（不再受 applied 约束） --- */
  console.log("");
  console.log("[3] peek() 在密码框为空时返回 needRestore");
  {
    const dom = newWindow();
    const form = buildLoginDom(dom);
    const api = injectRenderer(dom);
    // 3a. 全新注入的渲染进程（还没有凭据）：看到空密码框就向主进程索要
    let r = api.peek();
    check("新渲染进程看到空密码框 -> needRestore=true", !!(r && r.needRestore), JSON.stringify(r));
    // 3b. 4 秒节流窗口内不重复索要（避免主进程被刷屏）
    r = api.peek();
    check("4 秒节流窗口内不重复索要", !(r && r.needRestore), JSON.stringify(r));
    // 3c. 节流窗口过后重新索要（凭据始终没送来的兜底路径）
    await sleep(4300);
    r = api.peek();
    check("节流窗口过后重新索要凭据", !!(r && r.needRestore), JSON.stringify(r));
    dom.window.close();
  }

  /* --- 3d. 已有凭据时，密码框被外部清空应自愈补回 --- */
  console.log("");
  console.log("[3d] 已有凭据 + 密码框被清空 -> 渲染进程自愈补回");
  {
    const dom = newWindow();
    const form = buildLoginDom(dom);
    const api = injectRenderer(dom);
    api.restore({ u: "王磊", p: "P@ssw0rd!", allowSubmit: true });
    await sleep(1400);
    check("先回填成功", form.psw.value === "P@ssw0rd!", form.psw.value);
    form.psw.value = ""; // 外部/门户把密码框清空了
    await sleep(1600);
    check("★ 密码框被清空后被自动补回", form.psw.value === "P@ssw0rd!", "value=" + JSON.stringify(form.psw.value));
    dom.window.close();
  }

  /* --- 4. 主动退出（allowSubmit=false）：回填但不自动提交 --- */
  console.log("");
  console.log("[4] allowSubmit=false：回填但不自动提交");
  {
    const dom = newWindow();
    const form = buildLoginDom(dom);
    const api = injectRenderer(dom);
    api.restore({ u: "王磊", p: "P@ssw0rd!", allowSubmit: false });
    await sleep(1400);
    check("密码框已回填", form.psw.value === "P@ssw0rd!", form.psw.value);
    check("登录按钮未被点击", form.wrap.getAttribute("data-clicked") === null, form.wrap.getAttribute("data-clicked"));
    dom.window.close();
  }

  /* --- 5. 用户自己输入密码：不覆盖、不自动提交 --- */
  console.log("");
  console.log("[5] 用户手工输入密码：不覆盖、不自动提交");
  {
    const dom = newWindow();
    let form = buildLoginDom(dom);
    const api = injectRenderer(dom);
    api.restore({ u: "王磊", p: "P@ssw0rd!", allowSubmit: true });
    await sleep(1400);
    // 用户在重绘后的表单里自己敲了密码
    form = buildLoginDom(dom);
    form.psw.value = "user-typed";
    await sleep(1600);
    check("用户输入的密码未被覆盖", form.psw.value === "user-typed", form.psw.value);
    check("用户输入时未自动提交", form.wrap.getAttribute("data-clicked") === null, form.wrap.getAttribute("data-clicked"));
    dom.window.close();
  }

  /* --- 6. 有验证码时不自动提交 --- */
  console.log("");
  console.log("[6] 页面存在验证码时不自动提交");
  {
    const dom = newWindow();
    const form = buildLoginDom(dom, { captcha: true });
    const api = injectRenderer(dom);
    api.restore({ u: "王磊", p: "P@ssw0rd!", allowSubmit: true });
    await sleep(1400);
    check("密码框已回填", form.psw.value === "P@ssw0rd!", form.psw.value);
    check("有验证码时未自动提交", form.wrap.getAttribute("data-clicked") === null, form.wrap.getAttribute("data-clicked"));
    dom.window.close();
  }

  /* --- 7. 重复注入幂等（主进程会在 SPA 路由变化时再次注入） --- */
  console.log("");
  console.log("[7] 重复注入保持幂等，不重复安装监听");
  {
    const dom = newWindow();
    const form = buildLoginDom(dom);
    const api = injectRenderer(dom);
    api.restore({ u: "王磊", p: "P@ssw0rd!", allowSubmit: true });
    await sleep(1400);
    const api2 = injectRenderer(dom);
    check("重复注入返回同一个实例", api2 === api);
    check("重复注入不破坏已回填的值", form.psw.value === "P@ssw0rd!", form.psw.value);
    dom.window.close();
  }

  console.log("");
  console.log("=== 结果: " + pass + " passed, " + fail + " failed ===");
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("测试异常:", (e && e.stack) || e);
  process.exit(2);
});
