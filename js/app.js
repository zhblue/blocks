/*
 * app.js — 积木 → 等价 C / C++ 代码 → 浏览器内 clang 编译 → wasm 运行
 *
 * 三段职责：
 *   1) Blockly 工作区：注入、示例、积木变化后实时重新生成
 *   2) CGen.generate：积木 → C 或 C++ 源码（看工具栏「语言」）+ 中文诊断；
 *      诊断既列在面板里，也钉回积木上
 *   3) Worker 流水线：常驻 compile.worker（clang+lld 只加载一次）+ 一次性 run.worker
 */
'use strict';

const $ = (id) => document.getElementById(id);

/* Worker 里 fetch 按 worker 脚本的位置解析，所以资源必须给绝对 URL */
const BASE = new URL('assets/', location.href).href;
const ASSETS = { clang: 'clang.wasm', lld: 'lld.wasm', memfs: 'memfs.wasm', sysroot: 'sysroot.tar' };
const LS = { ws: 'blockly-c.workspace', stdin: 'blockly-c.stdin', opts: 'blockly-c.opts' };

/*
 * 语言类型。界面默认 C++，也可以切回 C：
 *   compile —— 传给 clang 的 -x 值（wasmclang.js 里 'c' 之外的值都按 C++ 处理）
 *   file    —— 编译时的文件名，只为让报错信息里的扩展名和实际语言一致
 *   stds    —— 「标准」下拉框在该语言下的候选；wasmclang.js 把 -std= 原样透传，
 *              所以候选必须和工具链里那份 clang 认的名字一致。这里的 clang.wasm 是
 *              wasi-sdk 5.6 的 clang 8.0.1，从二进制里的语言名表可以读到：
 *                C   : c89 c99 c11 c17
 *                C++ : c++98 c++11 c++14 c++17 c++2a   ← 没有 c++20，那个别名是
 *              clang 10 才加的，选了会被拒；要试 C++20 就用 c++2a。
 *              同理 C++ 模式绝不能出现 -std=c11 这种错配。
 * 生成器 js/c-generator.js 认的也是这个 key（'cpp' / 'c'）。
 */
const LANGS = {
  cpp: {
    compile: 'c++', file: 'main.cc', label: 'C++',
    stds: [['c++98', '-std=c++98'], ['c++11', '-std=c++11'], ['c++14', '-std=c++14'],
      ['c++17', '-std=c++17'], ['c++2a', '-std=c++2a（即 C++20）']],
    dflt: 'c++17',
  },
  c: {
    compile: 'c', file: 'main.c', label: 'C',
    stds: [['c99', '-std=c99'], ['c11', '-std=c11'], ['c17', '-std=c17']],
    dflt: 'c11',
  },
};
const langKey = () => ($('lang').value === 'c' ? 'c' : 'cpp');
const langOpt = () => LANGS[langKey()];

/** 按当前语言重填「标准」下拉框；keep 时尽量保住仍然存在的旧值 */
function fillStd(keep) {
  const sel = $('std');
  const prev = sel.value;
  const list = langOpt().stds;
  sel.innerHTML = '';
  for (const [val, text] of list) {
    const o = document.createElement('option');
    o.value = val;
    o.textContent = text;
    sel.appendChild(o);
  }
  const still = list.some((p) => p[0] === prev);
  sel.value = keep && still ? prev : langOpt().dflt;
}

/** 代码面板的标题跟着语言改：main.cc / main.c，别写着 C 却编 C++ */
function refreshSourceCaption() {
  $('srccap').textContent = '生成的 ' + langOpt().label + ' 代码 ' + langOpt().file
    + '（可直接微调后再编译；改过积木会被覆盖，用「按积木重新生成」找回）';
}

/* ================================================================== */
/* 1. Blockly 工作区                                                   */
/* ================================================================== */
const workspace = Blockly.inject('blocklyDiv', {
  renderer: 'zelos',
  toolbox: CBlocks.toolbox,
  media: 'vendor/blockly/media/',
  grid: { spacing: 28, length: 3, colour: '#d3d7e2', snap: true },
  zoom: { controls: true, wheel: true, startScale: 0.8, minScale: 0.35, maxScale: 1.6, scaleSpeed: 1.15 },
  trashcan: true,
  move: { scrollbars: true, drag: true, wheel: false },
});

/* ---------- 积木构造小 DSL ---------------------------------------- */
/* mk(类型, 字段, 输入)：语句槽给数组（自动串成链），值槽给单块。      */
/* extraState 按输入槽名字推断，示例写起来就不用再操心形状。           */
/* ------------------------------------------------------------------ */
function mk(type, fields, inputs) {
  const b = workspace.newBlock(type);
  const names = Object.keys(inputs || {});
  if (type === 'c_printf' || type === 'c_scanf') {
    b.loadExtraState({ nargs: names.filter((n) => n.indexOf('ARG') === 0).length });
  } else if (type === 'c_if' && names.indexOf('ELSE') >= 0) {
    b.loadExtraState({ hasElse: true });
  } else if (type === 'c_func_def') {
    b.loadExtraState({ np: String((fields && fields.NP) || 0) });
  } else if (type === 'c_call_stmt' || type === 'c_call_expr') {
    b.loadExtraState({ fn: (fields && fields.NAME) || '' });
  }
  b.cSpec = { fields: fields || {}, inputs: inputs || {} };
  b.initSvg();
  return b;
}

/* 字段按四种时机设，顺序错了值就填不进去：
   plain   —— 普通字段（变量名、类型、格式串…），最先设，后面的下拉才认得它们
   rebuild —— 设值会重建输入槽（调用积木选函数 → 长实参槽；函数积木改形参数），
              必须在连线之前设，否则连线后再设会把刚接上的子块拆掉
   late    —— 动态下拉（变量/数组名），要等工作区结构连好、且声明块名字已设好
*/
const REBUILD_FIELDS = { c_call_stmt: ['NAME'], c_call_expr: ['NAME'], c_func_def: ['NP'] };
const LATE_FIELDS = {
  c_var_get: ['VAR'], c_var_set: ['VAR'], c_read_var: ['VAR'],
  c_arr_get: ['ARR'], c_arr_set: ['ARR'], c_read_arr: ['ARR'],
};

/* 变量 / 数组 / 函数名的下拉候选是 Blockly 缓存的（积木刚从工具箱里拖出来时算的
   那一份往往是空的）。工作区一变就强制重算，并把还停在占位符上的选择补成第一个
   可用项，不然用户会看到「明明声明过却选不到」。 */
let syncingNames = false;
function syncNameFields() {
  if (syncingNames) return;
  syncingNames = true;
  try { CBlocks.helpers.syncDynamicFields(workspace); } finally { syncingNames = false; }
}

function realize(roots) {
  const list = Array.isArray(roots) ? roots : [roots];
  const all = [];
  const walk = (b) => {
    if (!b || b.__seen) return;
    b.__seen = true;
    all.push(b);
    for (const name of Object.keys(b.cSpec.inputs)) {
      const v = b.cSpec.inputs[name];
      (Array.isArray(v) ? v : [v]).forEach(walk);
    }
  };
  list.forEach(walk);

  const inList = (map, b, k) => (map[b.type] || []).indexOf(k) >= 0;
  /* 形参的类型/名字也算 late：设 NP 会重建这些字段，值必须等重建之后再补 */
  const isLate = (b, k) => inList(LATE_FIELDS, b, k) || /^P\d+_[TN]$/.test(k);
  const isRebuild = (b, k) => inList(REBUILD_FIELDS, b, k);
  /* 同一轮里也要讲先后：函数定义的 NP 和形参名必须先落地，「调用积木选函数」才会按
     真实形参长出实参槽，「变量」下拉也才认得那些名字；反过来就会把刚建好的结构拆掉。 */
  const RANK = { c_func_def: 0, c_var_decl: 1, c_arr_decl: 1 };
  const rank = (b) => (RANK[b.type] === undefined ? 5 : RANK[b.type]);
  const ordered = all.slice().sort((a, b) => rank(a) - rank(b));
  const setOne = (b, k) => {
    const f = b.getField && b.getField(k);
    /* Blockly 13 里 getOptions(false) 才是「重新生成」，getOptions(true) 是「用缓存」。
       缓存的是积木构造期算出来的那份（那时还没连线，是空的），所以必须传 false 强制重算。 */
    if (f && f.getOptions) { try { f.getOptions(false); } catch (e) {} }
    b.setFieldValue(b.cSpec.fields[k], k);
  };
  /** 按时机筛一遍字段来设 */
  const pass = (want) => {
    for (const b of ordered) {
      for (const k of Object.keys(b.cSpec.fields)) {
        const rebuild = isRebuild(b, k);
        const late = isLate(b, k);
        if (want === 'rebuild' ? rebuild : want === 'late' ? (late && !rebuild) : (!rebuild && !late)) {
          setOne(b, k);
        }
      }
    }
  };

  pass('plain');      /* 1) 声明名、类型、格式串先落地 */
  pass('rebuild');    /* 2) 长出参数槽 / 实参槽 */

  for (const b of all) {                                /* 3) 连线 */
    for (const name of Object.keys(b.cSpec.inputs)) {
      const inp = b.getInput(name);
      if (!inp || !inp.connection) continue;
      const kids = (Array.isArray(b.cSpec.inputs[name]) ? b.cSpec.inputs[name] : [b.cSpec.inputs[name]])
        .filter(Boolean);
      let prev = null;
      for (const child of kids) {
        if (child.outputConnection) inp.connection.connect(child.outputConnection);
        else if (prev && prev.nextConnection) prev.nextConnection.connect(child.previousConnection);
        else if (inp.connection && child.previousConnection) inp.connection.connect(child.previousConnection);
        prev = child;
      }
    }
  }

  pass('plain');      /* 4) 结构就位后再补一轮，然后才轮到依赖结构的下拉 */
  pass('late');
  syncNameFields();   /* 没写死字段名的下拉（比如新拖进来的「变量」）补上第一个可用项 */
  all.forEach((b) => { delete b.__seen; if (b.render) b.render(); });
  return all;
}

/** 整体换程序：清空工作区 → 造块 → 连线 → 重新生成 → 存本地。
 *  build 必须是函数：块要等 clear 之后才创建，否则会被自己清掉。 */
function loadProgram(build, opts) {
  const o = opts || {};
  workspace.clear();
  const roots = build();
  realize(roots);
  if (workspace.cleanUp) workspace.cleanUp();
  if (o.stdin !== undefined) $('stdin').value = o.stdin;
  saveWorkspace();
  regenerate();
}

/* ================================================================== */
/* 2. 示例程序                                                         */
/* ================================================================== */
const V = (type, fields) => mk(type, fields, {});           /* 纯值块，少写一对花括号 */
const get = (name) => V('c_var_get', { VAR: name });
const num = (n) => V('c_num', { NUM: String(n) });
const txt = (s) => V('c_text', { TEXT: s });
const cmp = (a, op, b) => mk('c_compare', { OP: op }, { A: a, B: b });

const EXAMPLES = {
  '入门：输出与变量': () => loadProgram(
    () => mk('c_main', {}, {
      BODY: [
        mk('c_print', { NL: 'TRUE' }, { MSG: txt('你好，C！') }),
        mk('c_var_decl', { TYPE: 'int', NAME: 'n' }, { INIT: num(42) }),
        mk('c_var_decl', { TYPE: 'double', NAME: 'pi' }, { INIT: num(3.14159) }),
        mk('c_printf', { FMT: 'n = %d，pi 保留两位 = %.2f\\n' }, { ARG0: get('n'), ARG1: get('pi') }),
      ],
    })),

  '读入 + 判断：比大小': () => loadProgram(
    () => mk('c_main', {}, {
      BODY: [
        mk('c_var_decl', { TYPE: 'int', NAME: 'a' }, {}),
        mk('c_var_decl', { TYPE: 'int', NAME: 'b' }, {}),
        mk('c_print', { NL: 'FALSE' }, { MSG: txt('请输入两个整数：') }),
        mk('c_read_var', { VAR: 'a' }, {}),
        mk('c_read_var', { VAR: 'b' }, {}),
        mk('c_if', {}, {
          COND: cmp(get('a'), '>', get('b')),
          DO: [mk('c_print', { NL: 'TRUE' }, { MSG: txt('a 大') })],
          ELSE: [mk('c_if', {}, {
            COND: cmp(get('a'), '==', get('b')),
            DO: [mk('c_print', { NL: 'TRUE' }, { MSG: txt('一样大') })],
            ELSE: [mk('c_print', { NL: 'TRUE' }, { MSG: txt('b 大') })],
          })],
        }),
      ],
    }), { stdin: '7 3\n' }),

  '循环 + 数组：求和与最大值': () => loadProgram(
    () => mk('c_main', {}, {
      BODY: [
        mk('c_arr_decl', { TYPE: 'int', NAME: 'a', LEN: '5' }, {}),
        mk('c_var_decl', { TYPE: 'int', NAME: 'sum' }, { INIT: num(0) }),
        mk('c_var_decl', { TYPE: 'int', NAME: 'max' }, { INIT: num(0) }),
        mk('c_for', { NAME: 'i' }, {
          FROM: num(0), TO: num(4), STEP: num(1),
          DO: [mk('c_read_arr', { ARR: 'a' }, { IDX: get('i') })],
        }),
        mk('c_for', { NAME: 'j' }, {
          FROM: num(0), TO: mk('c_arith', { OP: '-' }, { A: num(5), B: num(1) }), STEP: num(1),
          DO: [
            mk('c_var_set', { VAR: 'sum' }, {
              VALUE: mk('c_arith', { OP: '+' }, { A: get('sum'), B: mk('c_arr_get', { ARR: 'a' }, { IDX: get('j') }) }),
            }),
            mk('c_if', {}, {
              COND: cmp(mk('c_arr_get', { ARR: 'a' }, { IDX: get('j') }), '>', get('max')),
              DO: [mk('c_var_set', { VAR: 'max' }, { VALUE: mk('c_arr_get', { ARR: 'a' }, { IDX: get('j') }) })],
            }),
          ],
        }),
        mk('c_printf', { FMT: '和 = %d，最大 = %d\\n' }, { ARG0: get('sum'), ARG1: get('max') }),
      ],
    }), { stdin: '3 9 1 7 5\n' }),

  '函数：递归阶乘 + 调用': () => loadProgram(
    () => [
    mk('c_func_def', { NAME: 'fact', RET: 'int', NP: '1', P0_T: 'int', P0_N: 'n' }, {
      BODY: [
        mk('c_if', {}, {
          COND: cmp(get('n'), '<=', num(1)),
          DO: [mk('c_return', {}, { VALUE: num(1) })],
          ELSE: [mk('c_return', {}, {
            VALUE: mk('c_arith', { OP: '*' }, {
              A: get('n'),
              B: mk('c_call_expr', { NAME: 'fact' }, { ARG0: mk('c_arith', { OP: '-' }, { A: get('n'), B: num(1) }) }),
            }),
          })],
        }),
      ],
    }),
    mk('c_func_def', { NAME: 'report', RET: 'void', NP: '1', P0_T: 'int', P0_N: 'r' }, {
      BODY: [mk('c_printf', { FMT: '结果是 %d\\n' }, { ARG0: get('r') })],
    }),
    mk('c_main', {}, {
      BODY: [
        mk('c_var_decl', { TYPE: 'int', NAME: 'k' }, {}),
        mk('c_print', { NL: 'FALSE' }, { MSG: txt('求几的阶乘？') }),
        mk('c_read_var', { VAR: 'k' }, {}),
        mk('c_call_stmt', { NAME: 'report' }, {
          ARG0: mk('c_call_expr', { NAME: 'fact' }, { ARG0: get('k') }),
        }),
      ],
    }),
    ], { stdin: '6\n' }),

  'while + continue：3 的倍数之和': () => loadProgram(
    () => mk('c_main', {}, {
      BODY: [
        mk('c_var_decl', { TYPE: 'int', NAME: 'i' }, { INIT: num(0) }),
        mk('c_var_decl', { TYPE: 'int', NAME: 'sum' }, { INIT: num(0) }),
        mk('c_while', {}, {
          COND: cmp(get('i'), '<', num(10)),
          DO: [
            mk('c_var_set', { VAR: 'i' }, { VALUE: mk('c_arith', { OP: '+' }, { A: get('i'), B: num(1) }) }),
            mk('c_if', {}, {
              COND: cmp(mk('c_arith', { OP: '%' }, { A: get('i'), B: num(3) }), '!=', num(0)),
              DO: [mk('c_continue', {}, {})],
            }),
            mk('c_var_set', { VAR: 'sum' }, { VALUE: mk('c_arith', { OP: '+' }, { A: get('sum'), B: get('i') }) }),
          ],
        }),
        mk('c_printf', { FMT: '10 以内 3 的倍数之和 = %d\\n' }, { ARG0: get('sum') }),
      ],
    })),

  'printf/scanf 原生格式串': () => loadProgram(
    () => mk('c_main', {}, {
      BODY: [
        mk('c_var_decl', { TYPE: 'int', NAME: 'age' }, {}),
        mk('c_var_decl', { TYPE: 'double', NAME: 'height' }, {}),
        mk('c_var_decl', { TYPE: 'char', NAME: 'grade' }, {}),
        mk('c_printf', { FMT: '年龄 身高 等级：' }, {}),
        mk('c_scanf', { FMT: '%d %lf %c' }, { ARG0: get('age'), ARG1: get('height'), ARG2: get('grade') }),
        mk('c_printf', { FMT: '年龄 %d 岁，身高 %.1f m，等级 %c\\n' }, {
          ARG0: get('age'), ARG1: get('height'), ARG2: get('grade'),
        }),
      ],
    }), { stdin: '20 1.75 A\n' }),
};

/* ================================================================== */
/* 3. 代码面板（Ace）                                                  */
/* ================================================================== */
const ACE_BASE = new URL('vendor/ace/', location.href).href;
ace.config.setModuleUrl('ace/mode/c_cpp', ACE_BASE + 'mode-c_cpp.js');
ace.config.setModuleUrl('ace/theme/one_dark', ACE_BASE + 'theme-one_dark.js');

const srcEditor = ace.edit('editor', {
  mode: 'ace/mode/c_cpp',
  theme: 'ace/theme/one_dark',
  fontSize: '13px',
  showPrintMargin: false,
  useWorker: false,
  wrap: false,
  tabSize: 4,
  useSoftTabs: true,
  highlightActiveLine: false,
});

let lastGenerated = '';      /* 上次由积木生成的代码，用来判断用户有没有手改 */
let codeTouched = false;

function markGeneratedClean() { codeTouched = false; }

srcEditor.on('change', () => {
  const v = srcEditor.getValue();
  $('srclen').textContent = v.length + ' 字符 / ' + v.split('\n').length + ' 行';
  if (v !== lastGenerated) codeTouched = true;
  else codeTouched = false;
});

/* ================================================================== */
/* 4. 生成 + 诊断                                                      */
/* ================================================================== */
let pinned = [];             /* 钉过提示气泡的积木，下次生成前统一摘掉 */

function regenerate() {
  /* lang 决定生成 C 还是 C++ 写法（std::cout / #include <iostream>），不是只换编译参数 */
  const res = CGen.generate(workspace, { annotate: $('annotate').checked, lang: langKey() });
  lastGenerated = res.code;
  if (!codeTouched || srcEditor.getValue() === lastGenerated) {
    srcEditor.setValue(res.code, -1);
    srcEditor.clearSelection();
    codeTouched = false;
  }
  renderDiagnostics(res.diagnostics);
  $('blockcount').textContent = workspace.getAllBlocks(false).length + ' 块积木 / '
    + res.stats.stmts + ' 条语句';
  return res;
}

function renderDiagnostics(diags) {
  const box = $('diag');
  box.textContent = '';
  for (const b of pinned) { try { b.setWarningText(null); } catch (e) {} }
  pinned = [];

  if (!diags.length) {
    const p = document.createElement('div');
    p.className = 'd none';
    p.textContent = '✓ 积木没有发现问题，可以直接编译运行';
    box.appendChild(p);
    $('diaglen').textContent = '';
    return;
  }
  $('diaglen').textContent = diags.length + ' 条';

  for (const d of diags) {
    const row = document.createElement('div');
    row.className = 'd ' + d.sev;
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = d.sev === 'error' ? '错误' : d.sev === 'warn' ? '提醒' : '说明';
    const lbl = document.createElement('span');
    lbl.className = 'lbl';
    lbl.textContent = d.label || '';
    const txt2 = document.createElement('span');
    txt2.className = 'txt';
    txt2.textContent = d.msg;
    row.append(tag, lbl, txt2);
    row.onclick = () => focusBlock(d.blockId);
    box.appendChild(row);

    if (d.blockId && d.sev !== 'info') {
      const b = workspace.getBlockById(d.blockId);
      if (b && b.setWarningText) {
        try { b.setWarningText(d.sev === 'error' ? '错误：' + d.msg : '提醒：' + d.msg); pinned.push(b); } catch (e) {}
      }
    }
  }
}

function focusBlock(id) {
  const b = id && workspace.getBlockById(id);
  if (!b) { say('对应的积木已经不在了', 'warn'); return; }
  try {
    if (workspace.centerOnBlock) workspace.centerOnBlock(b.id, true);
    Blockly.common.setSelected ? Blockly.common.setSelected(b) : b.select();
  } catch (e) { b.select && b.select(); }
}

/* 积木一变就重新生成；撤销/重做、删除、连线都走这一个事件 */
let regenTimer = null;
workspace.addChangeListener(() => {
  clearTimeout(regenTimer);
  regenTimer = setTimeout(() => { syncNameFields(); regenerate(); saveWorkspace(); }, 120);
});

/* ================================================================== */
/* 5. 状态与输出                                                       */
/* ================================================================== */
const stdinEl = $('stdin'), outEl = $('out');
const dotEl = $('dot'), msgEl = $('msg');
const runBtn = $('run'), stopBtn = $('stop');

let decoder = null;
function newDecodeSession() {
  if (decoder) { try { outEl.value += decoder.decode(); } catch (e) {} }
  decoder = new TextDecoder('utf-8', { fatal: false });
}
function pushBytes(bytes) {
  if (!decoder) newDecodeSession();
  outEl.value += decoder.decode(bytes, { stream: true });
  outEl.scrollTop = outEl.scrollHeight;
  $('outlen').textContent = outEl.value.length + ' 字符';
}
function closeDecodeSession() {
  if (decoder) { outEl.value += decoder.decode(); decoder = null; }
}
function say(text, cls) { msgEl.textContent = text; msgEl.className = cls || ''; }
function setDot(kind) { dotEl.className = 'dot' + (kind ? ' ' + kind : ''); }

const METRICS = { exit: $('m-exit'), compile: $('m-compile'), run: $('m-run'), mem: $('m-mem') };
function metric(key, text, cls) {
  const el = METRICS[key];
  if (!el) return;
  el.textContent = text;
  el.className = cls || '';
}
function resetMetrics() { for (const k of Object.keys(METRICS)) metric(k, '—', ''); }

const enc = new TextEncoder();

/* ================================================================== */
/* 6. Worker：常驻编译 + 一次性运行                                    */
/* ================================================================== */
let compileWorker = null;
let workerReady = false;
let readyResolve = null, readyReject = null;
let readyPromise = new Promise((res, rej) => { readyResolve = res; readyReject = rej; });
let compileResolve = null, compileReject = null;
let runWorker = null, watchdog = null;

function startCompileWorker() {
  workerReady = false;
  readyPromise = new Promise((res, rej) => { readyResolve = res; readyReject = rej; });
  if (compileWorker) compileWorker.terminate();
  compileWorker = new Worker('js/compile.worker.js');
  compileWorker.onmessage = onCompileMessage;
  compileWorker.onerror = (e) => { setDot('bad'); say('Worker 出错：' + e.message, 'err'); };
  setDot('busy');
  say('正在初始化工具链（首次需下载约 58 MB）…');
  compileWorker.postMessage({ type: 'init', base: BASE, assets: ASSETS });
}

function onCompileMessage(ev) {
  const m = ev.data;
  switch (m.type) {
    case 'progress': say(m.text + '…'); break;
    case 'write': pushBytes(new Uint8Array(m.bytes)); break;
    case 'ready':
      workerReady = true;
      setDot('ready');
      say(`工具链就绪（${(m.initMs / 1000).toFixed(1)} s，sysroot 装入 ${m.sysrootFiles} 个头文件）`, 'ok');
      readyResolve();
      break;
    case 'stage': if (m.stage === 'compile') say('编译中（clang -cc1 -x ' + langOpt().compile + '）…'); break;
    case 'result':
      if (m.ok) compileResolve && compileResolve(m.wasm);
      else compileReject && compileReject({ phase: m.phase, ms: m.ms, exitCode: m.exitCode });
      break;
    case 'error':
      setDot('bad');
      say('编译器侧错误', 'err');
      outEl.value += '\n' + m.message + '\n';
      if (readyReject) readyReject(new Error(m.message));
      compileReject && compileReject({ jsError: m.message });
      break;
  }
}

function compile(code) {
  return new Promise((resolve, reject) => {
    compileResolve = resolve;
    compileReject = (err) => { reject(err); compileResolve = null; compileReject = null; };
    compileWorker.postMessage({
      type: 'compile',
      code,
      opts: {
        /* 语言类型：默认 C++（-x c++），也可以切回 C（-x c）；std 候选跟着换 */
        lang: langOpt().compile,
        std: $('std').value,
        optimize: $('opt').value,
        stackSize: 8 * 1048576,
        flags: ['-Wall'],
        filename: langOpt().file, obj: 'main.o', output: 'main.wasm',
        clang: ASSETS.clang, lld: ASSETS.lld,
      },
    });
  }).finally(() => { compileResolve = null; compileReject = null; });
}

function runProgram(wasmBytes, stdinText, timeoutMs) {
  return new Promise((resolve) => {
    if (runWorker) runWorker.terminate();
    runWorker = new Worker('js/run.worker.js');
    runWorker.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'write') pushBytes(new Uint8Array(m.bytes));
      if (m.type === 'exit') {
        clearTimeout(watchdog); watchdog = null;
        runWorker.terminate(); runWorker = null;
        resolve(Object.assign({}, m, { killed: false }));
      }
    };
    runWorker.onerror = (e) => {
      clearTimeout(watchdog); watchdog = null;
      resolve({ code: 127, note: e.message, ms: 0, memoryBytes: 0, killed: false });
    };
    watchdog = setTimeout(() => {
      runWorker.terminate(); runWorker = null;
      resolve({ code: null, killed: true, ms: timeoutMs, memoryBytes: 0 });
    }, timeoutMs);
    const buf = wasmBytes.buffer.slice(0);   /* 复制一份，原字节留给下次「只运行」 */
    runWorker.postMessage(
      { type: 'run', base: BASE, name: 'main.wasm', stdin: enc.encode(stdinText), wasm: buf },
      [buf]);
  });
}

/* ================================================================== */
/* 7. 主流程                                                          */
/* ================================================================== */
let busy = false;

async function doRun() {
  if (busy) return;
  busy = true;
  runBtn.disabled = true; stopBtn.disabled = false;
  const t0 = performance.now();
  resetMetrics();
  newDecodeSession();

  try {
    /* 代码面板是手改过的就直接编；否则先按积木生成一遍 */
    let code = srcEditor.getValue();
    if (!codeTouched) {
      const res = regenerate();
      code = res.code;
      if (res.hasError) {
        closeDecodeSession();
        setDot('bad');
        say('积木里有错误，先点诊断列表里的行找到出问题的积木', 'err');
        return;
      }
    }
    if (!/main/.test(code)) {
      closeDecodeSession();
      say('工作区里还没有「主程序」积木，编译了也没入口', 'warn');
      return;
    }

    if (!workerReady) await readyPromise;

    let wasm;
    try {
      wasm = await compile(code);
    } catch (err) {
      closeDecodeSession();
      setDot('bad');
      if (err && err.phase) {
        metric('compile', (err.ms || 0) + ' ms', 'err');
        metric('exit', err.exitCode === undefined ? '—' : err.exitCode, 'err');
        say(`${err.phase === 'compile' ? '编译' : '链接'}失败（clang 的报错在输出区）`, 'err');
      } else if (err && err.jsError) {
        metric('compile', '异常', 'err');
        say('编译器内部错误', 'err');
        outEl.value += '\n' + err.jsError + '\n';
      } else {
        say('编译被中断', 'warn');
      }
      return;
    }

    metric('compile', Math.round(performance.now() - t0) + ' ms', 'ok');
    say(`编译完成（产物 ${(wasm.byteLength / 1024).toFixed(1)} KB），运行中…`);

    const timeoutMs = Math.max(200, parseInt($('timeout').value, 10) || 5000);
    const r = await runProgram(wasm, stdinEl.value, timeoutMs);
    closeDecodeSession();

    if (r.killed) {
      setDot('bad');
      metric('run', '> ' + timeoutMs + ' ms', 'warn');
      metric('exit', 'TLE', 'warn');
      say('运行超时，已终止该 wasm 实例（多半是死循环）', 'warn');
      outEl.value += `\n[已终止] 运行超过 ${timeoutMs} ms\n`;
    } else {
      setDot(r.code === 0 ? 'ready' : 'bad');
      metric('exit', r.code, r.code === 0 ? 'ok' : 'err');
      metric('run', r.ms + ' ms', r.code === 0 ? '' : 'err');
      if (r.memoryBytes) metric('mem', (r.memoryBytes / 1048576).toFixed(1) + ' MB');
      say(r.note ? '运行出错：' + r.note : '正常结束', r.code === 0 ? 'ok' : 'err');
    }
    outEl.scrollTop = outEl.scrollHeight;
  } finally {
    if (watchdog) { clearTimeout(watchdog); watchdog = null; }
    busy = false;
    runBtn.disabled = false;
    stopBtn.disabled = true;
  }
}

function stopAll() {
  if (runWorker) { runWorker.terminate(); runWorker = null; }
  if (watchdog) { clearTimeout(watchdog); watchdog = null; }
  if (compileResolve && compileReject) compileReject({ aborted: true });
  closeDecodeSession();
  setDot('busy');
  say('已停止', 'warn');
}

/* ================================================================== */
/* 8. 保存 / 导入导出                                                  */
/* ================================================================== */
let saveTimer = null;
function saveWorkspace() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(LS.ws, JSON.stringify(Blockly.serialization.workspaces.save(workspace)));
      localStorage.setItem(LS.stdin, stdinEl.value);
      localStorage.setItem(LS.opts, JSON.stringify({
        lang: langKey(),
        std: $('std').value, opt: $('opt').value, annotate: $('annotate').checked,
        timeout: $('timeout').value,
      }));
    } catch (e) { /* 隐私模式或超额，忽略 */ }
  }, 300);
}

function restoreWorkspace(state) {
  workspace.clear();
  Blockly.serialization.workspaces.load(state, workspace);
  if (workspace.cleanUp) workspace.cleanUp();
  markGeneratedClean();
  regenerate();
}

function download(name, text, mime) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime || 'application/octet-stream' }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/* ================================================================== */
/* 9. UI 绑定                                                         */
/* ================================================================== */
(function fillExamples() {
  const sel = $('examples');
  for (const name of Object.keys(EXAMPLES)) {
    const o = document.createElement('option');
    o.textContent = name;
    sel.appendChild(o);
  }
  sel.onchange = () => {
    if (codeTouched && !confirm('载入示例会丢掉你在代码面板里的手改，继续？')) {
      sel.value = sel.dataset.prev || sel.options[0].value;
      return;
    }
    EXAMPLES[sel.value]();
    markGeneratedClean();
    regenerate();
    sel.dataset.prev = sel.value;
  };
})();

runBtn.onclick = doRun;
stopBtn.onclick = stopAll;
$('reload').onclick = () => { outEl.value = ''; $('outlen').textContent = ''; startCompileWorker(); };
$('clearout').onclick = () => { outEl.value = ''; $('outlen').textContent = ''; };
$('regen').onclick = () => { markGeneratedClean(); regenerate(); say('已按当前积木重新生成代码', 'ok'); };
$('save').onclick = () => {
  saveWorkspace();
  clearTimeout(saveTimer);
  try {
    localStorage.setItem(LS.ws, JSON.stringify(Blockly.serialization.workspaces.save(workspace)));
    say('积木已存到浏览器本地（下次打开自动恢复）', 'ok');
  } catch (e) { say('本地存储不可用：' + e.message, 'err'); }
};
$('export').onclick = () => {
  download('blocks.json', JSON.stringify(Blockly.serialization.workspaces.save(workspace), null, 2),
    'application/json');
};
$('import').onclick = () => $('file').click();
$('file').onchange = async () => {
  const f = $('file').files[0];
  $('file').value = '';
  if (!f) return;
  try {
    restoreWorkspace(JSON.parse(await f.text()));
    say('积木已导入', 'ok');
  } catch (e) { say('导入失败：' + e.message, 'err'); }
};
$('clear').onclick = () => {
  if (!confirm('清空整个积木工作区？')) return;
  workspace.clear();
  markGeneratedClean();
  regenerate();
  saveWorkspace();
};

['std', 'opt', 'timeout', 'annotate'].forEach((id) => $(id).addEventListener('change', saveWorkspace));

/*
 * 换语言：先把「标准」下拉框换成该语言的候选，再重生成一次代码。
 * markGeneratedClean() 是有意的——用户主动换语言就是想要另一份代码，
 * 此时哪怕代码面板里有手改也该被覆盖，否则会看到「选了 C++ 却还挂着 C 写法」。
 */
$('lang').addEventListener('change', () => {
  fillStd(false);
  refreshSourceCaption();
  markGeneratedClean();
  regenerate();
  saveWorkspace();
  const io = langKey() === 'cpp' ? 'std::cout / std::cin（#include <iostream>）' : 'printf / scanf（#include <stdio.h>）';
  say('已切换到 ' + langOpt().label + '：代码改用 ' + io + '，编译参数 clang -x '
    + langOpt().compile + ' -std=' + $('std').value, 'ok');
});

stdinEl.addEventListener('input', saveWorkspace);

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); doRun(); }
  if (e.key === 'Escape') stopAll();
});

/* ================================================================== */
/* 10. 启动                                                           */
/* ================================================================== */

/**
 * 存档不对劲就别 load：宁可这次不还原积木，也不能让页面一打开就转圈卡死。
 * Blockly 的存档是 { blocks: { blocks: [ { block: { inputs: { X: { block: … } },
 * statements: { DO: [ { block: … } ] } } } ] } }，逐层套下去；正常入门程序撑死
 * 几十层、几百块，超出的多半是被改坏或脚本硬连线写出来的脏数据。
 */
function stateLooksSane(state) {
  const tops = state && state.blocks && state.blocks.blocks;
  if (!Array.isArray(tops) || !tops.length) return false;
  if (tops.length > 2000) return false;
  let ids = 0;
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object') return true;
    const inner = node.block || node;
    if (depth > 200) return false;               /* 嵌套两百层：不是人写的 */
    if (++ids > 20000) return false;             /* 块数上限，兜住重复引用的脏树 */
    const kids = [];
    if (inner.statements) for (const k of Object.keys(inner.statements)) {
      const v = inner.statements[k];
      if (Array.isArray(v)) kids.push(...v);
    }
    if (inner.inputs) for (const k of Object.keys(inner.inputs)) {
      const c = inner.inputs[k];
      if (c && c.block) kids.push(c.block);
    }
    for (const c of kids) if (!walk(c, depth + 1)) return false;
    return true;
  };
  for (const t of tops) if (!walk(t, 0)) return false;
  return true;
}

(function boot() {
  let opts = {};
  try { opts = JSON.parse(localStorage.getItem(LS.opts) || '{}'); } catch (e) {}
  /*
   * 顺序：先定语言，再按语言重填「标准」，最后才把存档里的 std 套回去。
   * 反过来的话，C++ 存档里的 -std=c++17 会被 C 的候选列表刷掉，或者干脆出现
   * 「语言是 C、标准却是 c++17」这种 clang 直接报错的组合。
   */
  if (opts.lang === 'c' || opts.lang === 'cpp') $('lang').value = opts.lang;
  fillStd(false);
  refreshSourceCaption();
  if (opts.std && LANGS[langKey()].stds.some((p) => p[0] === opts.std)) $('std').value = opts.std;
  if (opts.opt) $('opt').value = opts.opt;
  if (opts.timeout) $('timeout').value = opts.timeout;
  if (typeof opts.annotate === 'boolean') $('annotate').checked = opts.annotate;
  const savedStdin = localStorage.getItem(LS.stdin);
  if (savedStdin !== null) stdinEl.value = savedStdin;

  let restored = false;
  /* 地址后面加 ?fresh=1 可以跳过本地存档（比如存档被改坏、页面一开就卡住时） */
  const wantFresh = /[?&]fresh(=|&|$)/.test(location.search);
  if (wantFresh) { try { localStorage.removeItem(LS.ws); } catch (e) {} }
  try {
    const raw = wantFresh ? null : localStorage.getItem(LS.ws);
    if (raw) {
      const state = JSON.parse(raw);
      if (state.blocks && state.blocks.blocks && state.blocks.blocks.length) {
        if (stateLooksSane(state)) {
          restoreWorkspace(state);
          restored = true;
        } else {
          /* 存档不对劲：跳过还原，但留着原文件，让用户有机会自己导出看看 */
          console.warn('本地积木存档结构不对劲，这次跳过还原（要清掉它请用 ?fresh=1）。');
        }
      }
    }
  } catch (e) { /* 存档坏了就走示例 */ }
  if (!restored) {
    $('examples').value = Object.keys(EXAMPLES)[0];
    EXAMPLES[$('examples').value]();
  }
  regenerate();
  startCompileWorker();
})();
