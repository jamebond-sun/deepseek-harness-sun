/**
 * PTC 模式代码生成 — Python 风味。把已注册的工具模式纯投影为
 * `runtime.language === 'python'` 下模型编程所依据的 Python SDK 文本。是
 * {@link ./ts-types.ts | ts-types.ts} 的姊妹文件；两者是同一注册表存储的两次投影，
 * 以已加载的 {@link @deepseek-ai/dsh-ptc-runtime#PtcRuntime.language | PTC
 * runtime 的语言} 为键。
 *
 * 在 `mode: 'ptc'` 下，原生工具模式会从请求中省略，因此这份生成的 SDK 是模型了解每个
 * 工具的参数名、必填字段、类型、描述与规范输出类型的唯一来源。对象形态的参数与输出
 * 渲染为每个工具（以及每个嵌套对象）一个命名的 `TypedDict`，而非不透明的
 * `dict[str, Any]`，于是模式得以延续进程序——该模式下没有任何其他载体承载它。
 * @module @deepseek-ai/dsh-tools/src/py-types
 */

import { assertSupportedJsonSchema } from './json-schema.ts'
import type { JsonSchemaNode, JsonSchemaScalar } from './json-schema.ts'
import type { ToolSdkSchema } from './ts-types.ts'

/**
 * 参考文法的 `xid_start xid_continue*` — 即在 Unicode 表与引擎一致的
 * CPython 上 `str.isidentifier()` 所接受的集合。版本偏差会带来什么，
 * 见 {@link isBareIdentifier}。
 */
const IDENTIFIER = /^[\p{XID_Start}_]\p{XID_Continue}*$/u

/**
 * 名称能否作为裸 Python 标识符输出，而不是改走下标/`dict[str, Any]` 路径。
 *
 * Python 标识符不是 ASCII：`路径` 与 `path` 同为合法字段名，拒绝它会使整个
 * 外层对象降级，丢掉每个字段的名称、必填性与类型——在 `mode: 'ptc'` 下，
 * 这些信息唯一的来源就是这份生成的文本。
 *
 * NFKC 稳定性是第二个独立条件，因为 CPython 在编译期规范化标识符，而 JSON
 * 键按原样比较：`ﬁeld` 会被声明并可按 `field` 访问，于是 SDK 会以 harness
 * 从不接受的拼写公示一个键，两个规范化后相同的键会塌缩成一个声明。这类名称
 * 改走下标路径，由它携带其精确字节。
 *
 * `IDENTIFIER` 与 `str.isidentifier()` 一致（在 Node 22.23.1 与 CPython 3.9.6
 * 的表上实测）：等价性在两个版本共享的表内成立，下面的偏差字符正是这一对表
 * 分歧之处。整个谓词刻意比 `isidentifier()` 更严格，后者不检测 NFKC 稳定性：
 * `'ﬁeld'.isidentifier()` 为 True，而这里返回 false。
 *
 * 两个条件都按引擎的 Unicode 表求值，且两侧的版本各自独立——
 * `\p{XID_Start}`/`\p{XID_Continue}` 跟随运行中的引擎（Node 22.23.1 报告
 * Unicode 17.0），CPython 跟随自己的表（3.9.6 报告 13.0.0）。偏差并不对称。
 * CPython 比引擎旧是危险方向：其表之后才加入任一属性的字符（U+10570
 * Vithkuqi 与 U+1E290 Toto，14.0；U+1E4D0 Nag Mundari，15.0；U+1C89
 * Cyrillic TJE，16.0——年代依 `DerivedAge.txt`；四者均 NFKC 稳定且在此被
 * 接受，而在那版 3.9.6 上都是 `Cn`，会被它拒绝）会被裸输出，其分词器拒绝
 * 该字符，拖垮整个 SDK 块——正是 {@link UNPRINTABLE}、
 * {@link LONE_SURROGATE} 与 {@link MAX_LIST_NESTING} 服务的同一可解析性
 * 不变量。两个属性都会引入它：只加入 `XID_Continue` 的字符能在尾部位置
 * 通过末尾的 `\p{XID_Continue}*`，以同样方式失败——U+200C ZWNJ 与
 * U+200D ZWJ 就是这种情况，在 UCD 15.1 获得 `XID_Continue`，而在 13.0.0、
 * 14.0.0 与 15.0.0 中缺席，因此 `a\u{200C}b` 在此裸输出，而
 * `isidentifier()` 在 3.9.6 与 3.12.13（15.0.0）上均为 False。CPython 比
 * 引擎新只会把合法名称改走下标/`dict[str, Any]` 路径：可读性差些，仍然
 * 正确。NFKC 条件归结为同一偏差，因为规范化稳定性保证已分配字符的规范化
 * 此后不再改变。
 *
 * 本谓词不是引擎表的唯一读取者。{@link camelCase} 还在另外三点读取它——
 * 其拆分集合、其首字符测试、其 `toUpperCase()` 大小写映射——本谓词的判定
 * 不约束其中任何一点：只要工具模式中任一对象形态声明了 `TypedDict`，在那里
 * 派生出的类名就会进入输出文本，包括本谓词拒绝的工具。名为
 * `zz-\u{1E4D0}x` 且带此类参数的工具不会在这里触及偏差（`-` 直接将其
 * 拒绝），却会输出 `class
 * Zz\u{1E4D0}xArgs`，同一版 3.9.6 拒绝它——Nag Mundari 比它的表晚两个
 * 版本才加入。大小写映射是独立的表而非 XID 成员测试，它在上述两个条件都
 * 接受的名称上失败：`\u{019B}` 是 XID_Start 且 NFKC 稳定，本谓词接受它，
 * `async def \u{019B}` 在 3.9.6 上可编译，但 Node 把它大写为
 * `\u{A7DC}`——在那版 CPython 中未分配，其自身的 `.upper()` 在这里是恒等
 * ——于是声明的 `class \u{A7DC}Args` 以 `invalid
 * non-printable character U+A7DC` 失败。因此消除该暴露要覆盖全部四个读取
 * 点，而非仅本谓词；它需要目标解释器的版本，由报告 `language: 'python'`
 * 的后端持有；language-dispatch Agent Note 记录了这一延后。
 *
 * `ts-types` 姊妹文件保留自己的 ASCII 规则而不共用这条：ECMAScript 标识符
 * 是不同的集合（`$`）且从不被规范化，单一谓词无法对两者都正确。ZWJ/ZWNJ
 * 不是这一差异的一部分——两集合在引擎表上都包含它们；在那里区分二者的
 * 是上文的 CPython 表版本。
 * @param name - 原始模式字段名或工具名。
 * @returns 名称能否裸输出。
 */
function isBareIdentifier(name: string): boolean {
  return IDENTIFIER.test(name) && name.normalize('NFKC') === name
}

/**
 * Python 硬关键字：处处保留，因此名为 ``class`` 或 ``lambda`` 的工具或字段
 * 在传输层合法，但作为属性不合法（``tools.class`` 在模型程序中是
 * SyntaxError），也不能作为类语法的 `TypedDict` 字段。这样的工具以下标
 * 访问渲染，这样的对象降级为 ``dict[str, Any]``——模型仍能无冲突地到达
 * 每个工具和字段。
 * 软关键字（``match``、``case``、``type``、``_``——语言参考的完整集合）被
 * 刻意排除：每个只在恰好一个句法位置特殊——语句头（``match``、``type``）、
 * ``match`` 语句的子句头（``case``）或模式（``_``）——因此作为字段的
 * ``match: str`` 与作为方法的 ``async def match(...)`` 都合法，把它们包含
 * 进来会把常见的搜索/正则工具字段无谓地降级为 ``dict[str, Any]``。
 * 下划线开头的名称另行处理，不在此处：非 dunder 的 ``__token`` 会被名称
 * 改写，``object``/``type`` 上存在的 dunder 会在代理钩子之前解析，而隐式
 * 特殊方法查找完全绕过该钩子。
 */
const RESERVED = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class',
  'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global',
  'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise',
  'return', 'try', 'while', 'with', 'yield',
  // 不是关键字，但 CPython 在编译期拒绝给它赋值
  // （`SyntaxError: cannot assign to __debug__`），而这正是 TypedDict
  // 字段、参数名和关键字参数所做的事。
  '__debug__',
])

/** 本模块可能输出的 `typing` 符号，按确定性的导入顺序排列。 */
const TYPING_ORDER = ['Any', 'Literal', 'NotRequired', 'Protocol', 'TypedDict'] as const

/** 缩进 `indent` 层的行前缀（每层四个空格，与 PEP 8 输出一致）。 */
function pad(indent: number): string {
  return '    '.repeat(indent)
}

/**
 * 穿透 {@link renderType} 传递的收集器：已输出的 `TypedDict` 类声明
 * （嵌套类先于引用它们的父类）、已被占用的类名（用于冲突加后缀）、
 * 每个基名的冲突计数器，以及渲染实际用到的 `typing` 符号。
 */
interface RenderState {
  readonly classes: string[]
  readonly usedClassNames: Set<string>
  /** 每个截断基名的下一个冲突计数器，使分配为均摊 O(1) 而不是从 `2` 重新扫描。 */
  readonly nextClassCounter: Map<string, number>
  readonly typing: Set<string>
}

/**
 * 在 {@link describe} 的空白折叠后幸存且没有可打印形式的 `Cc` 码点：
 * C0 控制字符、DEL 与 C1 控制字符。只有 U+0009 到 U+000D 缺席，因为
 * ECMAScript `\s` 已把它们折叠——`\s` 是 TAB/VT/FF/SP/NBSP/ZWNBSP/Zs 加上
 * LF/CR/LS/PS，因此没有任何 C1 码点在其中，整个 U+0080 到 U+009F 块原封
 * 不动进入本规则。这些不是假设性输入：它们正是 Windows-1252 字节 0x80 到
 * 0x9F（弯引号、长破折号）按 Latin-1 解码所得。
 * CPython 直接拒绝包含 NUL 的源码
 * （`SyntaxError: source code string cannot contain null bytes`），无论它
 * 位于 docstring 还是注释中，因此模式描述里任意位置的一个这样的字节都会让
 * 整份生成的 SDK 无法解析——在 `mode: 'ptc'` 下，那是模型关于工具的唯一
 * 声明。其余字符合法但不可见；用同一规则转义它们可保持输出文本可读且
 * 处理统一。
 *
 * 边界是类别，而非逐码点的可寻址性：`\xNN` 寻址 U+0000 到 U+00FF，因此一种
 * 转义形式恰好覆盖 `Cc`。不可见的 `Cf` 格式字符按设计直接通过——其中只有
 * U+00AD 软连字符勉强能套进 `\xNN`，若只转义它而让 U+200B ZWSP、
 * U+200E/U+200F 双向标记与 U+2060 词连接符直接通过，得到的规则既不按类别
 * 也不按可寻址性成形。整个家族在两个消费方中都合法，因为只有 LF 和 CR 能
 * 终止 Python 字符串字面量或 `#` 注释。那个集合属于分词器，而不属于
 * `str.splitlines()`：NEL（U+0085）、LS（U+2028）与 PS（U+2029）会在运行
 * 期分割字符串，却不在源码中结束一个物理行——在 CPython 3.9.6 与 3.12.13
 * 上实测，两者在两种位置都被接受且值可往返——因此凡是以未转义形式进入
 * 输出文本之处它们都是安全的，对三者而言该处都是 `JSON.stringify`，共两个
 * 调用点：{@link pyScalar} 的字面量路径，以及下标工具名注释自己的那次调用
 * ——携带其中任一字符的名称必然到达后者，因为它们都不是
 * `XID_Continue`。`description` 路径按上述类别转义 NEL，并把 LS 与 PS 折入
 * {@link describe} 的 `\s+` 折叠，两者都属于 `\s`。
 */
const UNPRINTABLE = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g

/**
 * 未配对的代理码点，由 {@link describe} 以 `\uNNNN` 转义——那是它自己的
 * 形式，因为 `\xNN` 止步于 U+00FF。`u` 标志正是使其只匹配孤立者的原因：
 * Unicode 模式下格式良好的代理对是 D800 到 DFFF 之外的单个增补码点，因此
 * 描述中的 emoji 原样幸存。
 *
 * 这是 {@link UNPRINTABLE} 的 NUL 情形，而非不可见字符情形。Python 源码
 * 必须能以 UTF-8 编码，孤代理不能，因此文本中任意位置出现一个时
 * `compile()` 都会抛出 `UnicodeEncodeError: surrogates not allowed`——在
 * 3.9 上实测，字符串字面量与 `#` 注释皆然。原始或 MCP 工具描述会触及
 * 此处：对传输层 `"\ud800"` 转义做 `JSON.parse` 正好得到这样的码点。
 */
const LONE_SURROGATE = /[\ud800-\udfff]/gu

/**
 * 模式节点折叠后的单行 `description`（跨格式化扰动字节稳定），节点没有
 * 描述时为 `undefined`。每个调用方传入的都是对象——已验证的属性节点、
 * `ToolSdkSchema` 本身，或 {@link docLines} 合成的 `{ description }` 包装——
 * 因此只有 description 字段需要防护。折叠后为空（空串或纯空白）的描述
 * 同样是 `undefined`：它对节点的说明不比缺失更好，输出它会在 SDK 中留下
 * 空的 `"""` docstring 或一行孤零零的 `#   `。只有 ECMAScript 空白参与
 * 折叠，因此由空白加一个幸存控制字符组成的描述并非缺失：它会折叠为该
 * 字符可见的转义。
 *
 * 空白折叠后残留的控制字符渲染为其 `\xNN` 转义（见 {@link UNPRINTABLE}），
 * 未配对代理渲染为其 `\uNNNN` 转义（见 {@link LONE_SURROGATE}）；转义自身的
 * 反斜杠被两个消费方按字面输出，因为 {@link docLines} 将其翻倍为 Python 源码
 * 转义，而 `#` 注释原样携带它。
 */
function describe(schema: object): string | undefined {
  const description = (schema as Record<string, unknown>).description
  if (typeof description !== 'string') return undefined
  const collapsed = description
    .replace(/\s+/g, ' ')
    .replace(UNPRINTABLE, char => `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`)
    .replace(LONE_SURROGATE, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
    .trim()
  return collapsed.length === 0 ? undefined : collapsed
}

/**
 * 工具 `description` 的单行 docstring，没有描述时不产生任何行。
 * 反斜杠先加倍，每个引号都被转义，且尾部反斜杠无法幸存：以 `"` 或奇数个
 * 反斜杠结尾的描述否则会与（或转义）收尾的三引号合并，使生成的块——PTC
 * 模式下唯一的 SDK——成为语法非法的 Python。
 */
function docLines(description: unknown, indent: number): string[] {
  const collapsed = describe({ description })
  if (collapsed === undefined) return []
  const escaped = collapsed.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
  return [`${pad(indent)}"""${escaped}"""`]
}

/**
 * 把名称驼峰化为 Python 类型标识符：非标识符字符拆分单词，`_` 也拆分
 * （它属于 `XID_Continue`，因此拆分集合显式点名它），无法作为标识符开头的
 * 首字符加 `Tool` 前缀。Unicode 得以幸存，因此 `路径` 字段得到基于 `路径`
 * 的类名，而不是塌缩为裸前缀。不属于 `XID_Continue` 的字符即使是字母也
 * 拆分，因此 NFKC 折叠后会离开标识符集合的名称不会被原样带入——拆分集合
 * 是文法本身的，不是其 ASCII 近似。
 *
 * 结果做 NFKC 规范化：这些名称是生成的，从不与 JSON 键做匹配，因此在这里
 * 规范化没有代价，并使 CPython 编译所得与输出所见保持一致——不像
 * {@link isBareIdentifier} 那样必须直接拒绝不稳定的名称。在前缀决策之后
 * 再规范化，正是该性质在前缀造成的接缝处成立的原因：`Tool` +
 * 组合符号开头会在那里复合（`U+0301` 得到 `Tooĺ`，U+013A），因此只规范化
 * 未加前缀的部分会输出一个 CPython 编译为另一符号的名称。第二次调用在
 * 未加前缀的分支上是幂等的。
 *
 * 拆分集合、首字符测试与 `toUpperCase()` 都读取引擎的 Unicode 表，因此本
 * 函数以独立于 {@link isBareIdentifier} 的路径携带其记录的同一版本偏差：
 * 只要工具模式中任一对象形态声明了 `TypedDict`，这里派生的类名就会进入
 * 输出文本，而谓词对工具名的判定不约束它。大小写映射是唯一可能在本谓词
 * 已接受的名称上失败的一环；实际示例见彼处。
 * @param raw - 用于派生的模式字段名或工具名。
 * @returns 可安全输出的类名片段。
 */
function camelCase(raw: string): string {
  const joined = raw
    .split(/[^\p{XID_Continue}]+|_+/u)
    .filter(part => part.length > 0)
    .map(part => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join('')
    .normalize('NFKC')
  return (/^\p{XID_Start}/u.test(joined) ? joined : `Tool${joined}`).normalize('NFKC')
}

/** 类名基名上限，使每个输出的名称——以及总文本量——随模式深度保持线性。 */
const MAX_CLASS_NAME_BASE = 120

/**
 * 一个注解中在元素类型降级为 `Any` 之前可输出的最深 `list[…]` 嵌套。
 * CPython 的分词器拒绝同时打开超过 200 个括号的逻辑行（`MAXLEVEL`、
 * `SyntaxError: too many nested parentheses`），因此更深的数组链会渲染出
 * 一个完全不是合法 Python 的 SDK 块——与 {@link docLines} 中 docstring
 * 转义要防止的失败同类。180 为注解可能围绕链添加的少数括号留出余量，它们
 * 全部计入同一上限。按输出位置计数链最内点处打开的括号：
 *
 * - 返回注解，`async def f(self, args: X) -> chain:` — 180 个 `list[`
 *   加最内层的 `Literal[`。参数列表的 `(` 在 `->` 之前的 `)` 处闭合，因此
 *   此处并未打开：181。
 * - TypedDict 字段，`field: NotRequired[chain]` — 类体内一行，没有其他
 *   打开的括号，其子节点从 `listDepth: 1` 起算以预留 `NotRequired[`，
 *   因此 179 个 `list[` 加 `Literal[`：181。必填字段为统一性共用该起点，
 *   花费一层可表达深度在不输出的括号上。
 * - 参数注解，`async def f(self, args: chain) -> Y:` — `(` 在其周围仍然
 *   打开：180 个 `list[` 加 `Literal[` 加该圆括号，182，最坏情况。只能通过
 *   原始 `register()` 到达，其 `parameters` 是从根出发仅经 `oneOf` 分支
 *   到达的数组——根数组本身，或嵌套在任意深度并集下的数组，因为分支原样
 *   继承外层深度（`A | B` 不打开括号）。有对象祖先便脱离此情形：其字段在
 *   181 处重新起算链。`defineTool` 编译对象根，因此注解是裸的 TypedDict
 *   类名，或该对象降级时的单括号 `dict[str, Any]`——绝不会是链。
 *
 * 这是 CPython 文法限制，不是部署选择，因此固定而非可配置。姊妹的
 * `ts-types` 渲染器无需对应物：TypeScript 文法不限制嵌套，其 SDK 块也从不
 * 做类型检查。只有括号嵌套计数——`oneOf` 渲染为扁平的 `A | B` 链，嵌套
 * 对象渲染为独立的 `class` 语句，二者在任何深度都不累积打开的括号。此上限
 * 服务的不变量是文法有效性；刻意不设上限的那一个解释器限制见
 * {@link renderType} 的 `oneOf` 分支。
 */
const MAX_LIST_NESTING = 180

/**
 * 把类名基名截断到 {@link MAX_CLASS_NAME_BASE}（截断为何保持渲染线性，
 * 见各调用方）。`slice` 按 UTF-16 码元计数，跨越边界的增补字符会被切成
 * 两半并留下孤代理——它不是标识符字符，甚至不是格式良好的文本；丢弃它
 * 而不是输出它。
 */
function capClassNameBase(base: string): string {
  if (base.length <= MAX_CLASS_NAME_BASE) return base
  const capped = base.slice(0, MAX_CLASS_NAME_BASE)
  return /[\uD800-\uDBFF]$/.test(capped) ? capped.slice(0, -1) : capped
}

/**
 * 从基名预留唯一的类名，冲突时加后缀 `2`、`3`、…。基名先截断到
 * {@link MAX_CLASS_NAME_BASE}：子类名从父级已分配的名称派生
 * （`ParentChild`），否则由单字段对象构成的无界模式会让每个名称每层增长
 * 一个字段，所有名称之和达到 Θ(depth²)。截断基名使每个名称——以及总输出
 * 文本——随深度保持线性。冲突从 `state.nextClassCounter` 中每基名的
 * 计数器继续，而不是从 `2` 重新扫描，因此共享同一截断基名的深链每次分配
 * 保持 O(1)（均摊），而非时间上的 Θ(depth²)。
 */
function allocateClassName(base: string, state: RenderState): string {
  const capped = capClassNameBase(base)
  let name = capped
  if (state.usedClassNames.has(name)) {
    let n = state.nextClassCounter.get(capped) ?? 2
    while (state.usedClassNames.has(`${capped}${n}`)) n++
    name = `${capped}${n}`
    state.nextClassCounter.set(capped, n + 1)
  }
  state.usedClassNames.add(name)
  return name
}

/**
 * 把子名称片段追加到父类名基名之后，并将结果截断到
 * {@link MAX_CLASS_NAME_BASE}。在传播时截断（而不只在
 * {@link allocateClassName} 内部）使每层保持 O(1)：否则深的 `oneOf` 链或
 * 对象链会携带不断增长的 ConsString 沿树下行，并在每一层（经
 * `.length`/`.slice`）重新物化——Θ(depth²)。有界的基名加冲突计数器仍能
 * 产生唯一的名称。
 *
 * 连接时做 NFKC 规范化，因为两侧各自规范化，其拼接却未必：以韩文 L 字母或
 * LV 音节结尾的基名会与后续的 V 或 T 字母开头复合（`가` +
 * `ᆨ` 得到 `각`），于是输出的类名会不同于 CPython 编译出的符号，且两个
 * 字节不同的名称可能折叠为一个——`usedClassNames` 按原始字节去重，冲突
 * 计数器看不到这种折叠。规范化每层花费 O(cap + segment)，与它供数的
 * `slice` 同阶。另外两个连接点无需对应处理：`Args`/`Output` 以 `A`/`O`
 * 开头，{@link allocateClassName} 的后缀是数字，均不会向后复合。
 */
function childClassName(base: string, segment: string): string {
  return capClassNameBase(`${base}${segment}`.normalize('NFKC'))
}

/**
 * 把一个已验证的标量渲染为 Python 字面量文本（`True`/`False`、JSON 引号
 * 字符串、裸数字）。`null` 到不了这里：`null` 类型直接渲染为 `None`，且
 * 统一验证器在其他每个标量类型上都拒绝 null 的 `const`/`enum` 条目。
 *
 * 超出安全范围的整数取 `BigInt` 数字而非 `String`：Python 整数是任意精度，
 * 因此输出的数字就是模型编程所依据的值，而 `String` 可能给出与双精度数所存
 * 不同的整数（`2 ** 60` 打印舍入后的 `...847000`，而非精确的 `...846976`），
 * 或根本不产生整数字面量（`1e21` 打印 `1e+21`）。`String` 的舍入不是它的
 * 缺陷：`Number::toString` 输出重读回同一双精度数的最短十进制字符串，再用
 * 零补齐到指数（`1e20` 为 1 位有效数字，`2 ** 60` 为 16 位）——当最短
 * 字符串短于该双精度数的精确值时，那些补上的数字命名的是一个没有任何
 * 双精度数持有的整数。把它传回去必须以 JSON 数字跨越参数边界——又一次是
 * 双精度数——于是 SDK 会记载一个任何程序都无法传入的值。`BigInt` 无需分
 * 情形：在 `String` 本就精确之处（`2 ** 53`、`1e20`）二者逐字节一致，在
 * 不精确之处，`BigInt` 就是精确的那个。TS 风味完全无需对应物：其字面量由
 * JS 解析器重读回同一双精度数。
 *
 * `JSON.stringify` 也是保持本路径输出可解析的机制，且是唯一的机制。它覆盖
 * 两类危险：CPython 在源码中任何位置都拒绝的两类码点——C0 控制字符中的
 * NUL，以及整个 D800–DFFF 孤代理块（在 ES2019 良构字符串化下转义，引擎
 * 版本范围保证这一点）——以及专门破坏本行的那些：提前闭合字面量的裸 `"`、
 * 吃掉收尾引号的尾部奇数反斜杠，以及在终止符之前结束它的裸 LF/CR。
 * `description` 路径携带 {@link UNPRINTABLE} 与 {@link LONE_SURROGATE}，
 * 因为没有东西给它加引号，并在 {@link describe} 中折叠换行。
 *
 * 这依赖一个值得点名的巧合：`JSON.stringify` 能输出的每个转义（`\"`、
 * `\\`、`\b`、`\f`、`\n`、`\r`、`\t`、`\uXXXX`）同时也是表示同一字符的
 * Python 转义，因此输出的 `Literal[...]` 既可解析，又解码回模式声明的值。
 * DEL、C1 控制字符（含 NEL）与 LS/PS（U+2028/U+2029）确实以原始形式到达
 * 它——合法但不可见，与 TS 风味逐字节相同；转义它们属于两个风味同时改动。
 * 最后三者在此合法的理由即 {@link UNPRINTABLE} 所记：它们是
 * `str.splitlines()` 的边界，不是分词器的行终止符。下标工具名注释经它自己
 * 对同一 `JSON.stringify` 的调用引用名称，从不经过本函数，因而继承两半
 * ——转义与直通皆然。
 */
function pyScalar(value: JsonSchemaScalar): string {
  if (value === true) return 'True'
  if (value === false) return 'False'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
    return BigInt(value).toString()
  }
  return String(value)
}

/**
 * 把已验证的标量 `const`/`enum` 渲染为 `Literal[...]`，否则回退到宽类型。
 * 刻意偏离 PEP 586——它把 `Literal` 参数限制为 int/bool/str/bytes/enum/None：
 * 非整数数值的 `const`/`enum` 会输出 float 字面量（`Literal[1.5]`），严格的
 * 检查器会拒绝。整数情形不偏离——{@link pyScalar} 输出 int 数字，包括它经
 * `BigInt` 拓宽的超安全范围值，而 PEP 586 接受 int 参数。两种方式都无害
 * ——该 stub 属建议性提示词文本，只需可解析——保留精确值能向模型传达该
 * 约束。
 */
function renderConstrainedScalar(node: JsonSchemaNode, broad: string, state: RenderState): string {
  if (node.const !== undefined) {
    state.typing.add('Literal')
    return `Literal[${pyScalar(node.const)}]`
  }
  if (node.enum !== undefined) {
    state.typing.add('Literal')
    return `Literal[${node.enum.map(pyScalar).join(', ')}]`
  }
  return broad
}

/**
 * 把一个 JSON-Schema 节点映射为 Python 类型表达式，穿传 `state` 以收集
 * 完整渲染所需的 `TypedDict` 声明与 `typing` 符号。`className` 是赋给带
 * properties 的对象节点的名称（也是其嵌套对象的前缀）。处理每种统一模式
 * 构造——`oneOf`（→ `X | Y`）、`const`/`enum`（→ `Literal[...]`）、
 * `integer`（→ `int`）、`null`（→ `None`）——并把不支持或畸形的模式降级
 * 为 `Any` 而不抛出，与姊妹的 {@link ./ts-types.ts | ts-types} 渲染器同样
 * 的"验证后信任"立场。{@link jsonSchemaToPy} 是无上下文的入口；这里是
 * 收集核心。
 */
function renderType(schema: unknown, className: string, state: RenderState): string {
  interface Frame {
    // 已过根级 `assertSupportedJsonSchema` 的已验证 JSON-Schema 节点
    // （根帧的 schema 在构建任何帧之前先做断言），因此遍历读取其字段无需
    // 类型断言——与姊妹 ts-types 渲染器相同的带类型帧结构。
    schema: JsonSchemaNode
    className: string
    phase: 'start' | 'children'
    kind?: 'oneOf' | 'array' | 'typeddict'
    node?: JsonSchemaNode
    /** 在正在构建的注解中包围本节点的已打开 `list[` 括号数（{@link MAX_LIST_NESTING}）。 */
    listDepth: number
    children: { schema: JsonSchemaNode; className: string; listDepth: number }[]
    childIndex: number
    childTypes: string[]
    entries: [string, JsonSchemaNode][]
    allocated?: string
  }
  const newFrame = (schema: JsonSchemaNode, className: string, listDepth: number): Frame =>
    ({ schema, className, phase: 'start', listDepth, children: [], childIndex: 0, childTypes: [], entries: [] })
  try {
    // 先一次性验证整棵树，然后信任它——姊妹 ts-types 渲染器在带类型的
    // 同进程边界处遵循的同一契约。此点之后的每个节点都是已验证的
    // JSON-Schema 节点，遍历读取其字段无需复查。不支持或畸形的模式在此
    // 抛出（在任何输出之前）并降级为 `Any`，即 TS 风味 `unknown` 的
    // Python 对应物。
    assertSupportedJsonSchema(schema)
    const frames: Frame[] = [newFrame(schema, className, 0)]
    let result: string | undefined
    /* jscpd:ignore-start -- 显式栈遍历骨架刻意与
       ts-types.ts 的 renderSupportedSchema 平行；两个姊妹渲染器保持对称的结构。 */
    const finish = (type: string): void => {
      frames.pop()
      const parent = frames.at(-1)
      if (parent === undefined) result = type
      else parent.childTypes.push(type)
    }

    while (frames.length > 0) {
      const frame = frames.at(-1)
      /* v8 ignore next -- 循环条件保证当前帧存在。 */
      if (frame === undefined) break

      if (frame.phase === 'children') {
        if (frame.childIndex < frame.children.length) {
          const child = frame.children[frame.childIndex]
          /* v8 ignore next -- childIndex 受 children.length 约束。 */
          if (child === undefined) throw new Error('missing python render child')
          frame.childIndex++
          frames.push(newFrame(child.schema, child.className, child.listDepth))
          continue
        }
        if (frame.kind === 'oneOf') {
          // 增量拼接（模板字符串，而非 `Array.join`）：V8 会构建惰性
          // ConsString，因此深的 oneOf 链只在根部物化一次，而不是在每层
          // 重新物化累积的字符串（`join` 正会如此，使其成为 Θ(depth²)）。
          // 这与数组分支的模板字符串惰性以及 ts-types 的可组合文档方法
          // 一致——整个遍历随模式深度保持线性。
          let union = ''
          for (const [index, childType] of frame.childTypes.entries()) {
            union = index === 0 ? childType : `${union} | ${childType}`
          }
          finish(union)
          continue
        }
        /* jscpd:ignore-end */
        if (frame.kind === 'array') {
          // Python 中 `list[A | B]` 不需要圆括号。数组帧总是恰好调度一个
          // 子节点，因此其类型必然存在。
          /* v8 ignore next -- ?? 分支需要无子节点的数组帧，而 start 从不构建它。 */
          finish(`list[${frame.childTypes[0] ?? 'Any'}]`)
          continue
        }
        // typeddict：在子节点之后组装，使本类引用的任何嵌套类均已声明
        // （声明顺序 = 引用顺序）。
        const node = frame.node
        const name = frame.allocated
        /* v8 ignore next -- typeddict 帧总在 start 时设置 node 与 allocated。 */
        if (node === undefined || name === undefined) throw new Error('missing typeddict frame state')
        const required = new Set(node.required)
        const lines = [`class ${name}(TypedDict):`]
        for (let index = 0; index < frame.entries.length; index++) {
          const entry = frame.entries[index]
          const fieldType = frame.childTypes[index]
          /* v8 ignore next -- entries 与 childTypes 一一对应。 */
          if (entry === undefined || fieldType === undefined) throw new Error('missing typeddict field type')
          const [field, fieldSchema] = entry
          // 父节点已通过 assertSupportedJsonSchema，因此每个属性值都是
          // 已验证的模式节点。
          const description = describe(fieldSchema)
          if (description !== undefined) lines.push(`${pad(1)}# ${description}`)
          if (required.has(field)) {
            lines.push(`${pad(1)}${field}: ${fieldType}`)
          } else {
            state.typing.add('NotRequired')
            lines.push(`${pad(1)}${field}: NotRequired[${fieldType}]`)
          }
        }
        // TypedDict 语法无法表达开放性，因此开放对象带内声明它：注解无论
        // 如何都是建议性的，且 `mode: 'ptc'` 省略原生模式，使这一行成为模型
        // 得知接受额外键的唯一信号。
        if (node.additionalProperties !== false) {
          lines.push(`${pad(1)}# Additional keys beyond those declared are allowed.`)
        }
        // 封闭的空对象仍需类体（`pass`）才是合法 Python；声明的空本身就是
        // 信息。
        if (lines.length === 1) lines.push(`${pad(1)}pass`)
        state.classes.push(lines.join('\n'))
        finish(name)
        continue
      }

      frame.phase = 'children'
      const node = frame.schema
      if (node.oneOf !== undefined) {
        frame.kind = 'oneOf'
        // 并集渲染为 `A | B`——自身不带括号，因此分支原样继承外层深度。
        //
        // 并集长度刻意不设上限，与列表嵌套不同。两个限制性质不同：超过 200
        // 个打开括号是来自分词器的 SyntaxError，文本就不是 Python；长的
        // `A | B | …` 链在任意长度都文法有效，只有当 `compile()` 走左嵌套
        // BinOp 主干时才会击败 CPython 的 C 递归（实测：1,000 个分支可编译，
        // 5,000 个抛出 RecursionError）。本块是提示词文本——没有东西编译它
        // ——因此该限制在此毫无代价，而设上限会淘汰固定遍历线性时间与类名
        // 传播上限的深链测试。本渲染器坚持的标准是文法有效性，不是在某个
        // 解释器栈下的可编译性。
        frame.children = node.oneOf.map((branch, index) => ({ schema: branch, className: childClassName(frame.className, `${index + 1}`), listDepth: frame.listDepth }))
        continue
      }
      if (node.type === undefined) {
        state.typing.add('Any')
        finish('Any')
        continue
      }
      switch (node.type) {
        case 'string': finish(renderConstrainedScalar(node, 'str', state)); break
        case 'number': finish(renderConstrainedScalar(node, 'float', state)); break
        case 'integer': finish(renderConstrainedScalar(node, 'int', state)); break
        case 'boolean': finish(renderConstrainedScalar(node, 'bool', state)); break
        case 'null': finish('None'); break
        case 'array': {
          if (node.items === undefined) {
            state.typing.add('Any')
            finish('list[Any]')
            break
          }
          // 超过 MAX_LIST_NESTING 后再加一层 `list[` 会把注解推过 CPython
          // 的打开括号上限，使整个 SDK 块无法解析，因此链在此处降级
          // ——两种方式都无法使用，但这一种是合法 Python。
          if (frame.listDepth >= MAX_LIST_NESTING) {
            state.typing.add('Any')
            finish('Any')
            break
          }
          // 对象数组以该数组字段命名其元素类型。
          frame.kind = 'array'
          frame.children = [{ schema: node.items, className: frame.className, listDepth: frame.listDepth + 1 }]
          break
        }
        case 'object': {
          // 缺失的 `properties` 是空属性表，与统一验证器和 TS 渲染器的读取
          // 完全一致——不是未知形态。由此得到的空对象的开放性在下方决定，
          // 因此封闭的空对象仍声明空的 TypedDict，而不是宽松的
          // `dict[str, Any]`。
          const entries = Object.entries(node.properties ?? {})
          // 空的 `className` 标记无上下文的 `jsonSchemaToPy` 入口：没有可
          // 声明类名的命名上下文，因此降级。这里读取的是调用方传入的
          // className，而非 `frame.className`：该标记属于整趟遍历，帧会传播
          // 派生名（无上下文根的 `oneOf` 分支得到按索引派生的名称 `1`——
          // `childClassName` 只是拼接并截断，不经过 `camelCase`），逐帧读取
          // 会以一个连合法标识符都不是的名称声明调用方无从接收的类：
          // `class 1(TypedDict):`。不是合法 Python 属性的字段名无法表达为
          // 类语法的 `TypedDict` 字段，因此这样的对象整体降级。
          // 双下划线开头的非 dunder 字段（`__token`）会在类语法内被名称
          // 改写（`_ClassName__token`），描述的是与注册模式不同的 JSON 键
          // ——像其他任何无法表达的字段名一样降级。
          if (className === '' || !entries.every(([name]) => isBareIdentifier(name) && !RESERVED.has(name) && !(name.startsWith('__') && !name.endsWith('__')))) {
            state.typing.add('Any')
            finish('dict[str, Any]')
            break
          }
          // 开放的空对象即任意 dict；封闭的空对象声明空的 TypedDict，使
          // "不接受任何键"延续进 SDK。
          if (entries.length === 0 && node.additionalProperties !== false) {
            state.typing.add('Any')
            finish('dict[str, Any]')
            break
          }
          frame.kind = 'typeddict'
          frame.node = node
          frame.allocated = allocateClassName(frame.className, state)
          state.typing.add('TypedDict')
          frame.entries = entries
          // 字段注解自成一条逻辑行，因此嵌套重新起算——从 1 开始，为可选
          // 字段包裹它的 `NotRequired[…]` 括号预留。frame.allocated 已在
          // 上方三条语句处赋值；?? 分支只为类型系统存在。
          /* v8 ignore next -- 构建 children 之前 allocated 总已设置。 */
          frame.children = entries.map(([field, child]) => ({ schema: child, className: childClassName(frame.allocated ?? '', camelCase(field)), listDepth: 1 }))
          break
        }
        /* v8 ignore next 4 -- assertSupportedJsonSchema 已收窄此封闭类型联合。 */
        default: {
          state.typing.add('Any')
          finish('Any')
        }
      }
    }
    /* v8 ignore next -- 每个根帧产出一个表达式。 */
    return result ?? 'Any'
  } catch {
    // 不支持或畸形的模式未通过验证（在任何输出之前），或某个不可达的内部
    // 不变量被触发。二者都把节点降级为 `Any` 而不是让提示词组装崩溃
    // ——即 TS 风味 `unknown` 回退的 Python 对应物。
    state.typing.add('Any')
    return 'Any'
  }
}

/**
 * 把一个 JSON-Schema 节点映射为 `typing` 模块的无上下文 Python 类型表达式。
 * 处理每种统一模式构造——`object`（降级为 `dict[str, Any]`：命名一个
 * `TypedDict` 需要 {@link renderToolsSdkPy} 提供的渲染上下文）、
 * `const`/`enum`（→ `Literal[...]`）、`oneOf`（→ 并集）、
 * `string`/`number`/`integer`/`boolean`/`null`、`array`（`items` →
 * `list[T]`）——对不支持或畸形的模式返回 `Any`，与 TS 风味的 `unknown`
 * 回退一致。输出 SDK 中的类型注解仅供建议：Python 不在运行时强制它们。
 * @param schema - JSON-Schema 节点。
 * @returns Python 类型文本。
 */
export function jsonSchemaToPy(schema: unknown): string {
  // 一次性状态，其类收集器从不外泄：带 properties 的对象无处声明其
  // TypedDict，降级为 dict[str, Any]。renderToolsSdkPy 驱动命名
  // TypedDict 路径。
  return renderType(schema, '', { classes: [], usedClassNames: new Set(), nextClassCounter: new Map(), typing: new Set() })
}

/** 渲染在声明之上的固定模型可见用法契约。 */
const SDK_INSTRUCTIONS = `## Writing code for run_code

\`run_code\` takes two required arguments: \`code\`, the program to execute, and \`description\`, a short summary of what the program does. At run time exactly two of the names declared below are bound: \`tools\` and \`ToolCallError\`. Everything else is a STATIC STUB describing argument and return types — in particular the \`TypedDict\` classes do NOT exist at run time, so build arguments as plain \`dict\`/\`list\` JSON values: \`await tools.name({"field": 1})\`, never \`FooArgs(field=1)\`, which raises \`NameError\`. Inside the program:

- Call tools as \`await tools.name(args)\` — subscript access for exotic, reserved, or underscore-leading names: \`await tools["my-tool"](args)\`. Every call resolves to the tool's typed canonical JSON value (each method's return type below). Tool arguments must be lossless JSON.
- A FAILED tool call raises \`ToolCallError\`, whose \`toolName\` identifies the failed tool and whose message is human-readable — wrap in \`try/except\` to handle and continue.
- Independent read-only calls MAY overlap under \`asyncio.gather\` (safe calls run concurrently; mutating calls run alone, in submission order). Sequence dependent work with \`await\`.
- Only values emitted as program output enter the conversation. A successful tool result containing an image is attached after the run so you can inspect it on the next step; every other intermediate result stays out of the conversation, so extract just what you need.

The available tools:`

/**
 * 在 `runtime.language === 'python'` 下渲染完整的 `tools:sdk` 提示词节：
 * Python 风味的用法说明，外加每个工具参数或输出对象（以及每个嵌套对象）
 * 一个命名 `TypedDict`、`Tools` 协议上每个可见工具一个可等待方法——类型化
 * 参数进入、工具的规范输出值返回——并带一个模型调用的 `tools: Tools`
 * 单例。`typing` 导入行列出的恰好是渲染实际用到的符号。确定性——工具按
 * 名称字典序输出，类声明以同一顺序先于协议（嵌套类先于引用它们的父类），
 * 因此不变的工具集在多次组装间产生逐字节相同的文本。该排序对字节相同的
 * 名称不是全序，因此共享名称的两个模式会按参数顺序渲染；调用方的可见能力
 * 表以名称为键，输入因此绝不含重复。
 * @param schemas - 待声明的工具模式与规范输出模式
 *   （调用方已排除 `run_code` 本身）。
 * @returns 完整的节文本。
 */
export function renderToolsSdkPy(schemas: ToolSdkSchema[]): string {
  const sorted = [...schemas].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  const state: RenderState = { classes: [], usedClassNames: new Set(), nextClassCounter: new Map(), typing: new Set(['Protocol']) }
  // 唯一一条有序成员流，与已记载的字典序契约和 TypeScript 风味一致
  // （后者原位引用特殊键，而不是把它们分拆出去）。在此交错没有代价：
  // 两条 `async def` 行之间的注释行不是语句，不改变类体的解析方式。
  const members: string[] = []
  let statements = 0
  for (const schema of sorted) {
    const argType = renderType(schema.parameters, `${camelCase(schema.name)}Args`, state)
    const outputType = renderType(schema.output, `${camelCase(schema.name)}Output`, state)
    if (isBareIdentifier(schema.name) && !RESERVED.has(schema.name) && !schema.name.startsWith('_')) {
      // 只有作为方法体的第一条语句时，docstring 才记录该方法。若在
      // `async def` 之前输出，它会变成 `Tools` 类的 docstring（第一个工具）
      // 或死表达式（之后每个工具），使所有方法都无文档——而在
      // `mode: 'ptc'` 下这份 SDK 是模型了解工具作用的唯一描述。docstring
      // 本身就是完整的方法体，`...` stub 只用于无描述的情形。
      const doc = docLines(schema.description, 2)
      members.push(doc.length > 0
        ? `${pad(1)}async def ${schema.name}(self, args: ${argType}) -> ${outputType}:`
        : `${pad(1)}async def ${schema.name}(self, args: ${argType}) -> ${outputType}: ...`)
      members.push(...doc)
      statements += 1
    } else {
      // 无法作为 ``tools.name`` 访问——模型经 ``tools[name]`` 到达它。
      // 特殊名称与硬关键字根本不是合法属性；下划线开头的名称（``_foo``）
      // 是合法属性，但仍路由到这里，因为破坏访问的形式分三类——非 dunder
      // 的 ``__token`` 在调用处被名称改写，``object``/``type`` 上存在的
      // dunder（``__class__``、``__doc__``）在 ``__getattr__`` 运行前就已
      // 解析，而隐式特殊方法查找完全跳过该钩子——对整个家族用一条规则毫无
      // 代价，而逐形式规则就得逐一枚举（见 {@link RESERVED}）。stub 以
      // 下标注释列出它（同时引用命名的 TypedDict），让读者看到哪些可访问；
      // 运行期解析经代理的 __getitem__。
      members.push(`${pad(1)}# tools[${JSON.stringify(schema.name)}](args: ${argType}) -> ${outputType}`)
      const description = describe(schema)
      if (description !== undefined) members.push(`${pad(1)}#   ${description}`)
    }
  }
  // 下标条目是注释，不是语句：只有注释的类体无法解析，因此凡未输出任何
  // 方法时都需要 `pass`——包括只有下标条目的工具集。
  const bodyLines = statements > 0 ? members : [`${pad(1)}pass`, ...members]
  const body = bodyLines.join('\n')
  const imports = TYPING_ORDER.filter(symbol => state.typing.has(symbol))
  const classBlock = state.classes.length > 0 ? `${state.classes.join('\n\n')}\n\n` : ''
  const errorDeclaration = 'class ToolCallError(Exception):\n    toolName: str'
  const declaration = `from typing import ${imports.join(', ')}\n\n${errorDeclaration}\n\n${classBlock}class Tools(Protocol):\n${body}\n\ntools: Tools`
  return `${SDK_INSTRUCTIONS}\n\n\`\`\`python\n${declaration}\n\`\`\``
}
