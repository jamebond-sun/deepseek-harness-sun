/**
 * LSP 基础协议分帧：基于 `Content-Length` 分隔、跑在字节流上的 JSON-RPC。编码器产出一个
 * 分帧后的缓冲区；解码器缓冲收到的字节并产出完整的消息体，同时限制头部与整条消息的大小，
 * 使恶意或损坏的服务端无法耗尽内存。
 * @module @deepseek-ai/dsh-lsp-stdio/framing
 */

/** LSP 基础协议中的头部/正文分隔符。 */
const HEADER_SEPARATOR = '\r\n\r\n'

/** 头部区块的上限，防止一个永不发送分隔符的服务端让缓冲区无限增长。 */
const MAX_HEADER_BYTES = 1 << 16

/**
 * 把一条 JSON-RPC 消息编码为分帧后的 LSP 缓冲区（`Content-Length: N\r\n\r\n<utf-8 json>`）。
 * @param message - 要序列化的 JSON-RPC 消息对象。
 * @returns 可直接写入服务端 stdin 的分帧字节。
 */
export function encodeMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii')
  return Buffer.concat([header, body])
}

/**
 * `Content-Length` 分帧 JSON-RPC 的流式解码器。把 stdout 分片喂给它；它返回已完整的
 * 整条消息体。它只解析 `Content-Length` 头部并忽略其他头部（如 `Content-Type`），
 * 与基础协议一致。
 */
export class MessageDecoder {
  private buffer: Buffer = Buffer.alloc(0)
  private readonly maxMessageBytes: number

  /**
   * @param maxMessageBytes - 拒绝任何大于该值的单条分帧消息体（保护内存）。
   */
  constructor(maxMessageBytes: number) {
    this.maxMessageBytes = maxMessageBytes
  }

  /**
   * 追加一个分片，返回此刻已完整的所有消息体。
   * @param chunk - 来自服务端 stdout 的原始字节。
   * @returns 解析出的 JSON 消息体，按到达顺序（可能为空）。
   * @throws Error 当头部格式错误或消息体超过 `maxMessageBytes` 时。
   */
  push(chunk: Buffer): unknown[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    const messages: unknown[] = []
    for (;;) {
      const step = this.next()
      if (!step.ready) break
      messages.push(step.message)
    }
    return messages
  }

  /** 解析并消费下一条完整消息，或报告还需要更多字节。 */
  private next(): { ready: false } | { ready: true; message: unknown } {
    const separator = this.buffer.indexOf(HEADER_SEPARATOR)
    if (separator < 0) {
      if (this.buffer.length > MAX_HEADER_BYTES) {
        throw new Error(`LSP header exceeded ${MAX_HEADER_BYTES} bytes without a terminator`)
      }
      return { ready: false }
    }
    if (separator > MAX_HEADER_BYTES) {
      throw new Error(`LSP header exceeded ${MAX_HEADER_BYTES} bytes`)
    }
    const headerText = this.buffer.toString('ascii', 0, separator)
    const contentLength = parseContentLength(headerText)
    if (contentLength > this.maxMessageBytes) {
      throw new Error(`LSP message length ${contentLength} exceeds the ${this.maxMessageBytes}-byte limit`)
    }
    const bodyStart = separator + HEADER_SEPARATOR.length
    const bodyEnd = bodyStart + contentLength
    if (this.buffer.length < bodyEnd) return { ready: false }
    const body = this.buffer.toString('utf8', bodyStart, bodyEnd)
    this.buffer = this.buffer.subarray(bodyEnd)
    try {
      return { ready: true, message: JSON.parse(body) }
    } catch (error) {
      /* v8 ignore next -- JSON.parse 抛出的 SyntaxError 本身是 Error；String() 回退只是兜底。 */
      throw new Error(`LSP message body was not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/** 读取 `Content-Length` 头部值（大小写不敏感），缺失或非数字时报错。 */
function parseContentLength(headerText: string): number {
  for (const line of headerText.split('\r\n')) {
    const colon = line.indexOf(':')
    if (colon < 0) continue
    if (line.slice(0, colon).trim().toLowerCase() !== 'content-length') continue
    const value = Number(line.slice(colon + 1).trim())
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`invalid Content-Length header: ${JSON.stringify(line)}`)
    }
    return value
  }
  throw new Error(`LSP header block missing Content-Length: ${JSON.stringify(headerText)}`)
}
