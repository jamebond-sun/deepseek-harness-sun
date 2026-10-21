/**
 * 受管理子代理激活的生命周期边发布。
 *
 * 公开事件载荷位于 `./types.ts`；包内私有的观察者只保留每对 start/end
 * 所共享的身份。
 *
 * @module @deepseek-ai/dsh-subagent/lifecycle
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { foldConsumedWork } from '@deepseek-ai/dsh-agent'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { SubagentRunId } from './types.ts'
import type { SubagentResult, SubagentRunEndInfo, SubagentRunInfo } from './types.ts'

/**
 * 某次激活驻留周期的生命周期观察者。包内私有：续跑管理器是唯一消费者，
 * 其调用顺序属于包内契约，而非已发布的扩展点。
 */
export interface ActivationObserver {
  /**
   * 周期驻留后发布起始边。
   * @param child - 已驻留的本地 Agent，外部执行则为 undefined。
   */
  start(child?: Agent): void
  /**
   * 恰好发布一次终止边，与本周期的 {@link start} 配对，在处置结果已知之后
   * 调用。仅为已驻留的周期调用：驻留之前的失败不发布任何边，因为凭空造出
   * 一条边会报告一个子代理从未拥有的生命周期。
   * @param result - 已应用拆解失败的捕获结果。
   */
  settle(result: SubagentResult): void
}

/**
 * 以逐监听器异常隔离的方式发布一条生命周期边。运行边携带用于键控作用域
 * 分派的委托方父代理；提供方移除没有父代理载体，以无作用域方式到达监听器。
 *
 * service 拥有此闭包，因为作用域分派以精确的 service 实例为其载体键，
 * 该实例自身的上下文过滤器会组合进载体；一个收窄的替身会静默改变作用域过滤。
 */
export type LifecycleEmitter = {
  (name: 'subagent/start', info: SubagentRunInfo, parent: Agent): void
  (name: 'subagent/end', info: SubagentRunEndInfo, parent: Agent): void
  (name: 'subagent/provider-removed', info: string): void
}

/**
 * 构建本接缝发布每条边所经由的、带隔离的生命周期发射器。每个监听器都被
 * 独立隔离：同步抛出或返回的 promise 被拒绝只会记录日志，不会饿死同级
 * 监听器、不会改变运行，也不会 —— 对于从 disposer 触发的提供方移除 ——
 * 破坏拆解。
 * @param ctx - service 自身的上下文，拥有分派与日志器。
 * @param carrier - 为一个委托方父代理解析作用域分派载体。
 * @returns 观察者与提供方注册表共同发布所经由的发射器。
 */
export function createLifecycleEmitter(
  ctx: Context,
  carrier: (parent: Agent) => object,
): LifecycleEmitter {
  return (
    name: 'subagent/start' | 'subagent/end' | 'subagent/provider-removed',
    info: SubagentRunInfo | SubagentRunEndInfo | string,
    parent?: Agent,
  ): void => {
    const dispatchArgs: unknown[] = parent === undefined
      ? [name, info]
      : [carrier(parent), name, info]
    for (const callback of ctx.events.dispatch('emit', dispatchArgs)) {
      try {
        const returned: unknown = callback(info)
        void Promise.resolve(returned).catch((error: unknown) => {
          ctx.logger.warn(`subagent: ${name} listener rejected: ${renderThrown(error)}`)
        })
      } catch (error: unknown) {
        ctx.logger.warn(`subagent: ${name} listener threw: ${renderThrown(error)}`)
      }
    }
  }
}

/**
 * 为一次本地或外部激活的驻留周期构建观察者。驻留之前的创建失败不发出任何生命周期边。
 * @param emit - 带隔离的生命周期发射器。
 * @param provider - 记录在持久化描述符中的提供方名称。
 * @param childId - 持久化的子 session id。
 * @param parent - 键控作用域分派的精确实时直接父代理。
 * @returns 本周期发布其所经由的观察者。
 */
export function createActivationObserver(
  emit: LifecycleEmitter,
  provider: string,
  childId: SessionId,
  parent: Agent,
): ActivationObserver {
  const identity = { runId: SubagentRunId(randomUUID()), provider, id: childId, local: false }
  return {
    start: (child?: Agent): void => {
      identity.local = child !== undefined
      emit('subagent/start', identity, parent)
    },
    settle: ({ stopReason, output }: SubagentResult): void => {
      emit('subagent/end', {
        ...identity,
        stopReason,
        ...output.length === 0 ? {} : { lastAssistantMessage: output },
      }, parent)
    },
  }
}

/**
 * 本子代理周期为何结束，供终止生命周期边与管理器自身的父投递使用。
 * 子代理自身的日志是权威的：拆解成功并不说明模型是否出错、是否撞到 token
 * 上限、是否被取消，因此从处置推导原因会把失败的工作报告为已完成。
 *
 * {@link foldConsumedWork} 提供了原始轮次序列所无法给到的两半信息：哪个
 * 轮次为本周期消耗的工作负责，以及已接受的工作是否在之后被取消而没有任何
 * 轮次在其上开启。已记录的失败仍胜过取消 —— 停止一个已经失败的子代理不会
 * 把它的失败变成取消。
 * @param events - 本周期自有的事件后缀。
 * @returns 其终止停止原因；仅当一个周期既干净收尾又无剩余工作要跑时才为
 *   `completed`。
 */
export function epochStopReason(events: readonly SessionEvent[]): SubagentResult['stopReason'] {
  const { end, droppedUnrun } = foldConsumedWork(events)
  switch (end?.data.reason.kind) {
    case 'max-tokens':
      return 'max-tokens'
    case 'aborted':
    case 'interrupted':
      return 'aborted'
    case 'error':
      return 'error'
    // 步骤前拒绝 —— hook deny、策略插件 —— 丢弃了本周期已认领的输入：
    // 工作是被拒绝的，而非完成的。
    case 'blocked':
      return 'refusal'
    // 干净的结束与完全没有记账轮次共用一条规则：除非有被取消的队列
    // 另有说明，否则该周期完成了交给它的工作。
    case undefined:
    case 'completed':
      return droppedUnrun ? 'aborted' : 'completed'
    /* v8 ignore next 4 -- `forked` 仅出现在构造器 seed 历史中，而本函数读取
     * 周期自有的后缀。`TurnEndReason` 是可合并扩展的，因此无法列出后端新增的变体；
     * 把无法名状的原因当作成功会把失败的工作报告为已完成。 */
    default:
      return 'error'
  }
}

/** 渲染任意被监听器抛出的值，而不让强制转换逃出隔离。 */
function renderThrown(value: unknown): string {
  try {
    return value instanceof Error ? `${value.name}: ${value.message}` : String(value)
  } catch {
    return '<unrenderable thrown value>'
  }
}
