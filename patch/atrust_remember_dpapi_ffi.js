/**
 * aTrustRemember —— 进程内 DPAPI（ffi-napi 直调 Win32 CryptProtectData）
 *
 * 安装位置: <aTrustTray>\resources\app\src\service\atrust_remember_dpapi_ffi.js
 *
 * 为什么需要它：
 *   aTrust 托盘的「浏览器进程」被自保护策略(aTrustDefenser)禁止创建任何
 *   非深信服签名的子进程 —— spawnSync/execFile/spawn/explorer 一律 EPERM。
 *   即便用「自身 exe 以 ELECTRON_RUN_AS_NODE 自举」绕开，派生进程里再拉
 *   powershell 同样被拒。
 *
 *   但「加载一个本地 DLL」并不属于进程创建，不受该策略约束。
 *   本模块用 ffi-napi 在当前进程内直接调用 crypt32!CryptProtectData /
 *   CryptUnprotectData，**零子进程、零 PowerShell**，彻底绕开 EPERM。
 *
 * 依赖（第三方开源，随补丁一起放在 %APPDATA%\aTrustRemember\vendor\node_modules）：
 *   ffi-napi     MIT   —— libffi 绑定
 *   ref-napi     MIT   —— 指针/类型层
 *   ref-struct-di MIT  —— 结构体辅助
 *   node-gyp-build MIT —— 预编译二进制选择
 *   debug / ms   MIT
 *   全部为 N-API(N-API v1) 预编译二进制，不含 C++ 运行时、不编译、不联网。
 *
 * 安全属性：
 *   - DPAPI scope = CurrentUser：密文只能由「同一 Windows 用户 + 同一台机器」解密。
 *   - 本模块只提供加密/解密能力，不决定落盘策略；落盘决策在主进程模块里。
 *   - 加载失败时抛错，由上层决定是否降级；**任何情况下都不会落明文**。
 *
 * 本文件不含任何密钥或口令。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const APPDATA = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
const VENDOR_ROOT = path.join(APPDATA, "aTrustRemember", "vendor");
const NM = path.join(VENDOR_ROOT, "node_modules");

const CRYPTPROTECT_UI_FORBIDDEN = 0x1; // 不弹 UI

let S = null; // 已加载的 ffi 运行时
let S_ERR = null; // 加载失败原因（只记录一次）

function errText(e) {
  if (!e) return "null";
  return String((e && e.stack) || e).replace(/\s+/g, " ").slice(0, 300);
}

/**
 * 延迟加载 ffi 运行时。
 * 返回 null 表示不可用（S_ERR 里有原因）。
 */
function loadState() {
  if (S) return S;
  if (S_ERR) return null;
  try {
    if (!fs.existsSync(path.join(NM, "ffi-napi"))) {
      throw new Error("vendor-missing: " + NM);
    }
    const ffi = require(path.join(NM, "ffi-napi"));
    const ref = require(path.join(NM, "ref-napi"));

    const IS64 = process.arch === "x64";
    const crypt32 = ffi.Library("crypt32.dll", {
      CryptProtectData: ["bool", ["pointer", "pointer", "pointer", "pointer", "pointer", "uint32", "pointer"]],
      CryptUnprotectData: ["bool", ["pointer", "pointer", "pointer", "pointer", "pointer", "uint32", "pointer"]]
    });
    const kernel32 = ffi.Library("kernel32.dll", {
      LocalFree: ["pointer", ["pointer"]],
      GetLastError: ["uint32", []]
    });

    S = {
      ffi: ffi,
      ref: ref,
      crypt32: crypt32,
      kernel32: kernel32,
      IS64: IS64,
      CB_OFF: 0, // DWORD cbData
      PTR_OFF: IS64 ? 8 : 4, // BYTE *pbData（x64 需 4 字节对齐）
      BLOB_SIZE: IS64 ? 16 : 8,
      ptrType: ref.refType(ref.types.void)
    };
    return S;
  } catch (e) {
    S_ERR = e;
    S = null;
    return null;
  }
}

/* 独立分配（不走 Buffer 池，地址与 byteOffset 无关） */
function alloc(n) {
  return Buffer.allocUnsafeSlow(Math.max(n, 1));
}

/* 构造 DATA_BLOB 入参 */
function makeInBlob(st, bytes) {
  const blob = alloc(st.BLOB_SIZE);
  blob.fill(0);
  const data = alloc(bytes.length);
  bytes.copy(data);
  blob.writeUInt32LE(bytes.length, st.CB_OFF);
  // writePointer：写入 data 的真实地址
  st.ref.set(blob, st.PTR_OFF, data, st.ptrType);
  return { blob: blob, data: data };
}

/* 读取 DATA_BLOB 出参（必须在 LocalFree 之前拷贝） */
function readOutBlob(st, blob) {
  const cb = blob.readUInt32LE(st.CB_OFF);
  if (!cb || cb > 8 * 1024 * 1024) throw new Error("bad cbData=" + cb);
  const view = st.ref.readPointer(blob, st.PTR_OFF, cb);
  return Buffer.from(view).slice(0, cb);
}

/* 释放 CryptProtectData 分配的内存 */
function freeOut(st, blob) {
  try {
    // readPointer(size=1) 得到一个「位于该地址」的 1 字节 Buffer，
    // 它的数据指针即待释放的 HLOCAL，交给 LocalFree 即可。
    const handle = st.ref.readPointer(blob, st.PTR_OFF, 1);
    st.kernel32.LocalFree(handle);
  } catch (e) {
    /* 释放失败不影响正确性，只是泄漏一小块内存 */
  }
}

function protect(bytes) {
  const st = loadState();
  if (!st) throw new Error("ffi-unavailable: " + errText(S_ERR));
  const inB = makeInBlob(st, bytes);
  const outBlob = alloc(st.BLOB_SIZE);
  outBlob.fill(0);
  const ok = st.crypt32.CryptProtectData(
    inB.blob, null, null, null, null, CRYPTPROTECT_UI_FORBIDDEN, outBlob
  );
  if (!ok) {
    throw new Error("CryptProtectData failed lastError=" + st.kernel32.GetLastError());
  }
  const out = readOutBlob(st, outBlob);
  freeOut(st, outBlob);
  return out;
}

function unprotect(bytes) {
  const st = loadState();
  if (!st) throw new Error("ffi-unavailable: " + errText(S_ERR));
  const inB = makeInBlob(st, bytes);
  const outBlob = alloc(st.BLOB_SIZE);
  outBlob.fill(0);
  const ok = st.crypt32.CryptUnprotectData(
    inB.blob, null, null, null, null, CRYPTPROTECT_UI_FORBIDDEN, outBlob
  );
  if (!ok) {
    throw new Error("CryptUnprotectData failed lastError=" + st.kernel32.GetLastError());
  }
  const out = readOutBlob(st, outBlob);
  freeOut(st, outBlob);
  return out;
}

/** 可用性自检：做一次真实往返 */
function probe() {
  const st = loadState();
  if (!st) return { ok: false, err: errText(S_ERR) };
  const plain = Buffer.from("aTrustRemember-probe", "utf8");
  const enc = protect(plain);
  const dec = unprotect(enc);
  return {
    ok: dec.toString("utf8") === plain.toString("utf8"),
    arch: process.arch,
    encryptedBytes: enc.length,
    err: dec.toString("utf8") === plain.toString("utf8") ? "" : "roundtrip-mismatch"
  };
}

module.exports = {
  available: function () {
    return loadState() !== null;
  },
  protect: protect,
  unprotect: unprotect,
  probe: probe,
  vendorRoot: VENDOR_ROOT,
  nodeModules: NM,
  lastError: function () {
    return errText(S_ERR);
  }
};
