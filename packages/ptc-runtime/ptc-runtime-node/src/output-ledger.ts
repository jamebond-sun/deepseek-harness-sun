/** 对保留下来的程序输出做合并字节计量。 */
import type { PtcJsonValue, PtcRunFailure, PtcRunResult } from '@deepseek-ai/dsh-ptc-runtime'
import { jsonStringBytesUpTo, jsonValueBytesUpTo, truncateJsonStringBytes } from './output-json.ts'

/** 单次运行的合并外层输出账本；绑定值从不计入其中。 */
export class OutputLedger {
  private bytes = 2 // 空日志数组的 JSON 序列化结果：[]
  private entries = 0

  constructor(private readonly maxBytes: number, private readonly overflowMessage?: string) {}

  /** 接纳一条完整日志项，或报告硬上限已被越过。 */
  admit(text: string, sink: string[]): boolean {
    const separatorBytes = this.entries > 0 ? 1 : 0
    const stringBytes = jsonStringBytesUpTo(text, this.maxBytes - this.bytes - separatorBytes)
    if (stringBytes === undefined) return false
    this.bytes += stringBytes + separatorBytes
    this.entries += 1
    sink.push(text)
    return true
  }

  /** 对照合并上限，敲定一次成功且完成值为缺省或 JSON 的结果。 */
  success(logs: string[], value?: PtcJsonValue): PtcRunResult {
    if (value !== undefined && jsonValueBytesUpTo(value, this.maxBytes - this.bytes) === undefined) return this.limit(logs)
    return { logs, ...value !== undefined ? { value } : {} }
  }

  /** 敲定一条失败诊断；当合并字节超出上限时，output-limit 优先。 */
  failure(logs: string[], error: PtcRunFailure): PtcRunResult {
    if (jsonStringBytesUpTo(error.message, this.maxBytes - this.bytes) === undefined) return this.limit(logs)
    return { logs, error }
  }

  /** 构造显式的 output-limit 失败，同时保留最后那条日志能放下的前缀。 */
  limit(logs: string[]): PtcRunResult {
    const fullMessage = this.overflowMessage ?? `outer output exceeded ${this.maxBytes} bytes`
    // 该固定诊断文本是 ASCII，因此每个字符就是一个字节，再加上两侧的引号。
    const messageBytes = fullMessage.length + 2
    const retained: string[] = []
    let retainedBytes = 2
    const logBudget = this.maxBytes - messageBytes
    for (const text of logs) {
      const separatorBytes = retained.length > 0 ? 1 : 0
      const availableBytes = logBudget - retainedBytes - separatorBytes
      const stringBytes = jsonStringBytesUpTo(text, availableBytes)
      if (stringBytes !== undefined) {
        retained.push(text)
        retainedBytes += stringBytes + separatorBytes
        continue
      }
      const prefix = truncateJsonStringBytes(text, availableBytes)
      if (prefix.length > 0) {
        const prefixBytes = jsonStringBytesUpTo(prefix, availableBytes)
        /* v8 ignore next -- truncateJsonStringBytes 保证它返回的前缀能放进同一预算。 */
        if (prefixBytes === undefined) throw new Error('output ledger produced an oversized log prefix')
        retained.push(prefix)
        retainedBytes += prefixBytes + separatorBytes
      }
      break
    }
    const availableMessageBytes = this.maxBytes - retainedBytes
    const message = truncateJsonStringBytes(fullMessage, availableMessageBytes)
    return { logs: retained, error: { kind: 'output-limit', message } }
  }
}
