/** 独立的内容到终端记录让并发的浏览器写入互不干扰。 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WebTerminalId } from '../types.ts'

const PREFIX = 'dsh.terminal.binding.v1.'

/** 以 Session 与全局唯一的终端内容标识为键的已保存恢复目标。 */
export class TerminalBindings {
  private readonly memory = new Map<string, WebTerminalId>()

  /**
   * 读取已保存的目标；存储不可用时保留此窗口的值。
   * @param sessionId - 拥有该目标的 Session。
   * @param contentId - 终端内容标识，仅由刻意的副本共享。
   * @returns 已存在的 Host 标识（如果已保存）。
   */
  get(sessionId: SessionId, contentId: string): WebTerminalId | undefined {
    const key = this.key(sessionId, contentId)
    const known = this.memory.get(key)
    if (known !== undefined) return known
    if (typeof localStorage === 'undefined') return undefined
    try {
      const raw = localStorage.getItem(key)
      if (raw === null) return undefined
      const value: unknown = JSON.parse(raw)
      if (typeof value !== 'string' || !/^[\w-]{1,128}$/u.test(value)) return undefined
      this.memory.set(key, value as WebTerminalId)
      return value as WebTerminalId
    } catch (_storageUnavailable) { return undefined }
  }

  /**
   * 在其 Host 分配开始之前保存标识。
   * @param sessionId - 拥有该标识的 Session。
   * @param contentId - 全局唯一的终端内容标识。
   * @param id - 现有的或新分配的 Host 标识。
   */
  set(sessionId: SessionId, contentId: string, id: WebTerminalId): void {
    const key = this.key(sessionId, contentId)
    this.memory.set(key, id)
    if (typeof localStorage === 'undefined') return
    try { localStorage.setItem(key, JSON.stringify(id)) }
    catch (error) { console.error('Terminal binding persistence failed:', error) }
  }

  /**
   * 在其关闭意图保存之后移除此内容的目标。
   * @param sessionId - 拥有该目标的 Session。
   * @param contentId - 正在关闭的终端内容标识。
   */
  delete(sessionId: SessionId, contentId: string): void {
    const key = this.key(sessionId, contentId)
    this.memory.delete(key)
    if (typeof localStorage === 'undefined') return
    try { localStorage.removeItem(key) }
    catch (error) { console.error('Terminal binding cleanup failed:', error) }
  }

  /** 在 Client 服务释放时清空缓存值。 */
  clear(): void { this.memory.clear() }

  private key(sessionId: SessionId, contentId: string): string { return PREFIX + JSON.stringify([sessionId, contentId]) }
}
