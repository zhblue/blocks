/*
 * wasmclang.js — 浏览器内 C++ 工具链驱动层
 *
 * 派生自 binji/wasm-clang 的 shared.js
 *   Copyright 2020 WebAssembly Community Group participants
 *   Licensed under the Apache License, Version 2.0
 * https://github.com/binji/wasm-clang
 *
 * 相对上游的改动（都在 I/O 与健壮性上）：
 *   1. stdin/stdout 改为按字节传输，用 TextDecoder(stream) 解码 —— 中文不再乱码。
 *   2. 实现 clock_time_get（上游直接抛 NotImplemented），std::chrono / time() 可用。
 *   3. 宿主导入用 Proxy 兜底：模块引用了未实现的 wasi/env 函数时，报错信息里
 *      会指名是哪个函数，而不是 LinkError。
 *   4. 去掉 canvas 实现（保留名字），只留编译/链接/运行这条路径。
 *   5. 编译与链接合并成 compileAndLink()，由调用方决定在哪条 Worker 里跑。
 */

(function (global) {
  'use strict';

  const ESUCCESS = 0;

  class ProcExit extends Error {
    constructor(code) {
      super(`process exited with code ${code}.`);
      this.code = code;
    }
  }

  class NotImplemented extends Error {
    constructor(modname, fieldname) {
      super(`${modname}.${fieldname} not implemented.`);
    }
  }

  class AbortError extends Error {
    constructor(msg = 'abort') {
      super(msg);
    }
  }

  function assert(cond, msg) {
    if (!cond) throw new AbortError(msg || 'assertion failed.');
  }

  /* 只在路径 / ASCII 场景使用：逐字节转 Latin1，不做 UTF-8 解码。 */
  function readStr(u8, o, len = -1) {
    let str = '';
    let end = u8.length;
    if (len !== -1) end = o + len;
    for (let i = o; i < end && u8[i] !== 0; ++i) str += String.fromCharCode(u8[i]);
    return str;
  }

  const textEncoder = new TextEncoder();

  /* ------------------------------------------------------------------ */
  /* Guest memory view                                                   */
  /* ------------------------------------------------------------------ */
  class Memory {
    constructor(memory) {
      this.memory = memory;
      this.buffer = memory.buffer;
      this.u8 = new Uint8Array(this.buffer);
      this.u32 = new Uint32Array(this.buffer);
    }

    /* wasm 内存 grow 之后旧的 ArrayBuffer 会被 detach，必须重建视图。 */
    check() {
      if (this.buffer.byteLength === 0) {
        this.buffer = this.memory.buffer;
        this.u8 = new Uint8Array(this.buffer);
        this.u32 = new Uint32Array(this.buffer);
      }
    }

    read8(o) { return this.u8[o]; }
    read32(o) { return this.u32[o >> 2]; }
    write8(o, v) { this.u8[o] = v; }
    write32(o, v) { this.u32[o >> 2] = v; }

    writeU64(o, value) {
      const v = BigInt(value);
      this.write32(o, Number(v & 0xffffffffn));
      this.write32(o + 4, Number(v >> 32n));
    }
    readU64(o) {
      return BigInt(this.read32(o)) | (BigInt(this.read32(o + 4)) << 32n);
    }

    readStr(o, len = -1) { return readStr(this.u8, o, len); }

    /* data: Uint8Array | ArrayBuffer | string(UTF-8) */
    write(o, data) {
      if (data instanceof ArrayBuffer) data = new Uint8Array(data);
      if (typeof data === 'string') data = textEncoder.encode(data);
      this.check();
      new Uint8Array(this.buffer, o, data.length).set(data);
      return data.length;
    }

    read(o, len) {
      this.check();
      return new Uint8Array(new Uint8Array(this.buffer, o, len));  /* 复制一份 */
    }

    writeStr(o, str) {
      const n = this.write(o, str);
      this.write8(o + n, 0);
      return n + 1;
    }
  }

  /* ------------------------------------------------------------------ */
  /* memfs.wasm 的宿主侧包装：一个纯内存文件系统 + stdin/stdout 通道       */
  /* ------------------------------------------------------------------ */
  class MemFS {
    constructor(options) {
      this.compileStreaming = options.compileStreaming;
      /* hostWrite 收到的是 Uint8Array（原始字节，不是字符串）。 */
      this.hostWrite = options.hostWrite;
      this.memfsFilename = options.memfsFilename;
      this.stdinBytes = new Uint8Array(0);
      this.stdinPos = 0;
      this.hostMem_ = null;

      const target = {
        abort: (msg, len) => {
          this.mem.check();
          throw new AbortError(len === -1 ? 'abort' : this.mem.readStr(msg, len));
        },
        host_write: this.host_write.bind(this),
        host_read: this.host_read.bind(this),
        memfs_log: (buf, len) => {
          this.mem.check();
          console.log('[memfs]', this.mem.readStr(buf, len));
        },
        copy_out: (clang_dst, memfs_src, size) => {
          this.hostMem_.check();
          const dst = new Uint8Array(this.hostMem_.buffer, clang_dst, size);
          this.mem.check();
          dst.set(new Uint8Array(this.mem.buffer, memfs_src, size));
        },
        copy_in: (memfs_dst, clang_src, size) => {
          this.mem.check();
          const dst = new Uint8Array(this.mem.buffer, memfs_dst, size);
          this.hostMem_.check();
          dst.set(new Uint8Array(this.hostMem_.buffer, clang_src, size));
        },
      };

      this.ready = this.compileStreaming(this.memfsFilename)
        .then((module) => WebAssembly.instantiate(module, { env: guard(target, 'env') }))
        .then((instance) => {
          this.instance = instance;
          this.exports = instance.exports;
          this.mem = new Memory(this.exports.memory);
          this.exports.init();
        });
    }

    set hostMem(mem) { this.hostMem_ = mem; }

    setStdin(bytes) {
      this.stdinBytes = typeof bytes === 'string' ? textEncoder.encode(bytes) : bytes;
      this.stdinPos = 0;
    }

    addDirectory(path) {
      this.mem.check();
      this.mem.write(this.exports.GetPathBuf(), path);
      this.exports.AddDirectoryNode(path.length);
    }

    addFile(path, contents) {
      if (contents instanceof ArrayBuffer) contents = new Uint8Array(contents);
      if (typeof contents === 'string') contents = textEncoder.encode(contents);
      this.mem.check();
      this.mem.write(this.exports.GetPathBuf(), path);
      const inode = this.exports.AddFileNode(path.length, contents.length);
      const addr = this.exports.GetFileNodeAddress(inode);
      this.mem.check();
      this.mem.write(addr, contents);
    }

    /* 注意：memfs.wasm 的 FindNode 对不存在的路径是直接 abort(trap)，
       不是返回哨兵值，所以这里必须吃掉异常。 */
    hasFile(path) {
      try {
        this.mem.check();
        this.mem.write(this.exports.GetPathBuf(), path);
        const inode = this.exports.FindNode(path.length);
        if (inode === 0xffffffff || inode === 0) return false;
        this.exports.GetFileNodeAddress(inode);
        return true;
      } catch (e) {
        return false;
      }
    }

    getFileSize(path) {
      this.mem.check();
      this.mem.write(this.exports.GetPathBuf(), path);
      const inode = this.exports.FindNode(path.length);
      return this.exports.GetFileNodeSize(inode);
    }

    getFileContents(path) {
      this.mem.check();
      this.mem.write(this.exports.GetPathBuf(), path);
      const inode = this.exports.FindNode(path.length);
      assert(inode !== 0xffffffff, `no such file in memfs: ${path}`);
      const addr = this.exports.GetFileNodeAddress(inode);
      const size = this.exports.GetFileNodeSize(inode);
      return new Uint8Array(new Uint8Array(this.mem.buffer, addr, size));
    }

    /* iovec[] 全部落到一个 Uint8Array 再交给宿主，避免按字节拼字符串。 */
    host_write(fd, iovs, iovs_len, nwritten_out) {
      this.hostMem_.check();
      assert(fd <= 2, `host_write: unexpected fd ${fd}`);
      const parts = [];
      let size = 0;
      for (let i = 0; i < iovs_len; ++i) {
        const buf = this.hostMem_.read32(iovs);
        iovs += 4;
        const len = this.hostMem_.read32(iovs);
        iovs += 4;
        parts.push(this.hostMem_.read(buf, len));
        size += len;
      }
      const out = new Uint8Array(size);
      let off = 0;
      for (const p of parts) { out.set(p, off); off += p.length; }
      this.hostMem_.write32(nwritten_out, size);
      if (size > 0) this.hostWrite(out);
      return ESUCCESS;
    }

    host_read(fd, iovs, iovs_len, nread_out) {
      this.hostMem_.check();
      assert(fd === 0, `host_read: unexpected fd ${fd}`);
      let size = 0;
      for (let i = 0; i < iovs_len; ++i) {
        const buf = this.hostMem_.read32(iovs);
        iovs += 4;
        const len = this.hostMem_.read32(iovs);
        iovs += 4;
        const avail = this.stdinBytes.length - this.stdinPos;
        const n = Math.min(len, avail);
        if (n === 0) break;
        this.hostMem_.write(buf, this.stdinBytes.subarray(this.stdinPos, this.stdinPos + n));
        size += n;
        this.stdinPos += n;
        if (n !== len) break;
      }
      this.hostMem_.write32(nread_out, size);
      return ESUCCESS;
    }
  }

  /* ------------------------------------------------------------------ */
  /* 宿主导入兜底：未实现的名字返回一个会指名报错的函数                     */
  /* ------------------------------------------------------------------ */
  function guard(target, nsName, missing) {
    return new Proxy(target, {
      has() { return true; },
      get(obj, prop) {
        if (typeof prop !== 'string') return obj[prop];
        if (prop in obj) return obj[prop];
        if (missing && !missing.includes(prop)) missing.push(prop);
        return () => { throw new NotImplemented(nsName, prop); };
      },
    });
  }

  /* ------------------------------------------------------------------ */
  /* 一个 wasi preview1 应用（clang / lld / 用户程序都走这里）             */
  /* ------------------------------------------------------------------ */
  class WasiApp {
    constructor(module, memfs, name, ...args) {
      this.argv = [name, ...args];
      this.environ = { USER: 'player', PATH: '/' };
      this.memfs = memfs;
      this.handles = new Map();
      this.nextHandle = 3;          /* 0/1/2 是 stdin/stdout/stderr */
      this.missingImports = [];

      const self = this;
      const wasiTarget = Object.assign({}, memfs.exports, {
        proc_exit(code) { throw new ProcExit(code); },

        environ_sizes_get(count_out, buf_size_out) {
          self.mem.check();
          const names = Object.getOwnPropertyNames(self.environ);
          let size = 0;
          for (const n of names) size += n.length + self.environ[n].length + 2;
          self.mem.writeU64(count_out, names.length);
          self.mem.writeU64(buf_size_out, size);
          return ESUCCESS;
        },
        environ_get(ptrs, buf) {
          self.mem.check();
          for (const n of Object.getOwnPropertyNames(self.environ)) {
            self.mem.write32(ptrs, buf);
            ptrs += 4;
            buf += self.mem.writeStr(buf, `${n}=${self.environ[n]}`);
          }
          self.mem.write32(ptrs, 0);
          return ESUCCESS;
        },
        args_sizes_get(argc_out, buf_size_out) {
          self.mem.check();
          let size = 0;
          for (const a of self.argv) size += a.length + 1;
          self.mem.writeU64(argc_out, self.argv.length);
          self.mem.writeU64(buf_size_out, size);
          return ESUCCESS;
        },
        args_get(argv_ptrs, argv_buf) {
          self.mem.check();
          for (const a of self.argv) {
            self.mem.write32(argv_ptrs, argv_buf);
            argv_ptrs += 4;
            argv_buf += self.mem.writeStr(argv_buf, a);
          }
          self.mem.write32(argv_ptrs, 0);
          return ESUCCESS;
        },
        random_get(buf, len) {
          self.mem.check();
          const view = new Uint8Array(self.mem.buffer, buf, len);
          if (global.crypto && global.crypto.getRandomValues) {
            for (let i = 0; i < len; i += 65536) {
              global.crypto.getRandomValues(view.subarray(i, Math.min(i + 65536, len)));
            }
          } else {
            for (let i = 0; i < len; ++i) view[i] = (Math.random() * 256) | 0;
          }
          return ESUCCESS;
        },
        /* 上游这里是 NotImplemented；实现之后 std::chrono / time() / srand 播种才可用。 */
        clock_time_get(id, precision, out) {
          self.mem.check();
          let ns;
          if (id === 0) ns = BigInt(Date.now()) * 1000000n;
          else {
            const now = (typeof performance !== 'undefined' && performance.now)
              ? performance.now() : Date.now();
            ns = BigInt(Math.round(now * 1e6));
          }
          self.mem.writeU64(out, ns);
          return ESUCCESS;
        },
        poll_oneoff(_, __, ___, out) {
          /* 不实现真正的等待：返回 0 个事件，避免 std::this_thread::sleep 挂死。 */
          self.mem.check();
          self.mem.writeU64(out, 0);
          return ESUCCESS;
        },
      });

      /* 用户程序若链接了 libcanvas，会引用 env.canvas_*；一律空实现。 */
      const envTarget = {
        abort: (msg, len) => {
          self.mem.check();
          throw new AbortError(len === -1 ? 'abort' : self.mem.readStr(msg, len));
        },
      };

      const imports = {
        wasi_unstable: guard(wasiTarget, 'wasi_unstable', this.missingImports),
        wasi_snapshot_preview1: guard(wasiTarget, 'wasi_snapshot_preview1', this.missingImports),
        env: guard(envTarget, 'env', this.missingImports),
      };

      this.ready = WebAssembly.instantiate(module, imports).then((instance) => {
        this.instance = instance;
        this.exports = instance.exports;
        this.mem = new Memory(this.exports.memory);
        this.memfs.hostMem = this.mem;
      });
    }

    async start() {
      await this.ready;
      try {
        this.exports._start();
        return { code: 0, signal: null };
      } catch (exn) {
        if (exn instanceof ProcExit) {
          if (this.missingImports.length) {
            this.memfs.hostWrite(textEncoder.encode(
              `\n[warn] 未实现的宿主函数: ${this.missingImports.join(', ')}\n`));
          }
          return { code: exn.code, signal: null };
        }
        let msg = `\n[runtime error] ${exn && exn.message}\n`;
        if (exn && exn.stack) msg += `${exn.stack}\n`;
        this.memfs.hostWrite(textEncoder.encode(msg));
        return { code: 127, signal: null, error: exn };
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* ustar 解包（sysroot.tar 是 plain tar）                                */
  /* ------------------------------------------------------------------ */
  class Tar {
    constructor(buffer) {
      this.u8 = new Uint8Array(buffer);
      this.offset = 0;
    }
    readStr(len) { const s = readStr(this.u8, this.offset, len); this.offset += len; return s; }
    readOctal(len) { return parseInt(this.readStr(len), 8); }
    alignUp() { this.offset = (this.offset + 511) & ~511; }

    readEntry() {
      if (this.offset + 512 > this.u8.length) return null;
      const entry = {
        filename: this.readStr(100),
        mode: this.readOctal(8),
        owner: this.readOctal(8),
        group: this.readOctal(8),
        size: this.readOctal(12),
        mtim: this.readOctal(12),
        checksum: this.readOctal(8),
        type: this.readStr(1),
        linkname: this.readStr(100),
      };
      if (this.readStr(8) !== 'ustar  ') {
        /* 结尾的全零块 */
        return null;
      }
      entry.ownerName = this.readStr(32);
      entry.groupName = this.readStr(32);
      entry.devMajor = this.readStr(8);
      entry.devMinor = this.readStr(8);
      entry.filenamePrefix = this.readStr(155);
      this.alignUp();
      if (entry.type === '0') {
        entry.contents = this.u8.subarray(this.offset, this.offset + entry.size);
        this.offset += entry.size;
        this.alignUp();
      } else if (entry.type !== '5') {
        assert(false, `tar: unsupported entry type "${entry.type}" (${entry.filename})`);
      }
      return entry;
    }

    untar(memfs) {
      let entry;
      let files = 0;
      while ((entry = this.readEntry())) {
        if (entry.type === '0') { memfs.addFile(entry.filename, entry.contents); files++; }
        else memfs.addDirectory(entry.filename);
      }
      return files;
    }
    get files() { return 0; }
  }

  /* ------------------------------------------------------------------ */
  /* 工具链：clang -cc1 -> obj，wasm-ld -> user.wasm                      */
  /* ------------------------------------------------------------------ */
  const CLANG_COMMON = [
    '-disable-free',
    '-isysroot', '/',
    '-internal-isystem', '/include/c++/v1',
    '-internal-isystem', '/include',
    '-internal-isystem', '/lib/clang/8.0.1/include',
    '-ferror-limit', '19',
    '-fmessage-length', '80',
    '-fno-color-diagnostics',
  ];

  class Toolchain {
    /* options: {readBuffer(name)->ArrayBuffer, compileModule(name)->Module, onWrite(bytes)} */
    constructor(options) {
      this.options = options;
      this.moduleCache = new Map();
      this.missingImports = [];
      this.memfs = new MemFS({
        compileStreaming: options.compileModule,
        hostWrite: (bytes) => { this.writeSink(bytes); },
        memfsFilename: options.memfs || 'memfs.wasm',
      });
      this.sysrootPromise = null;
      this.ready = null;
    }

    /* 编译期输出（clang 诊断）走这里；运行期换成用户程序的通道。 */
    writeSink(bytes) {
      if (this.activeSink) this.activeSink(bytes);
      else this.options.onWrite(bytes);
    }

    setSink(fn) { this.activeSink = fn; }

    init() {
      if (this.ready) return this.ready;
      this.ready = (async () => {
        await this.memfs.ready;
        const t0 = Date.now();
        this.options.onProgress && this.options.onProgress('解压标准库头文件 sysroot.tar');
        const tar = new Tar(await this.options.readBuffer('sysroot.tar'));
        const n = tar.untar(this.memfs);
        this.options.onProgress && this.options.onProgress(`已装入 ${n} 个头文件/库`);
        this.sysrootFiles = n;
        this.initMs = Date.now() - t0;
      })();
      return this.ready;
    }

    async getModule(name) {
      if (this.moduleCache.has(name)) return this.moduleCache.get(name);
      this.options.onProgress && this.options.onProgress(`加载 ${name}`);
      const m = await this.options.compileModule(name);
      this.moduleCache.set(name, m);
      return m;
    }

    async runTool(module, ...args) {
      const app = new WasiApp(module, this.memfs, ...args);
      this.lastToolApp = app;
      const t0 = Date.now();
      const res = await app.start();
      res.ms = Date.now() - t0;
      return res;
    }

    /* 返回 {ok, wasm:Uint8Array|null, exitCode} */
    async compileAndLink(source, opts) {
      const o = opts || {};
      /* lang: 'c' 或 'c++'。积木生成的 C 代码要走 -x c / -std=c17，
         否则 clang 会按 C++ 语义接受/拒绝，报出来的行号和"等价 C 代码"对不上。 */
      const lang = o.lang === 'c' ? 'c' : 'c++';
      const filename = o.filename || (lang === 'c' ? 'main.c' : 'main.cc');
      const obj = o.obj || 'main.o';
      const out = o.output || 'main.wasm';
      const std = o.std || (lang === 'c' ? 'c17' : 'c++17');
      const level = o.optimize === undefined ? '2' : String(o.optimize);
      const stackSize = o.stackSize || 8 * 1024 * 1024;
      const extra = (o.flags || [])
        .join(' ').trim().split(/\s+/).filter((s) => s && s !== '-cc1');

      await this.init();
      this.memfs.addFile(filename, textEncoder.encode(source));

      const clang = await this.getModule(o.clang || 'clang.wasm');
      const cc1 = [
        'clang', '-cc1', '-emit-obj',
        ...CLANG_COMMON,
        `-std=${std}`,
        `-triple=wasm32-wasi`,
        `-O${level}`,
        ...extra,
        '-o', obj, '-x', lang, filename,
      ];
      const cres = await this.runTool(clang, ...cc1);
      if (cres.code !== 0 || !this.memfs.hasFile(obj)) {
        return { ok: false, phase: 'compile', exitCode: cres.code, wasm: null };
      }

      const lld = await this.getModule(o.lld || 'lld.wasm');
      const libdir = 'lib/wasm32-wasi';
      /* libc++.a 里的 long double / 128 位比较会引用 __lttf2/__getf2 这类
         compiler-rt 符号，必须显式链上 builtins 库。 */
      const builtins = 'lib/clang/8.0.1/lib/wasi';
      const ldArgs = [
        'wasm-ld', '--no-threads', '--export-dynamic',
        '-z', `stack-size=${stackSize}`,
        `-L${libdir}`, `-L${builtins}`,
        `${libdir}/crt1.o`, obj,
        '-lc', '-lc++', '-lc++abi', '-lcanvas',
        '-lclang_rt.builtins-wasm32',
        '-o', out,
      ];
      const lres = await this.runTool(lld, ...ldArgs);
      if (lres.code !== 0 || !this.memfs.hasFile(out)) {
        return { ok: false, phase: 'link', exitCode: lres.code, wasm: null };
      }
      return { ok: true, wasm: this.memfs.getFileContents(out), exitCode: 0 };
    }
  }

  global.WasmClang = {
    Toolchain, MemFS, WasiApp, Tar, Memory, ProcExit, NotImplemented, AbortError,
    textEncoder,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
