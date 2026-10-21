/**
 * 共享的超时算术、信号融合与分类。本库仅通过 abort 信号通知；每个能力仍各自
 * 拥有停止其工作的机制，并将超时原因转化为公开结果。
 * @module @deepseek-ai/dsh-timeout
 */

/**
 * 携带能力自有代码与已流逝截止时间的内部 abort 原因。提供方在返回给调用方前
 * 通过 {@link timeoutOf} 对其做转化。
 */
export class TimeoutReason extends Error {
  override name = 'TimeoutReason'

  /**
   * @param code 能力自有的超时代码（如 `BASH_TIMEOUT`）。
   * @param timeoutMs 已流逝的截止时间，以毫秒计。
   */
  constructor(readonly code: string, readonly timeoutMs: number) {
    super(`${code} after ${timeoutMs}ms`)
  }
}

/** Node 在不将其钳制到一毫秒的前提下所能调度的最大延迟。 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

function assertTimerDelay(timeoutMs: number, name: string): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`${name} must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
}

/**
 * 校验调用方可选的超时提示，使用后端默认值，然后加以限制。提供的值必须为正且
 * 有限；零不是公开的「禁用超时」哨兵。
 *
 * @param requested 调用方可选的提示；存在时会被校验。
 * @param def 当 `requested` 缺席时应用的后端默认值。
 * @param max 结果被限制到的后端上限。
 * @param name 抛出异常消息中使用的字段名（以便调用方看出是哪个输入有误）。
 * @returns 生效的超时，以毫秒计：`min(requested ?? def, max)`。
 */
export function clampTimeout(
  requested: number | undefined,
  def: number,
  max: number,
  name = 'timeoutMs',
): number {
  if (requested !== undefined && (!Number.isFinite(requested) || requested <= 0)) {
    throw new Error(`${name} must be a positive finite number`)
  }
  return Math.min(requested ?? def, max)
}

/** 一个截止时间信号，外加清除其计时器的清理逻辑（一次性释放）。 */
export interface Deadline {
  /** 在上游取消或超时时 abort（超时携带一个 {@link TimeoutReason}）。 */
  readonly signal: AbortSignal
  /** 清除计时器。可安全调用一次；`using` 在作用域退出时调用它。 */
  [Symbol.dispose](): void
}

/** 围绕一个未完成的异步迭代器需求的可重置超时看门狗。 */
export interface IdleWatchdog {
  /** 由上游取消或本看门狗超时中止的稳定信号。 */
  readonly signal: AbortSignal
  /**
   * 在空闲计时器已触发的情况下等待一个迭代器需求。即便被等待的工作忽略其 abort
   * 信号，截止时间仍会了结该需求。
   * @param iterator - 其下一个值代表提供方进展的迭代器。
   * @returns 该迭代器的下一个结果。
   * @throws 当空闲间隔先流逝时，本看门狗的 {@link TimeoutReason}。只有该截止时间
   *   才会了结需求：上游取消通过 {@link IdleWatchdog.signal} 抵达迭代器，且从不
   *   缩短等待。被遗弃的需求仍由调用方通过该信号释放；异步生成器会在其后排队自己的
   *   返回，因此调用方绝不能等待它。释放会清除计时器而不了结未完成的需求。
   */
  next<T>(iterator: AsyncIterator<T>): Promise<IteratorResult<T>>
  /** 在产生不了迭代器值的传输活动之后重置一个未完成需求；否则为空操作。 */
  pulse(): void
  /** 清除已触发的计时器；可在所属流的退出时安全调用一次。 */
  [Symbol.dispose](): void
}

/**
 * 将上游取消与一个可识别的超时融合。`timeoutMs <= 0` 是内部「无计时器」哨兵；
 * 返回的释放器会清除已触发的计时器。信号仅作通知，因此调用方必须停止其自身工作。
 *
 * @param upstream 调用方的取消信号（若有），被融合进结果。
 * @param timeoutMs 截止时间，以毫秒计；`<= 0` 意为「无超时」（不触发计时器）。
 * @param code 打在超时 {@link TimeoutReason} 上的能力自有代码。
 * @returns 融合后的 {@link Deadline}（信号 + 计时器清理）。
 */
export function deadline(
  upstream: AbortSignal | undefined,
  timeoutMs: number,
  code: string,
): Deadline {
  if (timeoutMs <= 0) {
    // 无超时（后台工作）：仅转发上游信号，或在没有上游时转发永不中止的信号。
    return { signal: upstream ?? new AbortController().signal, [Symbol.dispose]() {} }
  }

  assertTimerDelay(timeoutMs, 'deadline timeoutMs')

  const timer = new AbortController()
  const id = setTimeout(() => { timer.abort(new TimeoutReason(code, timeoutMs)) }, timeoutMs)
  return {
    // AbortSignal.any 采用最先中止的那个来源的 reason，因此竞争会归结为单一原因：
    // timeoutOf() 仅在超时胜出时读取 TimeoutReason，而上游胜出则留下普通的 abort 原因。
    signal: upstream !== undefined ? AbortSignal.any([upstream, timer.signal]) : timer.signal,
    [Symbol.dispose]() { clearTimeout(id) },
  }
}

/**
 * 为异步迭代器创建一个可重置的空闲看门狗。计时器仅当 {@link IdleWatchdog.next}
 * 未完成时存在，因此消费方的思考时间不计入提供方的空闲时间。返回的信号在整个
 * 调用期间稳定且只作通知；迭代器必须观察它，以释放截止时间所遗弃的需求资源。
 *
 * @param upstream - 融合进稳定信号中的调用方取消信号。
 * @param timeoutMs - 正的有限空闲间隔，以毫秒计。
 * @param code - 由超时原因携带的能力自有代码。
 * @returns 一个稳定信号、受保护的 next 操作，以及计时器释放器。
 */
export function idleWatchdog(
  upstream: AbortSignal | undefined,
  timeoutMs: number,
  code: string,
): IdleWatchdog {
  assertTimerDelay(timeoutMs, 'idleWatchdog timeoutMs')
  const timeout = new AbortController()
  const signal = upstream === undefined
    ? timeout.signal
    : AbortSignal.any([upstream, timeout.signal])
  // 截止时间拥有未完成的需求。传输层可能让它中止的读取永远挂起（undici 在 abort
  // 落在一个进行中的正文读取上时丢弃该错误），因此等待迭代器观察该信号会让调用方
  // 等待超过其自身截止时间。
  const reason = new TimeoutReason(code, timeoutMs)
  let timer: ReturnType<typeof setTimeout> | undefined
  let outstanding = false
  let disposed = false

  const arm = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timeout.abort(reason)
    }, timeoutMs)
  }

  return {
    signal,
    async next<T>(iterator: AsyncIterator<T>): Promise<IteratorResult<T>> {
      if (disposed) throw new Error('idleWatchdog is disposed')
      if (outstanding) throw new Error('idleWatchdog next is already outstanding')
      outstanding = true
      arm()
      const expired = Promise.withResolvers<never>()
      const onAbort = (): void => { expired.reject(reason) }
      timeout.signal.addEventListener('abort', onAbort, { once: true })
      try {
        // 两种反应都以该需求结束：为看门狗生命周期保留的截止时间 promise 会保留
        // 已了结竞争所产生的每个值。
        return await Promise.race([
          iterator.next().finally(() => { timeout.signal.removeEventListener('abort', onAbort) }),
          expired.promise,
        ])
      } finally {
        clearTimeout(timer)
        timer = undefined
        outstanding = false
      }
    },
    pulse(): void {
      if (disposed || !outstanding) return
      arm()
    },
    [Symbol.dispose](): void {
      if (disposed) return
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    },
  }
}

/**
 * 从一个携带原因的对象中恢复超时原因。提供 `code` 可将本截止时间与嵌套的上游
 * 截止时间区分开；异种代码走普通的取消路径。
 *
 * @param x 一个 {@link AbortSignal} 或任何 `{ reason }` 载体（如捕获的 abort 错误）。
 * @param code 提供时，只有携带此精确 `code` 的 {@link TimeoutReason} 才匹配。
 * @returns 匹配的 {@link TimeoutReason}，否则 `undefined`。
 */
export function timeoutOf(x: AbortSignal | { reason?: unknown }, code?: string): TimeoutReason | undefined {
  // AbortSignal.reason 被类型化为 `any`；将其固定为 `unknown` 以免 `any` 泄漏，
  // 并使 instanceof 对信号与裸原因载体都能干净地收窄。
  const reason: unknown = x.reason
  if (!(reason instanceof TimeoutReason)) return undefined
  return code === undefined || reason.code === code ? reason : undefined
}
