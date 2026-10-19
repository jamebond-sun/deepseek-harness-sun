/** Remote 贡献装配的 Host BFF 入口与 Loader 外壳。 */

import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  TypertRemoteEventDispatch,
  TypertRemoteEventInvocation,
  TypertRemoteEventOutcome,
  TypertRemoteEventSource,
} from '@deepseek-ai/dsh-api-gateway'
import { Deque } from '@deepseek-ai/dsh-deque'
import { carrierKeyOf } from '@deepseek-ai/dsh-scope'
import { isJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'
import { API_REMOTE_FORWARDED_EVENTS } from './remote-events.ts'

// owner 包的 client-safe `./types` 导出携带每个允许列表事件的
// cordis `Events` 声明。把它们拉入本编译面，正是这一点使下方
// 的形状断言判定真实签名，
// 而非空的事件词汇表。
import type {} from '@deepseek-ai/dsh-commands/types'
import type {} from '@deepseek-ai/dsh-cordis-host-runner/types'
import type {} from '@deepseek-ai/dsh-credentials/types'
import type {} from '@deepseek-ai/dsh-goal/types'
import type {} from '@deepseek-ai/dsh-llm/types'
import type {} from '@deepseek-ai/dsh-agent-preset-registry/types'
import type {} from '@deepseek-ai/dsh-permission-presets/types'
import type {} from '@deepseek-ai/dsh-settings/types'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'
export type {} from '@deepseek-ai/dsh-api-session-controller/types'

export { API_REMOTE_FORWARDED_EVENTS } from './remote-events.ts'
export type { ApiRemoteForwardedEvent } from './types.ts'

/** 必需的 Host 服务：Gateway 拥有物理 Remote 流复用器。 */
export const inject = ['typertGateway']

/** 注册本应用所选 Cordis 事件源的 Host 插件体。 */
export function apply(ctx: Context): void {
  ctx.effect(
    () => ctx.typertGateway.registerRemoteEvents(remoteEventSource(ctx), { home: homedir() }),
    'api-remotes: forwarded Cordis event source',
  )
}

/** 创建已注册 Gateway 消费的唯一队列与监听器集合。 */
function remoteEventSource(ctx: Context): TypertRemoteEventSource {
  return (signal) => {
    const queue = new RemoteEventQueue()
    const disposers = API_REMOTE_FORWARDED_EVENTS.map((entry) => {
      const { event, mode } = entry
      if (mode === 'emit') {
        const resources = 'resources' in entry ? entry.resources : undefined
        return ctx.on(event as never, ((...args: unknown[]) => {
          queue.push({ event, args: assertJsonArgs(event, args), ...resources === undefined ? {} : { resources } })
        }) as never)
      }
      return ctx.on(event as never, (function (
        this: unknown,
        request: object,
        next: () => unknown,
      ) {
        const carrierAgent = carrierKeyOf(this)
        if (carrierAgent === undefined) return next()
        const agent = (request as { readonly agent?: Agent }).agent
        if (agent === undefined || agent !== carrierAgent) {
          throw new TypeError(`forwarded scoped event ${JSON.stringify(event)} must carry its Agent directly`)
        }
        return forwardWaterfall(
          queue,
          event,
          request,
          { value: agent.ctx, subject: agent, agentId: agent.id },
          next,
        )
      }) as never)
    })
    return queue.iterate(signal, () => {
      for (const dispose of disposers) dispose()
    })
  }
}

/** 一个拉取驱动的队列，把同步 Cordis 监听器桥接到 AsyncIterable。 */
class RemoteEventQueue {
  private readonly buffer = new Deque<TypertRemoteEventDispatch>()
  private waiter: (() => void) | undefined
  private done = false

  push(frame: TypertRemoteEventDispatch): boolean {
    if (this.done) return false
    this.buffer.pushBack(frame)
    this.waiter?.()
    return true
  }

  private end(reason: unknown): void {
    if (this.done) return
    this.done = true
    while (this.buffer.size > 0) {
      const dispatch = this.buffer.popFront() as TypertRemoteEventDispatch
      if ('context' in dispatch) dispatch.reject(reason)
    }
    this.waiter?.()
  }

  async *iterate(signal: AbortSignal, cleanup: () => void): AsyncGenerator<TypertRemoteEventDispatch> {
    const abort = (): void => { this.end(remoteEventSourceEndReason(signal)) }
    signal.addEventListener('abort', abort, { once: true })
    try {
      while (true) {
        if (this.done || signal.aborted) return
        while (this.buffer.size > 0) yield this.buffer.popFront() as TypertRemoteEventDispatch
        await new Promise<void>((resolve) => { this.waiter = resolve })
        this.waiter = undefined
      }
    } finally {
      signal.removeEventListener('abort', abort)
      this.end(remoteEventSourceEndReason(signal))
      cleanup()
    }
  }
}

/**
 * 为待决的 Host 瀑布调用规范化事件源的关闭方式。
 * @param signal - 源生命周期，取消后以其 reason 为准。
 * @returns 取消原因，或非预期结束的失败。
 */
function remoteEventSourceEndReason(signal: AbortSignal): unknown {
  if (signal.aborted) return signal.reason
  return new Error('api-remotes: forwarded Remote event source ended')
}

/** 通过 Gateway 持有的待决事件桥接一个 Cordis 瀑布监听器。 */
function forwardWaterfall(
  queue: RemoteEventQueue,
  event: string,
  request: object,
  context: TypertRemoteEventInvocation['context'],
  next: () => unknown,
): Promise<unknown> {
  const settled = Promise.withResolvers<unknown>()
  const dispatch: TypertRemoteEventInvocation = {
    event,
    request,
    context,
    resolve: (outcome: TypertRemoteEventOutcome) => {
      if (outcome.kind === 'result') {
        settled.resolve(outcome.value)
        return
      }
      void Promise.resolve().then(next).then(settled.resolve, settled.reject)
    },
    reject: settled.reject,
  }
  if (!queue.push(dispatch)) void Promise.resolve().then(next).then(settled.resolve, settled.reject)
  return settled.promise
}

/** 拒绝运行时参数不是无损 JSON 数据的允许列表事件。 */
function assertJsonArgs(event: string, args: readonly unknown[]): JsonValue[] {
  for (const [index, arg] of args.entries()) {
    if (!isJsonValue(arg)) {
      throw new Error(`forwarded host event "${event}" argument ${String(index)} is not lossless JSON data`)
    }
  }
  return args as JsonValue[]
}
