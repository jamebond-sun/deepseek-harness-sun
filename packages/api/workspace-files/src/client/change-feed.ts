/**
 * 每个 Session 与请求路径一个 Host `changes` 订阅，由该目标的
 * 打开资源共享。
 *
 * Host 报告来自文件系统 watch 与插桩写入的失效。第一个 follower
 * 到达时该变更流打开目标流，把每一帧交给该路径的 follower，
 * 最后一个 follower 离开时释放流。follower 缓冲目标变更，
 * 直到 `stat` 给出其 Host 绝对路径，然后按该路径过滤排队与
 * 实时帧，`\\` 归一化为 `/`。
 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceFileChange, WorkspaceFileWatchFrame } from '../types.ts'
import type { SupervisedStream, WorkspaceFilesRemote } from './remote.ts'
import type { WorkspaceFileEdit, WorkspaceFileNotice } from './types.ts'

/**
 * 一个绝对路径的 follower 键。
 * @param path - 来自 Host stat 或变更帧的绝对路径。
 * @returns `\\` 归一化为 `/` 后的路径。
 */
function keyOf(path: string): string {
  return path.replace(/\\/g, '/')
}

/** 一个 follower 的通知，按序投递并由其消费方拉取。 */
class Follower implements AsyncIterable<WorkspaceFileNotice> {
  private readonly pending: Array<{ readonly key: string; readonly notice: WorkspaceFileNotice }> = []
  private readonly started = Promise.withResolvers<boolean>()
  private wake: (() => void) | undefined
  private ended = false
  private hostKey: string | undefined

  /**
   * Host 确认其订阅后兑现为 true；该 follower 在确认前结束时为 false。
   */
  readonly ready = this.started.promise

  /**
   * @param leave - 注销本 follower 及其 abort 监听器。
   */
  constructor(private readonly leave: () => void) {}

  /**
   * 为排队与后续变更选定 Host 路径。
   * @param absolutePath - 成功 stat 的绝对路径。
   */
  bind(absolutePath: string): void {
    this.hostKey = keyOf(absolutePath)
  }

  /** Host 已确认订阅生效并解析了 workspace 根。 */
  start(): void {
    this.started.resolve(true)
  }

  /**
   * 将一个通知排队。
   * @param notice - 消费方接下来收到的内容。
   * @param key - 该变更归一化后的 Host 路径。
   */
  push(notice: WorkspaceFileNotice, key: string): void {
    this.pending.push({ key, notice })
    this.wake?.()
  }

  /** 投递已排队的内容，然后结束。 */
  end(): void {
    this.ended = true
    this.started.resolve(false)
    this.wake?.()
  }

  /** 即使消费方尚未开始拉取通知也执行注销。 */
  dispose(): void {
    this.leave()
  }

  /** @inheritdoc */
  async *[Symbol.asyncIterator](): AsyncIterator<WorkspaceFileNotice> {
    try {
      while (true) {
        const next = this.pending.shift()
        if (next !== undefined) {
          if (next.notice.kind === 'refresh' || this.hostKey === undefined || next.key === this.hostKey) yield next.notice
          continue
        }
        if (this.ended) return
        await new Promise<void>((resolve) => { this.wake = resolve })
        this.wake = undefined
      }
    } finally {
      this.dispose()
    }
  }
}

/** 一个 Session 与请求路径的流及其 follower。 */
class SessionFeed {
  private readonly followers = new Set<Follower>()
  private readonly stream: SupervisedStream<WorkspaceFileWatchFrame>
  private closed = false
  private started = false
  private acknowledged = false

  /**
   * @param remote - 携带 `workspaceFiles.changes` 的 Remote 接口面。
   * @param sessionId - 本变更流观察其文件系统的 Session。
   * @param path - 提交给 Host 的目标路径。
   * @param after - 该目标上一个仍在关闭中的变更流（如有）；流在其结束后打开。
   * @param onClose - 流消失时调用一次，无论原因，传入正在关闭它的释放操作。
   */
  constructor(
    remote: WorkspaceFilesRemote,
    sessionId: SessionId,
    path: string,
    after: Promise<void> | undefined,
    private readonly onClose: (closed: Promise<void>) => void,
  ) {
    this.stream = remote.$stream<WorkspaceFileWatchFrame>({
      name: `workspace file changes of ${sessionId}`,
      // 仍在关闭中的前继先完成，因此一个目标绝不会同时打开
      // 两个 Host 流。
      open: (signal) => {
        this.started = false
        return openAfter(after, () => remote.workspaceFiles.changes(sessionId, path, signal))
      },
      // 正常结束意味着 Host 关闭了该目标的变更流。
      ended: () => new Error(`workspace file changes of ${sessionId} ended`),
    })
    void this.pump()
  }

  /**
   * 在 Host 路径已知之前注册一个资源地址。
   * @param follower - 接收变更，并在 stat 之后绑定其路径。
   */
  add(follower: Follower): void {
    this.followers.add(follower)
    if (this.started) follower.start()
  }

  /**
   * 注销一个 follower；最后一个离开者释放流。
   * @param follower - 要移除的 follower。
   */
  remove(follower: Follower): void {
    this.followers.delete(follower)
    if (this.followers.size === 0) this.close()
  }

  private async pump(): Promise<void> {
    try {
      for await (const item of this.stream) {
        const frame = item.value
        switch (frame.kind) {
          case 'ready':
            item.accept()
            this.started = true
            for (const follower of this.followers) {
              follower.start()
              if (this.acknowledged) follower.push({ kind: 'refresh' }, '')
            }
            this.acknowledged = true
            break
          case 'change': {
            const key = keyOf(frame.change.absolutePath)
            const notice = editOf(frame.change)
            for (const follower of this.followers) follower.push(notice, key)
            break
          }
          default:
            assertNever(frame)
        }
      }
    } catch {
      // 流的终态失败或 Host 的结束：follower 在下方安静结束，
      // 它们持有的元数据保持为最后已知值。
    } finally {
      this.close()
    }
  }

  private close(): void {
    if (this.closed) return
    this.closed = true
    const closed = this.stream.dispose()
    for (const follower of this.followers) follower.end()
    this.followers.clear()
    this.onClose(closed)
  }
}

/**
 * 在前继完成关闭后打开一个 Host 流。
 * @param after - 前继的释放操作，无则不等待。
 * @param open - 打开流。
 * @returns 流的条目。
 */
async function* openAfter<T>(after: Promise<void> | undefined, open: () => AsyncIterable<T>): AsyncIterable<T> {
  await after
  yield* open()
}

/**
 * Host 帧所报告的写入。
 * @param frame - Host 帧。
 * @returns follower 收到的变更通知。
 */
function editOf(frame: WorkspaceFileChange): WorkspaceFileEdit {
  return 'absent' in frame ? { kind: 'absent' } : { kind: 'changed', version: frame.version }
}

function assertNever(frame: never): never {
  throw new Error(`Unexpected workspace file watch frame: ${JSON.stringify(frame)}`)
}

/**
 * Host 的 workspace 文件变更流按目标的共享。
 *
 * 由提供方持有；一个实例服务 Client 的每个 session。
 */
export class ChangeFeed {
  /** 仅含存活变更流：流关闭时变更流自行移除。 */
  private readonly sessions = new Map<string, SessionFeed>()
  /** 仍在关闭中的流，按 Session 与路径；后继等待其前继。 */
  private readonly closing = new Map<string, Promise<void>>()

  /**
   * @param remote - 携带 `$stream` 与 `workspaceFiles.changes` 的 Remote 接口面。
   */
  constructor(private readonly remote: WorkspaceFilesRemote) {}

  /**
   * 在 Host 路径未知时，跟随一个 session 中的一个资源。
   *
   * follower 在调用时注册，而非首次拉取时。stat 等待期间，送达本
   * Client 的变更会排队。第一个 follower 发起该目标的本地
   * `changes` 调用。可迭代对象在 `signal` 中止或目标流消失时结束；
   * 提前结束（`break`、`return`）同样会注销 follower，且一个目标的
   * 最后一个 follower 释放其流。在 stat 之前先等待 `ready` 兑现为
   * true，使 Host 订阅生效，然后绑定每次 stat 的绝对路径。绑定前，
   * 任何目标失效都可触发重试；绑定后，只有匹配的排队与实时变更
   * 能通过。
   * @param sessionId - 提供文件读权限的 Session。
   * @param path - 请求的文件路径；仅相同 Session 与路径的 follower 共享流。
   * @param signal - 结束跟随。
   * @returns 带有 Host 路径绑定与显式释放的单消费方订阅。
   */
  follow(sessionId: SessionId, path: string, signal: AbortSignal): Follower {
    const feed = signal.aborted ? undefined : this.feedOf(sessionId, path)
    const leave = (): void => {
      signal.removeEventListener('abort', leave)
      follower.end()
      feed?.remove(follower)
    }
    const follower = new Follower(leave)
    if (feed === undefined) {
      follower.end()
    } else {
      feed.add(follower)
      signal.addEventListener('abort', leave, { once: true })
    }
    return follower
  }

  /**
   * 等待每个仍在关闭中的流，使属主拆卸时不留任何 Host 流。
   * @returns 本变更流没有流仍在关闭时兑现。
   */
  async settle(): Promise<void> {
    await Promise.all(this.closing.values())
  }

  private feedOf(sessionId: SessionId, path: string): SessionFeed {
    const key = JSON.stringify([sessionId, path])
    const existing = this.sessions.get(key)
    if (existing !== undefined) return existing
    const feed = new SessionFeed(this.remote, sessionId, path, this.closing.get(key), (closed) => {
      this.sessions.delete(key)
      // 被 reject 的释放仍是已结算的关闭：不再有需要等待的东西。
      const tracked: Promise<void> = closed.then(() => undefined, () => undefined).then(() => {
        if (this.closing.get(key) === tracked) this.closing.delete(key)
      })
      this.closing.set(key, tracked)
    })
    this.sessions.set(key, feed)
    return feed
  }
}
