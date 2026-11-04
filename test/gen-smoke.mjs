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

/* 文本变量：C 里是 char[256]，C++ 里是 std::string —— 同一批积木，两套写法 */
cases.push({
  name: '文本变量（C 的 char[256] / C++ 的 std::string）',
  roots: [blk('main', {}, {
    BODY: [
      blk('var_decl', { TYPE: 'string', NAME: 's' }, { INIT: text('hi') }),
      blk('var_decl', { TYPE: 'string', NAME: 't' }, {}),
      blk('var_set', { VAR: 't' }, { VALUE: vget('s') }),
      blk('read', { VAR: 't' }, {}),
      blk('print', { NL: 'TRUE' }, { MSG: vget('t') }),
      blk('printf', { FMT: '[%s]\\n' }, { ARG0: vget('s') }),
      blk('scanf', { FMT: '%s' }, { ARG0: vget('s') }),
    ],
  })],
});
cases[4].expect = [
  'char s[256] = "hi";',
  'char t[256];',
  'strcpy(t, s);',
  'scanf("%255s", t);',
  'printf("%s\\n", t);',
  'printf("[%s]\\n", s);',
  'scanf("%255s", s);',
  '#include <string.h>',
];
cases[4].expectDiag = ['%s 已自动写成 %255s'];

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

/* ---------------- 文本变量：C 的 char[256] vs C++ 的 std::string ---------------- */
console.log('\n══════ 文本变量 ══════');
{
  const r = cOut[4];
  check('C 不带 <string>（那是 C++ 的头）', !r.code.includes('#include <string>'));
  check('C 的文本变量前面不会莫名多出 &', !/&\bs\b/.test(r.code));
  check('C：printf 的 %s 直接用数组名，不补 .c_str()', r.code.includes('printf("[%s]\\n", s);') && !r.code.includes('c_str'));
  check('C：文本没有初始化值时只出 char t[256];', r.code.includes('char t[256];'));
  check('C：缓冲区大小写进提示里', r.diagnostics.some((d) => d.sev === 'info' && /256 字节的字符数组，最多存 255 个字符/.test(d.msg)));
}
{
  const r = cppOut[4];
  check('C++ 声明文本变量出 std::string s = "hi"', r.code.includes('std::string s = "hi";'));
  check('C++ 的 std::string 必须带 #include <string>', r.code.includes('#include <string>'));
  check('C++ 文本赋值直接用 =', r.code.includes('t = s;'));
  check('C++ 读文本用 std::cin >> t（不带格式符和 &）', r.code.includes('std::cin >> t;'));
  check('cout 输出文本变量不加 .c_str()', r.code.includes('std::cout << t << std::endl;'));
  check('printf 的 %s 配 std::string 自动补 .c_str()', r.code.includes('printf("[%s]\\n", s.c_str());'));
  check('拼接结果再进 %s 会先加括号：(a + b).c_str()',
    (() => {
      const w = workspace([blk('main', {}, {
        BODY: [
          blk('var_decl', { TYPE: 'string', NAME: 'a' }, {}),
          blk('var_decl', { TYPE: 'string', NAME: 'b' }, {}),
          blk('printf', { FMT: '%s\\n' }, { ARG0: blk('arith', { OP: '+' }, { A: vget('a'), B: vget('b') }, true) }),
        ],
      })]);
      const g = CGen.generate(w, { annotate: false, lang: 'cpp' });
      return g.code.includes('printf("%s\\n", (a + b).c_str());') && !g.hasError;
    })());
  check('scanf 的 %s 配 std::string 报错并指向「读入到变量」',
    r.diagnostics.some((d) => d.sev === 'error' && /%s 不能往文本变量「s」里写/.test(d.msg) && /std::cin >> s/.test(d.msg)));
  check('C++ 模式不带 <string.h> 也不出 strcpy', !r.code.includes('#include <string.h>') && !r.code.includes('strcpy'));
  check('cin >> 文本会提示「只读到一个词」', r.diagnostics.some((d) => d.sev === 'info' && /遇到空格、Tab 或换行就停/.test(d.msg)));
}
{
  /* 拼接与判等：C++ 按内容走，C 一律拦下 */
  const mk = () => workspace([blk('main', {}, {
    BODY: [
      blk('var_decl', { TYPE: 'string', NAME: 's' }, { INIT: text('hello') }),
      blk('print', { NL: 'TRUE' }, { MSG: blk('arith', { OP: '+' }, { A: vget('s'), B: text('!') }, true) }),
      blk('if', {}, {
        COND: blk('compare', { OP: '==' }, { A: vget('s'), B: text('hello') }, true),
        DO: [blk('print', { NL: 'TRUE' }, { MSG: text('对了') })],
      }),
    ],
  })]);
  const c1 = CGen.generate(mk(), { annotate: false, lang: 'cpp' });
  const c0 = CGen.generate(mk(), { annotate: false, lang: 'c' });
  check('C++：s + "!" 直接出拼接，不需要额外调用', c1.code.includes('std::cout << s + "!" << std::endl;') && !c1.hasError);
  check('C++：s == "hello" 比的是内容，照常出代码', c1.code.includes('if (s == "hello")'));
  check('C：文本相加报错', c0.diagnostics.some((d) => d.sev === 'error' && /文本不能参与/.test(d.msg)));
  check('C：文本比较报错（比的是地址）', c0.diagnostics.some((d) => d.sev === 'error' && /比的是地址/.test(d.msg)));
  check('C：报错里给出路（strcmp 没有 / 切 C++）',
    c0.diagnostics.some((d) => /strcmp/.test(d.msg) && /切到 C\+\+ 用 std::string/.test(d.msg)));
}
{
  /* 超长文本：C 那块 256 字节的缓冲区装不下，C++ 的 std::string 自己会扩 */
  const mk = () => workspace([blk('main', {}, {
    BODY: [blk('var_decl', { TYPE: 'string', NAME: 's' }, { INIT: text('中'.repeat(100)) })],
  })]);
  const c0 = CGen.generate(mk(), { annotate: false, lang: 'c' });
  const c1 = CGen.generate(mk(), { annotate: false, lang: 'cpp' });
  check('C：100 个汉字按 UTF-8 算 300 字节，超出缓冲区就报错',
    c0.diagnostics.some((d) => d.sev === 'error' && /要占 300 字节/.test(d.msg)));
  check('C++：同样的文本不报错', !c1.hasError);
}
{
  /* 函数收发文本：C++ 可以，C 报错并说明为什么 */
  const mk = () => workspace([
    blk('func_def', { NAME: 'greet', RET: 'string', NP: '1', P0_T: 'string', P0_N: 'who' }, {
      BODY: [blk('return', {}, { VALUE: vget('who') })],
    }),
    blk('main', {}, {
      BODY: [
        blk('var_decl', { TYPE: 'string', NAME: 's' }, { INIT: text('hi') }),
        blk('print', { NL: 'TRUE' }, { MSG: blk('call', { NAME: 'greet' }, { ARG0: vget('s') }, true) }),
      ],
    }),
  ]);
  const c1 = CGen.generate(mk(), { annotate: false, lang: 'cpp' });
  const c0 = CGen.generate(mk(), { annotate: false, lang: 'c' });
  check('C++ 原型出 std::string greet(std::string who)', c1.code.includes('std::string greet(std::string who);'));
  check('C++ 里文本能进能出函数，全程无 error', !c1.hasError && c1.code.includes('std::cout << greet(s) << std::endl;'));
  check('C：文本参数和文本返回值各报一条，不多不少',
    c0.diagnostics.filter((d) => d.sev === 'error').length === 2
    && c0.diagnostics.some((d) => /退化成指针/.test(d.msg))
    && c0.diagnostics.some((d) => /悬空指针/.test(d.msg)));
  check('C：数字实参传给文本形参会报错',
    (() => {
      const w = workspace([
        blk('func_def', { NAME: 'shout', RET: 'void', NP: '1', P0_T: 'string', P0_N: 'who' }, {
          BODY: [blk('print', { NL: 'TRUE' }, { MSG: vget('who') })],
        }),
        blk('main', {}, { BODY: [blk('call', { NAME: 'shout' }, { ARG0: num(1) })] }),
      ]);
      const g = CGen.generate(w, { annotate: false, lang: 'cpp' });
      return g.diagnostics.some((d) => d.sev === 'error' && /形参 who 是文本，实参 1 却是 int/.test(d.msg));
    })());
}
{
  /* 格式符配错：文本变量遇上 %d / %c / scanf %d */
  const w = workspace([blk('main', {}, {
    BODY: [
      blk('var_decl', { TYPE: 'string', NAME: 's' }, {}),
      blk('var_decl', { TYPE: 'int', NAME: 'n' }, {}),
      blk('printf', { FMT: '%d %c' }, { ARG0: vget('s'), ARG1: vget('s') }),
      blk('scanf', { FMT: '%d' }, { ARG0: vget('s') }),
      blk('scanf', { FMT: '%s' }, { ARG0: vget('n') }),
    ],
  })]);
  const r = CGen.generate(w, { annotate: false, lang: 'c' });
  check('%d 配文本变量报错', r.diagnostics.some((d) => d.sev === 'error' && /%d 要整数，第 1 个参数是文本/.test(d.msg)));
  check('%c 配文本变量报错（那是单个字符）', r.diagnostics.some((d) => d.sev === 'error' && /%c 打印的是单个字符/.test(d.msg)));
  check('scanf 用 %d 往文本变量里写报错', r.diagnostics.some((d) => d.sev === 'error' && /个目标是文本，不能用 %d 读入/.test(d.msg)));
  check('scanf 的 %s 配 int 变量报错（要的是字符数组）', r.diagnostics.some((d) => d.sev === 'error' && /%s 要的是字符数组名.*第 1 个槽放的是 int/.test(d.msg)));
  check('已经写了宽度的 %s 不重复加宽度',
    (() => {
      const w2 = workspace([blk('main', {}, {
        BODY: [
          blk('var_decl', { TYPE: 'string', NAME: 's' }, {}),
          blk('scanf', { FMT: '%20s' }, { ARG0: vget('s') }),
        ],
      })]);
      const g = CGen.generate(w2, { annotate: false, lang: 'c' });
      return g.code.includes('scanf("%20s", s);') && !/%255s/.test(g.code);
    })());
  check('宽度写得比缓冲区还大要报错',
    (() => {
      const w2 = workspace([blk('main', {}, {
        BODY: [
          blk('var_decl', { TYPE: 'string', NAME: 's' }, {}),
          blk('scanf', { FMT: '%9999s' }, { ARG0: vget('s') }),
        ],
      })]);
      const g = CGen.generate(w2, { annotate: false, lang: 'c' });
      return g.diagnostics.some((d) => d.sev === 'error' && /宽度 9999 比 256 字节的缓冲区还大/.test(d.msg));
    })());
}
{
  /* 数值变量遇上文本：报错要说清「换成文本类型」而不是丢一句类型不符 */
  const w = workspace([blk('main', {}, {
    BODY: [
      blk('var_decl', { TYPE: 'int', NAME: 'x' }, { INIT: text('abc') }),
      blk('var_decl', { TYPE: 'char', NAME: 'c' }, {}),
      blk('var_set', { VAR: 'c' }, { VALUE: text('abc') }),
      blk('var_set', { VAR: 'x' }, { VALUE: blk('char_lit', { CH: 'A' }, {}, true) }),
    ],
  })]);
  const r = CGen.generate(w, { annotate: false, lang: 'c' });
  check('int 变量用文本初始化：报错并提示换成文本类型',
    r.diagnostics.some((d) => d.sev === 'error' && /是 int，不能直接存放整块文本/.test(d.msg) && /把类型换成「文本」/.test(d.msg)));
  check('char 变量赋整块文本：提示改用「字符」积木',
    r.diagnostics.some((d) => d.sev === 'error' && /单个字符请用「字符」积木/.test(d.msg)));
  check('int 变量赋单个字符仍然正常（跟文本无关，不该被文本规则误伤）', r.code.includes('x = \'A\';'));
}

console.log('\n' + (fails ? '✗ ' + fails + ' 项不通过' : '✓ 全部断言通过'));
/* 允许直接在嵌入式 Node 环境里跑（没有 process 就不退出） */
if (typeof process !== 'undefined' && process.exit) process.exit(fails ? 1 : 0);
export { fails, LINES };
