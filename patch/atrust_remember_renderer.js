/**
 * aTrustRemember —— 渲染进程注入脚本
 *
 * 由主进程通过 webContents.executeJavaScript 注入到门户登录页所在的渲染进程。
 *
 * 实测的登录页 DOM 结构（aTrust 门户 SPA, useInitHelp*.js 模板）：
 *   div.switch-login-slide > div.auth-password
 *     > div.form-input-line.user-input  →  input#username   (placeholder: 请输入您的用户名)
 *     > div.form-input-line.rel         →  input#password   (placeholder: 请输入密码)
 *     > 登录按钮 = input[type=submit] / button，文本 "登录"
 *
 * 职责:
 *   1. 在密码行下方插入「记住密码」「掉线后自动登录」两个开关（localStorage 记忆）。
 *   2. 监听 #password 的输入，捕获明文密码（仅驻留内存）。
 *   3. 拦截 POST /passport/v1/auth/psw 的响应：
 *      成功 → 把凭据交给主进程用 DPAPI 加密保存；
 *      失败 → 通知主进程丢弃本地凭据，避免反复重试导致账号锁定。
 *   4. 主进程 restore() 时回填用户名/密码，并按开关自动提交登录。
 *
 * 说明: 这里的自动提交是「重新走一次正常的账号密码登录」，
 *       服务端的二次认证 / 设备风控 / 防重放策略全部照常生效。
 */
(function () {
  if (window.__atrustRemember) return;

  var MASK = "♂♀☺♪♫◙♂♀"; // 原生"记住密码"使用的密码掩码
  var LS_USER = "atrustRememberUser";
  var LS_ENABLED = "atrustRememberEnabled";
  var LS_AUTO = "atrustRememberAutoLogin";

  var state = { pending: null, fail: false, clear: false, restoreReq: null, applied: false, autoSubmitTried: false, sawLoginForm: false, lastUser: "", allowSubmit: false };
  var lastTyped = "";
  var retryCount = 0;
  var MAX_RETRY = 40;

  /* ---------------- API（主进程调用） ---------------- */
  window.__atrustRemember = {
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
      // 主动拉取：门户用 hash 路由跳到登录页时不会触发 did-finish-load，
      // 主进程推不到凭据；这里检测到登录框就向主进程请求回填。
      try {
        var now = new Date().getTime();
        if (!state.applied && findPswInput() && now - (state.askRestoreAt || 0) > 4000) {
          state.askRestoreAt = now;
          out = { needRestore: true };
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
    restore: function (c) {
      if (c && c.u) {
        state.restoreReq = { u: c.u, p: c.p };
        state.applied = false;
        state.autoSubmitTried = false;
        // 只有主进程明确允许时才自动提交（用户主动退出登录时禁止自动登录）
        state.allowSubmit = c.allowSubmit === true;
        retryCount = 0;
        applyCredential(c.u, c.p);
      }
    },
    /* 服务端拒绝凭据后取消本地自动重试，避免反复尝试导致账号锁定 */
    cancelRestore: function () {
      state.restoreReq = null;
      state.applied = false;
      state.autoSubmitTried = false;
      state.pending = null;
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
    /* 自检接口: 供主进程探针调用 */
    diag: function () {
      var u = findUserInput();
      var p = findPswInput();
      var b = findLoginButton();
      return {
        userFound: !!u,
        userPh: u ? String(u.placeholder || "") : null,
        userVal: u ? String(u.value || "") : null,
        pswFound: !!p,
        pswId: p ? p.id : null,
        pswType: p ? p.type : null,
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

  function findPswInput() {
    var byId = asInput(document.getElementById("password"));
    if (byId) return byId;
    var inputs = allInputs();
    return (
      inputs.filter(function (i) { return i.type === "password" && isVisible(i); })[0] ||
      inputs.filter(function (i) { return i.value === MASK; })[0] ||
      inputs.filter(function (i) { return (i.placeholder || "").indexOf("密码") >= 0 && isVisible(i); })[0] ||
      null
    );
  }

  function findUserInput() {
    var byId = asInput(document.getElementById("username"));
    if (byId) return byId;
    var psw = findPswInput();
    var inputs = allInputs().filter(function (i) {
      return i !== psw && i.type !== "checkbox" && i.type !== "radio" && i.type !== "hidden" && isVisible(i);
    });
    return (
      // 实测登录页用户名框: input.ix-input-inner[placeholder="请输入账号"]（无 id）
      inputs.filter(function (i) {
        var p = i.placeholder || "";
        return p.indexOf("账号") >= 0 || p.indexOf("用户名") >= 0;
      })[0] ||
      inputs.filter(function (i) { return i.type === "text" || !i.type; })[0] ||
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

  /* ---------------- 回填 + 自动提交 ---------------- */
  function applyCredential(u, p) {
    if (!state.restoreReq) return;
    if (state.applied) return;
    if (retryCount > MAX_RETRY) return;
    retryCount++;
    setTimeout(function () {
      var uEl = findUserInput();
      var pEl = findPswInput();
      if (!uEl || !pEl) {
        applyCredential(u, p);
        return;
      }
      retryCount = 0;
      state.applied = true;
      if (u) {
        setValue(uEl, u);
        state.lastUser = u;
      }
      if (p) {
        setValue(pEl, p);
        lastTyped = p;
      }
      if (localStorage.getItem(LS_AUTO) !== "1") return;
      if (state.allowSubmit !== true) return; // 用户主动退出登录时不自动提交
      if (hasCaptcha()) return; // 有图形验证码就交给人工
      if (state.autoSubmitTried) return; // 同一个页面只自动提交一次
      state.autoSubmitTried = true;
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
    }, 350);
  }

  /* ---------------- 观察 DOM，等待登录框渲染 ---------------- */
  function tick() {
    injectCheckboxes();
    // 登录框可能比主进程首次回填更晚渲染，这里持续重试直到成功
    if (state.restoreReq && !state.applied) {
      applyCredential(state.restoreReq.u, state.restoreReq.p);
    }
    // 兜底：登录成功后登录框从 DOM 消失（门户可能用 fetch 提交，拦截不到）。
    // 只有「确实见过登录框 + 用户手打过密码 + 现在登录框没了」才落凭据。
    var uNow = findUserInput();
    if (uNow && uNow.value) state.lastUser = uNow.value.trim();
    if (findPswInput()) {
      state.sawLoginForm = true;
    } else if (lastTyped && state.sawLoginForm && !state.pending) {
      stageCredential();
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
})();
