/**
 * 由有界进程通道承载的 JSON 消息词汇。宿主会校验每一条消息，
 * 因为模型代码可以直接往继承来的描述符里写。
 * @module @deepseek-ai/dsh-ptc-runtime-node/src/protocol
 */

import type { PtcJsonWire } from './json-wire.ts'

/** 就绪握手之后，宿主交给程序的内容。 */
export interface ProgramBootData {
  /** 已剥离类型的（纯 JS）程序体。 */
  code: string
  /** 需要具现化的绑定命名空间；函数本身留在宿主侧。 */
  namespaces: {
    global: string
    names: string[]
    errorClass?: { name: string; memberNameProperty: string }
  }[]
  /** 序列化后的外层日志加上完成值或失败诊断文本的合并硬上限。 */
  maxOutputBytes: number
}

/** 程序 → 宿主：一次被桥接的绑定调用。 */
interface CallMessage {
  type: 'call'
  /** 程序发出的关联 id；宿主对每个 id 至多应答一次，并忽略重复应答。 */
  id: number
  /** 该调用所指向的命名空间全局名。 */
  global: string
  /** 命名空间内的函数名。 */
  name: string
  /** 唯一的参数，以扁平的无损 JSON wire 值表示。 */
  args: PtcJsonWire
}

/** 程序 → 宿主：捕获到的文本，急切地流传出去，好让输出能扛过运行中途的终止（超时、中止、OOM）。 */
interface LogMessage {
  type: 'log'
  text: string
}

/** 程序 → 宿主：程序侧的捕获或完成值度量超出了外层上限。 */
interface OutputLimitMessage {
  type: 'output-limit'
}

/**
 * 程序 → 宿主：程序已结算。`error` 承载程序异常、非法完成值或输出溢出
 * （预算、中止与执行基座死亡由宿主侧观测）。`value` 仅在一次干净结束且确实产生了
 * 完成值时存在，它是扁平 wire 值，已确认无损且已被剩余合并输出上限接纳。
 * 日志不在这里承载 —— 它们早已作为 {@link LogMessage} 急切地流传出去了。
 */
export interface DoneMessage {
  type: 'done'
  value?: PtcJsonWire
  error?: { kind: 'exception' | 'invalid-output' | 'output-limit'; message: string }
}

/** 程序发出的每一种消息。 */
export type ProgramToHost = CallMessage | LogMessage | OutputLimitMessage | DoneMessage

/** 宿主 → 程序：对某条 {@link CallMessage} 的应答。 */
export type ReplyMessage =
  | { type: 'reply'; id: number; ok: true; value: PtcJsonWire }
  | { type: 'reply'; id: number; ok: false; message: string }
