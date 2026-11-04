/*
 * c-blocks.js — 积木定义：把 C 的语法结构拆成可拖拽的拼图块
 *
 * 每块积木带两份信息：
 *   1. Blockly 的图形定义（输入槽 / 输出榫 / 颜色 / 悬停提示）；
 *   2. 一个语义标签 this.cKind，c-generator.js 按 kind 分派，不依赖积木类型名。
 *
 * 变量 / 数组 / 函数三类下拉是动态的：菜单打开那一刻重新扫描工作区，并且
 * 只列出当前这块积木"看得见"的名字（沿执行顺序走到自己这一路上出现过的
 * 声明、for 的循环变量、所在函数的形参），越界引用在源头上就少一半。
 */
'use strict';

(function (global) {
  const SCALAR_TYPES = [
    { id: 'int', label: '整数 int' },
    { id: 'double', label: '小数 double' },
    { id: 'char', label: '字符 char' },
    { id: 'bool', label: '布尔 bool' },
  ];

  const COL = {
    vari: '#FF8C1A',
    io: '#CF63CF',
    iofmt: '#0FBD8C',
    math: '#59C059',
    logic: '#4C97FF',
    ctrl: '#FFAB19',
    func: '#FF6680',
    entry: '#5CB1D6',
  };

  const EMPTY = '（先拖一个「声明变量」积木）';
  const EMPTY_ARR = '（先拖一个「声明数组」积木）';
  const EMPTY_FN_VOID = '（还没有 void 函数：先拖「函数」积木）';
  const EMPTY_FN_VAL = '（还没有带返回值的函数：先拖「函数」积木）';
  const EMPTY_READ = '（先声明一个 int/double/char 变量）';
  /* 工作区里有声明，但按 C 的作用域规则对这块积木不可见时，说清楚为什么 */
  const EMPTY_FLOATING = '（这块还没接进语句里：把它拖进积木的凹槽，才能看到声明）';
  const EMPTY_NOT_IN_PROGRAM = '（没接到「主程序」/「函数」里：声明放在外面时，要先拖进程序体、且放在这块之前）';
  const EMPTY_SCOPE = '（这一层里没有可见的声明：把「声明」拖进同一个程序体，并放在这块之前）';

  /* 可变参数积木用的 +/− 图标：直接内联 data-URI，省掉一条 media 路径依赖 */
  const svgIcon = (path) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20">' +
    '<rect x="1" y="1" width="18" height="18" rx="4" fill="#ffffff" stroke="#5b5b5b" stroke-width="1.5"/>' +
    path + '</svg>');
  const ICON_ADD = svgIcon('<path d="M10 5.5v9M5.5 10h9" stroke="#3f3f3f" stroke-width="2" stroke-linecap="round"/>');
  const ICON_SUB = svgIcon('<path d="M5.5 10h9" stroke="#3f3f3f" stroke-width="2" stroke-linecap="round"/>');

  /* ================================================================== */
  /* 遍历与作用域                                                        */
  /* ================================================================== */

  /** 语句链：从链头顺着 next 一路走到底 */
  function chainOf(head) {
    const list = [];
    let cur = head;
    let guard = 0;
    while (cur && guard++ < 2000) { list.push(cur); cur = cur.getNextBlock(); }
    return list;
  }

  /**
   * 往上走到链头。Blockly 自带的 getRootBlock() 没有防环，语句槽一旦被程序化连线
   * 接成 A→B→A（存档损坏或脚本直接调 connect 时可能造出来），它会永远转圈、把页面
   * 主线程钉死。这里用 visited 集合走，最坏也只是回到自己。
   */
  function rootOf(block) {
    let cur = block;
    const seen = new Set();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const p = parentOf(cur);
      if (!p) return cur;
      cur = p;
    }
    return cur || block;
  }

  /** 直接父块：值槽/语句槽把自己塞进了谁的洞里 */
  function parentOf(block) {
    const c = block.outputConnection || block.previousConnection;
    if (!c || !c.targetConnection) return null;
    const holder = c.targetConnection;
    const src = typeof holder.getSourceBlock === 'function'
      ? holder.getSourceBlock() : holder.sourceBlock_;
    return src && src !== block ? src : null;
  }

  function isIdent(name) {
    return typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
  }

  /** 某积木的子树里是否包含 target（含整条语句链） */
  function contains(head, target, seen) {
    const hit = seen || new Set();
    for (const b of chainOf(head)) {
      if (b === target) return true;
      if (hit.has(b)) continue;              /* 结构有环时不至于把栈撑爆 */
      hit.add(b);
      for (const inp of b.inputList) {
        const t = inp.connection && inp.connection.targetBlock();
        if (t && contains(t, target, hit)) return true;
      }
    }
    return false;
  }

  /** 函数形参：[{type:'int', name:'n'}, …] */
  function funcParams(block) {
    const n = parseInt(block.getFieldValue('NP') || '0', 10) || 0;
    const list = [];
    for (let i = 0; i < n; i++) {
      list.push({
        type: block.getFieldValue('P' + i + '_T') || 'int',
        name: block.getFieldValue('P' + i + '_N') || ('a' + (i + 1)),
      });
    }
    return list;
  }

  /** 工作区里所有函数定义：name -> {block, ret, params} */
  function funcDefs(ws) {
    const map = new Map();
    for (const b of ws.getAllBlocks(false)) {
      if (b.cKind !== 'func_def') continue;
      const name = b.getFieldValue('NAME');
      if (name) map.set(name, { block: b, name: name, ret: b.getFieldValue('RET'), params: funcParams(b) });
    }
    return map;
  }

  /**
   * 沿执行顺序收集 block 可见的名字。
   * want = {kind:'var'|'array', types:null|['int',…]}
   * 返回 [{name, type}]；只有真正在 target 之前执行、且包住 target 的容器里的
   * 声明才算数（子链里没找到 target 就回滚，避免把已结束作用域的名字带进来）。
   *
   * 输入槽的类型用「子块有没有 previousConnection」判断，不去依赖
   * Blockly.inputs.inputTypes 这个可能被压缩掉名字的枚举。
   */
  function visibleNames(block, want) {
    /* 字段构造期会先跑一次菜单生成器，那时 sourceBlock 还是 null；
       没有积木也没有工作区，就没有任何名字可见，返回空表即可。 */
    if (!block || !block.workspace) return [];
    const out = [];
    const seen = new Set();
    const visited = new Set();          /* 走过的积木，防止环导致反复下钻 */
    const push = (name, type) => {
      if (!name || name === '__none__' || seen.has(name)) return;
      if (want.types && want.types.indexOf(type) < 0) return;
      seen.add(name);
      out.push({ name: name, type: type });
    };
    const mark = () => out.length;
    const undo = (len) => { while (out.length > len) seen.delete(out.pop().name); };

    function recordSelf(b) {
      if (b.cKind === 'var_decl') push(b.getFieldValue('NAME'), b.getFieldValue('TYPE'));
      else if (b.cKind === 'arr_decl') { if (want.kind === 'array') push(b.getFieldValue('NAME'), 'array'); }
      else if (b.cKind === 'for') push(b.getFieldValue('NAME'), 'int');
      else if (b.cKind === 'func_def') {
        if (want.kind === 'var') for (const p of funcParams(b)) push(p.name, p.type);
      }
    }

    function walkChain(head) {           /* 返回是否在链中找到 target */
      for (const b of chainOf(head)) {
        if (b === block) return true;
        if (visited.has(b)) break;      /* 结构有环（存档损坏或脚本硬连线）时到此为止，
                                           否则这里会指数级地反复下钻，把主线程钉死 */
        visited.add(b);
        recordSelf(b);                  /* 本块声明的名字：往后都可见，不能回滚 */
        const before = mark();          /* 只回滚子链里那些没走到 target 的声明 */
        for (const inp of b.inputList) {
          const t = inp.connection && inp.connection.targetBlock();
          if (!t) continue;
          if (t.previousConnection) {                 /* 语句槽：往下钻 */
            if (walkChain(t)) return true;
          } else if (contains(t, block)) {            /* 值槽：里面不会再有声明 */
            return true;
          }
        }
        undo(before);
      }
      return false;
    }

    walkChain(rootOf(block));
    return want.kind === 'var'
      ? out.filter((o) => o.type !== 'array')
      : out.filter((o) => o.type === 'array');
  }

  /* ================================================================== */
  /* 字段工厂                                                            */
  /* ================================================================== */

  /**
   * 候选为空时显示什么。光写「先拖一个声明积木」会把人带偏：工作区里明明有声明，
   * 只是按 C 的作用域规则对它不可见。所以分情况说清楚下一步该做什么。
   * spec = { kind: 'var'|'array'|'funcVoid'|'funcVal', none: '一个都没有时的提示' }
   */
  function emptyHint(block, spec) {
    const kind = typeof spec === 'string' ? spec : spec.kind;
    const none = typeof spec === 'string' ? null : spec.none;
    const wantArray = kind === 'array';
    const wantFunc = kind === 'funcVoid' || kind === 'funcVal';
    const fallback = none
      || (wantArray ? EMPTY_ARR : (kind === 'funcVoid' ? EMPTY_FN_VOID : (kind === 'funcVal' ? EMPTY_FN_VAL : EMPTY)));
    const ws = block && block.workspace;
    if (!ws) return fallback;
    let total = 0;
    for (const b of ws.getAllBlocks(false)) {
      if (wantFunc) {
        const ret = b.cKind === 'func_def' ? b.getFieldValue('RET') : null;
        if (ret && (kind === 'funcVoid' ? ret === 'void' : ret !== 'void')) total++;
      } else if (wantArray) {
        if (b.cKind === 'arr_decl') total++;
      } else if (b.cKind === 'var_decl' || b.cKind === 'for') {
        total++;
      }
    }
    if (!total) return fallback;
    const root = rootOf(block);
    if (root === block) return EMPTY_FLOATING;
    for (const b of chainOf(root)) {
      if (b.cKind === 'main' || b.cKind === 'func_def') return EMPTY_SCOPE;
    }
    return EMPTY_NOT_IN_PROGRAM;
  }

  function dynField(listFn, spec, validator) {
    const field = new Blockly.FieldDropdown(function () {
      const items = listFn(this.getSourceBlock());
      if (!items.length) return [[emptyHint(this.getSourceBlock(), spec), '__none__']];
      return items.map((it) => [it.label, it.value]);
    }, validator);
    /* 标记给 syncDynamicFields 用：Blockly 会缓存下拉候选，积木刚从工具箱里拖出来
       时算的那一份是空的，不强制刷新就会一直显示「没有可选」。 */
    field.__dyn = { locked: false };
    return field;
  }

  /** 下拉候选里的第 0 项的值 */
  function optionValue(opt) {
    if (!opt) return undefined;
    if (Array.isArray(opt)) return opt[1];
    return opt.value;
  }
  function optionText(opt) {
    if (!opt) return '';
    if (Array.isArray(opt)) return opt[0];
    return opt.text || String(opt.value);
  }

  /**
   * 工作区一变就刷新所有动态下拉：
   *   1. 强制重算候选（Blockly 会缓存，积木刚从工具箱拖出来时算的那份是空的）；
   *   2. 当前值还是占位符 __none__、而候选里已经有真名字时，自动选中第一个。
   * 已经选了真名字的积木不动：哪怕它现在越界了，也留给生成器报错，
   * 静悄悄地把 x 换成 y 反而更难查。
   * 返回改动的字段数。调用方要防重入（setValue 本身也会发变更事件）。
   */
  function syncDynamicFields(ws) {
    if (!ws || typeof ws.getAllBlocks !== 'function') return 0;
    let changed = 0;
    for (const b of ws.getAllBlocks(false)) {
      if (!b.inputList) continue;
      for (const inp of b.inputList) {
        for (const f of (inp.fieldRow || [])) {
          if (!f.__dyn || f.__dyn.locked || !f.getOptions) continue;
          let opts;
          try { opts = f.getOptions(false); } catch (e) { continue; }   /* false = 重新生成 */
          if (!opts || !opts.length) continue;
          const cur = f.getValue();
          if (cur !== '__none__' && cur !== null && cur !== undefined && cur !== '') continue;
          const first = opts[0];
          const val = optionValue(first);
          if (val === undefined || val === '__none__') continue;   /* 还是没得选 */
          f.__dyn.locked = true;
          try { f.setValue(val); changed++; } finally { f.__dyn.locked = false; }
          /* 让显示文本跟候选对齐（Blockly 找不到 selectedOption 时会把文本清空） */
          if (!f.getText || !f.getText()) {
            if (f.setValueIndex) { try { f.setValueIndex(0); } catch (e) { /* 忽略 */ } }
            else if (f.setText) f.setText(optionText(first));
          }
        }
      }
    }
    return changed;
  }

  function varList(block, want) {
    return visibleNames(block, want).map((v) => ({ label: v.name, value: v.name }));
  }

  function scalarTypeField() {
    return new Blockly.FieldDropdown(SCALAR_TYPES.map((t) => [t.label, t.id]));
  }

  function nameField(initial) {
    return new Blockly.FieldTextInput(initial || 'x');
  }

  const STMT = 'Statement';

  /* ================================================================== */
  /* 积木注册                                                            */
  /* ================================================================== */

  /* ---------- 控制 ---------- */
  Blockly.Blocks['c_main'] = {
    init: function () {
      this.cKind = 'main';
      this.setColour(COL.entry);
      this.appendStatementInput('BODY').setCheck(STMT).appendField('主程序');
      this.setTooltip('程序的入口，生成 int main(void) { … }。\n不放这块也行：主工作区上散落的语句会按顺序进 main。');
    },
  };

  Blockly.Blocks['c_if'] = {
    init: function () {
      this.cKind = 'if';
      this.setColour(COL.ctrl);
      this.appendValueInput('COND').setCheck('Value').appendField('如果');
      this.appendDummyInput('TAILCOND').appendField('就执行');
      this.appendStatementInput('DO').setCheck(STMT);
      this.appendDummyInput('MID').appendField(
        new Blockly.FieldCheckbox('FALSE', function (v) {
          const b = this.getSourceBlock();
          if (b.updateElse_) b.updateElse_(v === 'TRUE');
          return v;
        }), 'HAS_ELSE');
      this.appendDummyInput('ELSELBL').appendField('否则');
      this.setInputsInline(true);
      this.setPreviousStatement(true, STMT);
      this.setNextStatement(true, STMT);
      this.updateElse_ = function (has) {
        /* 复选框的 validator 会回调这里，同步字段时再触发一次就成死循环，
           所以用一把重入锁挡住第二层。 */
        if (this.__syncing) return;
        if (has && !this.getInput('ELSE')) this.appendStatementInput('ELSE').setCheck(STMT);
        else if (!has && this.getInput('ELSE')) this.removeInput('ELSE');
        /* 复选框和形状必须同步：存档里 extraState 说「有 ELSE」而字段说「没勾」，
           读档时字段会把刚建好的 ELSE 槽又拆掉，子积木就无处可连了。 */
        const box = this.getField && this.getField('HAS_ELSE');
        const want = has ? 'TRUE' : 'FALSE';
        if (box && box.getValue() !== want) {
          this.__syncing = true;
          try { box.setValue(want); } finally { this.__syncing = false; }
        }
      };
      /* 存取工作区时先恢复形状，再回填字段和子积木 */
      this.saveExtraState = function () {
        return { hasElse: !!(this.getInput && this.getInput('ELSE')) };
      };
      this.loadExtraState = function (state) {
        this.updateElse_(!!(state && state.hasElse));
      };
      this.setTooltip('对应 if (条件) { … }。\n勾上「否则」多出 else 分支；多分支就把「如果」塞进「否则」的槽里（就是 else-if 链）。');
    },
  };

  Blockly.Blocks['c_repeat'] = {
    init: function () {
      this.cKind = 'repeat';
      this.setColour(COL.ctrl);
      this.appendValueInput('TIMES').setCheck('Value').appendField('重复执行');
      this.appendDummyInput('N').appendField('次');
      this.appendStatementInput('DO').setCheck(STMT);
      this.setInputsInline(true);
      this.setPreviousStatement(true, STMT);
      this.setNextStatement(true, STMT);
      this.setTooltip('计数循环，生成 for (int c_i1 = 0; c_i1 < N; c_i1 += 1)。\n计数器由生成器自动取名并避让已有变量。');
    },
  };

  Blockly.Blocks['c_while'] = {
    init: function () {
      this.cKind = 'while';
      this.setColour(COL.ctrl);
      this.appendValueInput('COND').setCheck('Value').appendField('当');
      this.appendDummyInput('N').appendField('时，重复执行');
      this.appendStatementInput('DO').setCheck(STMT);
      this.setInputsInline(true);
      this.setPreviousStatement(true, STMT);
      this.setNextStatement(true, STMT);
      this.setTooltip('对应 while (条件) { … }：先判断再执行，条件一开始就假则一次都不进。');
    },
  };

  Blockly.Blocks['c_until'] = {
    init: function () {
      this.cKind = 'until';
      this.setColour(COL.ctrl);
      this.appendStatementInput('DO').setCheck(STMT).appendField('重复执行');
      this.appendValueInput('COND').setCheck('Value').appendField('直到');
      this.appendDummyInput('N').appendField('为止');
      this.setInputsInline(false);
      this.setPreviousStatement(true, STMT);
      this.setNextStatement(true, STMT);
      this.setTooltip('对应 do { … } while (!(条件));：至少执行一次，跑完再判断。');
    },
  };

  Blockly.Blocks['c_for'] = {
    init: function () {
      this.cKind = 'for';
      this.setColour(COL.ctrl);
      this.appendDummyInput('A').appendField('令').appendField(nameField('i'), 'NAME');
      this.appendValueInput('FROM').setCheck('Value').appendField('从');
      this.appendValueInput('TO').setCheck('Value').appendField('到');
      this.appendValueInput('STEP').setCheck('Value').appendField('每次加');
      this.appendStatementInput('DO').setCheck(STMT).appendField('执行');
      this.setInputsInline(true);
      this.setPreviousStatement(true, STMT);
      this.setNextStatement(true, STMT);
      this.setTooltip('对应 for (int i = 起; i <= 止; i += 步)。\n循环变量在体内可见，能用「变量」积木读到。');
    },
  };

  Blockly.Blocks['c_break'] = {
    init: function () {
      this.cKind = 'break';
      this.setColour(COL.ctrl);
      this.appendDummyInput().appendField('跳出循环');
      this.setPreviousStatement(true, STMT);
      this.setTooltip('break; 立刻跳出最近的一层循环。');
    },
  };

  Blockly.Blocks['c_continue'] = {
    init: function () {
      this.cKind = 'continue';
      this.setColour(COL.ctrl);
      this.appendDummyInput().appendField('跳过本轮');
      this.setPreviousStatement(true, STMT);
      this.setNextStatement(true, STMT);
      this.setTooltip('continue; 结束本轮，直接进入下一轮判断。');
    },
  };

  /* ---------- 变量与数组 ---------- */
  Blockly.Blocks['c_var_decl'] = {
    init: function () {
      this.cKind = 'var_decl';
      this.setColour(COL.vari);
      this.appendDummyInput()
        .appendField('声明')
        .appendField(scalarTypeField(), 'TYPE')
        .appendField('变量')
        .appendField(nameField('x'), 'NAME');
      this.appendValueInput('INIT').setCheck('Value').appendField('初始值（可留空）');
      this.setPreviousStatement(true, STMT);
      this.setNextStatement(true, STMT);
      this.setTooltip('对应 int x = 5; / double t; / char c; / bool ok;。\n声明之后的语句才能用它；放在循环里就等于每轮重新初始化。');
    },
  };

  Blockly.Blocks['c_var_set'] = {
    init: function () {
      this.cKind = 'var_set';
      this.setColour(COL.vari);
      this.appendValueInput('VALUE').setCheck('Value')
        .appendField('把')
        .appendField(dynField((b) => varList(b, { kind: 'var' }), 'var'), 'VAR')
        .appendField('设为');
      this.setPreviousStatement(true, STMT);
      this.setNextStatement(true, STMT);
      this.setTooltip('对应 x = 表达式;。这是赋值，不是数学等号：右边算完再存进左边。');
    },
  };

  Blockly.Blocks['c_var_get'] = {
    init: function () {
      this.cKind = 'var_get';
      this.setColour(COL.vari);
      this.appendDummyInput()
        .appendField('变量')
        .appendField(dynField((b) => varList(b, { kind: 'var' }), 'var'), 'VAR');
      this.setOutput(true, ['LValue', 'Value']);
      this.setTooltip('读取变量的值，可以塞进任何需要数值或文本的地方；\n放进 scanf 的槽位时会自动取地址（&x）。');
    },
  };

  Blockly.Blocks['c_arr_decl'] = {
    init: function () {
      this.cKind = 'arr_decl';
      this.setColour(COL.vari);
      this.appendDummyInput()
        .appendField('声明')
        .appendField(scalarTypeField(), 'TYPE')
        .appendField('数组')
        .appendField(nameField('a'), 'NAME')
        .appendField('长度')
        .appendField(new Blockly.FieldNumber(10, 1, 65536, 1), 'LEN');
      this.setPreviousStatement(true, STMT);
      this.setNextStatement(true, STMT);
      this.setTooltip('对应 int a[10];。长度是编译期常量；下标从 0 开始，合法范围 0 ~ 长度-1。');
    },
  };

  Blockly.Blocks['c_arr_get'] = {
    init: function () {
      this.cKind = 'arr_get';
      this.setColour(COL.vari);
      this.appendValueInput('IDX').setCheck('Value')
        .appendField(dynField((b) => varList(b, { kind: 'array' }), 'array'), 'ARR')
        .appendField('的第');
      this.appendDummyInput('TAIL').appendField('项');
      this.setInputsInline(true);
      this.setOutput(true, ['LValue', 'Value']);
      this.setTooltip('对应 a[i]。越界是未定义行为，C 运行时不会替你拦。\n放进 scanf 的槽位时会自动写成 &a[i]。');
    },
  };

  Blockly.Blocks['c_arr_set'] = {
    init: function () {
      this.cKind = 'arr_set';
      this.setColour(COL.vari);
      this.appendValueInput('IDX').setCheck('Value')
        .appendField('把')
        .appendField(dynField((b) => varList(b, { kind: 'array' }), 'array'), 'ARR')
        .appendField('的第');
      this.appendValueInput('VALUE').setCheck('Value').appendField('项设为');
      this.setInputsInline(true);
      this.setPreviousStatement(true, STMT);
      this.setNextStatement(true, STMT);
      this.setTooltip('对应 a[i] = 表达式;。');
    },
  };

  /* ---------- 输入 / 输出 ---------- */
  Blockly.Blocks['c_print'] = {
    init: function () {
      this.cKind = 'print';
      this.setColour(COL.io);
      this.appendValueInput('MSG').setCheck(['Text', 'Value']).appendField('输出');
      this.appendDummyInput()
        .appendField(new Blockly.FieldCheckbox('TRUE'), 'NL')
        .appendField('换行');
      this.setInputsInline(true);
      this.setPreviousStatement(true, STMT);
      this.setNextStatement(true, STMT);
      this.setTooltip('对应 printf：文本走 %s、整数 %d、小数 %g、字符 %c、布尔 %d。\n格式串由生成器写死，你输出的内容永远处在参数位置，不会变成格式串。');
    },
  };

  Blockly.Blocks['c_read_var'] = {
    init: function () {
      this.cKind = 'read';
      this.setColour(COL.io);
      this.appendDummyInput()
        .appendField('读入到变量')
        .appendField(dynField(
          (b) => varList(b, { kind: 'var', types: ['int', 'double', 'char'] }),
          { kind: 'var', none: EMPTY_READ },
        ), 'VAR');
      this.setPreviousStatement(true, STMT);
      this.setNextStatement(true, STMT);
      this.setTooltip('对应 scanf(" %d", &x)，格式符按目标变量类型自动选：int 用 %d、double 用 %lf、char 用 " %c"（前面留空格跳过换行和空白）。');
    },
  };

  Blockly.Blocks['c_read_arr'] = {
    init: function () {
      this.cKind = 'read_arr';
      this.setColour(COL.io);
      this.appendValueInput('IDX').setCheck('Value')
        .appendField('读入到数组')
        .appendField(dynField((b) => varList(b, { kind: 'array' }), 'array'), 'ARR')
        .appendField('的第');
      this.appendDummyInput('TAIL').appendField('项');
      this.setInputsInline(true);
      this.setPreviousStatement(true, STMT);
      this.setNextStatement(true, STMT);
      this.setTooltip('对应 scanf("%d", &a[i])。');
    },
  };

  /* ---------- 原生 printf / scanf：格式串 + 可变参数槽 ---------- */
  function mutableArgBlock(cfg) {
    Blockly.Blocks[cfg.type] = {
      init: function () {
        const self = this;
        this.cKind = cfg.cKind;
        this.setColour(COL.iofmt);
        this.nargs_ = cfg.start;
        this.check_ = cfg.check;
        this.rebuildArgs_ = function () {
          for (let i = 0; i < 16; i++) if (this.getInput('ARG' + i)) this.removeInput('ARG' + i);
          if (this.getInput('CTRL')) this.removeInput('CTRL');
          for (let i = 0; i < this.nargs_; i++) {
            this.appendValueInput('ARG' + i)
              .setCheck(this.check_)
              .appendField('    ' + cfg.argLabel + ' ' + (i + 1) + '：');
          }
          const ctrl = this.appendDummyInput('CTRL').appendField('   ');
          ctrl.appendField(new Blockly.FieldImage(ICON_ADD, 20, 20, '+', function () {
            self.nargs_ = Math.min(16, self.nargs_ + 1);
            self.rebuildArgs_();
            self.notifyShape_();
          }));
          ctrl.appendField(new Blockly.FieldImage(ICON_SUB, 20, 20, '−', function () {
            self.nargs_ = Math.max(0, self.nargs_ - 1);
            self.rebuildArgs_();
          }));
          ctrl.appendField(new Blockly.FieldLabel('（' + cfg.noun + ' ' + this.nargs_ + ' 个）'));
          /* init 阶段还没有 SVG，这时候渲染会在 null 上 setAttribute；
             真正的绘制交给调用方随后的 initSvg/render。 */
          if (this.svgGroup_) {
            if (this.renderEfficiently) this.renderEfficiently();
            else if (this.render) this.render();
          }
        };
        this.notifyShape_ = function () {
          /* 让撤销栈和自动保存知道形状变了；老版本没有这个事件就跳过 */
          try {
            if (this.queueEvent && Blockly.Events && Blockly.Events.BlockChange) {
              this.queueEvent(new Blockly.Events.BlockChange(this, 'extraState', null, null, null));
            }
          } catch (e) { /* 忽略：形状信息在 saveExtraState 里 */ }
        };
        this.appendDummyInput('HEAD').appendField(cfg.headLabel).appendField(
          new Blockly.FieldTextInput(cfg.fmtDefault), 'FMT');
        this.rebuildArgs_();
        this.setPreviousStatement(true, STMT);
        this.setNextStatement(true, STMT);
        this.saveExtraState = function () { return { nargs: this.nargs_ }; };
        this.loadExtraState = function (s) {
          const n = s && typeof s.nargs === 'number' ? s.nargs : this.nargs_;
          this.nargs_ = Math.max(0, Math.min(16, n));
          this.rebuildArgs_();
        };
        this.setTooltip(cfg.tooltip);
      },
    };
  }

  mutableArgBlock({
    type: 'c_printf', cKind: 'printf', headLabel: 'printf 格式', noun: '参数',
    argLabel: '参数', check: ['Value', 'Text'], fmtDefault: '%d\\n', start: 1,
    tooltip: '对应 printf("格式串", 参数…);。格式串里照 C 的写法填，例如 %d、%.2f、%g、%c、%s、\\n。\n生成器会数一遍格式说明符和参数个数是否对得上，这是 C 初学者最常踩的坑。',
  });

  mutableArgBlock({
    type: 'c_scanf', cKind: 'scanf', headLabel: 'scanf 格式', noun: '目标',
    argLabel: '放入', check: 'LValue', fmtDefault: '%d', start: 1,
    tooltip: '对应 scanf("格式串", &x, …);。槽位只吃变量或数组元素（表达式进不来），& 由生成器补。\n读 char 时记得在 %c 前面留个空格，否则会先吃掉上一行的换行符。',
  });

  Blockly.Blocks['c_text'] = {
    init: function () {
      this.cKind = 'text';
      this.setColour(COL.io);
      this.appendDummyInput().appendField('文本').appendField(new Blockly.FieldTextInput('你好'), 'TEXT');
      this.setOutput(true, 'Text');
      this.setTooltip('字符串字面量 "…"。双引号、反斜杠、% 都会自动转义。');
    },
  };

  Blockly.Blocks['c_char'] = {
    init: function () {
      this.cKind = 'char_lit';
      this.setColour(COL.io);
      this.appendDummyInput().appendField('字符').appendField(new Blockly.FieldTextInput('a'), 'CH');
      this.setOutput(true, 'Value');
      this.setTooltip("字符常量 'a'，本质是个小整数，可以和数字比较、参与运算。");
    },
  };

  /* ---------- 运算 ---------- */
  Blockly.Blocks['c_num'] = {
    init: function () {
      this.cKind = 'num';
      this.setColour(COL.math);
      this.appendDummyInput().appendField(new Blockly.FieldNumber(0), 'NUM');
      this.setOutput(true, 'Value');
      this.setTooltip('数字字面量：带小数点按 double，整数按 int。');
    },
  };

  Blockly.Blocks['c_arith'] = {
    init: function () {
      this.cKind = 'arith';
      this.setColour(COL.math);
      this.appendValueInput('A').setCheck('Value');
      this.appendDummyInput().appendField(
        new Blockly.FieldDropdown([['+', '+'], ['−', '-'], ['×', '*'], ['÷', '/'], ['取余', '%']]), 'OP');
      this.appendValueInput('B').setCheck('Value');
      this.setInputsInline(true);
      this.setOutput(true, 'Value');
      this.setTooltip('对应 + - * / %。两个整数相除会截断（7 / 2 得 3）；想要 3.5 就用「运算 → 值类型转换」先把一边转成 double。');
    },
  };

  Blockly.Blocks['c_neg'] = {
    init: function () {
      this.cKind = 'neg';
      this.setColour(COL.math);
      this.appendValueInput('A').setCheck('Value').appendField('负');
      this.setOutput(true, 'Value');
      this.setTooltip('一元负号 -(表达式)。');
    },
  };

  Blockly.Blocks['c_cast'] = {
    init: function () {
      this.cKind = 'cast';
      this.setColour(COL.math);
      this.appendValueInput('A').setCheck('Value');
      this.appendDummyInput().appendField('转成').appendField(
        new Blockly.FieldDropdown([['整数', 'int'], ['小数', 'double'], ['字符', 'char']]), 'TO')
        .appendField('的值');
      this.setInputsInline(true);
      this.setOutput(true, 'Value');
      this.setTooltip('显式类型转换 (int)x / (double)x / (char)x。7 / 2 得 3，(double)7 / 2 得 3.5。');
    },
  };

  /* ---------- 判断 / 逻辑 ---------- */
  Blockly.Blocks['c_compare'] = {
    init: function () {
      this.cKind = 'compare';
      this.setColour(COL.logic);
      this.appendValueInput('A').setCheck('Value');
      this.appendDummyInput().appendField(
        new Blockly.FieldDropdown([['=', '=='], ['≠', '!='], ['<', '<'], ['>', '>'], ['≤', '<='], ['≥', '>=']]), 'OP');
      this.appendValueInput('B').setCheck('Value');
      this.setInputsInline(true);
      this.setOutput(true, 'Value');
      this.setTooltip('比较运算 == != < > <= >=，结果是 1 或 0。小心：= 是赋值，== 才是相等。');
    },
  };

  Blockly.Blocks['c_logic'] = {
    init: function () {
      this.cKind = 'logic';
      this.setColour(COL.logic);
      this.appendValueInput('A').setCheck('Value');
      this.appendDummyInput().appendField(
        new Blockly.FieldDropdown([['且', '&&'], ['或', '||']]), 'OP');
      this.appendValueInput('B').setCheck('Value');
      this.setInputsInline(true);
      this.setOutput(true, 'Value');
      this.setTooltip('逻辑与 && / 逻辑或 ||，短路求值：左边已定胜负时右边不计算。');
    },
  };

  Blockly.Blocks['c_not'] = {
    init: function () {
      this.cKind = 'not';
      this.setColour(COL.logic);
      this.appendValueInput('A').setCheck('Value').appendField('非');
      this.setOutput(true, 'Value');
      this.setTooltip('逻辑非 !(表达式)：0 变 1，非 0 变 0。');
    },
  };

  Blockly.Blocks['c_bool'] = {
    init: function () {
      this.cKind = 'bool_lit';
      this.setColour(COL.logic);
      this.appendDummyInput().appendField(
        new Blockly.FieldDropdown([['真', 'true'], ['假', 'false']]), 'V');
      this.setOutput(true, 'Value');
      this.setTooltip('true / false。工作区里用到它才会 #include <stdbool.h>。');
    },
  };

  /* ---------- 函数 ---------- */
  Blockly.Blocks['c_func_def'] = {
    init: function () {
      this.cKind = 'func_def';
      this.setColour(COL.func);
      this.appendDummyInput()
        .appendField('函数')
        .appendField(nameField('sum'), 'NAME')
        .appendField('返回')
        .appendField(new Blockly.FieldDropdown([
          ['无返回值 void', 'void'], ['整数 int', 'int'], ['小数 double', 'double'], ['字符 char', 'char'],
        ]), 'RET')
        .appendField('参数')
        .appendField(new Blockly.FieldDropdown(
          [['无', '0'], ['1 个', '1'], ['2 个', '2'], ['3 个', '3']],
          function (v) { const b = this.getSourceBlock(); if (b.updateParams_) b.updateParams_(v); return v; }
        ), 'NP');
      this.appendStatementInput('BODY').setCheck(STMT).appendField('执行');
      this.updateParams_ = function (count) {
        const n = parseInt(count, 10) || 0;
        for (let i = 0; i < 3; i++) if (this.getInput('P' + i)) this.removeInput('P' + i);
        for (let i = 0; i < n; i++) {
          const inp = this.appendDummyInput('P' + i);
          inp.appendField(scalarTypeField(), 'P' + i + '_T');
          inp.appendField(nameField('a' + (i + 1)), 'P' + i + '_N');
        }
      };
      this.updateParams_(this.getFieldValue('NP') || '0');
      this.saveExtraState = function () {
        return { np: this.getFieldValue('NP') || '0' };
      };
      this.loadExtraState = function (state) {
        if (state && typeof state.np === 'string') this.updateParams_(state.np);
      };
      this.setTooltip('定义一个 C 函数，生成在 main 之前，并自动补一行函数原型，所以谁先谁后都能互相调用（递归也可以）。');
    },
  };

  function callArgs_(block, name) {
    if (!block || !block.workspace) return;
    const d = funcDefs(block.workspace).get(name);
    const n = d ? d.params.length : 0;
    /* 槽数和标签都已经对就别重建：removeInput 会把槽里已经接好的实参积木拆成孤儿 */
    let same = block.__argsFor === name;
    if (same) {
      for (let i = 0; i < 8; i++) {
        const inp = block.getInput('ARG' + i);
        const want = i < n;
        if (!!inp !== want) { same = false; break; }
        if (inp && d && String((inp.fieldRow[0] || {}).getValue && inp.fieldRow[0].getValue()) !== ('   ' + d.params[i].name + ' ＝')) { same = false; break; }
      }
    }
    if (same) return;
    block.__argsFor = name;
    for (let i = 0; i < 8; i++) if (block.getInput('ARG' + i)) block.removeInput('ARG' + i);
    for (let i = 0; i < n; i++) {
      const inp = block.appendValueInput('ARG' + i).setCheck('Value');
      inp.appendField('   ' + d.params[i].name + ' ＝');
    }
    block.setInputsInline(false);
  }

  function fnList(retWanted) {
    return function (block) {
      if (!block || !block.workspace) return [];   /* 构造期还没有积木 */
      const list = [];
      for (const d of funcDefs(block.workspace).values()) {
        if (retWanted === 'void' ? d.ret === 'void' : d.ret !== 'void') {
          list.push({ label: d.name, value: d.name });   /* Blockly 要 [文本, 值]，dynField 会转 */
        }
      }
      return list;
    };
  }

  Blockly.Blocks['c_call_stmt'] = {
    init: function () {
      this.cKind = 'call';
      this.setColour(COL.func);
      this.appendDummyInput()
        .appendField('执行函数')
        .appendField(dynField(fnList('void'), { kind: 'funcVoid' }, function (v) {
          callArgs_(this.getSourceBlock(), v);
          return v;
        }), 'NAME');
      this.setPreviousStatement(true, STMT);
      this.setNextStatement(true, STMT);
      this.saveExtraState = function () { return { fn: this.getFieldValue('NAME') || '' }; };
      this.loadExtraState = function (s) { if (s && s.fn) callArgs_(this, s.fn); };
      this.setTooltip('调用「无返回值 void」的函数，作为一条语句执行：f(表达式);');
    },
  };

  Blockly.Blocks['c_call_expr'] = {
    init: function () {
      this.cKind = 'call';
      this.setColour(COL.func);
      this.appendDummyInput()
        .appendField('函数')
        .appendField(dynField(fnList('value'), { kind: 'funcVal' }, function (v) {
          callArgs_(this.getSourceBlock(), v);
          return v;
        }), 'NAME')
        .appendField('的返回值');
      this.setOutput(true, 'Value');
      this.saveExtraState = function () { return { fn: this.getFieldValue('NAME') || '' }; };
      this.loadExtraState = function (s) { if (s && s.fn) callArgs_(this, s.fn); };
      this.setTooltip('调用有返回值的函数，返回值可以塞进任何数值槽：f(表达式)。');
    },
  };

  Blockly.Blocks['c_return'] = {
    init: function () {
      this.cKind = 'return';
      this.setColour(COL.func);
      this.appendValueInput('VALUE').setCheck('Value').appendField('返回');
      this.setPreviousStatement(true, STMT);
      this.setTooltip('return 表达式; 结束当前函数并把值交回调用处。\n槽留空就生成裸 return;（void 函数用）。主程序里的返回值是进程退出码。');
    },
  };

  /* ================================================================== */
  /* 工具箱                                                              */
  /* ================================================================== */
  const TOOLBOX = {
    kind: 'categoryToolbox',
    contents: [
      {
        kind: 'category', name: '控制', colour: COL.ctrl, contents: [
          { kind: 'block', type: 'c_main' },
          { kind: 'block', type: 'c_if' },
          { kind: 'block', type: 'c_repeat' },
          { kind: 'block', type: 'c_while' },
          { kind: 'block', type: 'c_until' },
          { kind: 'block', type: 'c_for' },
          { kind: 'block', type: 'c_break' },
          { kind: 'block', type: 'c_continue' },
        ],
      },
      {
        kind: 'category', name: '变量', colour: COL.vari, contents: [
          { kind: 'block', type: 'c_var_decl', fields: { NAME: 'x' } },
          { kind: 'block', type: 'c_var_set' },
          { kind: 'block', type: 'c_var_get' },
          { kind: 'sep' },
          { kind: 'block', type: 'c_arr_decl', fields: { NAME: 'a' } },
          { kind: 'block', type: 'c_arr_get' },
          { kind: 'block', type: 'c_arr_set' },
        ],
      },
      {
        kind: 'category', name: '输入输出', colour: COL.io, contents: [
          { kind: 'block', type: 'c_printf' },
          { kind: 'block', type: 'c_scanf' },
          { kind: 'sep' },
          { kind: 'block', type: 'c_print' },
          { kind: 'block', type: 'c_read_var' },
          { kind: 'block', type: 'c_read_arr' },
          { kind: 'sep' },
          { kind: 'block', type: 'c_text' },
          { kind: 'block', type: 'c_char' },
        ],
      },
      {
        kind: 'category', name: '运算', colour: COL.math, contents: [
          { kind: 'block', type: 'c_num' },
          { kind: 'block', type: 'c_arith' },
          { kind: 'block', type: 'c_neg' },
          { kind: 'block', type: 'c_cast' },
        ],
      },
      {
        kind: 'category', name: '判断', colour: COL.logic, contents: [
          { kind: 'block', type: 'c_compare' },
          { kind: 'block', type: 'c_logic' },
          { kind: 'block', type: 'c_not' },
          { kind: 'block', type: 'c_bool' },
        ],
      },
      {
        kind: 'category', name: '函数', colour: COL.func, contents: [
          { kind: 'block', type: 'c_func_def' },
          { kind: 'block', type: 'c_call_stmt' },
          { kind: 'block', type: 'c_call_expr' },
          { kind: 'block', type: 'c_return' },
        ],
      },
    ],
  };

  global.CBlocks = {
    toolbox: TOOLBOX,
    colours: COL,
    scalarTypes: SCALAR_TYPES,
    helpers: {
      visibleNames: visibleNames,
      syncDynamicFields: syncDynamicFields,
      funcDefs: funcDefs,
      funcParams: funcParams,
      chainOf: chainOf,
      contains: contains,
      isIdent: isIdent,
    },
  };
})(window);
