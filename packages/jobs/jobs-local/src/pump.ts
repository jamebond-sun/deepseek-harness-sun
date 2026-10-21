/**
 * 注册表自有的拉取泵：以有界节奏把一个任务的各个 {@link JobOutputSource} 复制到它的
 * 环形缓冲区里，并在生产者结算之后再排空一次，这样在结算裁剪并关闭它之前，环形缓冲区
 * 持有每一个字节。一次有损的源读取会作为断点块落地；源所保存的溢出文件在每次读取时都
 * 上报给 sink，因为那份引用比任何块都活得久。纯工具——不涉及 cordis，结算之后不保留定时器。
 * @module @deepseek-ai/dsh-jobs-local/pump
 */

import type { JobAppendOptions, JobOutputSource } from '@deepseek-ai/dsh-jobs'

/** 一次泵运行；`done` 在结算后的最终排空之后兑现。 */
export interface PumpHandle {
  done: Promise<void>
}

/** 泵把它读到的东西投递到何处。 */
export interface PumpSink {
  /**
   * 把复制来的文本追加到环形缓冲区。
   * @param text - 与读取时完全一致的块文本。
   * @param options - 流标签与断点标记。
   */
  append(text: string, options?: JobAppendOptions): void
  /**
   * 记录下标为 `index` 的源在其最近一次读取时通告的溢出文件；每次读取都会调用，
   * 当该源没有保存文件或已撤回时传 `undefined`。
   * @param index - 该源在泵的源数组中的位置。
   * @param path - 该源上报的宿主路径，如果有。
   */
  spill(index: number, path: string | undefined): void
}

/**
 * 按数组顺序排空每个源，休眠 `pollMs` 或直到 `until` 结算，然后重复，最后再排空一次。
 * 一次有损的源读取会把存活下来的尾部带上 `gapBefore` 追加，这样观察者仍能看到断点。
 * 每轮都按数组顺序排空，因此两个源在同一个轮询窗口内产出的字节按该顺序落地，而不是按
 * 它们被写入的顺序：环形缓冲区是一个尽力而为的实时视图，其跨源重排受 `pollMs` 约束。
 *
 * 无论任务跑多久，这个等待都只占用恒定的资源：整轮运行只在 `until` 上有一个订阅，
 * 且同一时刻只有一个待定定时器。
 * @param sources - 生产者的流，各自按自己的偏移被泵送。
 * @param sink - 接收每个复制来的块以及每个源当前的溢出文件。
 * @param pollMs - 轮询间隔，单位毫秒；一个正的有限数。
 * @param until - 生产者完成时结算（或拒绝，这也算结算）；只用到它的 `then`。
 * @returns 那个句柄，其 `done` 在最终排空之后兑现。
 */
export function startPump(
  sources: readonly JobOutputSource[],
  sink: PumpSink,
  pollMs: number,
  until: PromiseLike<unknown>,
): PumpHandle {
  if (!Number.isFinite(pollMs) || pollMs <= 0) {
    throw new Error(`invalid pump pollMs: expected a positive finite number of milliseconds, got ${JSON.stringify(pollMs)}`)
  }
  const states = sources.map(source => ({ source, cursor: 0 }))
  const drain = (): void => {
    for (const [index, state] of states.entries()) {
      const { source } = state
      const read = source.read(state.cursor)
      state.cursor = read.nextOffset
      sink.spill(index, read.spillPath)
      if (read.text.length === 0) continue
      if (source.channel === undefined && !read.lossy) {
        sink.append(read.text)
      } else {
        sink.append(read.text, {
          ...source.channel !== undefined ? { channel: source.channel } : {},
          ...read.lossy ? { gapBefore: true as const } : {},
        })
      }
    }
  }
  const done = (async (): Promise<void> => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let wake: (() => void) | undefined
    const finish = (): void => {
      settled = true
      // 清掉待定的轮询，这样已结束的泵不会在最多一个间隔内还持有定时器；同时释放当前的
      // 等待，让最终排空立刻执行。`finish` 总是从微任务里运行，即在循环停驻到它的第一个
      // 定时器之后，所以这里的定时器绝不会缺席。
      clearTimeout(timer)
      wake?.()
    }
    void until.then(finish, finish)
    while (!settled) {
      drain()
      await new Promise<void>((resolve) => {
        wake = resolve
        timer = setTimeout(resolve, pollMs)
      })
      wake = undefined
      timer = undefined
    }
    drain()
  })()
  return { done }
}
