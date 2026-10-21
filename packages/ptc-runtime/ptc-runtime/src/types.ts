/**
 * PTC 执行 seam 的词汇类型：调用方交给 {@link ../index.ts | PtcRuntime} 什么，
 * 以及拿回什么。纯类型 —— 此处不存放任何运行时代码。
 *
 * @module @deepseek-ai/dsh-ptc-runtime/src/types
 */

import type { SandboxEnforcement, SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'

/**
 * 以异步可调用形式暴露给程序的一个宿主侧函数。运行时会桥接对它的调用
 * （可能跨越序列化边界），因此 `args` 与决议值必须是无损 JSON。运行时遇到有损
 * 或不可克隆的值时，会以描述性错误拒绝，而不是破坏这次运行。seam 层面不对绑定
 * 决议值施加字节上限。该函数的拒绝会以对应调用被拒绝的形式呈现于程序内部。
 */
export type PtcBindingFunction = (args: unknown) => Promise<PtcJsonValue>

/** 可经由依赖精简的 Service Definition 传输的无损 JSON 值。 */
export type PtcJsonValue = null | boolean | number | string | PtcJsonValue[] | { [key: string]: PtcJsonValue }

/**
 * 某个绑定命名空间在程序可见的类型化拒绝形式。运行时会在 `name` 下注入一个
 * 真实的错误构造器；被拒绝的成员调用成为它的实例，并通过 `memberNameProperty`
 * 暴露精确的成员名。两个字符串都是运行时数据，而不是对某个具体消费者
 * （例如 PTC 模式）的假定。
 */
export interface PtcBindingErrorClass {
  /** 构造器全局名与结果中的 `Error.name`；与 {@link PtcBindingNamespace.global} 使用同一套可移植标识符规则。 */
  name: string
  /**
   * 承载成员名的非空自有属性。可移植排除集是 `RESERVED_ERROR_MEMBERS` 加上
   * dunder 形式名（`__x__`，中间非空），由各后端一致执行；其他任何名称 ——
   * 无论是否为标识符 —— 都在所有后端被接受。
   */
  memberNameProperty: string
}

/**
 * 运行时以单个全局对象（例如 `tools`）暴露给程序的一组具名
 * {@link PtcBindingFunction}。函数名是任意字符串 —— 运行时必须把 `__proto__`、
 * `constructor` 这类名称当作普通自有属性（null 原型构造），绝不能视为原型冲突。
 */
export interface PtcBindingNamespace {
  /**
   * 程序看到的全局标识符。必须匹配语言可移植标识符子集 `[A-Za-z_][A-Za-z0-9_]*`，
   * 且不属于任何语言的保留字，这样同一份命名空间列表在任意后端都成立，与 `language`
   * 无关 —— 像 `$tools` 这种只有 JS 能用的拼写，是设计上就被拒绝的，而非仅在
   * Python 后端被拒绝。满足标识符规则但指向后端自有槽位的名称
   * （`RESERVED_BINDING_GLOBALS`，例如 `console`、`__dsh_main__`）同样在所有后端被拒绝；
   * 完整集合与每条的保留理由见其声明处。
   */
  global: string
  /** 可调用成员，键为程序调用时使用的精确名称。 */
  functions: Record<string, PtcBindingFunction>
  /** 该命名空间可选的程序可见类型化拒绝契约。 */
  errorClass?: PtcBindingErrorClass
}

/**
 * 单个程序的调用方输入。provider 的 resolve 方法会在执行前校验受支持的选项，
 * 并补全工作目录、截止时间与权限。
 */
export interface PtcRunRequest {
  /**
   * 程序源码，使用运行时的 {@link ../index.ts | language}。它遵循 provider 的
   * programFormat：async 函数体支持顶层 `await` 与 `return`；REPL 支持顶层声明、
   * `await` 与末尾表达式。完成值即 {@link PtcRunResult.value}。
   */
  program: string
  /**
   * 可选内存状态的对象标识所有者。省略表示请求一个全新环境。
   * 所有者生命周期结束时，消费者必须 await runtime.release(owner)。
   * 无状态 provider 忽略该字段；保留状态从不持久化。
   */
  stateOwner?: object
  /** 暴露给程序的宿主函数，每个命名空间一个全局对象。 */
  bindings: PtcBindingNamespace[]
  /** 已挂载文件系统与子进程执行世界中的工作目录。 */
  cwd?: string
  /**
   * 以毫秒计的执行时间预算。省略时使用 provider 默认值；null 表示不设截止时间。
   * provider 会校验并为数值预算设限，或拒绝不受支持的取值。
   */
  timeoutMs?: number | null
  /** 本次执行所解析出的权限。不具备隔离能力的 provider 会拒绝显式策略。 */
  sandboxPolicy?: SandboxExecutionPolicy
  /**
   * 中止本次运行：运行时停止程序（硬停止，即使在循环中途），并以 kind 为
   * `'abort'` 的 {@link PtcRunFailure} 决议。进行中的绑定调用由调用方自行了结 ——
   * 运行时只是不再继续请求。
   */
  signal?: AbortSignal
}

/** 已完全解析的执行输入；run 绝不替调用方补上缺失的目录或截止时间选择。 */
export interface PtcRunSpec extends PtcRunRequest {
  /** provider 执行世界中的绝对目录。 */
  cwd: string
  /** provider 设限之后的正有限执行时间预算（毫秒），或 null 表示无截止时间。 */
  timeoutMs: number | null
}

/** 施加于程序的文件隔离，与其最终成败无关。 */
export interface PtcRunSandbox {
  /** 本次执行使用的文件效果模式。 */
  mode: SandboxMode
  /** 程序失败文本命中了后端诊断特征；这不是强制执行的证明，也不是完整的拒绝记录。 */
  denied: boolean
  /** 所选隔离后端报告的完备性；完全访问时缺省。 */
  enforcement?: SandboxEnforcement
}

/**
 * 一次运行为何失败。这些 kind 是彼此正交、各自独立上报的结果
 * （参见 docs/defensive-patterns/general.md）：预算耗尽不是异常，中止不是超时，
 * 执行基座死亡既不是前者也不是后者。
 *
 * - `'exception'` —— 程序抛出异常，或解析/转换失败。
 * - `'timeout'` —— 实现方自有的预算到期；消息会说明是哪一项。
 * - `'abort'` —— {@link PtcRunRequest.signal} 被触发。
 * - `'worker-exit'` —— 执行基座未给出结果就退出了（例如 OOM）。
 * - `'invalid-output'` —— 完成值不是无损 JSON。
 * - `'output-limit'` —— 序列化后的外层日志/值/诊断超出配置上限。
 * - `'protocol'` —— 程序发送了非法或超预算的控制流量。
 * - `'sandbox-unavailable'` —— 无法建立所需的隔离。
 */
export interface PtcRunFailure {
  /** 失败类别（各 kind 的含义见接口文档）。 */
  kind: 'exception' | 'timeout' | 'abort' | 'worker-exit' | 'invalid-output' | 'output-limit' | 'protocol' | 'sandbox-unavailable'
  /** 人类可读的细节，适合回喂给模型让它自行纠错。 */
  message: string
}

/**
 * 一次运行的结果。错误是已决议结果上的一个字段，绝不是 `run()` 的拒绝 ——
 * 上报程序失败是调用方的职责，而不是异常路径。
 */
export interface PtcRunResult {
  /** 当 provider 执行文件策略时，所应用的文件策略与观测到的拒绝。 */
  sandbox?: PtcRunSandbox
  /**
   * 程序的完成值（return 或 REPL 末尾表达式），当程序运行至结束且该值跨过了运行时的
   * 无损 JSON 边界时存在。非法或超限的完成值会让本次运行失败，而不是替换成一段
   * 渲染出来的字符串；失败或无值的运行不含该字段。
   */
  value?: PtcJsonValue
  /**
   * 捕获到的文本。每个来源通道各自保持发送顺序；相互独立的通道之间如何交错
   * 取决于后端。仅作为外层结果的一部分受限。
   */
  logs: string[]
  /** 仅在运行失败时存在；分类体系见 {@link PtcRunFailure}。 */
  error?: PtcRunFailure
}
