/** Cordis timer Service 的浏览器侧实现。 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'

/*
 * 浏览器侧 Service 保留了被 vendored 的 Host TimerService 中被擦除的回调元组，
 * 以及任意的 async-iterator 返回值与拒绝值，因此收窄这些位置会改变公开 API。
 */
/* oxlint-disable typescript/no-explicit-any -- 与 Host TimerService API 的精确兼容；见上文。 */
/* oxlint-disable typescript/no-unsafe-argument -- 被擦除的回调元组原样透传。 */
/* oxlint-disable typescript/no-unsafe-assignment -- 被擦除的回调元组原样透传。 */
/* oxlint-disable typescript/no-unsafe-member-access -- 返回的封装保留了其 dispose 属性。 */
/* oxlint-disable typescript/no-unsafe-return -- 被擦除的泛型返回值原样透传。 */
/* oxlint-disable typescript/prefer-promise-reject-errors -- Async iterator 保留任意的 throw 原因。 */

declare module '@deepseek-ai/cordis' {
  interface Context extends Pick<ClientTimerService, 'interval' | 'timeout' | 'throttle' | 'debounce' | 'setTimeout' | 'setInterval'> {
    /** 被混入的 Context 辅助方法所使用的浏览器侧 timer Service。 */
    timer: ClientTimerService
  }
}

type WithDispose<T> = T & { dispose: () => void }

// 这些 `any` 位置镜像了 Host TimerService 的重载擦除：泛型回调元组与 async-iterator
// 的返回/拒绝值必须原样透传，而不能收窄到某一次调用的形态。

/** 与 Host Cordis TimerService 公开 API 相同的浏览器侧 timer Service。 */
export class ClientTimerService extends Service {
  /** 注册该 Service 并将其生命周期安全的辅助方法混入 Context。 */
  constructor(ctx: Context) {
    super(ctx, 'timer')
    ctx.mixin('timer', ['timeout', 'interval', 'throttle', 'debounce', 'setTimeout', 'setInterval'])
  }

  /**
   * 经由 {@link timeout} 运行一次回调。
   * @param callback - 延迟后要执行的工作。
   * @param delay - 延迟，以毫秒计。
   * @returns 提前取消挂起回调的释放器。
   * @deprecated 请改用 `ctx.timeout()`。
   */
  setTimeout(callback: () => void, delay: number): () => void {
    return this.timeout(callback, delay)
  }

  /**
   * 经由 {@link interval} 反复运行回调。
   * @param callback - 每次触发时执行的工作。
   * @param delay - 间隔，以毫秒计。
   * @returns 提前停止该间隔的释放器。
   * @deprecated 请改用 `ctx.interval()`。
   */
  setInterval(callback: () => void, delay: number): () => void {
    return this.interval(callback, delay)
  }

  /**
   * 在延迟后运行一次回调。
   * @param callback - 要运行的工作。
   * @param delay - 延迟，以毫秒计。
   * @returns 取消该回调的释放器。
   */
  timeout(callback: () => void, delay: number): () => void
  /**
   * 等待一段延迟。
   * @param delay - 延迟，以毫秒计。
   * @returns 延迟后被解析的 promise。
   */
  timeout(delay: number): Promise<void>
  timeout(...args: any[]): any {
    const callback = typeof args[0] === 'function' ? args.shift() as () => void : undefined
    const delay = args[0] as number
    if (callback !== undefined) {
      const dispose = this.ctx.effect(() => {
        const timer = globalThis.setTimeout(() => {
          void dispose()
          callback()
        }, delay)
        return () => { globalThis.clearTimeout(timer) }
      }, 'ctx.timeout()')
      return dispose
    }

    const { promise, resolve, reject } = Promise.withResolvers<void>()
    const dispose = this.ctx.effect(() => {
      const timer = globalThis.setTimeout(resolve, delay)
      return () => {
        globalThis.clearTimeout(timer)
        reject(new Error('Context has been disposed'))
      }
    }, 'ctx.timeout()')
    return promise.finally(() => { void dispose() })
  }

  /**
   * 反复运行回调。
   * @param callback - 每次触发时执行的工作。
   * @param delay - 间隔，以毫秒计。
   * @returns 停止该间隔的释放器。
   */
  interval(callback: () => void, delay: number): () => void
  /**
   * 遍历定时器触发。
   * @param delay - 间隔，以毫秒计。
   * @returns 触发的 async iterator。
   */
  interval<R = any>(delay: number): AsyncIterableIterator<void, R, void>
  interval(...args: any[]): any {
    const callback = typeof args[0] === 'function' ? args.shift() as () => void : undefined
    const delay = args[0] as number
    if (callback !== undefined) {
      return this.ctx.effect(() => {
        const timer = globalThis.setInterval(callback, delay)
        return () => { globalThis.clearInterval(timer) }
      }, 'ctx.interval()')
    }

    let done: { kind: 'return'; value: any } | { kind: 'throw'; reason: any } | undefined
    let nextTask: PromiseWithResolvers<IteratorResult<void>> | undefined
    const dispose = this.ctx.effect(() => {
      const timer = globalThis.setInterval(() => {
        nextTask?.resolve({ done: false, value: undefined })
      }, delay)
      return () => {
        globalThis.clearInterval(timer)
        if (done !== undefined) return
        done = { kind: 'throw', reason: new Error('Context has been disposed') }
        nextTask?.reject(done.reason)
      }
    }, 'ctx.interval()')
    return {
      next: () => {
        if (done === undefined) return (nextTask = Promise.withResolvers()).promise
        if (done.kind === 'return') return Promise.resolve({ done: true, value: done.value })
        return Promise.reject(done.reason)
      },
      return: (value: any) => {
        if (done === undefined) done = { kind: 'return', value }
        nextTask?.resolve({ done: true, value })
        void dispose()
        return Promise.resolve({ done: true, value })
      },
      throw: (reason: any) => {
        if (done === undefined) done = { kind: 'throw', reason }
        nextTask?.reject(reason)
        void dispose()
        return Promise.resolve({ done: true, value: undefined })
      },
      [Symbol.asyncIterator]() {
        return this
      },
    } satisfies AsyncIterableIterator<void>
  }

  /** 构建一个延迟封装，其挂起的回调归属于调用方的 Fiber。 */
  private schedule(label: string, trigger: (args: any[], disposed: boolean) => number | undefined, disposed = false): any {
    let timer: number | undefined
    const dispose = this.ctx.effect(() => () => {
      disposed = true
      globalThis.clearTimeout(timer)
    }, label)
    const wrapper: any = (...args: any[]): void => {
      globalThis.clearTimeout(timer)
      timer = trigger(args, disposed)
    }
    wrapper.dispose = dispose
    return wrapper
  }

  /**
   * 返回一个被节流的函数，其定时器随调用方 Fiber 一并释放。
   * @param callback - 要节流的函数。
   * @param delay - 调用之间的最小间隔，以毫秒计。
   * @param noTrailing - 是否抑制一次延迟的尾部调用。
   * @returns 带有提前释放器的节流函数。
   */
  throttle<F extends (...args: any[]) => void>(callback: F, delay: number, noTrailing?: boolean): WithDispose<F> {
    let lastCall = -Infinity
    const execute = (...args: Parameters<F>): void => {
      lastCall = Date.now()
      callback(...args)
    }
    return this.schedule('ctx.throttle()', (args, disposed) => {
      const remaining = delay - Date.now() + lastCall
      if (remaining <= 0) {
        execute(...args as Parameters<F>)
      } else if (!disposed) {
        return globalThis.setTimeout(execute, remaining, ...args)
      }
    }, noTrailing)
  }

  /**
   * 返回一个被防抖的函数，其定时器随调用方 Fiber 一并释放。
   * @param callback - 要防抖的函数。
   * @param delay - 静默期，以毫秒计。
   * @returns 带有提前释放器的防抖函数。
   */
  debounce<F extends (...args: any[]) => void>(callback: F, delay: number): WithDispose<F> {
    return this.schedule('ctx.debounce()', (args, disposed) => {
      if (disposed) return
      return globalThis.setTimeout(callback, delay, ...args)
    })
  }
}

/**
 * 在一个 Client 组合上安装浏览器侧 timer Service。
 * @param ctx - 拥有该 Service 与被混入辅助方法的 Client 上下文。
 * @returns 注册 Service 之后无返回值。
 */
export function provideClientTimer(ctx: Context): void {
  new ClientTimerService(ctx)
}
