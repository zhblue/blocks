/*
 * test/split-probe.mjs — 不开浏览器，也能验证中间那根分隔条的数学与交互
 *
 *   node test/split-probe.mjs
 *
 * js/app.js 整份文件要真浏览器才能跑（Blockly、Ace、Worker 都在里面），所以这里
 * 只把「3.5 左右两栏宽度」那一节抽出来，喂一个假 DOM（假到只有这几个函数用得到的
 * 方法），数字全部按 index.html 里 main/.splitter 的实际 CSS 给：
 *   padding: 12px 18px、gap: 6px、--bar-w: 12px、--pane-l-min: 240px、--pane-r-min: 280px
 * 检查三件事：
 *   1) 拖过去以后分隔条的中心确实落在光标上（不是差半根条、也不是慢一截）；
 *   2) 夹限跟着窗口宽度走：CSS 那两条像素下限先生效时，百分比就夹到它，别出现
 *      「JS 说 82%、浏览器只给 76%，条停住不跟手」；
 *   3) 拖动过程不写存档、rAF 合并重排、Blockly/Ace 各重量一次。
 * 里面的期望值是从 CSS 手算的，改了 index.html 的那几个数这里会红。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LINES = [];
const realLog = (...a) => globalThis.console.log(...a);
const console = { log: (...a) => { LINES.push(a.map((x) => String(x)).join(' ')); realLog(...a); } };

/* index.html 里 main / .splitter 的那几个数字，和这里必须一起改 */
const CSS = { pad: 18, gap: 6, bar: 12, minL: 240, minR: 280 };
const HARD = { min: 18, max: 82, dflt: 58, step: 2 };

/* ---------------- 抽出 app.js 的分隔条那一节 ---------------- */
const src = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8').split('\n');
const from = src.findIndex((l) => l.includes('const SPLIT ='));
const to = src.findIndex((l) => l.includes("window.addEventListener('resize', relayout)"));
if (from < 0 || to < 0) {
  console.log('✗ 在 js/app.js 里找不到分隔条那一节（const SPLIT = … / window.addEventListener(\'resize\', relayout)）');
}
const section = src.slice(from, to + 1).join('\n');

/** 造一个假页面：main 宽 W 像素，把那一节装进 vm 沙箱 */
function harness(W) {
  const st = { cssVar: HARD.dflt + '.00%', aria: null, svg: 0, ace: 0, save: 0, say: [], rafQ: [], h: {} };
  const cs = {
    paddingLeft: CSS.pad + 'px', paddingRight: CSS.pad + 'px',
    columnGap: CSS.gap + 'px', gap: CSS.gap + 'px',
    getPropertyValue: (k) => ({
      '--bar-w': CSS.bar + 'px', '--pane-l-min': CSS.minL + 'px', '--pane-r-min': CSS.minR + 'px',
    }[k] || ''),
  };
  const mainEl = {
    style: {
      setProperty: (k, v) => { st.cssVar = v; },
      getPropertyValue: () => String(st.cssVar).replace('%', ''),
    },
    getBoundingClientRect: () => ({ left: 0, width: W }),
  };
  const splitterEl = {
    offsetWidth: CSS.bar, style: {},
    setAttribute: (k, v) => { st.aria = v; },
    classList: { add: () => {}, remove: () => {} },
    addEventListener: (t, fn) => { st.h[t] = fn; },
    setPointerCapture: () => {}, releasePointerCapture: () => {},
  };
  const sandbox = {
    $: (id) => (id === 'splitter' ? splitterEl : mainEl),
    document: {
      querySelector: () => mainEl,
      getElementById: (id) => (id === 'splitter' ? splitterEl : mainEl),
      body: { classList: { add: () => {}, remove: () => {} } },
    },
    getComputedStyle: () => cs,
    requestAnimationFrame: (fn) => st.rafQ.push(fn),
    parseFloat, Number, Math, String, isNaN,
    Blockly: { svgResize: () => { st.svg++; } },
    workspace: {},
    srcEditor: { resize: () => { st.ace++; } },
    say: (m) => st.say.push(m),
    saveWorkspace: () => { st.save++; },
    window: { addEventListener: (t, fn) => { st.h['win:' + t] = fn; } },
  };
  vm.createContext(sandbox);
  vm.runInContext(section + '\n;globalThis.api = { setSplit, currentSplit, splitAtX, splitBounds, splitMetrics, SPLIT };',
    sandbox, { filename: 'js/app.js#splitter' });
  st.api = sandbox.api;
  st.cur = () => parseFloat(st.cssVar);
  st.flush = () => { const q = st.rafQ; st.rafQ = []; q.forEach((f) => f()); return q.length; };
  return st;
}

let fails = 0;
function check(label, cond) {
  console.log((cond ? '✓ ' : '✗ ') + label);
  if (!cond) fails++;
}

/* ---------------- 1. 夹限跟着窗口宽度走 ---------------- */
console.log('\n══════ 夹限（CSS 像素下限 vs 百分比硬边界）══════');
console.log('窗口  内容宽   下限%   上限%   上限时左栏  右栏');
for (const W of [2400, 1920, 1600, 1280, 1024, 900, 700]) {
  const S = harness(W);
  const m = S.api.splitMetrics();
  const b = S.api.splitBounds(m);
  const content = W - 2 * CSS.pad;
  const eLo = Math.max(HARD.min, Math.min((CSS.minL / content) * 100, 50));
  const eHi = Math.min(HARD.max, Math.max(((content - CSS.bar - 2 * CSS.gap - CSS.minR) / content) * 100, eLo));
  const leftAtMax = (b.max / 100) * content;
  const rightAtMax = content - leftAtMax - CSS.bar - 2 * CSS.gap;
  console.log(W + '\t' + content + '\t' + b.min.toFixed(2) + '\t' + b.max.toFixed(2) +
    '\t' + leftAtMax.toFixed(0) + '\t' + rightAtMax.toFixed(0));
  check('W=' + W + '：上下限和手算一致', Math.abs(b.min - eLo) < 1e-9 && Math.abs(b.max - eHi) < 1e-9);
  check('W=' + W + '：夹到上限时两栏都没被 CSS 缩水（左 ' + leftAtMax.toFixed(0) + '≥' + CSS.minL + '，右 ' +
    rightAtMax.toFixed(0) + '≥' + CSS.minR + '）', leftAtMax >= CSS.minL - 0.5 && rightAtMax >= CSS.minR - 0.5);
  check('W=' + W + '：夹到下限时左栏 ≥' + CSS.minL + 'px', (b.min / 100) * content >= CSS.minL - 0.5);
}
{
  /* 窄到两栏下限塞不下时（窗口 < ~550px）区间会塌成一个点，但不能出 NaN / 反向 */
  const S = harness(520);
  S.api.setSplit(999, false); const hi = S.cur();
  S.api.setSplit(-999, false); const lo = S.cur();
  check('窗口窄到放不下两栏下限：不写 NaN、区间不反向（' + lo.toFixed(2) + '~' + hi.toFixed(2) + '）',
    Number.isFinite(hi) && Number.isFinite(lo) && hi >= lo && !String(S.cssVar).includes('NaN'));
}

/* ---------------- 2. 分隔条中心跟着光标 ---------------- */
console.log('\n══════ 拖动跟手（条中心 = 光标）══════');
for (const W of [1920, 1600, 1280, 900]) {
  const S = harness(W);
  const m = S.api.splitMetrics();
  const b = S.api.splitBounds(m);
  let worst = 0, at = 0, n = 0;
  for (let x = 0; x <= W; x += 7) {
    const p = S.api.splitAtX(x);
    S.api.setSplit(p, false);
    if (p < b.min - 1e-9 || p > b.max + 1e-9) continue;   /* 越界的部分本来就该被夹住 */
    /* 浏览器怎么画这一格：左轨道 = 百分比 × 内容宽，条居中在它后面 */
    const rendered = m.left + S.cur() / 100 * m.content + m.gap + m.bar / 2;
    n++;
    if (Math.abs(rendered - x) > worst) { worst = Math.abs(rendered - x); at = x; }
  }
  console.log('W=' + W + '：夹限内采样 ' + n + ' 点，最坏偏差 ' + worst.toFixed(4) + 'px（@x=' + at + '）');
  /* 只剩 --split 保留两位小数带来的舍入：0.005% × 内容宽，1920 下约 0.08px，肉眼看不见 */
  check('W=' + W + '：偏差 ≤ ' + (0.005 / 100 * (W - 2 * CSS.pad)).toFixed(3) + 'px（两位小数的舍入上限）',
    worst <= 0.005 / 100 * (W - 2 * CSS.pad) + 1e-9);
}
{
  const S = harness(1600);
  check('splitAtX(900) 就是「光标在 900 时左栏该占的百分比」', Math.abs(S.api.splitAtX(900) - 55.6266) < 0.001);
  check('光标跑到左边界外（x=0）时算出负值，后面由夹限托住', S.api.splitAtX(0) < 0);
  check('clientX 不是数字时保持现状', (() => { S.api.setSplit(62, false); return S.api.splitAtX(NaN) === 62; })());
  check('宽度还没量出来（content=0）时不写出 0%', (() => {
    const Z = harness(2 * CSS.pad); Z.api.setSplit(50, false); return Z.cur() !== 0;
  })());
}

/* ---------------- 3. 存档 / 重排 / 交互 ---------------- */
console.log('\n══════ 存档、重排、交互 ══════');
{
  const S = harness(1600);
  S.api.setSplit(HARD.dflt, false); S.flush();
  check('默认 58% → --split: 58.00%、aria-valuenow=58', S.cssVar === '58.00%' && S.aria === '58');
  check('改完宽度重排一次：Blockly.svgResize + Ace resize 各一次', S.svg === 1 && S.ace === 1);
  const s0 = S.save, r0 = S.svg;
  [520, 540, 560, 580, 600].forEach((x) => S.api.setSplit(S.api.splitAtX(x), false));
  check('拖动过程中不写 localStorage', S.save === s0);
  check('连续 5 次改宽度只排一帧重绘（rAF 合并）', S.flush() <= 1 && S.svg - r0 === 1);
  S.api.setSplit(NaN, false); check('存档里是 NaN 时退回默认，不写出 NaN%', S.cur() === HARD.dflt && !S.cssVar.includes('NaN'));
  S.api.setSplit(undefined, false); check('字段缺失（undefined）同样退回默认', S.cur() === HARD.dflt);
  S.api.setSplit(95, false); check('存档里超界的百分比被夹回本窗口上限（' + S.cur().toFixed(2) + '%）', S.cur() <= 82 && S.cur() < 95);
  const s1 = S.save; S.api.setSplit(64, true); check('keep=true 才写存档', S.save === s1 + 1);
}
{
  const S = harness(1600);
  let pd = 0;
  S.h.pointerdown({ clientX: 900, pointerId: 1, preventDefault: () => { pd++; } });
  check('pointerdown 调了 preventDefault（顺带压住拖选中文字）', pd === 1);
  S.h.pointermove({ clientX: 900 });
  check('pointermove 把宽度定在光标上（' + S.cur().toFixed(2) + '%）', Math.abs(S.cur() - S.api.splitAtX(900)) <= 0.0051);
  const s2 = S.save; S.h.pointerup({ pointerId: 1 });
  check('pointerup 松手才存一次', S.save === s2 + 1);
  S.h.pointerdown({ clientX: 900, pointerId: 2, preventDefault: () => {} });
  S.h['win:blur']();
  const v = S.cur();
  S.h.pointermove({ clientX: 1300 });
  check('拖到一半切走窗口：blur 收尾，之后的移动不再改宽度', S.cur() === v);
  S.h.pointerdown({ clientX: 900, pointerId: 3, preventDefault: () => {} });
  S.h.pointercancel({ pointerId: 3 });
  const v2 = S.cur();
  S.h.pointermove({ clientX: 400 });
  check('pointercancel（触屏被系统抢走）同样收尾', S.cur() === v2);
}
{
  const S = harness(1600);
  S.api.setSplit(70, false);
  S.h.dblclick({});
  check('双击分隔条回到 58% 并给一句提示', S.cur() === HARD.dflt && S.say.some((m) => m.includes(String(HARD.dflt))));
  S.h.keydown({ key: 'ArrowRight', preventDefault: () => {} });
  check('聚焦后按→ 每次 +' + HARD.step + '%（' + S.cur() + '%）', Math.abs(S.cur() - 60) < 1e-9);
  S.h.keydown({ key: 'ArrowLeft', preventDefault: () => {} });
  check('按← 每次 -' + HARD.step + '%', Math.abs(S.cur() - 58) < 1e-9);
  S.h.keydown({ key: 'Home', preventDefault: () => {} });
  check('Home 回默认', S.cur() === HARD.dflt);
  let used = 0;
  S.api.setSplit(58, false);
  S.h.keydown({ key: 'Enter', preventDefault: () => { used++; } });
  check('无关按键不动宽度、也不抢事件', S.cur() === 58 && used === 0);
  const N = harness(900);   /* 窄窗口：下限是 CSS 的 240px，不是 18% */
  N.api.setSplit(20, false);
  const floored = N.cur();
  N.h.keydown({ key: 'ArrowLeft', preventDefault: () => {} });
  check('窄窗口连按← 停在 CSS 下限（' + floored.toFixed(2) + '% → ' + N.cur().toFixed(2) + '%），不越过 240px',
    floored >= 27.78 - 1e-9 && N.cur() >= 27.78 - 1e-9);
  check('window resize 也绑了 relayout', typeof S.h['win:resize'] === 'function');
}

console.log('\n' + (fails ? '✗ ' + fails + ' 项不通过' : '✓ 分隔条断言全部通过'));
if (typeof process !== 'undefined' && process.exit) process.exit(fails ? 1 : 0);
export { fails, LINES };
