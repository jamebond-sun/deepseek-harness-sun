/** 由 Session Header 按钮与 `/export` 共享的浏览器下载状态。 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SESSION_LOG_EXPORT_ROUTE } from '../routes.ts'

/** 共享弹窗所呈现的下载阶段。 */
export type SessionLogDownloadStatus = 'downloading' | 'success' | 'error'

/** 某个 Session 当前的下载弹窗状态。 */
export interface SessionLogDownloadEntry {
  readonly open: boolean
  readonly status: SessionLogDownloadStatus
  readonly error: string | null
}

/** 以拥有该弹窗的 Session 为键的下载状态。 */
export interface SessionLogDownloadState {
  bySession: Record<string, SessionLogDownloadEntry | undefined>
}

/** 导出路由的 HTTP 载体。 */
type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>
type Save = (url: string, filename: string) => void

const INITIAL: SessionLogDownloadState = { bySession: {} }

/**
 * 把不可信的 Session id 收敛为宿主机端点所拥有的文件名约定。
 * @param sessionId - 其归档被下载的 Session。
 * @returns 一个安全的浏览器下载文件名。
 */
export function sessionLogZipFilename(sessionId: SessionId): string {
  return `dsh-session-${String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_')}.zip`
}

/**
 * 把 Host 的下载路由交给浏览器下载管理器，后者会依据文档自身的 base 解析它。
 * @param url - 相对文档的 Host 下载路由。
 * @param filename - 浏览器下载文件名。
 */
export function downloadUrl(url: string, filename: string): void {
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 为每个 Session 持有一个进行中的浏览器下载，并发布弹窗状态。 */
export class SessionLogDownloadController {
  /** 由每个 Session 作用域的弹窗贡献共享的 uSES 安全状态源。 */
  readonly store: SnapshotStore<SessionLogDownloadState> = createSnapshotStore(INITIAL)

  private readonly active = new Map<SessionId, { readonly abort: AbortController; readonly done: Promise<void> }>()
  private disposed = false

  /**
   * @param fetcher - 用于读取宿主机流式 ZIP 的 HTTP 载体。
   * @param save - 浏览器保存操作。
   */
  constructor(
    private readonly fetcher: Fetch = (input, init) => fetch(input, init),
    private readonly save: Save = downloadUrl,
  ) {}

  /**
   * 下载一棵 Session 树；对同一个 Session 的并发操作共享同一次下载。
   * @param sessionId - 根 Session，其 ZIP 包含后代与附件。
   * @returns 在浏览器保存开始、错误状态被发布，或已释放之后的迟到请求被忽略之后返回。
   */
  download(sessionId: SessionId): Promise<void> {
    const existing = this.active.get(sessionId)
    if (existing !== undefined) return existing.done
    if (this.disposed) return Promise.resolve()
    const abort = new AbortController()
    const done = this.run(sessionId, abort.signal).finally(() => {
      this.active.delete(sessionId)
    })
    this.active.set(sessionId, { abort, done })
    return done
  }

  /**
   * 关闭某个 Session 的弹窗，但不取消进行中的浏览器下载。
   * @param sessionId - 其弹窗被关闭的 Session。
   */
  dismiss(sessionId: SessionId): void {
    const current = this.store.getSnapshot().bySession[String(sessionId)]
    if (current === undefined || !current.open) return
    this.publish(sessionId, { ...current, open: false })
  }

  /**
   * 中止进行中的 fetch 并达到静止状态。
   * @returns 在每一个进行中的操作都结算之后返回。
   */
  async dispose(): Promise<void> {
    this.disposed = true
    const active = [...this.active.values()]
    for (const operation of active) operation.abort.abort()
    await Promise.allSettled(active.map(operation => operation.done))
  }

  private async run(sessionId: SessionId, signal: AbortSignal): Promise<void> {
    this.publish(sessionId, { open: true, status: 'downloading', error: null })
    try {
      const query = new URLSearchParams({ sessionId, includeDescendants: 'true' })
      const route = `${SESSION_LOG_EXPORT_ROUTE}?${query.toString()}`
      const response = await this.fetcher(route, { method: 'HEAD', signal })
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw new Error(`Export failed: HTTP ${response.status}${detail === '' ? '' : ` ${detail}`}`)
      }
      this.save(route, sessionLogZipFilename(sessionId))
      const open = this.store.getSnapshot().bySession[String(sessionId)]?.open ?? true
      this.publish(sessionId, { open, status: 'success', error: null })
    } catch (error: unknown) {
      if (signal.aborted) return
      const open = this.store.getSnapshot().bySession[String(sessionId)]?.open ?? true
      this.publish(sessionId, { open, status: 'error', error: messageOf(error) })
    }
  }

  private publish(sessionId: SessionId, entry: SessionLogDownloadEntry): void {
    this.store.update((state) => {
      state.bySession = { ...state.bySession, [String(sessionId)]: entry }
    })
  }
}
