/** Client 终端模型服务；视图的键独立于 Host 终端标识。 */
import { Service, type Context } from '@deepseek-ai/cordis'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { TerminalView, type TerminalRemote } from './model.ts'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { TerminalShell, WebTerminalId, WebTerminalInfo } from '../types.ts'
import { preferredShell, rememberShell } from './shell-preference.ts'
import { TerminalCloseRequests, type TerminalCloseRequest } from './close-requests.ts'
import { TerminalWindowHold } from './retention.ts'
import { TerminalBindings } from './bindings.ts'
import { TerminalInventory } from './inventory.ts'

export type { TerminalView, TerminalViewState, TerminalViewIssue, TerminalRenderFrame, TerminalRemote } from './model.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 不依赖 React 的浏览器终端视图与显式进程清理。 */
    webTerminals: ClientTerminals
  }
}

/** Host 发现的 shell 菜单，附带浏览器记住的可用选择。 */
export interface TerminalLaunchShells {
  readonly shells: readonly TerminalShell[]
  readonly selectedShell: string | undefined
}

/** 可在不恢复其标签页的情况下重试的后台关闭失败。 */
export interface TerminalCloseFailure {
  readonly id: WebTerminalId
  readonly title: string
  readonly message: string
}

/** Session 与出现项查找、独立的标签页与终端标识，以及后台清理。 */
export class ClientTerminals extends Service {
  /** 失败的清理任务；成功与进行中的关闭没有可见通知。 */
  readonly closeFailures: SnapshotStore<readonly TerminalCloseFailure[]> = createSnapshotStore<readonly TerminalCloseFailure[]>([])
  private readonly requests = new TerminalCloseRequests()
  private readonly closing = new Map<WebTerminalId, Promise<void>>()
  private readonly closed = new Set<WebTerminalId>(this.requests.pending().map(request => request.id))
  private disposed = false
  private readonly views = new Map<SessionId, Map<string, TerminalView>>()
  private readonly inventories = new Map<SessionId, TerminalInventory>()
  private readonly bindings = new TerminalBindings()
  private readonly holds = new Map<SessionId, Map<WebTerminalId, TerminalWindowHold>>()
  private readonly releasing = new Set<Promise<void>>()
  private openTabs: readonly { sessionId: SessionId; tabId: string; contentId: string }[] = []

  /**
   * @param ctx - 携带 Gateway 与终端 Remote 命名空间的 Client 根上下文。
   * @param remote - 生成的终端命名空间。
   */
  constructor(ctx: Context, private readonly remote: TerminalRemote) {
    super(ctx, 'webTerminals')
    const connection = ctx.get('connection') as ConnectionHandle
    let connected = connection.generation.getSnapshot() !== undefined
    ctx.on('connection/reset', () => {
      if (!connected) { connected = true; return }
      for (const [sessionId, inventory] of this.inventories) {
        void inventory.reset()?.catch((error: unknown) => {
          if (!this.disposed) {
            this.ctx.logger.warn('Terminal list refresh failed; retry terminal recovery', { sessionId, error })
          }
        })
      }
    })
    ctx.effect(() => async () => {
      this.disposed = true
      const listing = [...this.inventories.values()].map(inventory => inventory.dispose())
      this.inventories.clear()
      const detaching = [...this.views.values()].flatMap(views => [...views.values()].map(view => view.dispose()))
      this.views.clear()
      this.bindings.clear()
      const holds = [...this.holds.values()].flatMap(holds => [...holds.values()].map(hold => hold.dispose()))
      this.holds.clear()
      await Promise.all([...listing, ...detaching, ...holds, ...this.releasing, ...this.closing.values()])
    }, 'terminal-controller.client.views')
    for (const request of this.requests.pending()) this.cleanup(request)
  }

  /**
   * 返回一个侧边栏出现项的稳定模型。
   * @param sessionId - 拥有该出现项的 Session。
   * @param key - 侧边栏出现项键。
   * @param contentId - 全局唯一的内容标识；布局局部的标签页 id 不是持久化键。
   * @param terminalId - 恢复列表中已有终端时的现有 Host 标识；否则复用已保存的内容标识。
   * @param shellPath - 新终端的显式 shell；恢复的终端保留各自的 shell。
   * @returns 其可观察状态与终端命令。
   */
  view(sessionId: SessionId, key: string, contentId: string, terminalId?: WebTerminalId, shellPath?: string): TerminalView {
    let views = this.views.get(sessionId)
    if (views === undefined) { views = new Map(); this.views.set(sessionId, views) }
    let view = views.get(key)
    if (view === undefined) {
      const saved = terminalId ?? this.bindings.get(sessionId, contentId)
      const id = saved ?? randomUUID() as WebTerminalId
      this.bindings.set(sessionId, contentId, id)
      view = new TerminalView(sessionId, this.remote, this.ctx.remote, this.inventory(sessionId), id, saved === undefined, shellPath,
        signal => this.hold(sessionId, id).ready(signal))
      views.set(key, view)
      this.reconcileHolds()
      void view.refresh()
    }
    return view
  }

  private inventory(sessionId: SessionId): TerminalInventory {
    let inventory = this.inventories.get(sessionId)
    if (inventory === undefined) {
      inventory = new TerminalInventory(() => this.remote.list(sessionId))
      this.inventories.set(sessionId, inventory)
    }
    return inventory
  }

  /**
   * 按需发现可用的启动选择，不分配 PTY。
   * @param sessionId - 目标 Session。
   * @param signal - 菜单请求的生命周期。
   * @returns 已安装的 shell 与当前可用的浏览器偏好。
   */
  async launchShells(sessionId: SessionId, signal: AbortSignal): Promise<TerminalLaunchShells> {
    const result = await this.remote.shells(sessionId, signal)
    if (!result.ok) throw new Error(result.error.message)
    const previous = preferredShell()
    return { shells: result.value, selectedShell: result.value.find(shell => shell.path === previous)?.path ?? result.value[0]?.path }
  }

  /**
   * 在分配其终端标签页之前记住引导选择。
   * @param path - 从 Host 发现中选择的 shell。
   */
  selectShell(path: string): void { rememberShell(path) }

  /**
   * 保存关闭意图并立即释放标签页；清理比 DOM 卸载与刷新更持久。
   * @param sessionId - 拥有该出现项的 Session。
   * @param key - 侧边栏出现项键，包括未激活的已恢复标签页。
   * @param contentId - 要移除其绑定的全局唯一内容标识。
   * @param terminalId - 标签页尚无模型时的已恢复标识。
   */
  close(sessionId: SessionId, key: string, contentId: string, terminalId?: WebTerminalId): void {
    const views = this.views.get(sessionId)
    const view = views?.get(key)
    const id = view?.id ?? terminalId ?? this.bindings.get(sessionId, contentId)
    if (id === undefined) return
    const request: TerminalCloseRequest = { sessionId, id, title: view?.state.getSnapshot().title ?? key }
    this.closed.add(id)
    this.requests.save(request)
    this.bindings.delete(sessionId, contentId)
    views?.delete(key)
    if (views?.size === 0) this.views.delete(sessionId)
    this.cleanup(request, view)
    this.reconcileHolds()
  }

  /**
   * 调和此窗口打开的终端出现项，包括休眠的已保存 Session。
   * @param tabs - 由侧边栏布局拥有者提供的终端类成员关系。
   */
  retainTabs(tabs: readonly { sessionId: SessionId; tabId: string; contentId: string }[]): void {
    this.openTabs = tabs
    this.reconcileHolds()
  }

  private hold(sessionId: SessionId, id: WebTerminalId): TerminalWindowHold {
    let holds = this.holds.get(sessionId)
    if (holds === undefined) { holds = new Map(); this.holds.set(sessionId, holds) }
    let hold = holds.get(id)
    if (hold === undefined || hold.failed) {
      if (hold !== undefined) this.release(hold)
      hold = new TerminalWindowHold(this.ctx.remote, this.remote, sessionId, id)
      holds.set(id, hold)
    }
    return hold
  }

  private reconcileHolds(): void {
    if (this.disposed) return
    const wanted = new Map<SessionId, Set<WebTerminalId>>()
    for (const tab of this.openTabs) {
      const id = this.bindings.get(tab.sessionId, tab.contentId)
      if (id === undefined || this.closed.has(id)) continue
      let ids = wanted.get(tab.sessionId)
      if (ids === undefined) { ids = new Set(); wanted.set(tab.sessionId, ids) }
      ids.add(id)
      const view = this.views.get(tab.sessionId)?.get(tab.tabId)
      if (view === undefined || view.state.getSnapshot().info !== undefined) {
        if (!this.holds.get(tab.sessionId)?.has(id)) this.hold(tab.sessionId, id)
      }
    }
    for (const [sessionId, holds] of this.holds) {
      for (const [id, hold] of holds) {
        if (!wanted.get(sessionId)?.has(id)) { holds.delete(id); this.release(hold) }
      }
      if (holds.size === 0) this.holds.delete(sessionId)
    }
  }

  private release(hold: TerminalWindowHold): void {
    const releasing = hold.dispose().finally(() => { this.releasing.delete(releasing) })
    this.releasing.add(releasing)
    void releasing.catch((error: unknown) => { this.ctx.logger.warn('Terminal hold release failed', error) })
  }

  /**
   * 读取共享的 Session 发现，不依赖活动视图或未完成的关闭。
   * @param sessionId - 正在展示的 Session。
   * @param refresh - 显式替换已落定的发现结果，包括先前的失败。
   * @returns 可作为恢复标签页打开的终端。
   */
  async recover(sessionId: SessionId, refresh: boolean = false): Promise<WebTerminalInfo[]> {
    const available = await this.inventory(sessionId).read(refresh)
    const held = new Set([...(this.views.get(sessionId)?.values() ?? [])].map(view => view.id))
    const closing = new Set(this.requests.pending().map(request => request.id))
    return [...available.values()].filter(info => !held.has(info.id) && !closing.has(info.id) && !this.closed.has(info.id))
  }

  /**
   * 重试已保存的关闭请求，而不重新打开其标签页。
   * @param id - 失败的终端标识。
   */
  retryClose(id: WebTerminalId): void {
    const record = this.requests.pending().find(item => item.id === id)
    if (record !== undefined) this.cleanup(record)
  }

  private cleanup(record: TerminalCloseRequest, view?: TerminalView): void {
    if (this.closing.has(record.id) || this.disposed) return
    this.closeFailures.set(this.closeFailures.getSnapshot().filter(failure => failure.id !== record.id))
    const pending = (async () => {
      if (view !== undefined) await view.close()
      else {
        const result = await this.remote.close(record.sessionId, record.id)
        if (!result.ok) throw result.error
      }
      this.inventories.get(record.sessionId)?.remove(record.id)
      this.requests.remove(record.id)
    })().catch((error: unknown) => {
      if (remoteErrorOf(error)?.code === 'session/not-found') {
        this.requests.remove(record.id)
        return
      }
      if (!this.disposed) this.closeFailures.set([...this.closeFailures.getSnapshot(), {
        id: record.id, title: record.title,
        message: error instanceof Error ? error.message : String(error),
      }])
    }).then(async () => {
      await view?.dispose()
      this.closing.delete(record.id)
    })
    this.closing.set(record.id, pending)
  }
}

/** 所需的 Client 传输与终端命名空间。 */
export const inject = ['remote', 'remote.terminal', 'connection']

/**
 * 安装 Client 终端模型。
 * @param ctx - Client 根上下文。
 */
export function apply(ctx: Context): void {
  new ClientTerminals(ctx, ctx.remote.terminal)
}
