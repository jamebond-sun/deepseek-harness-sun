/**
 * `changes` 所需的目标范围文件系统 watch 与 `fs/observed` 失效。
 * 每个生成在 watcher 初始化后发送 `ready`，随后为匹配的排队与
 * 实时失效读取当前目标元数据。
 */

import type { Context } from '@deepseek-ai/cordis'
import { Deque } from '@deepseek-ai/dsh-deque'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { FsObservation, FsTarget } from '@deepseek-ai/dsh-fs'
import type { WorkspaceFileWatchFrame } from './types.ts'

/** 一个目标失效，可选携带其插桩观察。 */
type Observed = readonly [target: FsTarget, observation?: FsObservation]

/** 持有目标 watch、插桩观察，以及每个打开的 `changes` 生成。 */
export class WorkspaceChangeFeed {
  private readonly followers = new Set<ChangeFollower>()

  /** @param ctx - 携带观察来源文件系统的 Host 上下文。 */
  constructor(private readonly ctx: Context) {
    ctx.on('fs/observed', (target, observation) => {
      for (const follower of this.followers) follower.push([target, observation])
    })
    ctx.effect(() => async () => {
      const followers = [...this.followers]
      await Promise.all(followers.map(follower => follower.close()))
      this.followers.clear()
    }, 'workspace-files.changes')
  }

  /**
   * 打开一个目标 watch；目录目标保持在 `workspaceRoot` 之内。
   * @param workspaceRoot - session 的 workspace 根路径。
   * @param path - 目标路径，相对 workspace 根解析；其类型由 Host 元数据判定。
   * @param signal - 生成取消。
   * @returns watch 开始后先发 `ready`，随后对目标失效发送当前元数据。
   */
  async *follow(workspaceRoot: string, path: string, signal: AbortSignal): AsyncIterable<WorkspaceFileWatchFrame> {
    signal.throwIfAborted()
    // 目标解析期间，插桩观察保持排队。
    const follower = new ChangeFollower(() => {
      signal.removeEventListener('abort', cancel)
      this.followers.delete(follower)
    })
    signal = AbortSignal.any([signal, follower.controller.signal])
    const aborted = (): boolean => signal.aborted
    const cancel = (): void => {
      void follower.close().catch((error: unknown) => { this.ctx.logger.error(error) })
    }
    signal.addEventListener('abort', cancel, { once: true })
    this.followers.add(follower)
    let unwatch: (() => Promise<void>) | undefined
    try {
      // 设置阶段共享取消，因此迟到的解析无法再获取 watcher。
      const root = await this.ctx.fs.resolve(workspaceRoot, { signal }).catch((error: unknown) => {
        if (aborted()) return undefined
        throw error
      })
      if (root === undefined || aborted() || follower.isClosed) return
      const target = await this.ctx.fs.resolve(path, { cwd: workspaceRoot, signal }).catch((error: unknown) => {
        if (aborted()) return undefined
        throw error
      })
      if (target === undefined || aborted()) return
      const stat = async () => {
        const info = await this.ctx.fs.stat(target, signal).catch((error: unknown) => {
          if (aborted()) return undefined
          throw error
        })
        if (info?.type === 'directory' && !this.ctx.fs.contains(root, target)) {
          throw new RemoteError('workspace-file/outside-workspace', 'Directory is outside the workspace', { path })
        }
        return info
      }
      await stat()
      if (aborted()) return
      try {
        unwatch = await this.ctx.fs.watch(target, (error) => {
          if (error !== undefined) follower.fail(error)
          else if (!follower.isClosed) follower.push([target])
        }, signal)
        if (follower.error !== undefined) throw follower.error
      } catch (error) {
        if (aborted() && follower.error === undefined) return
        const failure = follower.error ?? error
        throw new RemoteError('workspace-file/watch-unsupported',
          failure instanceof Error ? failure.message : String(failure), { path })
      }
      follower.initialized.resolve(unwatch)
      if (aborted()) return
      yield { kind: 'ready' }
      for await (const [observed] of follower.read()) {
        if (observed.targetKey !== target.targetKey) continue
        const info = await stat()
        if (aborted()) return
        const absolutePath = this.ctx.fs.processPath(target)
        yield {
          kind: 'change',
          change: info !== undefined
            ? { absolutePath, version: info.version }
            : { absolutePath, absent: true },
        }
      }
    } finally {
      follower.initialized.resolve(unwatch)
      await follower.close()
    }
  }
}

/** 一个生成的队列：观察在此等待，直到其消费方拉取。 */
class ChangeFollower {
  readonly controller = new AbortController()
  readonly initialized = Promise.withResolvers<(() => Promise<void>) | undefined>()
  error: Error | undefined
  private readonly queue = new Deque<Observed>()
  private wake: (() => void) | undefined
  private closed = false
  private closing: Promise<void> | undefined

  constructor(private readonly release: () => void) {}

  /** 该生成是否已停止接受失效。 */
  get isClosed(): boolean {
    return this.closed
  }

  push(observed: Observed): void {
    if (this.closed) return
    this.queue.pushBack(observed)
    this.wake?.()
  }

  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    this.closed = true
    this.closing = this.initialized.promise.then(unwatch => unwatch?.()).finally(this.release)
    this.controller.abort()
    this.wake?.()
    return this.closing
  }

  fail(error: Error): void {
    this.error = error
    this.controller.abort()
  }

  /** 排空直到关闭或中止；届时仍在排队的项随生成一起丢弃。 */
  async *read(): AsyncIterable<Observed> {
    while (!this.closed) {
      const observed = this.queue.popFront()
      if (observed !== undefined) {
        yield observed
        continue
      }
      await new Promise<void>((resolve) => { this.wake = resolve })
      this.wake = undefined
    }
    if (this.error !== undefined) throw this.error
  }
}
