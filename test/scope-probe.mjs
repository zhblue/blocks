/*
 * test/scope-probe.mjs — 变量/数组/函数名下拉的候选，到底给了谁看
 *
 *   node test/scope-probe.mjs
 *
 * 这是「拖了声明却选不到变量」那类问题的回归测试：用一组假积木对象模拟
 * Blockly 的连接关系（父槽 targetConnection、语句链 next/prev），直接调
 * js/c-blocks.js 导出的 visibleNames，核对每种摆放方式给出的候选。
 * 最后一条故意把语句链接成环，确认遍历会被挡住而不是把主线程转死。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

class FieldStub { constructor() { /* 定义期不关心字段 */ } }
const Blockly = {
  Blocks: {},
  FieldDropdown: FieldStub, FieldTextInput: FieldStub, FieldNumber: FieldStub,
  FieldCheckbox: FieldStub, FieldImage: FieldStub, FieldLabel: FieldStub, FieldVariable: FieldStub,
  inputs: { inputTypes: { VALUE: 1, STATEMENT: 3, DUMMY: 5 } },
  Events: {}, utils: { checkIdentifier: undefined },
  defineBlocksWithJsonArray() {},
};
const sandbox = { Blockly, console, encodeURIComponent, Object, Array, Set, Map, RegExp, JSON, Math, String, Number, Boolean, isNaN, parseFloat, Intl };
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of ['js/c-blocks.js', 'js/c-generator.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f });
}
const H = sandbox.CBlocks.helpers;

let idSeq = 0;
const blocks = [];

/**
 * @param isValue 值块（只有 outputConnection）还是语句块（有 previous/nextConnection）
 */
function blk(cKind, fields, isValue) {
  const b = {
    id: 'b' + (++idSeq), cKind, fields: fields || {}, inputList: [],
    next: null, workspace: null,
    getFieldValue(n) { return this.fields[n]; },
    getNextBlock() { return this.next; },
  };
  if (isValue) b.outputConnection = { getSourceBlock: () => b };
  else { b.previousConnection = { getSourceBlock: () => b }; b.nextConnection = { getSourceBlock: () => b }; }
  b.getInputTargetBlock = (n) => {
    const inp = b.inputList.find((i) => i.name === n);
    return inp ? inp.connection.targetBlock() : null;
  };
  blocks.push(b);
  return b;
}

/** 把 child 塞进 parent 的输入槽，并把连接关系接实（真 Blockly 在 connect 时就这么干） */
function into(parent, name, child) {
  const conn = {
    getSourceBlock: () => parent,
    targetBlock: () => child || null,
  };
  conn.targetConnection = child ? (child.previousConnection || child.outputConnection) : null;
  if (child) (child.previousConnection || child.outputConnection).targetConnection = conn;
  parent.inputList.push({ name, connection: conn });
  return parent;
}

/** 一串语句块连成链，放进 parent 的 name 槽 */
function stmtInto(parent, name, list) {
  const arr = list.filter(Boolean);
  for (let i = 0; i < arr.length; i++) {
    if (i + 1 < arr.length) {
      arr[i].next = arr[i + 1];
      arr[i + 1].previousConnection.targetConnection = {
        getSourceBlock: () => arr[i],
        targetBlock: () => arr[i + 1],
      };
    }
  }
  if (arr.length) into(parent, name, arr[0]);
  return parent;
}

function asWorkspace(roots) {
  const ws = {
    getAllBlocks: () => blocks.slice(),
    getTopBlocks: () => roots.slice(),
  };
  blocks.forEach((b) => { b.workspace = ws; });
  return ws;
}

const main = () => blk('main', {});
const decl = (name) => blk('var_decl', { TYPE: 'int', NAME: name });
const print = (valueBlock) => { const p = blk('print', { NL: 'TRUE' }); if (valueBlock) into(p, 'MSG', valueBlock); return p; };
const vget = () => blk('var_get', { VAR: '__none__' }, true);
const ifBlk = (body) => { const i = blk('if', {}); stmtInto(i, 'DO', body); return i; };

let fails = 0;
const expect = (label, valueBlock, want) => {
  const got = H.visibleNames(valueBlock, { kind: 'var' }).map((v) => v.name).join(',');
  const ok = got === want;
  if (!ok) fails++;
  console.log((ok ? '✓ ' : '✗ ') + label + ' → [' + got + ']' + (ok ? '' : ' 期望 [' + want + ']'));
};

/* 每段场景都重开一批积木：blocks 里只留当前这一棵树 */
function fresh() { blocks.length = 0; }

fresh();
let va = vget();
let ma = stmtInto(main(), 'BODY', [decl('x'), print(va)]);
asWorkspace([ma]);
expect('A 声明在使用之前', va, 'x');

fresh();
let vb = vget();
let mb = stmtInto(main(), 'BODY', [print(vb), decl('x')]);
asWorkspace([mb]);
expect('B 声明在使用之后', vb, '');

fresh();
let vc = vget();
let mc = stmtInto(main(), 'BODY', [print(vc)]);
asWorkspace([mc, decl('y')]);          /* 声明散落在 main 外面 */
expect('C 声明没接进主程序', vc, '');

fresh();
let vIn = vget(), vOut = vget();
let md = stmtInto(main(), 'BODY', [ifBlk([decl('inner'), print(vIn)]), print(vOut)]);
asWorkspace([md]);
expect('D1 if 体内（声明也在体内）', vIn, 'inner');
expect('D2 if 体后想用它', vOut, '');

fresh();
let ve = vget();
let fe = blk('func_def', { NAME: 'f', RET: 'int', NP: '1', P0_T: 'int', P0_N: 'n' });
stmtInto(fe, 'BODY', [print(ve)]);
asWorkspace([fe]);
expect('E 函数里能用形参', ve, 'n');

fresh();
let vf = vget();
asWorkspace([decl('q')]);               /* 变量块还没接进任何语句 */
expect('F 变量块浮空', vf, '');

fresh();
let vg = vget();
let mg = stmtInto(main(), 'BODY', [decl('a'), decl('b'), print(vg), decl('c')]);
asWorkspace([mg]);
expect('G 只认前面的 a、b', vg, 'a,b');

fresh();
let vh = vget();
let mh = stmtInto(main(), 'BODY', [decl('out'), ifBlk([decl('in'), print(vh)])]);
asWorkspace([mh]);
expect('H 外层和内层的声明都可见', vh, 'out,in');

/* —— I：结构被接成环（存档损坏或脚本硬连线），遍历必须挡住而不是转圈 */
fresh();
let vi = vget();
let pi = print(vi);
let di = decl('r');
pi.next = di;
di.next = pi;                            /* 环：print → decl → print */
di.previousConnection.targetConnection = { getSourceBlock: () => pi };
pi.previousConnection.targetConnection = { getSourceBlock: () => di };
let mi = into(main(), 'BODY', pi);
asWorkspace([mi]);
const t0 = Date.now();
let ring;
try { ring = H.visibleNames(vi, { kind: 'var' }).map((v) => v.name).join(','); }
catch (e) { ring = 'THREW ' + e.message; }
const cost = Date.now() - t0;
const okRing = cost < 2000;
if (!okRing) fails++;
console.log((okRing ? '✓ ' : '✗ ') + 'I 环状积木链没有把遍历转死（' + cost + 'ms，候选 [' + ring + ']）');

console.log(fails ? '\n✗ ' + fails + ' 条不符' : '\n✓ 作用域候选全部符合预期');
/* 直接 node 跑时用退出码表示成败；嵌在别的运行时里（没有 process）就跳过 */
if (globalThis.process) globalThis.process.exitCode = fails ? 1 : 0;
