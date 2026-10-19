/** 叠加在可重连 Remote 流之上的基线加增量协议。 */

import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteStream } from './remote-stream.ts'

/** Host 侧的流协议违规，已加标记，使消费方将其呈现为错误状态。 */
function protocolViolation(message: string): RemoteError<'gateway/internal'> {
  return new RemoteError('gateway/internal', message, {})
}

/** 一个快照流的领域操作。 */
export interface RemoteSnapshotStreamOptions<Snapshot, Delta> {
  /** 协议失败中使用的诊断性流名称。 */
  readonly name: string
  /** 区分起始快照与后续增量。 */
  readonly isSnapshot: (value: Snapshot | Delta) => value is Snapshot
  /** 用完整快照原子地替换领域模型。 */
  readonly replace: (snapshot: Snapshot) => void
  /** 在代快照之后应用一次增量更新。 */
  readonly update: (delta: Delta) => void
  /** 发布一次终止性的业务或协议失败。 */
  readonly failed: (error: unknown) => void
}

/**
 * 消费各自恰好包含一个起始快照加后续增量的代。
 *
 * 底层流重试期间，先前的领域快照保持已发布状态。只有领域所有者
 * 成功应用之后，替换才会被接受。
 */
export class RemoteSnapshotStream<Snapshot, Delta> {
  private started = false
  private disposed = false
  private done: Promise<void> | undefined

  /**
   * @param stream - 可重连的物理代流。
   * @param options - 帧判别符与领域状态目的地。
   */
  constructor(
    private readonly stream: RemoteStream<Snapshot | Delta>,
    private readonly options: RemoteSnapshotStreamOptions<Snapshot, Delta>,
  ) {}

  /** 启动唯一的消费方；重复调用无效果。 */
  start(): void {
    if (this.started) return
    this.started = true
    this.done = this.consume()
  }

  /** 替换活跃的物理代，而不丢弃已发布的快照。 */
  restart(): void {
    this.stream.restart()
  }

  /**
   * 永久停止流，并等待其消费方归于静止。
   * @returns 不再有任何代或回调可以运行时。
   */
  async dispose(): Promise<void> {
    this.disposed = true
    await this.stream.dispose()
    await this.done
  }

  private async consume(): Promise<void> {
    let generation = 0
    let snapshotSeen = false
    try {
      for await (const item of this.stream) {
        if (item.generation !== generation) {
          generation = item.generation
          snapshotSeen = false
        }
        if (this.options.isSnapshot(item.value)) {
          if (snapshotSeen) {
            throw protocolViolation(`${this.options.name} emitted more than one opening snapshot`)
          }
          this.options.replace(item.value)
          snapshotSeen = true
          item.accept()
          continue
        }
        if (!snapshotSeen) {
          throw protocolViolation(`${this.options.name} emitted an update before its opening snapshot`)
        }
        this.options.update(item.value)
      }
    } catch (error) {
      if (!this.disposed) this.options.failed(error)
    }
  }
}
