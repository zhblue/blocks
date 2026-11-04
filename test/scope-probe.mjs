/*
 * test/scope-probe.mjs — 变量/数组/函数名下拉的候选，到底给了谁看
 *
 *   node test/scope-probe.mjs
 *
 * 这是「拖了声明却选不到变量」那类问题的回归测试：用一组假积木对象模拟
 * Blockly 的连接关系（父槽 targetConnection、语句链 next/prev），直接调
 * js/c-blocks.js 导出的 visibleNames，核对每种摆放方式给出的候选。
 * 最后一条故意把语句链接成环，确认遍历会被挡住而不是把主线程转死。
 *
 * J~P 测的是另一半：syncDynamicFields 给刚拖出来的下拉补默认值时补哪一个。
 * 以前一律补候选第一项，scanf 的两个槽、连着两条「读入」都会拿到同一个名字，
 * 生成的 scanf("%d %d", &a, &a) 编译得过但第二个数永远覆盖第一个。现在按槽位顺序
 * 补、同组不重名，同时守住几条不能过界的规则：只剩一个候选时允许重复、
 * 数组槽不互斥、不同层的槽（x = x + 1）不互相让名字、跑第二遍要幂等。
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

/* ================================================================== */
/* J~P：自动补默认值时，同一组槽位不抢同一个名字                        */
/* ================================================================== */

/** 假的下拉字段：候选现算（真 Blockly 里是 Blockly 缓存后由 sync 强制重算） */
function dynStub(block, kind, cands) {
  return {
    __dyn: { locked: false, kind: kind },
    value: '__none__',
    getOptions: () => cands.slice().map((n) => [n, n]),
    getValue() { return this.value; },
    setValue(v) { this.value = v; },
    getText() { return this.value === '__none__' ? '' : this.value; },
  };
}

/** 给积木挂一个动态下拉（真 Blockly 里它在 dummy input 的 fieldRow 上） */
function addField(b, name, kind, cands) {
  const inp = { name: 'CTRL_' + name, connection: { targetBlock: () => null, getSourceBlock: () => b }, fieldRow: [] };
  b.inputList.push(inp);
  const f = dynStub(b, kind, cands);
  inp.fieldRow.push(f);
  b['__f_' + name] = f;
  return f;
}

/** 带变量下拉的「变量」值块 */
function vgetF(cands) { const b = blk('var_get', { VAR: '__none__' }, true); addField(b, 'VAR', 'var', cands); return b; }
/** 带变量下拉的「读入到变量」语句块 */
function readF(cands) { const b = blk('read', { VAR: '__none__' }); addField(b, 'VAR', 'var', cands); return b; }
/** 带数组下拉的「数组第 i 项」值块 */
function arrGetF(cands) { const b = blk('arr_get', { ARR: '__none__' }, true); addField(b, 'ARR', 'array', cands); return b; }
const picked = (b, n) => b['__f_' + n].getValue();
const expectPick = (label, got, want) => {
  const ok = got === want;
  if (!ok) fails++;
  console.log((ok ? '✓ ' : '✗ ') + label + ' → [' + got + ']' + (ok ? '' : ' 期望 [' + want + ']'));
};
const AB = ['a', 'b', 'c'];

/* J：scanf 的两个目标槽各拖一块「变量」—— 以前两块都补第一个，得到 &a、&a */
fresh();
let sJ = blk('scanf', { FMT: '%d %d' });
let gJ1 = vgetF(AB), gJ2 = vgetF(AB);
into(sJ, 'ARG0', gJ1); into(sJ, 'ARG1', gJ2);
let mJ = stmtInto(main(), 'BODY', [decl('a'), decl('b'), sJ]);
asWorkspace([mJ]);
H.syncDynamicFields(mJ.workspace);
expectPick('J scanf 两个槽按槽位取不同名字', picked(gJ1, 'VAR') + ',' + picked(gJ2, 'VAR'), 'a,b');

/* K：同一条语句链里连着两条「读入」，也是 a、b 而不是 a、a */
fresh();
let rK1 = readF(AB), rK2 = readF(AB);
let mK = stmtInto(main(), 'BODY', [decl('a'), decl('b'), rK1, rK2]);
asWorkspace([mK]);
H.syncDynamicFields(mK.workspace);
expectPick('K 两条读入语句默认不同名', picked(rK1, 'VAR') + ',' + picked(rK2, 'VAR'), 'a,b');

/* L：只有一个候选时照旧重复 —— 两次读同一个变量是合法需求，不能留空 */
fresh();
let sL = blk('scanf', { FMT: '%d %d' });
let gL1 = vgetF(['a']), gL2 = vgetF(['a']);
into(sL, 'ARG0', gL1); into(sL, 'ARG1', gL2);
let mL = stmtInto(main(), 'BODY', [decl('a'), sL]);
asWorkspace([mL]);
H.syncDynamicFields(mL.workspace);
expectPick('L 只剩一个候选时允许重复', picked(gL1, 'VAR') + ',' + picked(gL2, 'VAR'), 'a,a');

/* M：用户已经手动定了 a，新拖进来的槽让给 b；已定的那个不能被改走 */
fresh();
let sM = blk('scanf', { FMT: '%d %d' });
let gM1 = vgetF(AB), gM2 = vgetF(AB);
gM1['__f_VAR'].setValue('a');            /* 学生自己选的 */
into(sM, 'ARG0', gM1); into(sM, 'ARG1', gM2);
let mM = stmtInto(main(), 'BODY', [decl('a'), decl('b'), sM]);
asWorkspace([mM]);
H.syncDynamicFields(mM.workspace);
expectPick('M 手动选中的保持不变', picked(gM1, 'VAR'), 'a');
expectPick('M 新拖进来的避开已用名', picked(gM2, 'VAR'), 'b');

/* N：数组下拉不参与互斥 —— 读同一个数组的两格是常态 */
fresh();
let sN = blk('scanf', { FMT: '%d %d' });
let aN1 = arrGetF(['a', 'b']), aN2 = arrGetF(['a', 'b']);
into(sN, 'ARG0', aN1); into(sN, 'ARG1', aN2);
let mN = stmtInto(main(), 'BODY', [blk('arr_decl', { TYPE: 'int', NAME: 'a', LEN: '5' }), sN]);
asWorkspace([mN]);
H.syncDynamicFields(mN.workspace);
expectPick('N 两个数组槽可以都选同一个数组', picked(aN1, 'ARR') + ',' + picked(aN2, 'ARR'), 'a,a');

/* O：x = x + 1 这种「不同层的槽」不该被拆成两个名字（互斥只限同一个父积木的槽） */
fresh();
let setO = blk('var_set', { VAR: '__none__' });
addField(setO, 'VAR', 'var', AB);
let addO = blk('arith', { OP: '+' }, true);
let leftO = vgetF(AB);
into(addO, 'A', leftO);
into(setO, 'VALUE', addO);
let mO = stmtInto(main(), 'BODY', [decl('a'), setO]);
asWorkspace([mO]);
H.syncDynamicFields(mO.workspace);
expectPick('O 赋值目标和它表达式里的变量仍是同一个名', picked(setO, 'VAR') + ',' + picked(leftO, 'VAR'), 'a,a');

/* P：再跑一遍不该改动任何东西（幂等），也不会把已选的值换掉 */
fresh();
let sP = blk('scanf', { FMT: '%d %d %d' });
let gP = [vgetF(AB), vgetF(AB), vgetF(AB)];
into(sP, 'ARG0', gP[0]); into(sP, 'ARG1', gP[1]); into(sP, 'ARG2', gP[2]);
let mP = stmtInto(main(), 'BODY', [decl('a'), decl('b'), decl('c'), sP]);
asWorkspace([mP]);
const n1 = H.syncDynamicFields(mP.workspace);
const gotP = gP.map((b) => picked(b, 'VAR')).join(',');
const n2 = H.syncDynamicFields(mP.workspace);
expectPick('P 三个槽拿到三个名字', gotP, 'a,b,c');
if (n2 !== 0) { fails++; console.log('✗ P 第二次同步又改了 ' + n2 + ' 个字段（应幂等）'); }
else console.log('✓ P 第二次同步不再改动（幂等，第一轮改了 ' + n1 + ' 个）');

console.log(fails ? '\n✗ ' + fails + ' 条不符' : '\n✓ 作用域候选与下拉默认值全部符合预期');/* 直接 node 跑时用退出码表示成败；嵌在别的运行时里（没有 process）就跳过 */
if (globalThis.process) globalThis.process.exitCode = fails ? 1 : 0;
