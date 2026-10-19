/** 实例自有的原生图像变换并发上限。 */

/**
 * 保留 Error 拒绝原因，并将非 Error 的原生绑定值归一化。
 * @param reason - 压缩任务返回的拒绝原因。
 * @returns 适合用于 promise 拒绝的 Error。
 */
export function compressionFailure(reason: unknown): Error {
  return reason instanceof Error
    ? reason
    : new Error('Image compression task rejected with a non-Error value.', { cause: reason })
}

/** 面向异步压缩工作的先进先出限制器。 */
export class CompressionLimiter {
  private active = 0
  private readonly waiting: Array<() => void> = []

  /**
   * @param concurrency - 活跃任务数的正数上限。
   */
  constructor(readonly concurrency: number) {}

  /**
   * 在实例槽位可用后运行一个任务。
   * @param task - 占用一个槽位直至落定的压缩操作。
   * @returns 任务结果。
   */
  run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = (): void => {
        this.active += 1
        const release = (): void => {
          this.active -= 1
          this.waiting.shift()?.()
        }
        void Promise.resolve().then(task).then(
          (value) => {
            release()
            resolve(value)
          },
          (error: unknown) => {
            release()
            reject(compressionFailure(error))
          },
        )
      }
      if (this.active < this.concurrency) start()
      else this.waiting.push(start)
    })
  }
}
