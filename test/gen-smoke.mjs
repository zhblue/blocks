/*
 * test/gen-smoke.mjs — 不打开浏览器，也能验证「积木 → 等价代码」这一段
 *
 *   node test/gen-smoke.mjs
 *
 * 它用一组假积木对象模拟 Blockly 工作区（只需要生成器用到的那几个方法），
 * 把 js/c-blocks.js + js/c-generator.js 装进 vm 沙箱跑起来，同一批积木分别按
 * C 和 C++ 各生成一遍，打印源码和诊断信息，并核对若干断言。
 * 真正的编译/执行请在页面里点「编译并运行」，由浏览器内的 clang.wasm 完成。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/* 让输出既能打印、也能被内嵌 Node 环境收集下来检查 */
const LINES = [];
const realLog = (...a) => globalThis.console.log(...a);
const console = { log: (...a) => { LINES.push(a.map((x) => String(x)).join(' ')); realLog(...a); } };

/* ---------------- 假 Blockly：只需要定义期的那几个名字 ---------------- */
class Field { constructor() { /* 定义期不关心字段行为 */ } }
const Blockly = {
  Blocks: {},
  FieldDropdown: Field, FieldTextInput: Field, FieldNumber: Field,
  FieldCheckbox: Field, FieldImage: Field, FieldLabel: Field, FieldVariable: Field,
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
const CGen = sandbox.CGen;

/* ---------------- 假积木 / 假工作区 ---------------- */
let idSeq = 0;
class FakeBlock {
  constructor(cKind, fields, inputs, isValue) {
    this.id = 'b' + (++idSeq);
    this.cKind = cKind;
    this.type = 'x_' + cKind;
    this.fields = fields || {};
    this.inputs = inputs || {};
    this.next = null;
    this.prev = null;
    this.outputConnection = isValue ? {} : null;
    this.workspace = null;
  }
  getFieldValue(n) { return this.fields[n]; }
  getInputTargetBlock(n) {
    const v = this.inputs[n];
    if (v === undefined || v === null) return null;
    return Array.isArray(v) ? (v[0] || null) : v;
  }
  getInput(n) {
    const v = this.inputs[n];
    if (v === undefined) return null;
    const self = this;
    return { name: n, targetBlock: () => self.getInputTargetBlock(n) };
  }
  getNextBlock() { return this.next; }
  getPreviousBlock() { return this.prev; }
  getRootBlock() { let b = this; while (b._parentRef) b = b._parentRef; return b; }
}

/** 语句列表：把一串积木连成链 */
function chain(list) {
  const arr = (Array.isArray(list) ? list : [list]).filter(Boolean);
  for (let i = 0; i < arr.length; i++) {
    arr[i].prev = i ? arr[i - 1] : null;
    arr[i].next = i + 1 < arr.length ? arr[i + 1] : null;
  }
  return arr.length ? arr[0] : null;
}

/** inputs 里的数组值当语句链处理 */
function blk(cKind, fields, inputs, isValue) {
  const b = new FakeBlock(cKind, fields, {}, isValue);
  for (const [k, v] of Object.entries(inputs || {})) {
    if (Array.isArray(v)) b.inputs[k] = chain(v.slice());
    else b.inputs[k] = v;
    linkChildren(b, k, v);
  }
  return b;
}
function linkChildren(parent, key, v) {
  const heads = Array.isArray(v) ? v : (v ? [v] : []);
  for (const h of heads) if (h) h._parentRef = parent;
}

function workspace(roots) {
  const all = [];
  const seen = new Set();
  const visit = (b) => {
    if (!b || seen.has(b)) return;
    seen.add(b);
    all.push(b);
    for (const key of Object.keys(b.inputs)) visit(b.getInputTargetBlock(key));
    visit(b.getNextBlock());
  };
  for (const r of roots) visit(r);
  const ws = {
    getTopBlocks: () => roots.slice(),
    getAllBlocks: () => all.slice(),
  };
  all.forEach((b) => { b.workspace = ws; });
  return ws;
}

/* ---------------- 用例 ---------------- */
const num = (n) => blk('num', { NUM: String(n) });
const vget = (n) => blk('var_get', { VAR: n }, {}, true);
const text = (t) => blk('text', { TEXT: t }, {}, true);
const aget = (a, i) => blk('arr_get', { ARR: a }, { IDX: i }, true);

const cases = [];

cases.push({
  name: 'Hello + 自动输出积木 + printf/scanf',
  roots: [blk('main', {}, {
    BODY: [
      blk('print', { NL: 'TRUE' }, { MSG: text('你好，C！') }),
      blk('printf', { FMT: '%d 加 %g 等于 %s\\n' }, {
        ARG0: num(1), ARG1: num(2.5), ARG2: text('三'),
      }),
      blk('var_decl', { TYPE: 'int', NAME: 'n' }, {}),
      blk('scanf', { FMT: '%d' }, { ARG0: vget('n') }),
    ],
  })],
});

cases.push({
  name: '循环 + 判断 + 数组求和',
  roots: [blk('main', {}, {
    BODY: [
      blk('arr_decl', { TYPE: 'int', NAME: 'a', LEN: '5' }, {}),
      blk('var_decl', { TYPE: 'int', NAME: 'sum', }, { INIT: num(0) }),
      blk('for', { NAME: 'i' }, {
        FROM: num(0), TO: blk('arith', { OP: '-' }, { A: num(5), B: num(1) }, true), STEP: num(1),
        DO: [blk('read_arr', { ARR: 'a' }, { IDX: vget('i') })],
      }),
      blk('repeat', {}, {
        TIMES: num(5),
        DO: [blk('var_set', { VAR: 'sum' }, {
          VALUE: blk('arith', { OP: '+' }, { A: vget('sum'), B: aget('a', vget('sum')) }, true),
        })],
      }),
      blk('if', {}, {
        COND: blk('compare', { OP: '>' }, { A: vget('sum'), B: num(100) }, true),
        DO: [blk('printf', { FMT: 'sum=%d\\n' }, { ARG0: vget('sum') })],
        ELSE: [blk('print', { NL: 'TRUE' }, { MSG: text('不大') })],
      }),
      blk('while', {}, {
        COND: blk('logic', { OP: '&&' }, {
          A: blk('compare', { OP: '!=' }, { A: vget('sum'), B: num(0) }, true),
          B: blk('not', {}, { A: blk('compare', { OP: '<' }, { A: vget('sum'), B: num(0) }, true) }, true),
        }, true),
        DO: [blk('break', {}, {})],
      }),
      blk('until', {}, { COND: num(1), DO: [blk('continue', {}, {})] }),
    ],
  })],
});

cases.push({
  name: '函数（含递归）与调用',
  roots: [
    blk('func_def', { NAME: 'fact', RET: 'int', NP: '1', P0_T: 'int', P0_N: 'n' }, {
      BODY: [
        blk('if', {}, {
          COND: blk('compare', { OP: '<=' }, { A: vget('n'), B: num(1) }, true),
          DO: [blk('return', {}, { VALUE: num(1) })],
          ELSE: [blk('return', {}, {
            VALUE: blk('arith', { OP: '*' }, {
              A: vget('n'),
              B: blk('call', { NAME: 'fact' }, { ARG0: blk('arith', { OP: '-' }, { A: vget('n'), B: num(1) }, true) }, true),
            }, true),
          })],
        }),
      ],
    }),
    blk('func_def', { NAME: 'show', RET: 'void', NP: '1', P0_T: 'double', P0_N: 'v' }, {
      BODY: [blk('printf', { FMT: '值是 %.2f\\n' }, { ARG0: vget('v') })],
    }),
    blk('main', {}, {
      BODY: [
        blk('call', { NAME: 'show' }, { ARG0: blk('cast', { TO: 'double' }, { A: blk('call', { NAME: 'fact' }, { ARG0: num(5) }, true) }, true) }),
        blk('var_decl', { TYPE: 'bool', NAME: 'ok' }, { INIT: blk('bool_lit', { V: 'true' }, {}, true) }),
      ],
    }),
  ],
});

cases.push({
  name: '该报错的组合：格式符数量不符 / 越界作用域 / 中文变量名 / scanf 类型错',
  roots: [blk('main', {}, {
    BODY: [
      blk('printf', { FMT: '%d %d %d' }, { ARG0: num(1), ARG1: num(2) }),
      blk('var_set', { VAR: 'later' }, { VALUE: num(1) }),
      blk('var_decl', { TYPE: 'int', NAME: 'later' }, {}),
      blk('var_decl', { TYPE: 'int', NAME: '总数' }, {}),
      blk('break', {}, {}),
      blk('scanf', { FMT: '%f %c' }, { ARG0: blk('arith', { OP: '+' }, { A: num(1), B: num(2) }, true) }),
      blk('var_decl', { TYPE: 'double', NAME: 'd' }, {}),
      blk('scanf', { FMT: '%f' }, { ARG0: vget('d') }),
      blk('print', { NL: 'FALSE' }, { MSG: blk('cast', { TO: 'double' }, { A: num(7) }, true) }),
    ],
  })],
});

/* 关键断言：生成出来的代码应当长这样 */
cases[0].expect = [
  'printf("你好，C！\\n");',
  'printf("%d 加 %g 等于 %s\\n", 1, 2.5, "三");',
  'int n;',
  'scanf("%d", &n);',
];
cases[0].expectDiag = [];
cases[1].expect = [
  'int a[5];',
  'for (int i = 0; i <= 5 - 1; i += 1)',
  'scanf("%d", &a[i]);',
  'for (int c_i1 = 0; c_i1 < 5; c_i1 += 1)',
  '} else {',
  'while (sum != 0 && !(sum < 0))',
  'do {',
  '} while (!(1));',
];
cases[1].expectDiag = ['数组「a」有 5 个格子'];
cases[2].expect = [
  'int fact(int n);',
  'void show(double v);',
  'int fact(int n) {',
  'show((double)(fact(5)));',
  'bool ok = true;',
  '#include <stdbool.h>',
];
cases[3].expectDiag = [
  '格式串里 3 个格式说明符对上 2 个实参',
  '在这里不可见',
  '有中文',
  '只能放在循环积木里面',
  '只吃「变量」或「数组的第 i 项」',
  '读小数必须写 %lf',
];

/* ---------------- 跑 ---------------- */
let fails = 0;
const cOut = [];
for (const c of cases) {
  idSeq = 0;
  const ws = workspace(c.roots);
  const res = CGen.generate(ws, { annotate: true });
  cOut.push(res);
  console.log('\n══════ ' + c.name + ' ══════');
  console.log(res.code);
  console.log('── 诊断 ──');
  for (const d of res.diagnostics) console.log('  [' + d.sev + '] ' + (d.label ? d.label + '：' : '') + d.msg);
  if (c.expect) {
    for (const e of c.expect) {
      const ok = res.code.includes(e);
      if (!ok) { fails++; console.log('  ✗ 期望代码里含 ' + e); }
    }
  }
  if (c.expectDiag) {
    for (const e of c.expectDiag) {
      if (!res.diagnostics.some((d) => d.msg.includes(e))) { fails++; console.log('  ✗ 期望诊断含「' + e + '」'); }
    }
  }
}

/* ---------------- C++ 模式：同一批积木再过一遍生成器 ---------------- */
const cppOut = [];
for (const c of cases) {
  idSeq = 0;
  const ws = workspace(c.roots);
  const res = CGen.generate(ws, { annotate: true, lang: 'cpp' });
  cppOut.push(res);
  console.log('\n══════ [C++] ' + c.name + ' ══════');
  console.log(res.code);
  console.log('── 诊断 ──');
  for (const d of res.diagnostics) console.log('  [' + d.sev + '] ' + (d.label ? d.label + '：' : '') + d.msg);
}

/* 断言表 */
console.log('\n══════ 断言 ══════');
function check(label, cond) {
  console.log((cond ? '✓ ' : '✗ ') + label);
  if (!cond) fails++;
}
idSeq = 0;
{
  const ws = workspace([blk('main', {}, {
    BODY: [blk('repeat', {}, { TIMES: num(3), DO: [blk('print', { NL: 'TRUE' }, { MSG: num(1) })] })],
  })]);
  const r = CGen.generate(ws, { annotate: false });
  check('重复 3 次 → for (int c_i1 = 0; c_i1 < 3; c_i1 += 1)', /for \(int c_i1 = 0; c_i1 < 3; c_i1 \+= 1\)/.test(r.code));
}
{
  const ws = workspace([blk('main', {}, {
    BODY: [
      blk('var_decl', { TYPE: 'int', NAME: 'x' }, { INIT: num(2) }),
      blk('var_decl', { TYPE: 'int', NAME: 'y' }, { INIT: num(3) }),
      blk('print', { NL: 'TRUE' }, { MSG: blk('arith', { OP: '*' }, {
        A: blk('arith', { OP: '+' }, { A: vget('x'), B: vget('y') }, true), B: num(2) }, true) }),
      blk('print', { NL: 'TRUE' }, { MSG: blk('arith', { OP: '-' }, {
        A: num(10), B: blk('arith', { OP: '-' }, { A: num(3), B: num(2) }, true) }, true) }),
    ],
  })]);
  const r = CGen.generate(ws, { annotate: false });
  check('(x + y) * 2 加了必要的括号', r.code.includes('printf("%d\\n", (x + y) * 2);'));
  check('10 - (3 - 2) 右边保留括号、左边不啰嗦', r.code.includes('printf("%d\\n", 10 - (3 - 2));'));
}
{
  const ws = workspace([blk('main', {}, {
    BODY: [
      blk('var_decl', { TYPE: 'int', NAME: 'n' }, {}),
      blk('print', { NL: 'FALSE' }, { MSG: text('请输入：') }),
      blk('read', { VAR: 'n' }, {}),
      blk('print', { NL: 'TRUE' }, { MSG: vget('n') }),
    ],
  })]);
  const r = CGen.generate(ws, { annotate: false });
  check('自动读入整数用 scanf("%d", &n)', r.code.includes('scanf("%d", &n);'));
  check('输出紧接读入 → 自动插 fflush(stdout)', /printf\("请输入："\);\n\s*fflush\(stdout\);/.test(r.code));
  check('读入前面是声明时不多插 fflush', (r.code.match(/fflush\(stdout\)/g) || []).length === 1);
}
{
  const ws = workspace([blk('main', {}, {
    BODY: [
      blk('var_decl', { TYPE: 'char', NAME: 'c' }, {}),
      blk('var_decl', { TYPE: 'double', NAME: 'x' }, {}),
      blk('read', { VAR: 'c' }, {}),
      blk('read', { VAR: 'x' }, {}),
    ],
  })]);
  const r = CGen.generate(ws, { annotate: false });
  check('读入字符用 " %c"（前导空格吃掉残留换行）', r.code.includes('scanf(" %c", &c);'));
  check('读入小数用 %lf', r.code.includes('scanf("%lf", &x);'));
}
{
  const ws = workspace([
    blk('func_def', { NAME: 'shout', RET: 'void', NP: '0' }, { BODY: [blk('print', { NL: 'TRUE' }, { MSG: text('hi') })] }),
    blk('main', {}, { BODY: [blk('print', { NL: 'TRUE' }, { MSG: blk('call', { NAME: 'shout' }, {}, true) })] }),
  ]);
  const r = CGen.generate(ws, { annotate: false });
  check('void 函数放进数值槽会报错', r.diagnostics.some((d) => d.sev === 'error' && d.msg.includes('是 void，没有返回值可用')));
}
{
  const ws = workspace([blk('main', {}, {
    BODY: [blk('char_lit_check', {}, {})],
  })]);
  const r = CGen.generate(ws, { annotate: false });
  check('未知积木会报 error', r.hasError);
}

/* ---------------- C++ 模式断言 ---------------- */
console.log('\n══════ C++ 模式 ══════');
{
  const r = cppOut[0];
  check('输出 → std::cout << … << std::endl', r.code.includes('std::cout << "你好，C！" << std::endl;'));
  check('勾了换行就不再多打一个换行', (r.code.match(/std::endl/g) || []).length === 1);
  check('printf 积木照旧出 printf', r.code.includes('printf("%d 加 %g 等于 %s\\n", 1, 2.5, "三");'));
  check('scanf 积木照旧出 scanf', r.code.includes('scanf("%d", &n);'));
  check('用了 cout → #include <iostream>', r.code.includes('#include <iostream>'));
  check('用了 printf → #include <cstdio>', r.code.includes('#include <cstdio>'));
  check('C++ 模式不再带 <stdio.h>', !r.code.includes('#include <stdio.h>'));
  check('main 签名是 int main()', r.code.includes('int main() {') && !r.code.includes('int main(void) {'));
  check('头注释写明 C++', r.code.includes('目标语言：C++'));
  check('返回值带 lang: cpp', r.lang === 'cpp');
}
{
  const r = cppOut[2];
  check('bool 声明在 C++ 里不需要 <stdbool.h>',
    r.code.includes('bool ok = true;') && !r.code.includes('#include <stdbool.h>'));
  check('C++ 的 void 函数原型是 void show(double v)', r.code.includes('void show(double v);'));
  check('强制转换仍是 C 风格', r.code.includes('show((double)(fact(5)));'));
}
{
  const r = cppOut[3];
  const cErrs = cOut[3].diagnostics.filter((d) => d.sev === 'error').map((d) => d.msg);
  const cppErrs = r.diagnostics.filter((d) => d.sev === 'error').map((d) => d.msg);
  check('C++ 模式下诊断口径与 C 完全一致（格式串/作用域/中文变量名照旧）',
    cErrs.length === cppErrs.length && cErrs.every((m, i) => m === cppErrs[i]));
  check('出错条目数符合预期（7 条 error）', cppErrs.length === 7);
}
{
  /* 没勾换行的输出紧接读入：cout 不 flush，得补一句 std::flush */
  const ws = workspace([blk('main', {}, {
    BODY: [
      blk('var_decl', { TYPE: 'int', NAME: 'n' }, {}),
      blk('print', { NL: 'FALSE' }, { MSG: text('请输入：') }),
      blk('read', { VAR: 'n' }, {}),
      blk('print', { NL: 'TRUE' }, { MSG: blk('arith', { OP: '+' }, { A: vget('n'), B: num(1) }, true) }),
    ],
  })]);
  const r = CGen.generate(ws, { annotate: false, lang: 'cpp' });
  check('读入用 std::cin >> n（不带 & 和格式符）', r.code.includes('std::cin >> n;'));
  check('提示后补 std::cout << std::flush', r.code.includes('std::cout << std::flush;'));
  check('算术表达式不用加括号（<< 结合力低于 +）', r.code.includes('std::cout << n + 1 << std::endl;'));
  check('纯 cin/cout 的程序不引 <cstdio>', !r.code.includes('#include <cstdio>'));
}
{
  /* 勾了换行的输出本身就 flush，不该再多补一句 */
  const ws = workspace([blk('main', {}, {
    BODY: [
      blk('var_decl', { TYPE: 'int', NAME: 'n' }, {}),
      blk('print', { NL: 'TRUE' }, { MSG: text('请输入：') }),
      blk('read', { VAR: 'n' }, {}),
    ],
  })]);
  const r = CGen.generate(ws, { annotate: false, lang: 'cpp' });
  check('std::endl 已经 flush，不再补 std::flush', !r.code.includes('std::flush'));
}
{
  /* 空参函数：C 要写 (void)，C++ 直接空括号 */
  const ws = workspace([
    blk('func_def', { NAME: 'shout', RET: 'void', NP: '0' }, { BODY: [blk('print', { NL: 'TRUE' }, { MSG: text('hi') })] }),
    blk('main', {}, { BODY: [blk('call', { NAME: 'shout' }, {}, true)] }),
  ]);
  const cStyle = CGen.generate(ws, { annotate: false, lang: 'c' });
  const cppStyle = CGen.generate(ws, { annotate: false, lang: 'cpp' });
  check('C 的空参函数是 void shout(void)', cStyle.code.includes('void shout(void);'));
  check('C++ 的空参函数是 void shout()', cppStyle.code.includes('void shout();'));
}
{
  /* cout << 的比较式必须加括号：<< 的结合力高于 > 和 &&，不加括号会变成 (cout << a) > b */
  const ws = workspace([blk('main', {}, {
    BODY: [
      blk('var_decl', { TYPE: 'int', NAME: 'x' }, { INIT: num(2) }),
      blk('print', { NL: 'TRUE' }, { MSG: blk('compare', { OP: '>' }, { A: vget('x'), B: num(1) }, true) }),
      blk('print', { NL: 'FALSE' }, { MSG: blk('logic', { OP: '&&' }, {
        A: blk('compare', { OP: '<' }, { A: vget('x'), B: num(9) }, true),
        B: blk('not', {}, { A: blk('compare', { OP: '==' }, { A: vget('x'), B: num(0) }, true) }, true),
      }, true) }),
      blk('print', { NL: 'TRUE' }, { MSG: blk('arith', { OP: '*' }, {
        A: blk('arith', { OP: '+' }, { A: vget('x'), B: num(1) }, true), B: num(2) }, true) }),
    ],
  })]);
  const r = CGen.generate(ws, { annotate: false, lang: 'cpp' });
  check('比较式输出自动加括号', r.code.includes('std::cout << (x > 1) << std::endl;'));
  check('逻辑与输出自动加括号', r.code.includes('std::cout << (x < 9 && !(x == 0));'));
  check('(x + 1) * 2 只保留必要的括号', r.code.includes('std::cout << (x + 1) * 2 << std::endl;'));
}
{
  /* bool 变量在两种语言下的读入提示 */
  const ws = workspace([blk('main', {}, {
    BODY: [blk('var_decl', { TYPE: 'bool', NAME: 'f' }, {}), blk('read', { VAR: 'f' }, {})],
  })]);
  const c1 = CGen.generate(ws, { annotate: false, lang: 'c' });
  const c2 = CGen.generate(ws, { annotate: false, lang: 'cpp' });
  check('C 模式说 bool 没有合适的读入格式', c1.diagnostics.some((d) => /没有合适的读入格式/.test(d.msg)));
  check('C++ 模式改成解释 cin 的 0/非 0', c2.diagnostics.some((d) => /cin 会把 0\/非 0/.test(d.msg)));
}
{
  /* 不传 lang 时保持 C：老调用（示例、其它脚本）行为不变 */
  const ws = workspace([blk('main', {}, {
    BODY: [blk('print', { NL: 'TRUE' }, { MSG: text('hi') })],
  })]);
  const r = CGen.generate(ws, { annotate: false });
  check('默认仍是 C（printf + <stdio.h>）', r.code.includes('printf("hi\\n");') && r.lang === 'c');
}

console.log('\n' + (fails ? '✗ ' + fails + ' 项不通过' : '✓ 全部断言通过'));
/* 允许直接在嵌入式 Node 环境里跑（没有 process 就不退出） */
if (typeof process !== 'undefined' && process.exit) process.exit(fails ? 1 : 0);
export { fails, LINES };
