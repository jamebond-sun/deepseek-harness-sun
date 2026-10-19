/** 未完成的关闭请求可在刷新后存活，独立于被移除的侧边栏标签页。 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WebTerminalId } from '../types.ts'

/** 一条显式清理请求；此处不镜像任何进程或打开标签页的元数据。 */
export interface TerminalCloseRequest {
  readonly sessionId: SessionId
  readonly id: WebTerminalId
  readonly title: string
}

const PREFIX = 'dsh.terminal.close.v1.'

/** 每个请求都有自己的存储键，其他浏览器窗口无法覆盖其清理。 */
export class TerminalCloseRequests {
  private readonly requests = new Map<WebTerminalId, TerminalCloseRequest>()

  constructor() {
    try {
      if (typeof localStorage === 'undefined') return
      for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index)
        if (key?.startsWith(PREFIX)) this.load(key)
      }
    } catch (error) { console.error('Terminal cleanup recovery failed:', error) }
  }

  /**
   * 读取仍在等待 Host 确认的清理工作。
   * @returns 此浏览器实例拥有的未完成请求。
   */
  pending(): readonly TerminalCloseRequest[] { return [...this.requests.values()] }

  /**
   * 在移除标签页之前让清理跨刷新保留。
   * @param request - 要在移除其标签页之前保存的关闭意图。
   */
  save(request: TerminalCloseRequest): void {
    this.requests.set(request.id, request)
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(PREFIX + request.id, JSON.stringify(request))
    } catch (error) { console.error('Terminal cleanup persistence failed:', error) }
  }

  /**
   * 在内存与浏览器存储中清除已确认的清理。
   * @param id - Host 清理已成功的终端。
   */
  remove(id: WebTerminalId): void {
    this.requests.delete(id)
    try {
      if (typeof localStorage !== 'undefined') localStorage.removeItem(PREFIX + id)
    } catch (error) { console.error('Terminal cleanup persistence failed:', error) }
  }

  private load(key: string): void {
    try {
      const raw = localStorage.getItem(key)
      if (raw === null) return
      const parsed: unknown = JSON.parse(raw)
      if (!isRequest(parsed) || key !== PREFIX + parsed.id) throw new Error('Invalid terminal cleanup request')
      this.requests.set(parsed.id, parsed)
    } catch (error) { console.error('Terminal cleanup recovery failed:', error) }
  }
}

function isRequest(value: unknown): value is TerminalCloseRequest {
  if (typeof value !== 'object' || value === null) return false
  const request = value as Record<string, unknown>
  return typeof request.sessionId === 'string' && request.sessionId.length > 0
    && typeof request.id === 'string' && /^[\w-]{1,128}$/u.test(request.id)
    && typeof request.title === 'string'
}
