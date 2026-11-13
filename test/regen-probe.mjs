/*
 * test/regen-probe.mjs — 不开浏览器，也能验证「积木一变代码就跟着变」这条链路
 *
 *   node test/regen-probe.mjs
 *
 * 冲着老师那句反馈来的：「用积木连续编写几个程序之后，C++ 代码不更新，要刷新网页。」
 * 查下来有三处会让代码面板停住，而且都不声不响：
 *   1) 在代码面板里敲过一个字，codeTouched 就一直是 true，之后拖积木再也不写面板，
 *      界面上没有任何地方说得清这件事 —— 用户只以为坏了，于是刷新（刷新会清掉它）。
 *   2) loadProgram() 整份换程序时不清这个标记，换了示例代码却不动。
 *   3) 防抖被纯 UI 事件（点击/选中/滚视口）不停重新计时，或者 regenerate() 抛一次，
 *      排在后面的 saveWorkspace() 跟着不执行：既不更新也不存档。
 *
 * js/app.js 整份要真浏览器才能跑，所以这里照 split-probe.mjs 的办法，只把相关的三节
 * 抽出来喂假 DOM + 假时钟（setTimeout / Date.now 全是虚拟的，断言不依赖真实时间）。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LINES = [];
const realLog = (...a) => globalThis.console.log(...a);
const console = { log: (...a) => { LINES.push(a.map((x) => String(x)).join(' ')); realLog(...a); } };

let pass = 0, fail = 0;
function check(name, ok) {
  if (ok) { pass++; console.log('✓ ' + name); }
  else { fail++; console.log('✗ ' + name); }
}

/* ---------------- 从 app.js 里抽三节 ---------------- */
const src = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8').split('\n');

/** 从 startMarker 那行起，到之后第一行正好是 endLine 的地方（含） */
function section(startMarker, endLine) {
  const from = src.findIndex((l) => l.includes(startMarker));
  if (from < 0) return null;
  for (let i = from + 1; i < src.length; i++) {
    if (src[i] === endLine) return src.slice(from, i + 1).join('\n');
  }
  return null;
}

const SEC_STATE = section("let lastGenerated = '';", '});');        /* 手改标记 + 状态胶囊 + Ace change */
const SEC_LOAD = section('function loadProgram(build, opts) {', '}');
const SEC_REGEN = section('const REGEN_DEBOUNCE =', '});');         /* 防抖 + 兜异常 + 事件过滤 */

if (!SEC_STATE || !SEC_LOAD || !SEC_REGEN) {
  console.log('✗ 在 js/app.js 里找不到要测的那三节（let lastGenerated / function loadProgram / const REGEN_DEBOUNCE）');
  throw new Error('抽取失败，后面的断言不再执行');
}

/* 状态胶囊的初始文案写在 index.html 里（首屏就该有字，不能等第一次事件），
   这里顺带把这份约定钉住：HTML 的初始值和 JS 的「干净」文案必须是同一句。 */
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const htmlBadge = /<button[^>]*id="srcstate"[^>]*>([^<]*)<\/button>/.exec(html);

/* ---------------- 假时钟 ---------------- */
function clock() {
  const st = { now: 1000, seq: 0, q: new Map() };
  return {
    now: () => st.now,
    setTimeout: (fn, ms) => { const id = ++st.seq; st.q.set(id, { at: st.now + (ms || 0), fn }); return id; },
    clearTimeout: (id) => { st.q.delete(id); },
    pending: () => st.q.size,
    /** 往前走 ms，按到期时间顺序执行回调（回调里新排的定时器也照跑） */
    tick(ms) {
      const end = st.now + ms;
      for (;;) {
        let best = null;
        for (const [id, t] of st.q) if (t.at <= end && (!best || t.at < best.t.at)) best = { id, t };
        if (!best) break;
        st.q.delete(best.id);
        st.now = best.t.at;
        best.t.fn();
      }
      st.now = end;
    },
  };
}

/* ---------------- 假 DOM ---------------- */
function el(tag) {
  return {
    tagName: tag, className: '', textContent: '', title: '', kids: [],
    classList: {
      _s: new Set(),
      toggle(c, on) { if (on) this._s.add(c); else this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
    append(...xs) { this.kids.push(...xs); },
    appendChild(x) { this.kids.push(x); },
  };
}

/* ================================================================== */
/* 1. 手改标记：看得见、一键找回，换程序时自动清掉                        */
/* ================================================================== */
console.log('\n══════ 手改标记与状态胶囊 ══════');
{
  check('index.html 里首屏就给了状态胶囊，初始文案是「跟随积木」',
    !!htmlBadge && htmlBadge[1] === '跟随积木');
  check('index.html 里给「已手改」备了 .srcstate.touched 的样式',
    /\.srcstate\.touched\s*\{/.test(html));

  const badge = el('button'), srclen = el('span');
  badge.textContent = htmlBadge ? htmlBadge[1] : '';   /* 首屏文案来自 HTML，不是 JS 现算的 */
  const st = { changeFn: null, value: '', writes: 0 };
  const srcEditor = {
    on: (ev, fn) => { if (ev === 'change') st.changeFn = fn; },
    getValue: () => st.value,
    setValue: (v) => { st.value = v; st.writes++; if (st.changeFn) st.changeFn(); },
    clearSelection: () => {},
  };
  const sandbox = {
    $: (id) => (id === 'srcstate' ? badge : id === 'srclen' ? srclen : el('div')),
    srcEditor, console,
  };
  vm.createContext(sandbox);
  new vm.Script(SEC_STATE).runInContext(sandbox);

  const run = (code) => vm.runInContext(code, sandbox);

  check('开局是「跟随积木」，不带 touched 样式',
    badge.textContent === '跟随积木' && !badge.classList.contains('touched'));

  /* 积木生成了一份代码，面板跟着写 */
  run("lastGenerated = 'int main(){}'; srcEditor.setValue(lastGenerated);");
  check('生成写面板之后仍是「跟随积木」', run('codeTouched') === false && badge.textContent === '跟随积木');

  /* 用户在面板里敲了一个字 */
  st.value = 'int main(){ }';
  st.changeFn();
  check('面板里敲字 → codeTouched 置起', run('codeTouched') === true);
  check('胶囊改成「已手改」并带 touched 样式',
    badge.textContent.indexOf('已手改') === 0 && badge.classList.contains('touched'));
  check('胶囊文案里给了出路（点我按积木重新生成）', badge.textContent.indexOf('重新生成') > 0);
  check('悬停提示说清了「积木的改动不会再覆盖这里」', badge.title.indexOf('不会再覆盖') > 0);

  /* 手改之后 regenerate 不该覆盖用户的字 —— 这个行为是有意的，保住它 */
  const writesBefore = st.writes;
  run("lastGenerated = 'int main(){ return 0; }';");
  check('手改状态下只更新 lastGenerated，不动面板', st.writes === writesBefore);

  /* 一键找回 */
  run('markGeneratedClean();');
  check('markGeneratedClean() 把胶囊收回「跟随积木」',
    run('codeTouched') === false && badge.textContent === '跟随积木' && !badge.classList.contains('touched'));

  /* 用户把字改回原样，也该自动收回 */
  run("lastGenerated = 'ABC'; srcEditor.setValue('ABC');");
  st.value = 'ABCD';
  st.changeFn();
  check('再次手改 → 置起', run('codeTouched') === true);
  st.value = 'ABC';
  st.changeFn();
  check('改回与生成结果一致 → 自动收回标记', run('codeTouched') === false && badge.textContent === '跟随积木');
}

/* ================================================================== */
/* 2. loadProgram：整份换程序时必须清掉手改标记                          */
/* ================================================================== */
console.log('\n══════ 换程序（loadProgram）══════');
{
  const badge = el('button');
  const st = { cleared: 0, regen: 0, saved: 0, realized: 0, stdin: null };
  const sandbox = {
    $: (id) => (id === 'srcstate' ? badge : id === 'stdin' ? { set value(v) { st.stdin = v; }, get value() { return st.stdin; } } : el('div')),
    workspace: { clear: () => { st.cleared++; }, cleanUp: () => {} },
    realize: () => { st.realized++; },
    saveWorkspace: () => { st.saved++; },
    regenerate: () => { st.regen++; },
    markGeneratedClean: null,
    console,
  };
  vm.createContext(sandbox);
  /* 状态那一节提供真的 markGeneratedClean / codeTouched，loadProgram 那一节用它 */
  new vm.Script(SEC_STATE.replace("srcEditor.on('change', () => {", "const srcEditor = { on: () => {}, getValue: () => '', setValue: () => {}, clearSelection: () => {} };\nsrcEditor.on('change', () => {"))
    .runInContext(sandbox);
  new vm.Script(SEC_LOAD).runInContext(sandbox);
  const run = (code) => vm.runInContext(code, sandbox);

  run('codeTouched = true; renderSourceState();');
  check('先造出「已手改」状态', badge.classList.contains('touched'));

  run("loadProgram(() => [], { stdin: '1 2\\n' });");
  check('loadProgram 清了工作区、造了块、存了档、重生成了',
    st.cleared === 1 && st.realized === 1 && st.saved === 1 && st.regen === 1);
  check('loadProgram 之后手改标记被清掉（否则换了程序代码却不动）', run('codeTouched') === false);
  check('胶囊跟着回到「跟随积木」', badge.textContent === '跟随积木' && !badge.classList.contains('touched'));
  check('opts.stdin 照旧写进标准输入框', st.stdin === '1 2\n');

  /* 不带 opts 也不该炸 */
  run('loadProgram(() => []);');
  check('不带 opts 再换一次程序同样正常', st.regen === 2 && run('codeTouched') === false);
}

/* ================================================================== */
/* 3. 防抖：只认内容事件、带最长等待、抛异常也不断链                      */
/* ================================================================== */
console.log('\n══════ 重新生成的调度与兜底 ══════');
{
  const ck = clock();
  const diag = el('div'), diaglen = el('span');
  const st = { regen: 0, sync: 0, save: 0, said: [], listener: null, throwNext: false };
  const sandbox = {
    $: (id) => (id === 'diag' ? diag : id === 'diaglen' ? diaglen : el('div')),
    document: { createElement: (t) => el(t) },
    workspace: { addChangeListener: (fn) => { st.listener = fn; }, getBlockById: () => null },
    pinned: [],
    syncNameFields: () => { st.sync++; },
    regenerate: () => {
      st.regen++;
      if (st.throwNext) { st.throwNext = false; throw new Error('假装生成器炸了'); }
    },
    saveWorkspace: () => { st.save++; },
    say: (t, c) => { st.said.push([t, c]); },
    setTimeout: ck.setTimeout, clearTimeout: ck.clearTimeout,
    Date: { now: ck.now },
    Set, Math, String, Number, console,
  };
  vm.createContext(sandbox);
  new vm.Script(SEC_REGEN).runInContext(sandbox);
  const fire = (type) => st.listener({ type });

  check('REGEN_DEBOUNCE / REGEN_MAXWAIT 是 120 / 400',
    vm.runInContext('REGEN_DEBOUNCE', sandbox) === 120 && vm.runInContext('REGEN_MAXWAIT', sandbox) === 400);

  /* 纯 UI 事件不该重新计时 */
  const uiTypes = ['ui', 'click', 'selected', 'bubble_open', 'trashcan_open', 'viewport_change', 'theme_change', 'toolbox_item_select', 'drag'];
  for (const t of uiTypes) fire(t);
  check('九类纯 UI 事件一个都不排生成（点击/选中/滚视口不再把防抖往后推）', ck.pending() === 0 && st.regen === 0);

  /* 内容事件要排 */
  for (const t of ['create', 'delete', 'change', 'move', 'var_create', 'var_rename', 'var_delete', 'finished_loading']) fire(t);
  check('八类内容事件都排上了生成', ck.pending() === 1);
  ck.tick(119);
  check('120ms 防抖：119ms 时还没生成', st.regen === 0);
  ck.tick(1);
  check('到 120ms 生成一次，且只生成一次（八个事件合并）', st.regen === 1 && st.sync === 1 && st.save === 1);

  /* 最长等待：事件一直来，也不能永远等不到那 120ms 的空档 */
  st.regen = 0;
  for (let i = 0; i < 20; i++) { fire('move'); ck.tick(50); }   /* 1000ms 里每 50ms 一个事件 */
  check('连续 1000ms 每 50ms 一个事件：靠最长等待生成了 2 次（400ms / 800ms），没有被饿死',
    st.regen === 2);
  ck.tick(500);
  check('事件停下来之后补最后一次', st.regen === 3);

  /* 抛异常：错误摆出来，存档照做，链路不断 */
  st.regen = 0; st.save = 0; st.said = []; st.throwNext = true;
  diag.kids = [];
  fire('change');
  ck.tick(200);
  check('生成器抛异常也被接住，没有把异常甩给定时器', st.regen === 1);
  check('抛异常之后仍然存档（原来这里会跟着跳过，刷新就丢积木）', st.save === 1);
  check('诊断列表里摆出一条 error', diag.kids.length === 1 && diag.kids[0].className === 'd error');
  check('错误文案里带上原始 message', diag.kids[0].kids.some((k) => String(k.textContent).indexOf('假装生成器炸了') > 0));
  check('错误文案里告诉用户积木已存档、刷新不会丢',
    diag.kids[0].kids.some((k) => String(k.textContent).indexOf('刷新不会丢') > 0));
  check('状态条也报了一句 err', st.said.length === 1 && st.said[0][1] === 'err');
  check('diaglen 写了 1 条', diaglen.textContent === '1 条');

  /* 炸过一次之后，下一次改动照样能生成 */
  fire('change');
  ck.tick(200);
  check('炸过一次之后链路没断：下一次改动照常生成 + 存档', st.regen === 2 && st.save === 2);

  /* 定时器句柄要复位，否则最长等待的起点会一直停在很久以前 */
  check('跑完一轮之后定时器句柄复位（下一轮重新起算防抖）',
    vm.runInContext('regenTimer', sandbox) === null);
  fire('change');
  ck.tick(119);
  check('新一轮仍是 120ms 防抖，不是立刻生成', st.regen === 2);
  ck.tick(1);
  check('新一轮到点生成', st.regen === 3);
}

/* ================================================================== */
console.log('\n' + (fail ? '✗ 有 ' + fail + ' 条断言没过' : '✓ 代码更新链路断言全部通过') + '（' + pass + ' 条通过）');
if (fail) throw new Error(fail + ' 条断言没过');