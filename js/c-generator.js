/*
 * c-generator.js — 积木树 → 等价的 C / C++ 代码
 *
 * 生成过程分三步：
 *   1. 遍历工作区，把积木按执行顺序铺开（主程序链 + 若干函数定义）；
 *   2. 自底向上给每个表达式算出 {代码片段, 类型, 结合力}，用来决定要不要加括号、
 *      printf 该用哪个格式符、赋值会不会丢小数；
 *   3. 打印成带 4 空格缩进的源码，同时产出一串中文诊断（error / warn / info），
 *      每条诊断都记住自己是哪块积木引起的，点一下就能跳回工作区。
 *
 * 语言由 opts.lang 决定：'cpp' / 'c++' 出 C++（std::cout、std::cin、按需带
 * <iostream>），其它一律按 C 出（printf/scanf、<stdio.h>、bool 需要 <stdbool.h>）。
 * 不传 opts.lang 时保持 C —— 老调用方（测试脚本）的行为不变。
 * 除「文本」变量外，两种语言共用同一套「原生数组 + C 风格强制转换」的写法：
 *   C++ 的文本变量出 std::string（按需带 <string>）；
 *   C   的文本变量出 char 名[256]，整块数组名就是字符串（赋值走 strcpy，读入带 %255s 上限）。
 *
 * 设计原则：宁可在生成阶段把话说清楚，也不让 clang 抛一句看不懂的报错。
 */
'use strict';

(function (global) {
  const H = global.CBlocks.helpers;

  const IND = '    ';

  const KEYWORDS = new Set([
    'auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do', 'double', 'else',
    'enum', 'extern', 'float', 'for', 'goto', 'if', 'inline', 'int', 'long', 'register',
    'restrict', 'return', 'short', 'signed', 'sizeof', 'static', 'struct', 'switch',
    'typedef', 'union', 'unsigned', 'void', 'volatile', 'while',
    '_Bool', '_Complex', 'true', 'false', 'NULL', 'main', 'printf', 'scanf', 'puts', 'getchar',
  ]);

  const PF = { int: '%d', double: '%g', char: '%c', bool: '%d' };   /* 自动输出积木用 */
  const SF = { int: '%d', double: '%lf', char: ' %c' };             /* 自动读入积木用 */

  /*
   * 「文本」有三种类型标签，别混成一个：
   *   string —— 「文本」积木的字面量，两种语言里都是 "abc"（C++ 里是 const char*）
   *   stdstr —— C++ 模式的文本变量，std::string
   *   cstr   —— C 模式的文本变量，char[256]，数组名本身就是字符串
   * 判断「是不是一整块文本」一律用 isStr()，只关心其中某一种的再单独比标签。
   */
  const CSTR_CAP = 256;          /* C 模式文本变量的缓冲区：最后一格留给 \0 */
  const CSTR_MAX = CSTR_CAP - 1; /* 能放进去的最多字符数，也是 scanf 的宽度上限 */
  function isStr(t) { return t === 'string' || t === 'stdstr' || t === 'cstr'; }

  /* 诊断信息里的类型名：内部标签（stdstr/cstr）别直接印给学生 */
  const TYPE_CN = {
    int: 'int', double: 'double', char: 'char', bool: 'bool',
    string: '文本', stdstr: '文本 std::string', cstr: '文本 char[]',
  };
  const tName = (t) => TYPE_CN[t] || t;

  /** 一段文本按 UTF-8 编出来占几字节（积木里打中文时，一个汉字是 3 字节） */
  function utf8Len(s) {
    let n = 0;
    for (const ch of s) {
      const c = ch.codePointAt(0);
      n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
    }
    return n;
  }

  const SPEC_GROUP = {
    d: 'int', i: 'int', u: 'int', o: 'int', x: 'int', X: 'int',
    f: 'double', F: 'double', e: 'double', E: 'double', g: 'double', G: 'double',
    c: 'char', s: 'string', p: 'any',
  };

  /* ================================================================== */
  /* 字符串与字符转义                                                    */
  /* ================================================================== */
  const UNESCAPE = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', "'": "'", '0': '\0' };

  /** 用户在输入框里写的 \n 是两个字符；先按 C 的写法解成真控制字符，再统一转义回去 */
  function unescapeUser(s) {
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '\\' && i + 1 < s.length) {
        const nx = s[i + 1];
        if (Object.prototype.hasOwnProperty.call(UNESCAPE, nx)) { out += UNESCAPE[nx]; i++; continue; }
      }
      out += ch;
    }
    return out;
  }

  function escapeC(s, keepPercent) {
    let out = '';
    for (const ch of s) {
      const c = ch.codePointAt(0);
      if (ch === '"') out += '\\"';
      else if (ch === '\\') out += '\\\\';
      else if (ch === '\n') out += '\\n';
      else if (ch === '\t') out += '\\t';
      else if (ch === '\r') out += '\\r';
      else if (c < 0x20) out += '\\x' + c.toString(16).padStart(2, '0');
      else if (ch === '%' && !keepPercent) out += '%%';
      else out += ch;
    }
    return out;
  }

  /** 扫描格式串里的转换说明符 */
  function scanFormat(fmt) {
    const specs = [];
    const re = /%([-+ #0]*[0-9]*(?:\.[0-9]+)?[hlLjzt]*)([diuoxXfFeEgGcsp%])/g;
    let m;
    while ((m = re.exec(fmt)) !== null) {
      if (m[2] === '%') continue;
      /* m[1] 再拆成标志 / 宽度 / 精度 / 长度修饰符：给 %s 补宽度上限时要用 */
      const p = /^([-+ #0]*)([0-9]*)((?:\.[0-9]+)?)([hlLjzt]*)$/.exec(m[1]);
      specs.push({
        conv: m[2], mod: m[1], at: m.index, text: m[0],
        flags: p[1], width: p[2], prec: p[3], len: p[4],
      });
    }
    const stray = fmt.replace(re, '').indexOf('%') >= 0;
    return { specs, stray };
  }

  /**
   * scanf 的 %s 必须带宽度：scanf("%s", buf) 是最经典的缓冲区溢出写法，
   * 学生输入 300 个字符就会写穿那个 256 字节的数组。
   * 已经写了宽度的（%20s）照原样保留，只判断它是否超过缓冲区。
   */
  function widthSpec(sp, cap) {
    if (sp.width) return { text: sp.text, tooBig: parseInt(sp.width, 10) > cap };
    /* C 的宽度写在标志之后、精度和长度修饰符之前：%s → %255s，%-10s → %-10s */
    return { text: '%' + sp.flags + cap + sp.prec + sp.len + sp.conv, tooBig: false };
  }

  /** 按 specs 的位置把若干说明符换成新写法，拼回完整格式串 */
  function patchFormat(fmt, specs, edits) {
    let out = '';
    let at = 0;
    for (let i = 0; i < specs.length; i++) {
      const sp = specs[i];
      out += fmt.slice(at, sp.at);
      out += edits[i] !== undefined ? edits[i] : sp.text;
      at = sp.at + sp.text.length;
    }
    return out + fmt.slice(at);
  }

  /* ================================================================== */
  /* 小工具                                                             */
  /* ================================================================== */
  function numType(raw) {
    return /[.eE]/.test(raw) ? 'double' : 'int';
  }

  function isNumeric(t) { return t === 'int' || t === 'double' || t === 'char' || t === 'bool'; }
  function rank(t) { return t === 'double' ? 3 : t === 'int' ? 2 : 1; }   /* char/bool 提升成 int */
  function promote(a, b) { return rank(a) >= rank(b) ? a : b; }

  /** 结合力：数字越小越紧，0 表示原子（永远不用加括号） */
  const P_ATOM = 0, P_MUL = 1, P_ADD = 2, P_CMP = 3, P_AND = 4, P_OR = 5, P_ANY = 6;

  function wrap(e, limit) {
    if (!e) return '';
    return e.prec > limit ? '(' + e.code + ')' : e.code;
  }

  /** 语句级（赋值右边、return、函数实参）几乎不需要括号 */
  function top(e) { return wrap(e, P_ANY); }

  /**
   * C++ 流式输出「std::cout << X」里的 X。
   * C++ 里 << 的结合力低于算术、高于比较和逻辑运算，所以：
   *   cout << a + b   —— 不加括号也是 (a + b)，安全
   *   cout << a > b   —— 会被解析成 (cout << a) > b，编译报错
   *   cout << a && b  —— 会被解析成 (cout << a) && b，静悄悄少输出半个表达式
   * 因此比较（P_CMP）及更松的 && / || 必须加括号，加减乘除和一元取负/类型转换不用。
   */
  function streamExpr(e) { return wrap(e, P_ADD); }

  /**
   * 在表达式后面接 .c_str() 这类「紧跟其后」的东西。
   * 成员访问比任何运算符都紧，所以只有原子级表达式能裸着接：
   *   s        →  s.c_str()
   *   a + b    →  (a + b).c_str()      —— 写成 a + b.c_str() 就变成「a 加上 b 的 C 指针」
   */
  function memberExpr(e, suffix) {
    return wrap(e, P_ATOM) + suffix;
  }

  /* ================================================================== */
  /* 生成器主体                                                          */
  /* ================================================================== */
  function generate(ws, opts) {
    const o = opts || {};
    const annotate = o.annotate !== false;
    /* 语言分支：'cpp' / 'c++' 出 C++ 写法（cout/cin/iostream），其余按 C。
       默认保持 C，这样不带参数调用（测试、老链接）的行为不变。 */
    const cpp = o.lang === 'cpp' || o.lang === 'c++';
    const diags = [];
    const used = { stdbool: false, cstdio: false, iostream: false, string: false, cstring: false };
    let seq = 0;

    /* 积木下拉里的 'string'（文本）落到具体语言时变成各自的标签：
       C++ 是 std::string 对象，C 是 char[256] 缓冲区。 */
    const tagOf = (t) => (t === 'string' ? (cpp ? 'stdstr' : 'cstr') : t);
    /** 声明/形参里写的类型名 */
    const spellOf = (t) => (t === 'stdstr' ? 'std::string' : t === 'cstr' ? 'char' : t);
    /** 形参的完整写法：C 的文本参数是数组，声明里带上长度（收到的是指针，长度只是注释意义） */
    const paramDecl = (p) => (p.type === 'cstr'
      ? 'char ' + p.name + '[' + CSTR_CAP + ']'
      : spellOf(p.type) + ' ' + p.name);

    const diag = (sev, msg, block) => {
      diags.push({ sev, msg, blockId: block ? block.id : null, label: block ? blockLabel(block) : '' });
    };
    const err = (m, b) => { diag('error', m, b); };
    const warn = (m, b) => { diag('warn', m, b); };
    const info = (m, b) => { diag('info', m, b); };

    /* ---- 名字占用表：给「重复 N 次」自动生成计数器时避让 ---- */
    const taken = new Set();
    for (const b of ws.getAllBlocks(false)) {
      if (!b.cKind) continue;
      if (b.cKind === 'var_decl' || b.cKind === 'arr_decl' || b.cKind === 'for') {
        const n = b.getFieldValue('NAME');
        if (n) taken.add(n);
      }
      if (b.cKind === 'func_def') {
        taken.add(b.getFieldValue('NAME') || '');
        for (const p of H.funcParams(b)) taken.add(p.name);
      }
    }
    const fresh = (base) => {
      let n;
      do { n = base + (++seq); } while (taken.has(n));
      taken.add(n);
      return n;
    };

    /* ---- 名称合法性 ---- */
    function checkName(raw, kindWhat, block) {
      const name = String(raw || '').trim();
      if (!name) { err(kindWhat + '的名字是空的。', block); return null; }
      if (!H.isIdent(name)) {
        if (/[^\x00-\x7F]/.test(name)) {
          err(kindWhat + '名「' + name + '」里有中文。C 的标识符只能用英文字母、数字和下划线，'
            + '并且不能以数字开头；改成 total / count 这样的名字。', block);
        } else {
          err(kindWhat + '名「' + name + '」不是合法的 C 标识符（只能用字母、数字、下划线，且不能以数字开头）。', block);
        }
        return name;
      }
      if (KEYWORDS.has(name)) {
        err(kindWhat + '名「' + name + '」是 C 的关键字或标准库名字，换一个。', block);
        return name;
      }
      return name;
    }

    /* ---- 函数表 ---- */
    const funcs = H.funcDefs(ws);
    const funcOrder = [];
    for (const d of funcs.values()) funcOrder.push(d);
    for (const d of funcOrder) {
      d.name = checkName(d.block.getFieldValue('NAME'), '函数', d.block);
      d.ret = tagOf(String(d.block.getFieldValue('RET') || 'void'));
      const seen = new Set();
      for (const p of d.params) {
        p.type = tagOf(p.type);
        const n = checkName(p.name, '参数', d.block);
        if (n) p.name = n;
        if (seen.has(p.name)) err('函数 ' + d.name + ' 的形参名重复：' + p.name + '。', d.block);
        seen.add(p.name);
      }
      if (!cpp) {
        /* C 里文本 = 一块 char 数组，它不能当函数返回值，也不适合当参数（见下面的理由）。
           C++ 的 std::string 是真正的值类型，这两件事都照写不误。 */
        if (d.ret === 'cstr') {
          err('函数 ' + d.name + ' 想返回一整块文本，但 C 做不到：那块字符数组是函数里的局部变量，'
            + '函数一返回内存就没了，递出去的只是悬空指针。要返回文本请切到 C++（std::string），'
            + '或者把缓冲区当参数交给函数、由调用方持有。', d.block);
        }
        for (const p of d.params) {
          if (p.type !== 'cstr') continue;
          err('函数 ' + d.name + ' 的文本参数「' + p.name + '」在 C 里会退化成指针：'
            + '函数收不到「这块缓冲区有多大」，往里写满 ' + CSTR_MAX + ' 个字符就可能越界。'
            + '本版积木因此不支持 C 的文本参数 —— 切到 C++ 用 std::string（长度自己带着），'
            + '或者改用 int / char 参数。', d.block);
        }
      }
    }

    /* ---- 主程序积木：找出入口链 ---- */
    const tops = ws.getTopBlocks(false);
    let mainHead = null;
    let hasMain = false;
    const stray = [];
    for (const b of tops) {
      if (b.cKind === 'func_def') continue;
      if (b.cKind === 'main') {
        hasMain = true;
        if (mainHead) { err('放了两个「主程序」积木，后面这个被忽略。', b); continue; }
        mainHead = b.getInputTargetBlock('BODY');
        continue;
      }
      if (b.outputConnection) {
        info('这块表达式没有接进任何语句，生成时忽略它。', b);
        continue;
      }
      stray.push(b);
    }
    /* 散落在画布上的语句链会被拼到 main 末尾，这正好是「声明了却选不到」的常见原因 */
    if (hasMain) {
      for (const st of stray) {
        warn('「' + blockLabel(st) + '」没有接进「主程序」，生成时会被放到 main 的最后：'
          + '排在它前面的语句看不到这个声明。把整条链拖进「主程序」的凹槽里，放在用到它的那块之前。', st);
      }
    }

    /* ================================================================== */
    /* 作用域                                                            */
    /* ================================================================== */
    function newCtx(func) {
      return { lines: [], ind: 0, scopes: [], func: func || null, loops: 0 };
    }
    const pushScope = (ctx) => { ctx.scopes.push(new Map()); };
    const popScope = (ctx) => { ctx.scopes.pop(); };
    const declare = (ctx, name, type, kind, block) => {
      const cur = ctx.scopes[ctx.scopes.length - 1];
      if (!cur) return;
      if (cur.has(name)) {
        err('变量「' + name + '」在这一层里已经声明过了（C 不允许同名重复声明）。', block);
        return;
      }
      cur.set(name, { name: name, type: type, kind: kind });
    };
    const lookup = (ctx, name) => {
      for (let i = ctx.scopes.length - 1; i >= 0; i--) {
        if (ctx.scopes[i].has(name)) return ctx.scopes[i].get(name);
      }
      return null;
    };

    /* ================================================================== */
    /* 表达式                                                            */
    /* ================================================================== */
    function E(block, ctx) {
      if (!block) return null;
      const k = block.cKind;
      const id = block.id;

      switch (k) {
        case 'num': {
          const raw = String(block.getFieldValue('NUM') || '0');
          if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(raw)) {
            err('数值积木里的内容「' + raw + '」不是合法数字。', block);
          }
          return { code: raw, type: numType(raw), prec: P_ATOM };
        }

        case 'text': {
          const s = unescapeUser(String(block.getFieldValue('TEXT') || ''));
          return { code: '"' + escapeC(s, true) + '"', type: 'string', prec: P_ATOM, bytes: utf8Len(s) };
        }

        case 'char_lit': {
          const s = unescapeUser(String(block.getFieldValue('CH') || ''));
          const cps = Array.from(s);
          if (cps.length !== 1) {
            err('字符积木要正好一个字符，现在是 ' + cps.length + ' 个（空着也算）。', block);
            return { code: "'\\0'", type: 'char', prec: P_ATOM };
          }
          const ch = cps[0];
          const c = ch.codePointAt(0);
          if (c > 0x7f) {
            err('字符常量只能是单字节 ASCII，「' + ch + '」是 '
              + (c > 0xff ? '多字节' : 'Latin-1') + '字符。中文请改用「文本」积木，或写它的 ASCII 码（65 就是 A）。', block);
            return { code: "'\\0'", type: 'char', prec: P_ATOM };
          }
          if (ch === "'") return { code: "'\\''", type: 'char', prec: P_ATOM };
          if (ch === '\\') return { code: "'\\\\'", type: 'char', prec: P_ATOM };
          if (ch === '\n') return { code: "'\\n'", type: 'char', prec: P_ATOM };
          if (ch === '\t') return { code: "'\\t'", type: 'char', prec: P_ATOM };
          if (ch === '\r') return { code: "'\\r'", type: 'char', prec: P_ATOM };
          if (c < 0x20) {
            warn('字符积木里是控制字符 0x' + c.toString(16) + '，已写成八位转义。', block);
            return { code: "'\\x" + c.toString(16).padStart(2, '0') + "'", type: 'char', prec: P_ATOM };
          }
          return { code: "'" + ch + "'", type: 'char', prec: P_ATOM };
        }

        case 'bool_lit': {
          used.stdbool = true;
          return { code: block.getFieldValue('V') === 'true' ? 'true' : 'false', type: 'bool', prec: P_ATOM };
        }

        case 'var_get': {
          const name = block.getFieldValue('VAR');
          if (!name || name === '__none__') {
            err('「变量」积木还没选要读哪个变量。下拉里一个名字都没有，说明这一层看不到「声明」积木：'
              + '把「声明」拖进同一个程序体，并且放在这块之前。', block);
            return { code: '0', type: 'int', prec: P_ATOM };
          }
          const v = lookup(ctx, name);
          if (!v) {
            err('变量「' + name + '」在这里不可见：C 只能读在它声明之后、同一层花括号里面的位置。'
              + '把「声明」积木挪到前面，或者换成别的名字。', block);
            return { code: name, type: 'int', prec: P_ATOM };
          }
          if (v.kind === 'array') { err('「' + name + '」是数组，要写「a 的第 i 项」才能取值。', block); }
          return { code: name, type: v.type, prec: P_ATOM };
        }

        case 'arr_get': {
          const name = block.getFieldValue('ARR');
          if (!name || name === '__none__') {
            err('数组积木还没选数组。下拉里空的，说明这一层没有可见的「声明数组」积木：'
              + '把「声明数组」拖进同一个程序体，并且放在这块之前。', block);
            return { code: '0', type: 'int', prec: P_ATOM };
          }
          const v = lookup(ctx, name);
          if (!v || v.kind !== 'array') {
            err('数组「' + name + '」在这里不可见，先用「声明数组」积木建它。', block);
            return { code: '0', type: 'int', prec: P_ATOM };
          }
          const idx = I(block.getInputTargetBlock('IDX'), ctx, name);
          return { code: name + '[' + idx + ']', type: v.type, prec: P_ATOM };
        }

        case 'arith': {
          const a = sub(block.getInputTargetBlock('A'), ctx, block);
          const b = sub(block.getInputTargetBlock('B'), ctx, block);
          if (!a || !b) return { code: '0', type: 'int', prec: P_ATOM };
          const op = block.getFieldValue('OP');
          /* C++ 的 std::string 可以相加，这是「拼文本」唯一的合法写法，且至少一边得是文本变量：
             "a" + "b" 是两个指针相加，编译不过；s + 5 会被当成「追加字符码 5」，不是加 5。 */
          if (op === '+' && (a.type === 'stdstr' || b.type === 'stdstr')) {
            if (isStr(a.type) && isStr(b.type)) {
              return { code: wrap(a, P_ADD) + ' + ' + wrap(b, P_ADD), type: 'stdstr', prec: P_ADD };
            }
            err('拼文本只能「文本 + 文本」：这边是 ' + tName(isStr(a.type) ? b.type : a.type)
              + '。数字要接在文本后面得先转成文本（C++ 用 std::to_string），本版积木还没有它；'
              + '想直接打印出来，用「输出」积木连着输出就行。', block);
          } else if (isStr(a.type) || isStr(b.type)) {
            err(cpp
              ? '文本不能参与 ' + op + ' 运算：std::string 只支持用 + 拼接，而且得有一边是文本变量。'
              : '文本不能参与算术运算（C 的字符串不是数值）。要比较文本请用 strcmp，本版积木暂未提供。', block);
          }
          const type = op === '/' && a.type === 'int' && b.type === 'int'
            ? 'int'
            : promote(isStr(a.type) ? 'int' : a.type, isStr(b.type) ? 'int' : b.type);
          const prec = (op === '*' || op === '/' || op === '%') ? P_MUL : P_ADD;
          if (op === '%' && (a.type === 'double' || b.type === 'double')) {
            err('取余 %% 只能用于整数；右边是小数，请先用「值类型转换」取整。', block);
          }
          if (op === '/' && a.type === 'int' && b.type === 'int') {
            info('两个 int 相除会丢掉小数部分（7 / 2 得 3）。想要 3.5，把其中一边用「转成小数」包一下。', block);
          }
          const left = wrap(a, prec);
          /* 减法和除法不满足结合律：右操作数只要同样紧就得加括号
             （10 - 3 - 2 与 100 / 2 / 5 若不加括号会算错） */
          const rightLimit = (op === '-' || op === '/') ? prec - 1 : prec;
          const right = wrap(b, rightLimit);
          return { code: left + ' ' + op + ' ' + right, type: type, prec: prec };
        }

        case 'neg': {
          const a = sub(block.getInputTargetBlock('A'), ctx, block);
          if (!a) return { code: '0', type: 'int', prec: P_ATOM };
          return { code: '-' + wrap(a, P_ATOM), type: a.type, prec: P_ATOM };
        }

        case 'not': {
          const a = sub(block.getInputTargetBlock('A'), ctx, block);
          if (!a) return { code: '0', type: 'int', prec: P_ATOM };
          if (isStr(a.type)) err('不能对文本取逻辑非。', block);
          return { code: '!' + wrap(a, P_ATOM), type: 'int', prec: P_ATOM };
        }

        case 'cast': {
          const a = sub(block.getInputTargetBlock('A'), ctx, block);
          const to = block.getFieldValue('TO');
          if (!a) return { code: '0', type: to, prec: P_ATOM };
          if (isStr(a.type)) { err('不能把文本转成 ' + to + '（C 的字符串不是数值）。', block); }
          else if (to === 'int' && a.type === 'double') {
            info('(int) 是截断取整，不是四舍五入：3.9 变 3，-3.9 变 -3。', block);
          }
          return { code: '(' + to + ')(' + top(a) + ')', type: to, prec: P_ATOM };
        }

        case 'compare': {
          const a = sub(block.getInputTargetBlock('A'), ctx, block);
          const b = sub(block.getInputTargetBlock('B'), ctx, block);
          if (!a || !b) return { code: '0', type: 'int', prec: P_ATOM };
          const op = block.getFieldValue('OP');
          if (isStr(a.type) || isStr(b.type)) {
            const bothStr = isStr(a.type) && isStr(b.type);
            /* 只有真对象（std::string）参与的比较才看内容；字面量在 C++ 里是 const char*，
               两边都是字面量时比的是地址。C 里的文本是数组，同样只能比出地址。 */
            const byValue = a.type === 'stdstr' || b.type === 'stdstr';
            if (!bothStr) {
              err('文本只能和文本比较：另一边是 ' + tName(isStr(a.type) ? b.type : a.type) + '。', block);
            } else if (!byValue) {
              if (cpp) {
                err('两块「文本」积木不能用 ' + op + ' 比：C++ 里字面量比的是指针地址，看不出内容是否相同。'
                  + '把其中一边换成文本变量（std::string），' + op + ' 比的就是内容。', block);
              } else {
                err('文本之间不能用 ' + op + ' 比较：C 里这样比的是地址。要比内容请用 strcmp（本版积木暂未提供），'
                  + '或者切到 C++ 用 std::string —— 那里的 ' + op + ' 比的就是内容。', block);
              }
            } else {
              return { code: wrap(a, P_ADD) + ' ' + op + ' ' + wrap(b, P_ADD), type: 'int', prec: P_CMP };
            }
          }
          if (op === '==' && (a.type === 'double' || b.type === 'double')) {
            warn('小数很难正好相等（0.1 + 0.2 不等于 0.3）。判等建议改成「差的绝对值小于一个很小的数」。', block);
          }
          return { code: wrap(a, P_ADD) + ' ' + op + ' ' + wrap(b, P_ADD), type: 'int', prec: P_CMP };
        }

        case 'logic': {
          const a = sub(block.getInputTargetBlock('A'), ctx, block);
          const b = sub(block.getInputTargetBlock('B'), ctx, block);
          if (!a || !b) return { code: '0', type: 'int', prec: P_ATOM };
          const op = block.getFieldValue('OP');
          for (const side of [a, b]) {
            if (isStr(side.type)) err('「且 / 或」两边必须是条件或整数，文本不行。', block);
          }
          const prec = op === '&&' ? P_AND : P_OR;
          return {
            code: wrap(a, prec) + ' ' + op + ' ' + wrap(b, prec),
            type: 'int', prec: prec,
          };
        }

        case 'call': {
          return callExpr(block, ctx);
        }

        default:
          err('这块积木（' + (k || '未知') + '）不能当数值用。', block);
          return { code: '0', type: 'int', prec: P_ATOM };
      }
    }

    /** 取一个值槽里的表达式；没接积木时报错并返回 null */
    function sub(block, ctx, owner) {
      if (!block) {
        err('「' + blockLabel(owner) + '」的槽位是空的。', owner);
        return null;
      }
      return E(block, ctx);
    }

    /** 数组下标：小数下标编译不过，自动加 (int) 并说明 */
    function I(block, ctx, arrName) {
      if (!block) {
        err('数组「' + arrName + '」的下标槽是空的（C 的下标从 0 开始）。', ctx.current || null);
        return '0';
      }
      const e = E(block, ctx);
      if (e.type === 'double') {
        info('数组下标必须是整数，已自动加 (int) 截断：' + arrName + '[(int)(' + top(e) + ')]。', block);
        return '(int)(' + top(e) + ')';
      }
      if (isStr(e.type)) { err('数组下标不能是文本。', block); return '0'; }
      return top(e);
    }

    /* ---- 函数调用（语句和表达式两种积木都走这里） ---- */
    function callExpr(block, ctx) {
      const fname = block.getFieldValue('NAME');
      const d = funcs.get(fname);
      const wantValue = !!block.outputConnection;
      if (!fname || fname === '__none__' || !d) {
        err('调用积木还没选函数，或者那个函数已经被删掉了。'
          + (wantValue ? '（有返回值的函数要用「函数 … 的返回值」这块积木调用）'
            : '（无返回值 void 的函数才用「执行函数」这块积木）'), block);
        return { code: '0', type: 'int', prec: P_ATOM };
      }
      const args = [];
      for (let i = 0; i < Math.max(d.params.length, 16); i++) {
        const b = block.getInputTargetBlock('ARG' + i);
        if (b) args.push({ e: E(b, ctx), block: b });
      }
      if (args.length !== d.params.length) {
        err('函数 ' + fname + ' 有 ' + d.params.length + ' 个形参，调用处只给了 ' + args.length
          + ' 个实参' + (args.length > d.params.length ? '（多出来的槽请点 − 删掉）' : '') + '。', block);
      }
      const parts = [];
      for (let i = 0; i < Math.max(args.length, d.params.length); i++) {
        const p = d.params[i];
        const a = args[i];
        if (!a) { parts.push('0'); continue; }
        if (isStr(p.type)) {
          /* C++：文本字面量和 std::string 都能隐式转换成形参的 std::string，直接传名字即可；
             C 的文本参数已经在函数定义处报过错了，这里不再重复一次。 */
          if (!isStr(a.e.type)) {
            err('形参 ' + p.name + ' 是文本，实参 ' + (i + 1) + ' 却是 ' + tName(a.e.type) + '。', a.block);
          }
        } else if (isStr(a.e.type)) {
          err('实参 ' + (i + 1) + ' 是文本，但形参 ' + p.name + ' 是 ' + tName(p.type)
            + '（文本塞不进数值格子）。', a.block);
        } else if (p.type === 'int' && a.e.type === 'double') {
          warn('传给 ' + fname + ' 的第 ' + (i + 1) + ' 个参数是小数，形参是 int，会截掉小数部分。', a.block);
        }
        parts.push(top(a.e));
      }
      if (wantValue && d.ret === 'void') {
        err('函数 ' + fname + ' 是 void，没有返回值可用；请改用「执行函数」积木。', block);
      }
      return { code: fname + '(' + parts.join(', ') + ')', type: d.ret === 'void' ? 'int' : d.ret, prec: P_ATOM };
    }

    /**
     * scanf 槽位：只接受变量 / 数组元素，返回写好的地址表达式。
     * C 的文本变量是个 char 数组，数组名本身就是首元素地址，不能再加 &；
     * 顺带把这块缓冲区能装多少个字符（cap）交出去，%s 才有宽度可写。
     */
    function addrOf(block, ctx) {
      if (!block) return null;
      const k = block.cKind;
      if (k === 'var_get') {
        const name = block.getFieldValue('VAR');
        if (!name || name === '__none__') { err('scanf 要写进的那块「变量」积木还没选变量。', block); return null; }
        const v = lookup(ctx, name);
        if (!v) { err('scanf 要写进变量「' + name + '」，但它在这里不可见。', block); return null; }
        if (v.kind === 'array') { err('%s 之类需要字符数组的名字，本版积木暂不支持把整个数组传进 scanf。', block); return null; }
        if (v.type === 'cstr') return { code: name, type: 'cstr', cap: CSTR_MAX, block: block };
        if (v.type === 'stdstr') return { code: name, type: 'stdstr', block: block };
        return { code: '&' + name, type: v.type, block: block };
      }
      if (k === 'arr_get') {
        const name = block.getFieldValue('ARR');
        if (!name || name === '__none__') { err('scanf 要写进的那块数组积木还没选数组。', block); return null; }
        const v = lookup(ctx, name);
        if (!v || v.kind !== 'array') { err('数组「' + name + '」在这里不可见。', block); return null; }
        const idx = I(block.getInputTargetBlock('IDX'), ctx, name);
        return { code: '&' + name + '[' + idx + ']', type: v.type, block: block };
      }
      err('scanf 的槽位只吃「变量」或「数组的第 i 项」积木：它要的是能存放数据的地址，'
        + '算出来的数值（比如 3 + 4）没法往里写。', block);
      return null;
    }

    /* ================================================================== */
    /* 语句                                                              */
    /* ================================================================== */
    function line(ctx, text, block) {
      let s = IND.repeat(ctx.ind) + text;
      if (annotate && block) {
        const note = blockLabel(block);
        const pad = Math.max(1, 46 - s.length);
        s += (s.length < 46 ? ' '.repeat(pad) : ' ') + '// ' + note;
      }
      ctx.lines.push(s);
    }

    function emitChain(ctx, head) {
      let b = head;
      let guard = 0;
      const seen = new Set();
      while (b && guard++ < 20000) {
        /* 正常积木链不会有环；出现了就是结构被改坏了（存档或脚本连线）。
           再走一遍会把同一条语句重复输出上万次，直接把页面卡死，所以就地停下报错。 */
        if (seen.has(b)) { warn('积木链成了环：「' + blockLabel(b) + '」后面又接回了它自己，这条链到此为止。', b); return; }
        seen.add(b);
        emitStmt(ctx, b);
        b = b.getNextBlock();
      }
    }

    /** 半行（if / for / while 的头部），主体由 emitChainWithBrace 续写 */
    function startLine(ctx, text) {
      ctx.lines.push(IND.repeat(ctx.ind) + text);
    }

    function emitStmt(ctx, block) {
      ctx.current = block;
      const k = block.cKind;

      switch (k) {
        case 'main':
        case 'func_def':
          err('「' + blockLabel(block) + '」要放在主工作区的空白处，不能塞进别的积木里面。', block);
          return;

        case 'var_decl': {
          const name = checkName(block.getFieldValue('NAME'), '变量', block);
          const type = tagOf(String(block.getFieldValue('TYPE') || 'int'));
          if (type === 'bool') used.stdbool = true;
          if (type === 'stdstr') used.string = true;
          const initB = block.getInputTargetBlock('INIT');
          let rhs = '';
          let copyFrom = null;      /* C 模式：用另一块文本初始化，只能先声明再 strcpy */
          if (initB) {
            const e = E(initB, ctx);
            if (isStr(e.type) !== isStr(type)) {
              if (isStr(type)) {
                err('文本变量「' + name + '」的初始值得是一段文本，现在是 ' + tName(e.type)
                  + '。' + (type === 'cstr' ? '单个字符请写进 char 变量。' : ''), initB);
              } else {
                err('变量「' + name + '」是 ' + tName(type) + '，不能直接存放整块文本。'
                  + (type === 'char' ? '单个字符请用「字符」积木，整段文本请把类型换成「文本」。'
                    : '要存整段文本请把类型换成「文本」。'), initB);
              }
            } else if (isStr(type)) {
              if (type === 'cstr' && e.type === 'cstr') {
                copyFrom = top(e);          /* char a[256] = b; 在 C 里不合法，得 strcpy */
              } else {
                if (type === 'cstr' && e.type === 'string' && e.bytes > CSTR_MAX) {
                  err('「' + name + '」是 ' + CSTR_CAP + ' 字节的缓冲区，这段文本要占 ' + e.bytes
                    + ' 字节（再加结尾的 \\0），放不进去。', initB);
                }
                rhs = ' = ' + top(e);
              }
            } else {
              /* 数值类型：先按类型收窄诊断，再把初始值照常写出去 */
              if (type === 'int' && e.type === 'double') {
                warn('用小数初始化 int 变量会截断小数部分；要保留小数请把类型改成 double。', block);
              } else if (type === 'double' && (e.type === 'int' || e.type === 'char' || e.type === 'bool')) {
                /* 隐式提升，安全 */
              } else if (type === 'char' && e.type !== 'char') {
                warn('把 ' + e.type + ' 存进 char 只留低 8 位，中文/大数会变样。', block);
              } else if (type === 'bool' && e.type !== 'bool' && e.type !== 'int') {
                warn('bool 变量按 0 / 非 0 规则赋值。', block);
              }
              rhs = ' = ' + top(e);
            }
          }
          declare(ctx, name, type, 'var', block);
          if (type === 'stdstr') {
            line(ctx, 'std::string ' + name + rhs + ';', block);
          } else if (type === 'cstr') {
            line(ctx, 'char ' + name + '[' + CSTR_CAP + ']' + rhs + ';', block);
            if (copyFrom !== null) {
              used.cstring = true;
              line(ctx, 'strcpy(' + name + ', ' + copyFrom + ');', block);
            }
            info('「' + name + '」是 ' + CSTR_CAP + ' 字节的字符数组，最多存 ' + CSTR_MAX
              + ' 个字符，最后一格留给结束符 \\0；一个汉字占 3 字节，装不了多少。', block);
          } else {
            line(ctx, type + ' ' + name + rhs + ';', block);
          }
          return;
        }

        case 'arr_decl': {
          const name = checkName(block.getFieldValue('NAME'), '数组', block);
          const type = block.getFieldValue('TYPE');
          if (type === 'bool') used.stdbool = true;
          const len = String(block.getFieldValue('LEN') || '10');
          if (!/^\d+$/.test(len) || parseInt(len, 10) < 1) {
            err('数组长度要是 1 以上的整数常量，现在是「' + len + '」。', block);
          }
          declare(ctx, name, type, 'array', block);
          line(ctx, type + ' ' + name + '[' + len + '];', block);
          info('数组「' + name + '」有 ' + len + ' 个格子，下标从 0 到 ' + (parseInt(len, 10) - 1) + '；越界 C 不会拦你。', block);
          return;
        }

        case 'var_set': {
          const name = block.getFieldValue('VAR');
          if (!name || name === '__none__') { err('这块「赋值」积木还没选要写哪个变量。', block); return; }
          const v = lookup(ctx, name);
          const e = sub(block.getInputTargetBlock('VALUE'), ctx, block);
          let stmt = name + ' = ' + (e ? top(e) : '0') + ';';
          if (!v) {
            err('赋值目标「' + name + '」在这里不可见，先用「声明变量」积木建它。', block);
          } else if (v.kind === 'array') {
            err('「' + name + '」是数组，要写「把 a 的第 i 项设为 …」。', block);
          } else if (e) {
            if (isStr(e.type) && !isStr(v.type)) {
              err('不能把整块文本赋给 ' + tName(v.type) + ' 变量「' + name + '」。'
                + (v.type === 'char' ? '单个字符请用「字符」积木。' : ''), block);
            } else if (v.type === 'cstr') {
              /* C 的文本变量是一块数组，赋值只能是「整块拷进去」：s = "x" 在 C 里编不过 */
              if (!isStr(e.type)) {
                err('「' + name + '」是文本（char 数组），只能整块写入文本，现在右边是 ' + tName(e.type) + '。', block);
              } else {
                if (e.type === 'string' && e.bytes > CSTR_MAX) {
                  err('「' + name + '」只有 ' + CSTR_CAP + ' 字节，这段文本要占 ' + e.bytes
                    + ' 字节（再加 \\0），strcpy 会写越界。', block);
                }
                used.cstring = true;
                stmt = 'strcpy(' + name + ', ' + top(e) + ');';
              }
            } else if (v.type === 'stdstr') {
              if (e.type === 'char') {
                info('把单个字符赋给文本变量「' + name + '」，得到的是一段只有 1 个字符的文本。', block);
              } else if (!isStr(e.type)) {
                err('不能把 ' + tName(e.type) + ' 赋给文本变量「' + name + '」。', block);
              }
            } else if (v.type === 'int' && e.type === 'double') {
              warn('右边是小数，左边是 int：赋值会截断小数部分（3.9 存进去变 3）。', block);
            } else if (v.type === 'char' && e.type !== 'char') {
              warn('把 ' + e.type + ' 存进 char 只留低 8 位。', block);
            } else if (v.type === 'double' && e.type === 'int') {
              /* 隐式提升 */
            }
          }
          line(ctx, stmt, block);
          return;
        }

        case 'arr_set': {
          const name = block.getFieldValue('ARR');
          if (!name || name === '__none__') { err('这块数组赋值积木还没选要写哪个数组。', block); return; }
          const v = lookup(ctx, name);
          if (!v || v.kind !== 'array') {
            err('数组「' + name + '」在这里不可见，先用「声明数组」积木建它。', block);
          }
          const idx = I(block.getInputTargetBlock('IDX'), ctx, name);
          const e = sub(block.getInputTargetBlock('VALUE'), ctx, block);
          if (v && e) {
            if (isStr(e.type)) err('数组「' + name + '」是 ' + tName(v.type) + ' 类型，存不了整块文本。', block);
            else if (v.type === 'int' && e.type === 'double') warn('小数写进 int 数组会截断。', block);
          }
          line(ctx, name + '[' + idx + '] = ' + (e ? top(e) : '0') + ';', block);
          return;
        }

        case 'print': {
          const b = block.getInputTargetBlock('MSG');
          if (!b) { err('「输出」积木里没放东西。', block); return; }
          const e = E(b, ctx);
          const nl = block.getFieldValue('NL') !== 'FALSE';
          let stmt;
          if (cpp) {
            /* C++：一律 std::cout << …，换行开关走 std::endl（顺带 flush，读入前不用再补） */
            used.iostream = true;
            stmt = 'std::cout << ' + streamExpr(e) + (nl ? ' << std::endl;' : ';');
          } else if (b.cKind === 'text' && e.type === 'string') {
            /* 文本积木直接当格式串：省掉 %s，生成的代码更好读；% 已经转义成 %% */
            const body = e.code.slice(1, -1);
            stmt = 'printf("' + body + (nl ? '\\n' : '') + '");';
          } else if (isStr(e.type)) {
            stmt = 'printf("' + (nl ? '%s\\n' : '%s') + '", ' + top(e) + ');';
          } else {
            if (e.type === 'bool') used.stdbool = true;
            stmt = 'printf("' + (PF[e.type] || '%d') + (nl ? '\\n' : '') + '", ' + top(e) + ');';
          }
          line(ctx, stmt, block);
          return;
        }

        case 'printf': {
          const raw = String(block.getFieldValue('FMT') || '');
          const fmt = unescapeUser(raw);
          const args = [];
          for (let i = 0; i < 16; i++) {
            const inp = block.getInput('ARG' + i);
            if (!inp) break;
            const b = block.getInputTargetBlock('ARG' + i);
            if (b) args.push({ e: E(b, ctx), block: b, slot: i });
            else args.push({ missing: true, slot: i });
          }
          const filled = args.filter((a) => !a.missing);
          const { specs, stray: strayPct } = scanFormat(fmt);
          if (strayPct) {
            warn('格式串里有一个孤立的 %。要输出百分号请写成 %%。', block);
          }
          if (filled.length !== args.length) {
            const holes = args.filter((a) => a.missing).map((a) => a.slot + 1).join('、');
            err('printf 的第 ' + holes + ' 个参数槽是空的。', block);
          }
          if (specs.length !== filled.length) {
            err('格式串里 ' + specs.length + ' 个格式说明符对上 ' + filled.length + ' 个实参：'
              + (specs.length > filled.length ? '少给了实参，printf 会读到栈上的垃圾值。'
                : '实参多了，多出来的不会被打印出来。')
              + '（现在是 "' + fmt.replace(/"/g, '\\"') + '"）', block);
          }
          for (let i = 0; i < Math.min(specs.length, filled.length); i++) {
            const sp = specs[i];
            const a = filled[i];
            const want = SPEC_GROUP[sp.conv];
            const got = a.e.type;
            if (got === 'bool') used.stdbool = true;
            if (want === 'any') {
              /* %p 之类也要的是指针：std::string 对象本身不能进变参，给个 .c_str() 至少是合法指针 */
              if (got === 'stdstr') { a.cstr = true; info('这里补了 .c_str()：std::string 不能直接交给 printf，只有它的内部字符指针可以。', block); }
              continue;
            }
            if (want === 'string') {
              if (!isStr(got)) err('%s 要的是字符串，第 ' + (i + 1) + ' 个参数是 ' + tName(got) + '。', a.block);
              else if (got === 'stdstr') {
                /* 这就是「printf("%s", s) 编译不过」的根因：可变参数拿不到类型信息，
                   传 std::string 过去是把对象整个塞进栈里，clang 直接拒绝。
                   .c_str() 交出的是真正的 const char*，printf 认得。 */
                a.cstr = true;
              }
            } else if (want === 'double') {
              if (got !== 'double') err('%' + sp.conv + ' 要 double，第 ' + (i + 1) + ' 个参数是 ' + tName(got)
                + '。整数请改用 %d，或先用「转成小数」积木。', a.block);
            } else if (want === 'char') {
              if (got === 'double') err('%c 要字符/整数，第 ' + (i + 1) + ' 个参数是小数。', a.block);
              else if (isStr(got)) err('%c 打印的是单个字符，第 ' + (i + 1) + ' 个参数是一整块文本；整块文本请用 %s。', a.block);
            } else if (want === 'int') {
              if (got === 'double') err('%' + sp.conv + ' 要整数，第 ' + (i + 1) + ' 个参数是 double（会打印出错乱的值）。', a.block);
              if (isStr(got)) err('%' + sp.conv + ' 要整数，第 ' + (i + 1) + ' 个参数是文本。', a.block);
            }
            if (sp.mod.indexOf('l') >= 0 && want === 'int') {
              info('格式里带了 l 长度修饰符，对应 long；本版积木的类型是 int，可以去掉 l。', block);
            }
          }
          const lit = '"' + escapeC(fmt, true) + '"';
          used.cstdio = true;      /* printf/scanf 积木在 C++ 模式下也照原样出 printf */
          const argText = (a) => (a.cstr ? memberExpr(a.e, '.c_str()') : top(a.e));
          line(ctx, 'printf(' + lit + (filled.length ? ', ' + filled.map(argText).join(', ') : '') + ');', block);
          return;
        }

        case 'scanf': {
          const raw = String(block.getFieldValue('FMT') || '');
          const fmt = unescapeUser(raw);
          const targets = [];
          for (let i = 0; i < 16; i++) {
            const inp = block.getInput('ARG' + i);
            if (!inp) break;
            const b = block.getInputTargetBlock('ARG' + i);
            if (!b) { targets.push({ missing: true, slot: i }); continue; }
            const a = addrOf(b, ctx);
            targets.push(a || { bad: true, block: b });
          }
          const good = targets.filter((t) => t.code);
          const { specs, stray: strayPct } = scanFormat(fmt);
          if (strayPct) warn('格式串里有一个孤立的 %。要匹配百分号请写成 %%。', block);
          if (good.length !== targets.filter((t) => !t.bad).length) {
            err('scanf 有 ' + targets.filter((t) => t.bad || t.missing).length + ' 个槽位没放对（要么空着，要么放了表达式）。', block);
          }
          if (specs.length !== good.length) {
            err('格式串里 ' + specs.length + ' 个转换说明符对上 ' + good.length + ' 个写入目标；'
              + 'scanf 会按格式串逐个往这些地址里写，数量对不上就是写越界或读到垃圾。', block);
          }
          const edits = {};      /* 需要改写格式说明符的位置：%s → %255s */
          for (let i = 0; i < Math.min(specs.length, good.length); i++) {
            const sp = specs[i];
            const t = good[i];
            const want = SPEC_GROUP[sp.conv];
            if (want === 'string') {
              if (t.type === 'cstr') {
                /* C 的文本变量就是那块缓冲区：数组名本身就是地址，宽度上限替学生补上 */
                const w = widthSpec(sp, t.cap || CSTR_MAX);
                if (w.tooBig) {
                  err('%s 里的宽度 ' + sp.width + ' 比 ' + CSTR_CAP + ' 字节的缓冲区还大，'
                    + '最多只能写 %' + CSTR_MAX + 's。', block);
                } else if (!sp.width) {
                  info('%s 已自动写成 ' + w.text + '：不给宽度上限的话，输入只要比缓冲区长就会写越界。', block);
                }
                edits[i] = w.text;
              } else if (t.type === 'stdstr') {
                const nm = t.block ? String(t.block.getFieldValue('VAR') || '') : '';
                err('%s 不能往文本变量' + (nm ? '「' + nm + '」' : '') + '里写：scanf 要的是 char*，'
                  + '而 std::string 这一刻还没分配内存，写进去就是往空指针里倒字符。'
                  + '读文本请改用「读入到变量」积木' + (nm ? '（它会出 std::cin >> ' + nm + ';）' : '') + '。', block);
              } else {
                err('%s 要的是字符数组名（一整块缓冲区），第 ' + (i + 1) + ' 个槽放的是 ' + tName(t.type)
                  + '；先用「声明变量」建一个类型为「文本」的变量，再把它放进这个槽。', block);
              }
              continue;
            }
            if (isStr(t.type)) {
              err('第 ' + (i + 1) + ' 个目标是文本，不能用 ' + sp.text + ' 读入'
                + (t.type === 'cstr' ? '；文本请用 %s（会自动带上缓冲区上限），或改用「读入到变量」积木。'
                                     : '；请改用「读入到变量」积木。'), block);
            }
            if (want === 'double' && sp.mod.indexOf('l') < 0) {
              err('scanf 读小数必须写 %lf：'
                + '%f 是给 float 用的，往 double 的格子里按 float 写会破坏内存。', block);
            }
            if (want === 'int' && sp.mod.indexOf('l') >= 0) {
              info('格式里的 l 是给 long 用的；这里的变量是 int，去掉 l 更稳。', block);
            }
            if (t.type === 'double' && sp.conv !== 'f' && sp.conv !== 'e' && sp.conv !== 'g') {
              warn('第 ' + (i + 1) + ' 个目标是 double，但格式是 ' + sp.text + '；double 用 %lf。', block);
            }
            if (t.type === 'int' && (sp.conv === 'f' || sp.conv === 'g' || sp.conv === 'e')) {
              err('第 ' + (i + 1) + ' 个目标是 int，不能用 ' + sp.text + ' 读入（会按浮点写进整数格子）。', block);
            }
            if (sp.conv === 'c') {
              const prev = fmt[sp.at - 1];
              if (prev !== ' ' && prev !== '\t' && prev !== '\n') {
                info('%c 前面留一个空格（" %c"）才会跳过上一行剩下的换行符，否则会直接读到 \\n。', block);
              }
            }
          }
          const lit = '"' + escapeC(Object.keys(edits).length ? patchFormat(fmt, specs, edits) : fmt, true) + '"';
          used.cstdio = true;
          line(ctx, 'scanf(' + lit + (good.length ? ', ' + good.map((a) => a.code).join(', ') : '') + ');', block);
          return;
        }

        case 'read': {
          const name = block.getFieldValue('VAR');
          if (!name || name === '__none__') { err('这块「读入到变量」积木还没选变量。', block); return; }
          const v = lookup(ctx, name);
          if (!v) { err('读入目标「' + name + '」在这里不可见，先声明它。', block); return; }
          if (v.kind === 'array') { err('「' + name + '」是数组，请用「读入到数组的第 i 项」。', block); return; }
          if (v.type === 'bool') {
            err(cpp ? 'bool 变量不适合直接读入：cin 会把 0/非 0 当 false/true，请先读进 int 变量再赋值。'
                    : 'bool 没有合适的读入格式；请先读进一个 int 变量。', block);
            return;
          }
          emitFlushBeforeRead(ctx, block);
          if (cpp) {
            /* C++：cin 自己会跳过空白，不需要 " %c" 那种前导空格，也没有 %lf 的坑 */
            used.iostream = true;
            line(ctx, 'std::cin >> ' + name + ';', block);
            if (v.type === 'stdstr') {
              info('cin >> 读文本是「读到一个词」：遇到空格、Tab 或换行就停，一行里的后半截留给下一次读入。', block);
            }
            return;
          }
          if (v.type === 'cstr') {
            /* 数组名不加 &（加了变成 &s，类型是 char (*)[256]，%s 不认），宽度必须给 */
            line(ctx, 'scanf("%' + CSTR_MAX + 's", ' + name + ');', block);
            info('%255s 的那个 255 是上限：输入比这更长会被截断，换来的是不会写穿 '
              + CSTR_CAP + ' 字节的缓冲区。另外 scanf 读文本遇到空格就停。', block);
            return;
          }
          const spec = SF[v.type];
          line(ctx, 'scanf("' + spec + '", &' + name + ');', block);
          if (v.type === 'char') {
            info('这里 " %c" 前面那个空格是必需的：它会吃掉上一行残留的换行符。', block);
          }
          return;
        }

        case 'read_arr': {
          const name = block.getFieldValue('ARR');
          if (!name || name === '__none__') { err('这块「读入到数组」积木还没选数组。', block); return; }
          const v = lookup(ctx, name);
          if (!v || v.kind !== 'array') { err('数组「' + name + '」在这里不可见。', block); return; }
          if (v.type === 'bool') {
            err(cpp ? 'bool 数组不适合直接读入，请改用 int 数组。' : 'bool 数组没有合适的读入格式。', block);
            return;
          }
          const idx = I(block.getInputTargetBlock('IDX'), ctx, name);
          emitFlushBeforeRead(ctx, block);
          if (cpp) {
            used.iostream = true;
            line(ctx, 'std::cin >> ' + name + '[' + idx + '];', block);
            return;
          }
          const spec = SF[v.type];
          line(ctx, 'scanf("' + spec + '", &' + name + '[' + idx + ']);', block);
          return;
        }

        case 'if': {
          const cond = sub(block.getInputTargetBlock('COND'), ctx, block);
          if (cond && isStr(cond.type)) err('「如果」的条件不能是文本，请放比较积木。', block);
          if (cond && cond.type === 'double') {
            info('条件是 double：非 0 即为真，但小数判真通常该写成比较（例如 x > 0.5）。', block);
          }
          startLine(ctx, 'if (' + (cond ? top(cond) : '0') + ')');
          emitChainWithBrace(ctx, block, 'DO');
          if (block.getInput('ELSE')) {
            ctx.lines[ctx.lines.length - 1] += ' else';
            emitChainWithBrace(ctx, block, 'ELSE');
          }
          return;
        }

        case 'repeat': {
          const n = sub(block.getInputTargetBlock('TIMES'), ctx, block);
          const iv = fresh('c_i');
          if (n && n.type === 'double') {
            info('重复次数是小数，循环变量会提升成 double 再比较；要整数次数请先转成 int。', block);
          }
          pushScope(ctx);
          declare(ctx, iv, 'int', 'var', block);
          startLine(ctx, 'for (int ' + iv + ' = 0; ' + iv + ' < ' + (n ? wrap(n, P_CMP) : '0') + '; ' + iv + ' += 1)');
          emitChainWithBrace(ctx, block, 'DO');
          popScope(ctx);
          return;
        }

        case 'for': {
          const name = checkName(block.getFieldValue('NAME'), '循环变量', block);
          const from = sub(block.getInputTargetBlock('FROM'), ctx, block);
          const to = sub(block.getInputTargetBlock('TO'), ctx, block);
          const step = sub(block.getInputTargetBlock('STEP'), ctx, block);
          let down = false;
          if (step) {
            const sv = parseFloat(step.code);
            if (!isNaN(sv)) down = sv < 0;
            else if (isStr(step.type)) err('循环步长不能是文本。', block);
          }
          for (const [e, w] of [[from, '起点'], [to, '终点'], [step, '步长']]) {
            if (e && e.type === 'double') info('循环变量的' + w + '是小数，已按 (int) 截断（C 的 for 计数通常是整数）。', block);
          }
          const cast = (e, dflt) => {
            if (!e) return dflt;
            const s = top(e);
            return e.type === 'double' ? '(int)(' + s + ')' : s;
          };
          pushScope(ctx);
          declare(ctx, name, 'int', 'var', block);
          startLine(ctx, 'for (int ' + name + ' = ' + cast(from, '0') + '; ' + name
            + (down ? ' >= ' : ' <= ') + cast(to, '0') + '; ' + name + ' += ' + cast(step, '1') + ')');
          emitChainWithBrace(ctx, block, 'DO');
          popScope(ctx);
          return;
        }

        case 'while': {
          const cond = sub(block.getInputTargetBlock('COND'), ctx, block);
          ctx.loops++;
          startLine(ctx, 'while (' + (cond ? top(cond) : '0') + ')');
          pushScope(ctx);
          emitChainWithBrace(ctx, block, 'DO');
          popScope(ctx);
          ctx.loops--;
          return;
        }

        case 'until': {
          const cond = sub(block.getInputTargetBlock('COND'), ctx, block);
          ctx.loops++;
          ctx.lines.push(IND.repeat(ctx.ind) + 'do {');
          pushScope(ctx);
          const head = block.getInputTargetBlock('DO');
          if (!head) info('「重复执行直到」的执行槽是空的。', block);
          ctx.ind++;
          emitChain(ctx, head);
          ctx.ind--;
          popScope(ctx);
          ctx.lines.push(IND.repeat(ctx.ind) + '} while (!(' + (cond ? top(cond) : '0') + '));');
          ctx.loops--;
          return;
        }

        case 'break':
          if (!ctx.loops) err('「跳出循环」只能放在循环积木里面。', block);
          line(ctx, 'break;', block);
          return;

        case 'continue':
          if (!ctx.loops) err('「跳过本轮」只能放在循环积木里面。', block);
          line(ctx, 'continue;', block);
          return;

        case 'call': {
          if (block.outputConnection) {
            err('这块「函数 … 的返回值」是表达式，得塞进某个数值槽；想当语句执行请改用「执行函数」。', block);
            return;
          }
          const r = callExpr(block, ctx);
          const d = funcs.get(block.getFieldValue('NAME'));
          if (d && d.ret !== 'void') {
            info('调用 ' + d.name + ' 后有返回值没用（C 允许丢弃返回值，但请确认这是你想要的）。', block);
          }
          line(ctx, r.code + ';', block);
          return;
        }

        case 'return': {
          const b = block.getInputTargetBlock('VALUE');
          const ret = ctx.func ? ctx.func.ret : 'void';
          if (ctx.isMain) {
            if (!b) { line(ctx, 'return 0;', block); return; }
            const e = E(b, ctx);
            if (e.type !== 'int') warn('主程序返回的应该是整数退出码（0 表示成功），现在是 ' + tName(e.type) + '。', block);
            line(ctx, 'return ' + top(e) + ';', block);
            return;
          }
          if (!b) {
            if (ret !== 'void') err('函数 ' + ctx.func.name + ' 声明返回 ' + ret + '，「返回」积木必须带一个值。', block);
            line(ctx, 'return;', block);
            return;
          }
          const e = E(b, ctx);
          if (ret === 'void') {
            err('函数 ' + ctx.func.name + ' 是 void，不能返回值；把「返回」积木里的值拿掉，或把函数改成有返回值。', block);
            line(ctx, 'return;', block);
            return;
          }
          if (isStr(e.type) && !isStr(ret)) err('函数 ' + ctx.func.name + ' 返回 ' + tName(ret) + '，不能返回文本。', block);
          else if (isStr(ret) && !isStr(e.type)) err('函数 ' + ctx.func.name + ' 返回文本，「返回」积木里得放一段文本，现在是 '
            + tName(e.type) + '。', block);
          else if (ret === 'int' && e.type === 'double') warn('返回小数但函数声明成 int，小数部分会被截断。', block);
          else if (ret === 'double' && e.type === 'int') { /* 隐式提升 */ }
          else if (ret === 'char' && e.type !== 'char') warn('返回 ' + e.type + ' 给 char 函数只保留低 8 位。', block);
          line(ctx, 'return ' + top(e) + ';', block);
          return;
        }

        default:
          err('不认识的积木：' + (k || block.type) + '，已跳过。', block);
      }
    }

    /** 循环体 / 分支体：接在上一行（for、if、else 的半行）后面，展开成 { … }，自带一层块作用域 */
    function emitChainWithBrace(ctx, block, inputName, emptyNote) {
      pushScope(ctx);
      const head = block.getInputTargetBlock(inputName);
      if (!head) info(emptyNote || ('「' + blockLabel(block) + '」的执行槽是空的，生成了一对空花括号。'), block);
      ctx.lines[ctx.lines.length - 1] += ' {';
      ctx.ind++;
      emitChain(ctx, head);
      ctx.ind--;
      ctx.lines.push(IND.repeat(ctx.ind) + '}');
      popScope(ctx);
    }

    /** 读入前把提示冲出去：stdout 有缓冲，否则「请输入」会滞留在缓冲区里看不见 */
    function emitFlushBeforeRead(ctx, block) {
      const prev = block.getPreviousBlock();
      if (!prev) return;
      const FLUSH = 'fflush(stdout);  /* 先把提示送出去，再等输入 */';
      if (prev.cKind === 'printf') {
        used.cstdio = true;
        ctx.lines.push(IND.repeat(ctx.ind) + FLUSH);
      } else if (prev.cKind === 'print') {
        if (!cpp) { ctx.lines.push(IND.repeat(ctx.ind) + FLUSH); return; }
        /* cout << … << std::endl 本身就 flush；只有没勾「换行」时才要补一句 */
        if (prev.getFieldValue('NL') === 'FALSE') {
          used.iostream = true;
          ctx.lines.push(IND.repeat(ctx.ind) + 'std::cout << std::flush;  /* 先把提示送出去，再等输入 */');
        }
      }
    }

    /* ================================================================== */
    /* 函数与主程序                                                       */
    /* ================================================================== */
    /* C 用 (void) 表示「没有参数」，C++ 直接空括号（(void) 也合法，但没人这么写） */
    const paramsOf = (d) => d.params.length
      ? d.params.map(paramDecl).join(', ')
      : (cpp ? '' : 'void');
    const retOf = (d) => (d.ret === 'void' ? 'void' : spellOf(d.ret));

    const funcBodies = [];
    for (const d of funcOrder) {
      const ctx = newCtx(d);
      ctx.isMain = false;
      pushScope(ctx);
      for (const p of d.params) {
        if (p.type === 'bool') used.stdbool = true;
        if (p.type === 'stdstr') used.string = true;
        declare(ctx, p.name, p.type, 'var', d.block);
      }
      if (d.ret === 'stdstr') used.string = true;
      ctx.lines.push(retOf(d) + ' ' + d.name + '(' + paramsOf(d) + ') {');
      ctx.ind++;
      const head = d.block.getInputTargetBlock('BODY');
      if (!head) info('函数 ' + d.name + ' 的函数体是空的。', d.block);
      emitChain(ctx, head);
      ctx.ind--;
      /* 往回找最后一条真语句：if/else 的两个分支都 return 时，末尾是「}」而不是「return」，
         只看最后一行会误报。 */
      const last = [...ctx.lines].reverse()
        .find((l) => l.trim() && !/^[{}][^A-Za-z]*$/.test(l.trim()) && !/^\s*(\/\*|\*|\/\/)/.test(l.trim()));
      if (d.ret !== 'void' && !/^\s*return\b/.test(last || '')) {
        warn('函数 ' + d.name + ' 声明返回 ' + tName(d.ret) + '，但最后一条语句不是「返回」；'
          + '走到函数末尾还不 return，调用处拿到的值是未定义的。', d.block);
      }
      ctx.lines.push('}');
      popScope(ctx);
      funcBodies.push(ctx.lines);
    }

    const mainCtx = newCtx({ ret: 'int', name: 'main' });
    mainCtx.isMain = true;
    pushScope(mainCtx);
    mainCtx.lines.push(cpp ? 'int main() {' : 'int main(void) {');
    mainCtx.ind++;
    if (mainHead) emitChain(mainCtx, mainHead);
    for (const st of stray) emitChain(mainCtx, st);
    if (!mainHead && !stray.length) {
      mainCtx.lines.push(IND.repeat(mainCtx.ind) + '/* 工作区还是空的：从左边「输入输出」里拖一块积木过来 */');
    }
    const lastMain = mainCtx.lines[mainCtx.lines.length - 1];
    if (!/return\b/.test(lastMain || '')) {
      mainCtx.lines.push(IND.repeat(mainCtx.ind) + 'return 0;' + (annotate ? '        // 0 表示程序正常结束' : ''));
    }
    mainCtx.ind--;
    mainCtx.lines.push('}');
    popScope(mainCtx);

    /* ================================================================== */
    /* 组装                                                              */
    /* ================================================================== */
    const counts = countBlocks(ws);
    const out = [];
    out.push('/*');
    out.push(' * 由积木可视化编程环境自动生成 —— ' + counts.total + ' 块积木 / '
      + counts.stmts + ' 条语句 / ' + funcOrder.length + ' 个自定义函数');
    out.push(' * 目标语言：' + (cpp ? 'C++（clang -x c++，在浏览器里编译成 wasm 后直接执行）'
      : 'C（clang -x c，在浏览器里编译成 wasm 后直接执行）'));
    out.push(' */');
    out.push('');
    if (cpp) {
      /* C++ 只带真用到的头：cin/cout 走 <iostream>，printf/scanf 积木仍走 <cstdio>，
         std::string 必须有 <string>（别指望 <iostream> 顺手带进来） */
      if (used.iostream) out.push('#include <iostream>');
      if (used.string) out.push('#include <string>       /* 积木里用了「文本」变量 */');
      if (used.cstdio) out.push('#include <cstdio>    /* 积木里用了 printf/scanf */');
    } else {
      out.push('#include <stdio.h>');
      if (used.stdbool) out.push('#include <stdbool.h>   /* 积木里用到 true / false / bool */');
      if (used.cstring) out.push('#include <string.h>    /* 文本变量之间赋值要用 strcpy */');
    }
    out.push('');

    if (funcOrder.length) {
      out.push('/* ---------- 函数原型：先声明，谁先谁后都能互相调用（递归也靠它） ---------- */');
      for (const d of funcOrder) {
        out.push(retOf(d) + ' ' + d.name + '(' + paramsOf(d) + ');');
      }
      out.push('');
      out.push('/* ---------- 函数定义 ---------- */');
      for (const lines of funcBodies) {
        out.push('');
        for (const l of lines) out.push(l);
      }
      out.push('');
    }

    out.push('/* ---------- 主程序 ---------- */');
    out.push('');
    for (const l of mainCtx.lines) out.push(l);
    out.push('');

    const hasError = diags.some((d) => d.sev === 'error');

    return {
      code: out.join('\n'),
      diagnostics: diags,
      hasError: hasError,
      stats: counts,
      stdbool: used.stdbool,
      lang: cpp ? 'cpp' : 'c',
    };
  }

  /* ================================================================== */
  /* 积木的人类可读标签（诊断和代码注释都靠它）                            */
  /* ================================================================== */
  function blockLabel(b) {
    if (!b) return '';
    const f = (n) => String(b.getFieldValue(n) || '');
    switch (b.cKind) {
      case 'main': return '主程序';
      case 'var_decl': return '声明 ' + f('NAME');
      case 'arr_decl': return '数组 ' + f('NAME');
      case 'var_set': return f('VAR') + ' 赋值';
      case 'var_get': return f('VAR');
      case 'arr_get': return f('ARR') + ' 的下标';
      case 'arr_set': return f('ARR') + ' 赋值';
      case 'print': return '输出';
      case 'read': return '读入 ' + f('VAR');
      case 'read_arr': return '读入 ' + f('ARR');
      case 'printf': return 'printf';
      case 'scanf': return 'scanf';
      case 'num': return f('NUM');
      case 'text': return '"' + f('TEXT') + '"';
      case 'char_lit': return "'" + f('CH') + "'";
      case 'bool_lit': return f('V');
      case 'arith': return f('OP');
      case 'compare': return f('OP');
      case 'logic': return f('OP') === '&&' ? '且' : '或';
      case 'not': return '非';
      case 'neg': return '负';
      case 'cast': return '转成' + f('TO');
      case 'if': return '如果';
      case 'repeat': return '重复执行';
      case 'while': return '当…循环';
      case 'until': return '重复直到';
      case 'for': return '循环 ' + f('NAME');
      case 'break': return 'break';
      case 'continue': return 'continue';
      case 'func_def': return '函数 ' + f('NAME');
      case 'call': return '调用 ' + f('NAME');
      case 'return': return '返回';
      default: return b.type;
    }
  }

  function countBlocks(ws) {
    let total = 0;
    let stmts = 0;
    for (const b of ws.getAllBlocks(false)) {
      total++;
      if (!b.outputConnection) stmts++;
    }
    return { total: total, stmts: stmts };
  }

  global.CGen = { generate: generate, blockLabel: blockLabel, scanFormat: scanFormat, unescapeUser: unescapeUser };
})(window);
