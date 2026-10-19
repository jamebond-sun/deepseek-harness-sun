/**
 * agent 作用域的分发与提示词组装助手。融合分发器 {@link agentEvents} 把
 * agent 主体与其作用域载体耦合在一起，使 scope 键与负载的 `agent` 不会
 * 分歧；重复分发的使用方（循环驱动方）在 agent 的构造函数中构建一次并复用。
 * @module @deepseek-ai/dsh-agent/dispatch
 */

import type { Context, Events } from '@deepseek-ai/cordis'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import type { Agent } from './types.ts'

/** 从事件处理器类型中提取参数元组（其 `this` 不属于该元组）。 */
type Params<F> = F extends (...args: infer P) => unknown ? P : never
/** 从事件处理器类型中提取返回类型。 */
type Return<F> = F extends (...args: never[]) => infer R ? R : never

/**
 * 主体是 agent 的事件名：处理器的第一个参数是携带 `agent` 主体的负载对象，
 * 且处理器声明了 `Scoped<Agent>` 的 `this`（作用域载体契约）。`this` 检查把
 * 负载恰好携带一个 Agent 的意外事件（或零参数事件——其参数元组会因可调用
 * 性而满足裸 rest 元组检查）排除在融合分发面之外。
 */
export type AgentSubjectEvent = {
  [K in keyof Events]: Events[K] extends (this: Scoped<Agent>, ...args: infer P) => unknown
    ? P extends [infer Payload, ...unknown[]]
      ? Payload extends { agent: Agent } ? K : never
      : never
    : never
}[keyof Events]

/** 单个 agent 主体事件的完整负载对象。 */
type PayloadOf<K extends AgentSubjectEvent> = Params<Events[K]> extends [infer Payload, ...unknown[]] ? Payload : never

/** 负载之后的事件参数：存在时即为 waterfall 的 `next`。 */
type Tail<K extends AgentSubjectEvent> = Params<Events[K]> extends [unknown, ...infer R] ? R : never

/**
 * emit 侧调用方传入的负载：完整负载去掉 agent 字段，该字段由融合分发器
 * 注入，使主体与 scope 键不会分歧。
 */
type PayloadRest<K extends AgentSubjectEvent> = Omit<PayloadOf<K> & object, 'agent'>

/**
 * 融合分发器 {@link agentEvents} 的返回值：每个方法都以 agent 的作用域载体
 * 作为 `thisArg`、并把 agent 本身注入负载，分发对应的 agent 主体事件。
 */
export interface AgentEventDispatch {
  /**
   * 在 agent 作用域内的即发即忘通知。每个监听器都会被调用；同步抛出与
   * 返回 promise 的拒绝按监听器记录并包容，因此通知不能否决生命周期
   * 推进，也不会饿死后续观察者。
   * @param name - 要发出的 agent 主体事件。
   * @param payload - 事件的负载字段；`agent` 会被注入。
   */
  emit<K extends AgentSubjectEvent>(name: K, payload: PayloadRest<K>): void
  /**
   * 在 agent 作用域内被等待的按序分发（Cordis `serial`）。
   * @param name - 要分发的 agent 主体事件。
   * @param payload - 事件的负载字段；`agent` 会被注入。
   * @returns 串行链的结果（如有第一个中止值）。
   */
  serial<K extends AgentSubjectEvent>(name: K, payload: PayloadRest<K>): Promise<Awaited<Return<Events[K]>>>
  /**
   * 在 agent 作用域内的环绕中间件分发（Cordis `waterfall`）。声明的事件参数
   * 已以 `next` 回调结尾，因此 `rest` 恰好是负载之后的事件参数 —— 最后一个
   * 元素是最内层的 `next`（监听器链包裹的默认值）。
   * @param name - 要分发的 agent 主体事件。
   * @param payload - 事件的负载字段；`agent` 会被注入。
   * @param rest - 负载之后的事件参数（`next` 回调）。
   * @returns waterfall 组合的结果。
   */
  waterfall<K extends AgentSubjectEvent>(name: K, payload: PayloadRest<K>, ...rest: Tail<K>): Return<Events[K]>
}

/**
 * 为一个 agent 主体构建融合的 scope 载体。
 *
 * 载体是无状态的路由对象。{@link agentEvents} 接受一个已有的载体，因此
 * 为同一个 agent 反过分发的调用方（循环驱动方）在 agent 的构造函数中
 * 构建一次并复用，保持热路径分发零分配。
 * @param agent - 主体 agent 与 scope 键。
 * @returns 作为事件分发器 `this` 值传入的载体。
 */
export function agentCarrier(agent: Agent): Scoped<Agent> {
  return scopeTarget(agent, agent)
}

/**
 * 构建一个把 agent 主体与其 scope 载体耦合在一起的分发器。
 * @param ctx - 用于分发的上下文（应用的任意上下文）。
 * @param agent - 主体 agent；同时也是 scope 载体的键。
 * @param carrier - 用于分发的 scope 载体；默认为该 agent 的
 * {@link agentCarrier}。传入构造函数中构建的载体可避免每次分发都重建。
 * @returns 融合分发器。
 */
export function agentEvents(ctx: Context, agent: Agent, carrier: Scoped<Agent> = agentCarrier(agent)): AgentEventDispatch {
  // 普通的分发方法通过 Cordis 的可变参数 mixin 转发。融合的
  // (carrier, name, payload, ...rest) 元组可以证明是匹配 thisArg 重载的有效
  // 参数列表，但 TypeScript 无法把泛型 Tail<K> 的展开关联回该重载的条件
  // 参数元组 —— 因此每个方法做一次被包容的、保持形状的类型转换。
  const fused = <K extends AgentSubjectEvent>(payload: PayloadRest<K>): PayloadOf<K> =>
    // 分发器拥有主体注入；调用方传入 PayloadRest，因此融合后的记录恰好是
    // 声明的负载。展开放在最前，使结构上可接受但恰好携带 `agent` 字段的
    // 负载永远无法覆盖注入的主体。
    ({ ...payload, agent } as PayloadOf<K>)
  return {
    emit(name, payload) {
      // Cordis 的 emit 通过 Array.map 调用回调：一次同步抛出会饿死后续
      // 监听器，返回的 promise 被丢弃。Agent 通知不可否决，因此自行解析
      // 同样的过滤回调集合并独立包容两种失败模式。
      const args: unknown[] = [carrier, name, fused(payload)]
      const callbacks = ctx.events.dispatch('emit', args)
      for (const callback of callbacks) {
        try {
          const returned: unknown = callback(...args)
          void Promise.resolve(returned).catch((error: unknown) => {
            ctx.logger.warn(`agent event "${name}" listener rejected: ${String(error)}`)
          })
        } catch (error: unknown) {
          ctx.logger.warn(`agent event "${name}" listener threw: ${String(error)}`)
        }
      }
    },
    async serial(name, payload) {
      // oxlint-disable-next-line typescript/unbound-method -- the events mixin accessor returns a pre-bound function
      const serial = ctx.serial as (thisArg: Scoped<Agent>, name: string, ...args: unknown[]) => Promise<never>
      return await serial(carrier, name, fused(payload))
    },
    waterfall(name, payload, ...rest) {
      // oxlint-disable-next-line typescript/unbound-method -- the events mixin accessor returns a pre-bound function
      const waterfall = ctx.waterfall as (thisArg: Scoped<Agent>, name: string, ...args: unknown[]) => never
      return waterfall(carrier, name, fused(payload), ...rest)
    },
  }
}

/**
 * 发出一条被包容的 agent 通知，而不分配一个被保留的分发器。
 * @param ctx - 用于分发的上下文。
 * @param agent - 主体 agent 与 scope 键。
 * @param name - 要发出的 agent 主体事件。
 * @param payload - 事件的负载字段；`agent` 会被注入。
 */
export function emitAgentEvent<K extends AgentSubjectEvent>(
  ctx: Context,
  agent: Agent,
  name: K,
  payload: PayloadRest<K>,
): void {
  agentEvents(ctx, agent).emit(name, payload)
}

/**
 * 构建同时设置 agent 与 scope 的提示词组装上下文，使 agent 作用域的提示词
 * 与工具贡献不会被静默遗漏。
 * @param agent - 组装所面向的 agent。
 * @param signal - 当前 turn 的显式控制信号（当组装属于一个 turn 时）。
 * @returns 传给 `assemble()` 的上下文。
 */
export function assembleContextFor(agent: Agent, signal?: AbortSignal): AssembleContext {
  return { agent, scope: agent, ...signal === undefined ? {} : { signal } }
}
