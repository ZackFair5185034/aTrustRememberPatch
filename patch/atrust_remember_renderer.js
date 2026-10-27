/**
 * aTrustRemember —— 渲染进程注入脚本 (v1.2)
 *
 * 由主进程通过 webContents.executeJavaScript 注入到门户登录页所在的渲染进程。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * v1.2 修复：解决「自动注销（掉线）后没有自动登录」的现场缺陷
 * ──────────────────────────────────────────────────────────────────────────
 * 缺陷 A（致命）：v1.1 用一个布尔量 state.applied 记录「已经回填过了」。
 *   门户是 SPA，掉线后会**重绘**登录表单（生成一个新的 password 输入框元素），
 *   而 state.applied 会一直保持 true，于是：
 *     - tick() 里的 `restoreReq && !state.applied` 不再成立 → 不再回填；
 *     - peek() 里的 `!state.applied && findPswInput()` 不再成立 → 不再向主进程索要凭据。
 *   结果：主进程即使把凭据推过去，渲染进程也认为「已经填过了」而直接跳过，
 *         密码框保持空白，也没有任何自动提交 —— 这就是用户看到的现象。
 *
 * 缺陷 B：主进程只监听 did-finish-load / did-navigate，
 *   而门户用 **hash 路由** 在同一个文档内跳转（#/app_center → #/login），
 *   这种跳转只会触发 did-navigate-in-page，
 *   于是掉线回到登录页时主窗口既不会被重新激活、凭据也不会推给主窗口。
 *
 * v1.2 的做法：
 *   1) 「是否已回填」不再用布尔量，而是按 **密码框元素身份 + 当前值** 判断：
 *      只有当密码框为空（或为原生掩码 MASK）时才回填。
 *      → 表单被重绘（元素变了、值为空）→ 自动重新回填；
 *      → 用户自己敲了密码（值非空）→ 不覆盖、也不自动提交。
 *   2) peek() 的 needRestore 不再受 applied 约束：
 *      只要看到「密码框存在且值为空」，就向主进程索要凭据（4 秒节流）。
 *      → 凭据的 allowSubmit 也会随之刷新（主动退出时为 false，掉线时为 true）。
 *   3) 提交条件收紧：只提交「我们自己回填进去的那份密码」；
 *      同一表单元素只提交一次 + 全局 20 秒冷却 + 每轮最多 3 次（防止账号被锁）。
 *   4) 新增 revive()：SPA 路由变化时由主进程调用，解除粘滞状态并立即重试回填。
 *
 * 说明: 这里的自动提交是「重新走一次正常的账号密码登录」，
 *       服务端的二次认证 / 设备风控 / 防重放策略全部照常生效。
 */
(function () {
  var VERSION = "1.2";
  var MASK = "♂♀☺♪♫◙♂♀"; // 原生"记住密码"使用的密码掩码
  var LS_USER = "atrustRememberUser";
  var LS_ENABLED = "atrustRememberEnabled";
  var LS_AUTO = "atrustRememberAutoLogin";

  var ASK_COOLDOWN_MS = 4000; // 向主进程索要凭据的最小间隔
  var SUBMIT_COOLDOWN_MS = 20000; // 两次自动提交之间的最小间隔
  var MAX_SUBMIT_PER_CYCLE = 3; // 一轮登录周期内最多自动提交几次（防账号锁定）

  var state = {
    pending: null, // 待交给主进程保存的凭据 { u, p }
    fail: false, // 服务端拒绝了凭据
    clear: false, // 用户取消了「记住密码」
    restoreReq: null, // 主进程下发的凭据 { u, p, allowSubmit }
    appliedEl: null, // 我们回填过的密码框（按元素身份判断，表单重绘后自然失效）
    appliedVal: "", // 我们放进去的密码（用于确认「当前值仍是我们填的」）
    submitEl: null, // 已经自动提交过的表单元素
    submitCount: 0, // 本轮已自动提交次数
    lastSubmitAt: 0, // 上次自动提交的时间戳
    askRestoreAt: 0, // 上次索要凭据的时间戳
    reviveCount: 0, // 被主进程唤醒的次数
    sawLoginForm: false,
    lastUser: ""
  };
  var lastTyped = "";
  var legacyPending = null;

  /* ------------------------------------------------------------------ *
   * 注入幂等处理
   * ------------------------------------------------------------------ */
  if (window.__atrustRemember) {
    var old = window.__atrustRemember;
    if (old.__v === VERSION) {
      // 同一版本重复注入：只唤醒，不再重复安装事件监听
      try {
        old.revive();
      } catch (e) {}
      return;
    }
    // 旧版本实例：尽量把它已经捕获到的待存凭据接过来，避免漏存密码
    try {
      var r = old.peek ? old.peek() : null;
      if (r && r.u && r.p) legacyPending = { u: r.u, p: r.p };
    } catch (e) {}
  }

  /* ---------------- API（主进程调用） ---------------- */
  window.__atrustRemember = {
    __v: VERSION,

    /* 主进程每 1.5 秒轮询一次 */
    peek: function () {
      if (state.clear) {
        state.clear = false;
        return { clear: true };
      }
      if (state.fail) {
        state.fail = false;
        return { fail: true };
      }
      var out = null;
      /* 主动索要凭据：
       * 门户用 hash 路由跳到登录页时不会触发 did-finish-load，主进程推不到凭据；
       * 这里只要看到「密码框存在且值为空」就向主进程要一次。
       * 注意：这里 **不再** 受 state.applied 约束（v1.2 的核心修复）。 */
      try {
        var pEl = findPswInput();
        if (pEl && isEmptyPsw(pEl)) {
          var now = new Date().getTime();
          if (now - (state.askRestoreAt || 0) > ASK_COOLDOWN_MS) {
            state.askRestoreAt = now;
            out = { needRestore: true };
          }
        }
      } catch (e) {}
      if (state.pending) {
        out = out || {};
        out.u = state.pending.u;
        out.p = state.pending.p;
      }
      return out;
    },

    clearPending: function () {
      state.pending = null;
    },

    /* 主进程下发凭据 */
    restore: function (c) {
      if (!c || !c.u) return "no-credential";
      state.restoreReq = { u: c.u, p: c.p, allowSubmit: c.allowSubmit === true };
      // 刚收到凭据，短时间内不要重复索要
      state.askRestoreAt = new Date().getTime();
      applyCredential();
      return "ok";
    },

    /* 服务端拒绝凭据后取消本地自动重试，避免反复尝试导致账号锁定 */
    cancelRestore: function () {
      state.restoreReq = null;
      state.appliedEl = null;
      state.appliedVal = "";
      state.submitEl = null;
      state.submitCount = 0;
      state.pending = null;
      return "cancelled";
    },

    /* 掉线后自动进入登录页（仅在用户勾选了「掉线后自动登录」时生效） */
    autoGoLogin: function () {
      try {
        if (localStorage.getItem(LS_AUTO) !== "1") return "auto-off";
        var b = document.querySelector(".go_login, button.go_login");
        if (b) {
          b.click();
          return "clicked";
        }
        return "no-button";
      } catch (e) {
        return "err:" + e.message;
      }
    },

    /* SPA 路由变化后由主进程唤醒：解除粘滞状态，立即重试回填 */
    revive: function () {
      state.reviveCount++;
      state.appliedEl = null;
      state.appliedVal = "";
      state.askRestoreAt = 0;
      state.submitEl = null;
      applyCredential();
      return "revived";
    },

    /* 自检接口: 供主进程探针调用 */
    diag: function () {
      var u = findUserInput();
      var p = findPswInput();
      var b = findLoginButton();
      return {
        ver: VERSION,
        userFound: !!u,
        userPh: u ? String(u.placeholder || "") : null,
        userVal: u ? String(u.value || "") : null,
        pswFound: !!p,
        pswId: p ? p.id : null,
        pswType: p ? p.type : null,
        pswEmpty: p ? isEmptyPsw(p) : null,
        hasRestoreReq: !!state.restoreReq,
        restoreAllow: state.restoreReq ? state.restoreReq.allowSubmit === true : null,
        appliedHere: !!(p && state.appliedEl === p),
        appliedValHere: !!(p && state.appliedVal && p.value === state.appliedVal),
        submitCount: state.submitCount,
        reviveCount: state.reviveCount,
        btnFound: !!b,
        btnTag: b ? b.tagName : null,
        btnCls: b ? String(b.className || "").slice(0, 60) : null,
        btnTxt: b ? String(b.textContent || "").trim().slice(0, 10) : null,
        captcha: hasCaptcha(),
        box: !!document.getElementById("atrust-remember-box"),
        boxStyle: (function () {
          var sq = document.querySelector("#atrust-remember-box .atrust-cb-box");
          if (!sq) return null;
          var r = sq.getBoundingClientRect();
          var cs = window.getComputedStyle(sq);
          return {
            w: Math.round(r.width), h: Math.round(r.height),
            bg: cs.backgroundColor, border: cs.borderColor, radius: cs.borderRadius
          };
        })(),
        checked: (function () {
          var l = document.querySelector("#atrust-remember-box .atrust-cb-checked");
          return l ? l.textContent.trim().slice(0, 12) : null;
        })(),
        rememberChecked: !!(localStorage.getItem(LS_ENABLED) === "1"),
        autoChecked: localStorage.getItem(LS_AUTO) === "1"
      };
    }
  };

  /* ---------------- DOM helpers ---------------- */
  function allInputs() {
    return Array.prototype.slice.call(document.querySelectorAll("input"));
  }

  function asInput(el) {
    if (!el) return null;
    if (el.tagName === "INPUT") return el;
    var inner = el.querySelector("input");
    return inner || null;
  }

  function isVisible(el) {
    if (!el) return false;
    try {
      return !!(el.offsetParent || el.getClientRects().length);
    } catch (e) {
      return true;
    }
  }

  /* 密码框当前是否「空」——空 或者 只剩原生掩码 */
  function isEmptyPsw(el) {
    if (!el) return true;
    var v = el.value;
    if (v === undefined || v === null || v === "") return true;
    return String(v) === MASK;
  }

  function findPswInput() {
    var byId = asInput(document.getElementById("password"));
    var inputs = allInputs();
    var vis = inputs.filter(function (i) { return i.type === "password" && isVisible(i); })[0];
    if (vis) return vis;
    if (byId) return byId;
    return (
      inputs.filter(function (i) { return i.value === MASK; })[0] ||
      inputs.filter(function (i) { return (i.placeholder || "").indexOf("密码") >= 0 && isVisible(i); })[0] ||
      null
    );
  }

  function findUserInput() {
    var byId = asInput(document.getElementById("username"));
    if (byId) return byId;
    var psw = findPswInput();
    var candidates = allInputs().filter(function (i) {
      return i !== psw && i.type !== "checkbox" && i.type !== "radio" && i.type !== "hidden";
    });
    /* 优先在「可见」的输入框里找；万一一个都不可见（无布局引擎 / 元素被临时隐藏），
     * 退回全部候选，避免因为可见性判断失误而漏掉用户名框。 */
    var visible = candidates.filter(isVisible);
    var pool = visible.length ? visible : candidates;
    return (
      // 实测登录页用户名框: input.ix-input-inner[placeholder="请输入账号"]（无 id）
      pool.filter(function (i) {
        var p = i.placeholder || "";
        return p.indexOf("账号") >= 0 || p.indexOf("用户名") >= 0;
      })[0] ||
      pool.filter(function (i) { return i.type === "text" || !i.type; })[0] ||
      null
    );
  }

  function setValue(el, val) {
    if (!el) return;
    try {
      var proto =
        el.tagName === "TEXTAREA"
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(el, val);
    } catch (e) {
      el.value = val;
    }
    // Vue 的 v-model 依赖 input/change 事件，必须手动派发
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function findLoginButton() {
    // 实测登录页: button.ix-button.ix-button-block.ix-button-primary (文本 "登录")
    //           div.login-btn.auto-click-login (文本 "登录")
    var match = function (b) {
      return /登录|登入|Login|Sign\s?in/i.test(b.textContent || b.value || "");
    };
    var btns = Array.prototype.slice.call(document.querySelectorAll("button"));
    var primary = btns.filter(function (b) {
      return match(b) && /ix-button-primary|btn-primary|primary/i.test(String(b.className || ""));
    })[0];
    if (primary) return primary;
    var anyBtn = btns.filter(match)[0];
    if (anyBtn) return anyBtn;
    var byType = document.querySelector("input[type=submit]");
    if (byType) return byType;
    var cands = Array.prototype.slice.call(document.querySelectorAll("[class*='btn']"));
    return cands.filter(match)[0] || null;
  }

  function hasCaptcha() {
    // 只认"可见"的验证码输入框，避免页面里常驻的隐藏验证码组件造成误判
    return allInputs().some(function (i) {
      var p = (i.placeholder || "") + "|" + (i.name || "") + "|" + (i.id || "");
      if (!/验证码|checkcode|captcha/i.test(p)) return false;
      return isVisible(i);
    });
  }

  /* ---------------- 捕获密码 ---------------- */
  document.addEventListener(
    "input",
    function (e) {
      var t = e.target;
      if (!t || t.tagName !== "INPUT") return;
      if (t.id === "password" || t.type === "password") {
        if (t.value && t.value !== MASK) lastTyped = t.value;
      }
    },
    true
  );

  function stageCredential() {
    var uEl = findUserInput();
    var pEl = findPswInput();
    var username =
      (uEl && uEl.value ? uEl.value.trim() : "") || state.lastUser || localStorage.getItem(LS_USER) || "";
    var psw = lastTyped || (pEl ? pEl.value : "");
    if (!username || !psw) return;
    if (psw === MASK) return; // 原生掩码，拿不到明文
    if (localStorage.getItem(LS_ENABLED) !== "1") {
      state.clear = true; // 用户取消勾选 -> 让主进程删掉已存的凭据
      return;
    }
    localStorage.setItem(LS_USER, username);
    state.pending = { u: username, p: psw };
    lastTyped = ""; // 已落定，避免兜底逻辑重复提交
  }

  /* ---------------- 拦截登录请求结果 ---------------- */
  (function () {
    var openOrig = XMLHttpRequest.prototype.open;
    var sendOrig = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__atrustUrl = String(url || "");
      return openOrig.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      var self = this;
      if (self.__atrustUrl && /\/passport\/v\d+\/auth\/psw/.test(self.__atrustUrl)) {
        self.addEventListener("load", function () {
          var ok = false;
          try {
            var r = JSON.parse(self.responseText);
            ok = r && r.code === 0;
          } catch (e) {
            ok = false;
          }
          if (ok) stageCredential();
          else state.fail = true;
        });
      }
      return sendOrig.apply(this, arguments);
    };
  })();

  /* 门户也可能用 fetch 提交登录 —— 同样拦截 */
  (function () {
    if (typeof window.fetch !== "function") return;
    var fetchOrig = window.fetch;
    window.fetch = function (input) {
      var url = "";
      try {
        url = typeof input === "string" ? input : (input && input.url) || "";
      } catch (e) {}
      var p = fetchOrig.apply(this, arguments);
      try {
        if (/\/passport\/v\d+\/auth\/psw/.test(String(url))) {
          Promise.resolve(p)
            .then(function (resp) {
              if (!resp || typeof resp.clone !== "function") return null;
              return resp.clone().text();
            })
            .then(function (txt) {
              if (txt === null || txt === undefined) return;
              var ok = false;
              try {
                var r = JSON.parse(txt);
                ok = r && r.code === 0;
              } catch (e) {
                ok = false;
              }
              if (ok) stageCredential();
              else state.fail = true;
            })
            .catch(function () {});
        }
      } catch (e) {}
      return p;
    };
  })();

  /* ---------------- 界面开关 ----------------
   * 注意: 门户全局样式里有 `input,button{-webkit-appearance:none;border:0}`，
   * 直接插入原生 <input type=checkbox> 会被抹成不可见（只剩文字）。
   * 因此这里照抄门户 IDUX Checkbox 的结构（自绘方块 span），
   * 并内联一份自包含样式，色值取自门户 :root 设计令牌：
   *   --ix-color-primary:#1c6eff  --ix-border-color:#e0e0e0
   *   --ix-background-color:#fff --ix-border-radius-sm:2px --ix-font-size:14px
   */
  var CB_CSS = [
    "#atrust-remember-box{display:flex;align-items:center;gap:18px;flex-wrap:wrap;margin-top:10px;padding-left:2px;}",
    "#atrust-remember-box .atrust-cb{display:inline-flex;align-items:center;cursor:pointer;color:#1f1f1f;font-size:14px;line-height:22px;user-select:none;}",
    "#atrust-remember-box .atrust-cb-input{position:relative;line-height:1;cursor:pointer;display:inline-block;}",
    "#atrust-remember-box .atrust-cb-input-inner{position:absolute;top:0;left:0;width:100%;height:100%;opacity:0;z-index:1;cursor:pointer;margin:0;padding:0;border:0;}",
    "#atrust-remember-box .atrust-cb-box{position:relative;display:block;width:16px;height:16px;background-color:#fff;border:1px solid #e0e0e0;border-radius:2px;box-sizing:border-box;transition:all .3s;}",
    "#atrust-remember-box .atrust-cb-box:before{content:'';position:absolute;top:0;right:0;border-top:8px solid transparent;border-left:8px solid transparent;transition:all .3s;}",
    "#atrust-remember-box .atrust-cb-box:after{content:'';position:absolute;top:7px;left:4px;width:5px;height:9px;border:2px solid #fff;border-top:0;border-left:0;transform:rotate(45deg) scale(0) translate(-50%,-50%);transition:all .3s;}",
    "#atrust-remember-box .atrust-cb-checked .atrust-cb-box{background-color:#1c6eff;border-color:#1c6eff;}",
    "#atrust-remember-box .atrust-cb-checked .atrust-cb-box:before{border-top-color:#1c6eff;}",
    "#atrust-remember-box .atrust-cb-checked .atrust-cb-box:after{opacity:1;transform:rotate(45deg) scale(1) translate(-65%,-50%);}",
    "#atrust-remember-box .atrust-cb:hover .atrust-cb-box{border-color:#1c6eff;}",
    "#atrust-remember-box .atrust-cb-label{font-size:14px;line-height:22px;padding:0 4px;}"
  ].join("");

  function ensureStyle() {
    if (document.getElementById("atrust-remember-style")) return;
    var st = document.createElement("style");
    st.id = "atrust-remember-style";
    st.textContent = CB_CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  function injectCheckboxes() {
    if (document.getElementById("atrust-remember-box")) return;
    var psw = findPswInput();
    if (!psw) return;
    ensureStyle();

    var rel = psw.closest(".form-input-line");
    var host = rel && rel.parentElement ? rel.parentElement : psw.parentElement;
    if (!host) return;

    var box = document.createElement("div");
    box.id = "atrust-remember-box";

    function mk(id, text, lsKey) {
      var wrap = document.createElement("label");
      wrap.className = "atrust-cb";
      var inp = document.createElement("span");
      inp.className = "atrust-cb-input";
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "atrust-cb-input-inner";
      cb.id = id;
      var sq = document.createElement("span");
      sq.className = "atrust-cb-box";
      inp.appendChild(cb);
      inp.appendChild(sq);
      var lb = document.createElement("span");
      lb.className = "atrust-cb-label";
      lb.textContent = text;
      wrap.appendChild(inp);
      wrap.appendChild(lb);

      var sync = function () {
        if (cb.checked) wrap.classList.add("atrust-cb-checked");
        else wrap.classList.remove("atrust-cb-checked");
      };
      cb.checked = localStorage.getItem(lsKey) === "1";
      sync();
      cb.addEventListener("change", function () {
        sync();
        localStorage.setItem(lsKey, cb.checked ? "1" : "0");
        if (lsKey === LS_ENABLED && !cb.checked) state.clear = true;
      });
      return wrap;
    }

    box.appendChild(mk("atrust-remember-cb", "记住密码", LS_ENABLED));
    box.appendChild(mk("atrust-remember-auto-cb", "掉线后自动登录", LS_AUTO));

    if (rel && rel.parentElement === host) host.insertBefore(box, rel.nextSibling);
    else host.appendChild(box);
  }

  /* ---------------- 回填 + 自动提交（v1.2 核心） ---------------- */
  function applyCredential() {
    var req = state.restoreReq;
    if (!req) return "no-req";

    var pEl = findPswInput();
    if (!pEl) return "no-form"; // 表单还没渲染，等下一次 tick 再来

    /* 填充实则：
     *   - 密码框为空 / 只有原生掩码 → 说明需要（重新）回填；
     *   - 密码框里已经有内容（多半是用户自己敲的）→ 不动它。
     * 表单被 SPA 重绘后，新元素的值是空的 → 会自动重新回填，
     * 这正是 v1.1 漏掉的那一步。 */
    if (!isEmptyPsw(pEl)) {
      // 值不是空的：如果是我们自己填的就继续走提交流程，否则不碰
      if (!(state.appliedEl === pEl && state.appliedVal && pEl.value === state.appliedVal)) {
        return "user-filled";
      }
    } else {
      var uEl = findUserInput();
      if (uEl && req.u) {
        setValue(uEl, req.u);
        state.lastUser = req.u;
      }
      if (req.p) {
        setValue(pEl, req.p);
        lastTyped = req.p;
      }
      state.appliedEl = pEl;
      state.appliedVal = req.p || "";
    }

    /* 提交：只提交「我们自己回填进去的那份密码」 */
    if (state.appliedEl !== pEl) return "not-ours";
    if (!state.appliedVal || pEl.value !== state.appliedVal) return "value-changed";
    if (state.submitEl === pEl) return "already-submitted"; // 同一个表单只提交一次
    if (!req.allowSubmit) return "submit-not-allowed"; // 用户主动退出登录时不自动提交
    if (localStorage.getItem(LS_AUTO) !== "1") return "auto-off";
    if (hasCaptcha()) return "captcha"; // 有图形验证码就交给人工
    if (state.submitCount >= MAX_SUBMIT_PER_CYCLE) return "submit-limit";
    var now = new Date().getTime();
    if (now - (state.lastSubmitAt || 0) < SUBMIT_COOLDOWN_MS) return "submit-cooldown";

    state.submitEl = pEl;
    state.submitCount++;
    state.lastSubmitAt = now;
    setTimeout(function () {
      var btn = findLoginButton();
      if (btn) {
        btn.click();
        return;
      }
      var pswEl = findPswInput();
      if (pswEl) {
        pswEl.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            code: "Enter",
            keyCode: 13,
            which: 13,
            bubbles: true
          })
        );
      }
    }, 900);
    return "submitted";
  }

  /* ---------------- 观察 DOM，等待登录框渲染 ---------------- */
  function tick() {
    injectCheckboxes();

    var pEl = findPswInput();
    if (!pEl) {
      /* 登录框从 DOM 消失 → 登录页已离开（登录成功或跳走）
       * 结束本轮登录周期，允许下一轮重新提交。 */
      if (state.appliedEl) {
        state.appliedEl = null;
        state.appliedVal = "";
        state.submitEl = null;
        state.submitCount = 0;
      }
    } else {
      state.sawLoginForm = true;
      /* 自愈：只要有凭据且密码框是空的，就（重新）回填。
       * 表单重绘 → 元素变了、值为空 → 这里会自动补上。 */
      if (state.restoreReq) applyCredential();
    }

    // 兜底：登录成功后登录框从 DOM 消失（门户可能用 fetch 提交，拦截不到）。
    // 只有「确实见过登录框 + 用户手打过密码 + 现在登录框没了」才落凭据。
    var uNow = findUserInput();
    if (uNow && uNow.value) state.lastUser = uNow.value.trim();
    if (!findPswInput()) {
      if (lastTyped && state.sawLoginForm && !state.pending) {
        stageCredential();
      }
    }
  }

  if (window.MutationObserver) {
    var mo = new MutationObserver(function () {
      if (tick._t) return;
      tick._t = setTimeout(function () {
        tick._t = null;
        tick();
      }, 300);
    });
    var start = function () {
      if (document.body) mo.observe(document.body, { childList: true, subtree: true });
    };
    if (document.body) start();
    else document.addEventListener("DOMContentLoaded", start);
  }
  setInterval(tick, 1000);
  document.addEventListener("DOMContentLoaded", tick);

  /* 接管旧版本实例时，把它已经捕获的待存凭据补交上去 */
  if (legacyPending) {
    state.pending = legacyPending;
  }
})();
