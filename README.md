# 积木编程 → C / C++（blockly-c-playground）

拖积木写程序，一键生成等价的 C 或 C++ 代码，再在浏览器里用 clang.wasm 直接编译运行。
仿 Blockly / Scratch 的交互，但生成的是真代码：变量、数组、循环、判断、函数、递归都按 C 的规则来（先声明后使用、作用域、格式串与实参配对）。
工具栏的「语言」默认 C++（`std::cout` / `std::cin` / `#include <iostream>`），也可以切回 C（`printf` / `scanf`）—— 换的不只是编译参数，生成的源码写法本身会变。

源码仓库：<https://github.com/zhblue/blocks>（页面标题点进去就是这个地址）。

整个目录自包含：Blockly、Ace、wasm 工具链和 sysroot（416 个文件，含 libc++ 头与静态库）全部在本地，不联网、不引用目录外的任何文件，拷走就能用。

## 运行

```bash
cd blockly-c-playground
python serve.py 8010
```

然后打开 http://127.0.0.1:8010/index.html

必须走 http，不能直接双击 `index.html`：`file://` 下浏览器不允许加载 Worker，wasm 编译链路起不来。
`serve.py` 给 `assets/`、`vendor/` 打了长缓存，第二次打开基本秒就绪；首次加载约 58 MB（clang.wasm 29.8 MiB、lld.wasm 18.6 MiB、sysroot.tar 8.9 MiB、memfs.wasm 0.3 MiB）。
生产部署建议再叠一层 gzip/brotli：这类 wasm 二进制和 tar 里大量文本头文件压得动。

页面打不开或一打开就转圈（本地存档被改坏时可能出现）：访问 http://127.0.0.1:8010/index.html?fresh=1，会跳过并清掉本地积木存档。

## 界面

左：积木工作区（六个分组：控制 / 变量 / 输入输出 / 运算 / 判断 / 函数）。
右：代码面板（可以手改再点「编译并运行」，但代码不会反向变回积木）、标准输入、运行输出、诊断列表。标题本身是个链接，指向 <https://github.com/zhblue/blocks>；说明文字收在标题的悬停提示里。

按钮：按积木重新生成 / 编译并运行 / 停止 / 重载工具链 / 保存 / 导出 / 导入 / 清空积木。

工作区一变就重新生成代码，诊断既列在面板里，也用气泡钉在出问题的积木上。
「编译并运行」把代码交给常驻的 compile.worker（clang.wasm + lld.wasm）链成 wasm，再交给一次性 run.worker 在沙箱里执行，stdin 走「标准输入」框。
选项：语言（C++ / C，默认 C++）、标准（跟着语言换候选）、优化（-O0/-O1/-O2/-O3）、运行超时、是否在代码里保留中文注释；编译带 `-Wall`，栈大小默认 8 MB（`js/wasmclang.js`）。

「语言」这一栏同时改两件事：
生成器的写法（`js/c-generator.js` 里 `opts.lang === 'cpp'`）和编译参数（`clang -cc1 -x c++` 还是 `-x c`，文件名 `main.cc` / `main.c`）。
「标准」下拉框的候选来自 `js/app.js` 里的 `LANGS`，是按这份 clang.wasm（wasi-sdk 的 **clang 8.0.1**）二进制里实际认得的语言名列的：
C 是 `c89/c99/c11/c17`，C++ 是 `c++98/c++11/c++14/c++17/c++2a` —— 这份 clang 的语言表里没有 `c++20` 这个名字（只认 `c++2a`），想要 C++20 就选 `c++2a`。

## 积木与代码的对应

下表写的是 C 模式；C++ 模式只有表后那张对照表列出的几处不同，其它生成规则完全一样。

| 积木 | 生成的 C |
| --- | --- |
| 主程序 | `int main(void) { … }`（不放它时，主工作区上散落的语句按顺序进 main） |
| 如果 / 如果…否则 | `if (…) { … } else { … }` |
| 重复 N 次 | `for (int c_i1 = 0; c_i1 < N; c_i1 += 1)` |
| 当…就重复 / 重复直到 | `while (…) { … }` / `do { … } while (!(…));` |
| 计数循环 从 a 到 b 步长 s | `for (int i = a; i <= b; i += s)`（步长为负时自动换成 `>=`） |
| 跳出 / 继续 | `break;` / `continue;` |
| 声明 int/double/char/bool 变量 | `int x;` / `int x = …;` / `char c = 'A';` / `bool ok = true;` |
| 把…设为 | `x = …;` |
| 变量（值块） | `x`，C 模式放进 scanf 槽位时自动变成 `&x` |
| 声明数组 / 第 i 项 / 设为 | `int a[5];` / `a[i]` / `a[i] = …;` |
| 输出…（自动换行） | `printf("…\n", …)`，格式符按内容类型写死 |
| 读入变量 / 读入整个数组 | `scanf("%d", &n)` / 循环 `scanf`；小数自动用 `%lf`，读字符自动加前导空格 `" %c"` |
| printf / scanf（进阶） | 自己写格式串 + 实参槽，格式符数量与实参会逐项核对 |
| 数字 / 文本 / 字符 / 真假 | `42`、`"文本"`、`'A'`、`true` / `false` |
| 加减乘除余、取负、转类型 | `a + b`、`-a`、`(double)x`，按 C 优先级自动补括号 |
| 比较、与或非 | `==` `!=` `<` `<=` `>` `>=`、`&&` `||` `!` |
| 函数（返回值类型 + 形参） | 先出原型再出定义，谁先谁后都能互相调用，递归可用 |
| 调用函数（语句 / 表达式） | `fact(5);` / `x = fact(5);`，实参槽随被调函数的形参自动增减 |
| 返回 | `return …;`（void 函数是 `return;`） |

用到的头文件由生成器按需插入：C 模式是 `<stdio.h>`，出现 `true/false/bool` 时补 `<stdbool.h>`。

切到 C++ 后只有这几处写法不同，其余（循环、判断、数组、函数、类型、优先级补括号）与 C 一模一样：

| 积木 | C 模式 | C++ 模式 |
| --- | --- | --- |
| 输出… | `printf("…\n", x)` | `std::cout << x << std::endl;`（没勾换行就是 `std::cout << x;`） |
| 读入变量 / 数组第 i 项 | `scanf("%d", &n)` / `scanf("%lf", &a[i])` | `std::cin >> n;` / `std::cin >> a[i];`，没有格式符也没有 `&` |
| 读入前的 flush | 补 `fflush(stdout);` | `std::endl` 本身就 flush；只有上一条输出没勾换行时才补 `std::cout << std::flush;` |
| 主程序 / 空参函数 | `int main(void)`、`void shout(void)` | `int main()`、`void shout()` |
| bool | 需要 `#include <stdbool.h>` | 内建类型，不带头文件 |
| 头文件 | `#include <stdio.h>` | 用到 cout/cin 才 `#include <iostream>` |
| printf / scanf 积木 | `printf` / `scanf` + `<stdio.h>` | 还是 `printf` / `scanf`，改成带 `#include <cstdio>`；格式串校验一字不变 |
| 输出比较式 / 与或 | `printf("%d", x > 1)` 不需要括号 | `<<` 的结合力高于 `>` 和 `&&`，所以自动写成 `std::cout << (x > 1) << std::endl;`，不加括号会被解析成 `(cout << x) > 1` |

数组、`char`、强制转换在 C++ 模式下仍是 C 那一套：还是原生数组、还是 `(double)x`，不会生成 `std::string`、`std::vector` 或 `static_cast`。
诊断里的措辞也沿用「C 的标识符…」这类说法 —— 两门语言的标识符规则相同，只有 bool 读入那一条会按语言各说各的（C++ 解释 `cin` 把 0 / 非 0 当 false / true）。

## 诊断口径

生成器只在结构明显会出事时报错，并把话说清楚（下一步该拖哪块积木）：

- 错误：格式串与实参数量不符、用了没声明或声明在后面的名字、中文变量名、scanf 的写入目标类型不对、`break` 在循环外、有返回值的函数最后一条不是「返回」、调用 void 函数却想拿它的值。
- 警告：散落在「主程序」外面的语句链（会被挪到 main 末尾，导致前面的语句看不到这个声明）、数组越界提示等。
- 提示：数组长度等说明性信息。

变量名下拉的候选来自「按 C 作用域规则对这个槽位可见」的声明：同一程序体里、排在它前面。
所以「声明」拖在后面、或没接进程序体时，下拉里确实没有它 —— 这时下拉会写明原因，而不是让你以为没识别到。

## 目录结构

```
blockly-c-playground/
  index.html          页面 + 样式（积木工作区、代码面板、诊断、编译运行按钮）
  serve.py            本地静态服务器（带 wasm 的 MIME 和长缓存）
  js/app.js           Blockly 初始化、示例、语言/标准切换、保存/导入导出、编译运行调度
  js/c-blocks.js      积木定义、工具箱、作用域可见名字与动态下拉
  js/c-generator.js   积木 → C 或 C++ 源码（opts.lang）+ 中文诊断
  js/wasmclang.js     clang/lld 的 wasm 调用封装
  js/compile.worker.js  常驻编译线程
  js/run.worker.js      一次性执行线程（沙箱 + stdin + 超时）
  vendor/blockly/     Blockly 13.4.0（本地，含 zh-hans 提示与 media 资源）
  vendor/ace/         代码面板编辑器
  assets/             clang.wasm / lld.wasm / memfs.wasm / sysroot.tar（416 个文件：头文件 + libc++.a 等静态库）
  test/gen-smoke.mjs    不开浏览器也能跑的生成器断言，C 与 C++ 各过一遍（node test/gen-smoke.mjs）
  test/scope-probe.mjs  变量/数组名下拉的作用域断言（node test/scope-probe.mjs）
```

## 已知限制

- 只覆盖入门编程：没有指针运算、结构体、联合、文件读写、多文件、宏、`switch`。选 C++ 也不会给你类和模板 —— 积木本身没有这些概念。
- 数组必须声明时定长，长度是常数；不支持二维数组和变长数组。
- `char` 数组能存能读，但没有字符串函数库语义（`%s` 输出的是 C 字符串，不会自动补 `'\0'`）。
- 代码面板是「出口」不是「入口」：手改的代码只用来编译运行，不会解析回积木；点「按积木重新生成」就被积木覆盖。
- 执行在浏览器沙箱里，栈大小和运行超时可调，但死循环只能靠超时打断；`exit()`、`assert()` 这类需要运行期的行为不保证与本地一致。
- 编译产物是 wasm32 语义，`long`、指针宽度等与 64 位 Linux 本地编译不完全相同，讲课时别拿它做数据大小的对照实验。
