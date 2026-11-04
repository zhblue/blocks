/*
 * run.worker.js — 一次性运行 Worker
 * 每次「运行」都新建一个，超时就直接 terminate()，所以死循环不会拖垮编译状态。
 * 用户程序的 WASI 环境由 memfs.wasm（345KB，浏览器会缓存）提供。
 */
'use strict';
importScripts('wasmclang.js');

self.onmessage = async (ev) => {
  const m = ev.data;
  if (m.type !== 'run') return;
  const t0 = performance.now();

  let exit = { code: 127, memoryBytes: 0, note: 'startup-failed' };

  try {
    const memfs = new WasmClang.MemFS({
      compileStreaming: async () => {
        const r = await fetch(m.base + 'memfs.wasm');
        if (!r.ok) throw new Error(`HTTP ${r.status} 读取 memfs.wasm 失败`);
        return await WebAssembly.compile(await r.arrayBuffer());
      },
      hostWrite: (bytes) => postMessage({ type: 'write', bytes: bytes }, [bytes.buffer]),
      memfsFilename: 'memfs.wasm',
    });
    await memfs.ready;
    memfs.setStdin(m.stdin ? new Uint8Array(m.stdin) : new Uint8Array(0));

    const module = await WebAssembly.compile(new Uint8Array(m.wasm));
    const app = new WasmClang.WasiApp(module, memfs, m.name || 'main.wasm');
    await app.ready;
    exit = await app.start();
    exit.memoryBytes = app.exports.memory.buffer.byteLength;
    exit.note = exit.error ? String((exit.error.message || exit.error)) : null;
  } catch (e) {
    exit = {
      code: 127,
      memoryBytes: 0,
      note: String((e && e.message) || e),
    };
  }

  postMessage({
    type: 'exit',
    code: exit.code,
    ms: Math.round(performance.now() - t0),
    memoryBytes: exit.memoryBytes || 0,
    note: exit.note || null,
  });
};
