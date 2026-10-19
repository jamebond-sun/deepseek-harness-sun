/** 单个单消费方 Remote 流的可重连生命周期。 */

import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { RemoteStreamCarrierError } from './stream-client.ts'

/** 带有交付它的物理 Remote 流代标注的一个条目。 */
export interface RemoteStreamItem<Item> {
  /** 此逻辑流内单调递增的物理代编号。 */
  readonly generation: number
  /** 生成的 Remote 方法产出的已解码条目。 */
  readonly value: Item
  /** 交付此条目的代的取消生命周期。 */
  readonly signal: AbortSignal
  /** 将此代的起始基线或游标标记为已接受。 */
  accept(): void
}

/** {@link RemoteStream} 使用的领域自有操作。 */
export interface RemoteStreamOptions<Item> {
  /** 取消失败中使用的诊断性所有者名称。 */
  readonly name: string
  /** 打开逻辑流的一个物理代。 */
  readonly open: (signal: AbortSignal) => AsyncIterable<Item>
  /** 对起始条目被接受之前或之后的正常代结束进行分类。 */
  readonly ended: (accepted: boolean) => Error
  /** 在监管器等待或重新打开之前观察一次可重试的载体丢失。 */
  readonly carrierFailed?: (error: RemoteStreamCarrierError) => void
}

/**
 * 跨载体代重新打开一个逻辑 Remote 流。
 *
 * Connection 拥有物理重试时机；Gateway 执行每次请求的替换。
 * 领域消费方拥有其起始条目与之后的每个条目，
 * 且只有在校验完起始基线或游标之后，
 * 才调用 {@link RemoteStreamItem.accept}。
 */
export class RemoteStream<Item> implements AsyncIterable<RemoteStreamItem<Item>> {
  private readonly lifetime = new AbortController()
  private generationAbort: AbortController | undefined
  private iterator: AsyncGenerator<RemoteStreamItem<Item>> | undefined
  private closing: Promise<void> | undefined
  private revision = 0
  private taken = false

  /**
   * @param connection - 用于节制重试节奏的可观察 Host 代源。
   * @param options - 领域流打开器、结束分类与诊断。
   */
  constructor(
    private readonly connection: Pick<ConnectionHandle, 'generation'>,
    private readonly options: RemoteStreamOptions<Item>,
  ) {}

  /** 流与同级页面请求共享的取消生命周期。 */
  get signal(): AbortSignal {
    return this.lifetime.signal
  }

  /** 中断当前代并立即请求替换。 */
  restart(): void {
    if (this.lifetime.signal.aborted) return
    this.revision++
    this.generationAbort?.abort(new Error(`${this.options.name} generation restarted`))
  }

  /**
   * 永久停止此流并等待其迭代器关闭。
   * @returns 活跃代与消费方迭代器归于静止时。
   */
  dispose(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    if (!this.lifetime.signal.aborted) {
      const reason = new Error(`${this.options.name} disposed`)
      this.lifetime.abort(reason)
      this.generationAbort?.abort(reason)
    }
    const iterator = this.iterator
    if (iterator === undefined) return Promise.resolve()
    const closing = closeRemoteStreamIterator(iterator)
    this.closing = closing
    return closing
  }

  /** @inheritdoc */
  [Symbol.asyncIterator](): AsyncIterator<RemoteStreamItem<Item>> {
    if (this.taken) throw new Error(`${this.options.name} already has a consumer`)
    this.taken = true
    const iterator = this.read()
    this.iterator = iterator
    return iterator
  }

  private async * read(): AsyncGenerator<RemoteStreamItem<Item>> {
    let attempt = 0
    let generation = 0
    let observedRevision = this.revision
    try {
      while (!isAborted(this.lifetime.signal)) {
        if (observedRevision !== this.revision) {
          observedRevision = this.revision
          attempt = 0
        }
        const revision = this.revision
        const generationAbort = new AbortController()
        this.generationAbort = generationAbort
        const signal = AbortSignal.any([this.lifetime.signal, generationAbort.signal])
        const generationId = ++generation
        let accepted = false
        try {
          for await (const value of this.options.open(signal)) {
            if (isAborted(this.lifetime.signal)) return
            if (revision !== this.revision) break
            yield {
              generation: generationId,
              value,
              signal,
              accept: () => {
                if (this.generationAbort !== generationAbort || revision !== this.revision) return
                accepted = true
                attempt = 0
              },
            }
          }
          if (isAborted(this.lifetime.signal)) return
          if (revision !== this.revision) continue
          throw this.options.ended(accepted)
        } catch (error) {
          if (isAborted(this.lifetime.signal)) return
          if (revision !== this.revision) continue
          if (!(error instanceof RemoteStreamCarrierError)) throw terminalStreamFailure(error)
          this.options.carrierFailed?.(error)
          if (revision !== this.revision) continue
          attempt++
          try {
            await waitForRemoteStreamRetry(this.connection, error, attempt, signal)
          } catch (retryError) {
            if (isAborted(this.lifetime.signal)) return
            if (revision !== this.revision) continue
            throw terminalStreamFailure(retryError)
          }
        } finally {
          this.generationAbort = undefined
          if (!generationAbort.signal.aborted) {
            generationAbort.abort(new Error(`${this.options.name} generation ended`))
          }
        }
      }
    } finally {
      if (!this.lifetime.signal.aborted) {
        this.lifetime.abort(new Error(`${this.options.name} consumer closed`))
      }
      this.generationAbort?.abort(this.lifetime.signal.reason)
      this.generationAbort = undefined
    }
  }
}

async function waitForRemoteStreamRetry(
  connection: Pick<ConnectionHandle, 'generation'>,
  error: RemoteStreamCarrierError,
  attempt: number,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted()
  if (connection.generation.getSnapshot() !== undefined) {
    if (attempt === 1) return
    throw error
  }
  await new Promise<void>((resolve, reject) => {
    const subscription: {
      dispose?: () => void
      finished: boolean
    } = { finished: false }
    const finish = (failure?: Error): void => {
      if (subscription.finished) return
      subscription.finished = true
      subscription.dispose?.()
      signal.removeEventListener('abort', aborted)
      if (failure === undefined) resolve()
      else reject(failure)
    }
    const inspect = (): void => {
      if (connection.generation.getSnapshot() !== undefined) finish()
    }
    const aborted = (): void => {
      finish(new Error('Remote stream retry aborted', { cause: signal.reason }))
    }
    const dispose = connection.generation.subscribe(inspect)
    subscription.dispose = dispose
    if (subscription.finished) dispose()
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
    else inspect()
  })
}

/**
 * 在终止性异常跨出流边界之前为其加标记：消费方按 code 区分
 * 失败，未加标记的抛出会被当作本地缺陷。
 * 已标记的失败原样透传。
 * 载体类绝不作为终止结果逃逸——它始终是喂给
 * `carrierFailed` 与 `ended(true)` 重试触发的重试内部信号。
 */
function terminalStreamFailure(error: unknown): Error {
  return remoteErrorOf(error) ?? new RemoteError(
    'gateway/internal',
    error instanceof Error ? error.message : String(error),
    {},
    { cause: error },
  )
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

async function closeRemoteStreamIterator<Item>(
  iterator: AsyncIterator<RemoteStreamItem<Item>>,
): Promise<void> {
  try {
    await iterator.return?.()
  } catch {
    // 已释放的逻辑流没有剩余消费方接收取消失败。
  }
}
