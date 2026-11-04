/*
 * compile.worker.js — 常驻的编译 Worker
 * 只加载一次 clang.wasm / lld.wasm / sysroot.tar，之后反复复用。
 * 超时或出错时不需要重建它（运行用户程序用的是另一个一次性 Worker）。
 */
'use strict';
importScripts('wasmclang.js');

let tc = null;
let initing = null;

function postWrite(bytes) {
  postMessage({ type: 'write', bytes: bytes }, [bytes.buffer]);
}

function makeToolchain(base, assets) {
  async function readBuffer(name) {
    const r = await fetch(base + name);
    if (!r.ok) throw new Error(`HTTP ${r.status} 读取 ${name} 失败`);
    return r.arrayBuffer();
  }
  async function compileModule(name) {
    const url = base + (assets[name] || name);
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status} 读取 ${url} 失败`);
    const type = r.headers.get('content-type') || '';
    if (type.includes('application/wasm') && WebAssembly.compileStreaming) {
      return await WebAssembly.compileStreaming(r);
    }
    return await WebAssembly.compile(await r.arrayBuffer());
  }
  return new WasmClang.Toolchain({
    memfs: 'memfs.wasm',
    readBuffer: (n) => readBuffer(n),
    compileModule: (n) => compileModule(n),
    onWrite: postWrite,
    onProgress: (text) => postMessage({ type: 'progress', text }),
  });
}

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.type === 'init') {
      if (initing) return;
      const t0 = performance.now();
      tc = makeToolchain(m.base, m.assets || {});
      initing = tc.init().then(() => {
        postMessage({
          type: 'ready',
          initMs: Math.round(performance.now() - t0),
          sysrootFiles: tc.sysrootFiles,
        });
        initing = null;
      }).catch((e) => {
        initing = null;
        postMessage({ type: 'error', message: `工具链初始化失败：${(e && e.message) || e}` });
      });
      return;
    }

    if (m.type === 'compile') {
      const t0 = performance.now();
      tc.setSink(postWrite);
      postMessage({ type: 'stage', stage: 'compile' });
      const res = await tc.compileAndLink(m.code, m.opts);
      tc.setSink(null);
      const ms = Math.round(performance.now() - t0);
      if (!res.ok) {
        postMessage({
          type: 'result', ok: false, phase: res.phase, exitCode: res.exitCode, ms,
        });
        return;
      }
      postMessage({
        type: 'result', ok: true, ms, bytes: res.wasm.byteLength,
        wasm: res.wasm,
      }, [res.wasm.buffer]);
      return;
    }

    if (m.type === 'dispose') {
      tc = null;
      initing = null;
      close();
    }
  } catch (e) {
    tc && tc.setSink(null);
    postMessage({ type: 'error', message: String((e && e.stack) || e) });
  }
};
