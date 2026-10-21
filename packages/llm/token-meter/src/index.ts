/**
 * 供请求与表面压力使用的、单一且可感知回放的 token-meter 服务。
 *
 * @module @deepseek-ai/dsh-token-meter
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-compaction-image-offload/projection'
import z from '@deepseek-ai/schemastery'
import { assembleAssistantStream } from '@deepseek-ai/dsh-llm'
import type { LlmImageRequestPricing, LlmRuntime, Message, TokenUsage } from '@deepseek-ai/dsh-llm'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import type {
  EpochHeader,
  Session,
  SessionEvent,
  SessionLogOffset as SessionLogOffsetType,
} from '@deepseek-ai/dsh-session'
import {
  canonicalHeader,
  headerEquals,
  isSurfaceEvent,
  SessionLogOffset,
  SessionSeq,
} from '@deepseek-ai/dsh-session'
// 仅类型：激活 `ctx.sessionProjections` 的 Context 声明。
import type {} from '@deepseek-ai/dsh-session-projection'
import type {
  TokenMeasurement,
  TokenMeasurementBaseline,
  TokenMeterConfig,
} from './types.ts'
import { contextBreakdownProjectionDefinition } from './breakdown-projection.ts'
import { contextPressureProjectionDefinition, tokenUsageProjectionDefinition } from './usage-projection.ts'
import { estimateContent, estimateMessage, estimateToolsTokens, ROLE_OVERHEAD } from './estimate.ts'
import { commitSurfaceTokens, planSurfaceTokens } from './surface-fold.ts'
import type { MeterSurfaceNode } from './surface-fold.ts'
import { priceSurface } from './route-pricing.ts'

export type * from './types.ts'
// 模块边缘的再导出：强制让发出的 index.d.ts 导入那些投影单元模块，
// 因此它们的 SessionProjectionStateMap 增强会在只导入包根的聚合程序中加载。
export type * from './usage-projection.ts'
export type * from './breakdown-projection.ts'

/**
 * 在最近一次成功调用处捕获的原始锚点事实；基线按每次度量派生，
 * 因此被锚定的表面会在与它所比较的当前表面相同的路由定价下重新计价。
 */
interface MeasurementAnchor {
  readonly header: EpochHeader | undefined
  /** 紧邻被锚定的助手消息提交之前的已计价表面。 */
  readonly nodes: readonly MeterSurfaceNode[]
  /** 该调用提供方输出的固定启发式价格。 */
  readonly assistantTokens: number
  /** 该调用的提供方用量，当它在一个已知信封之下报告了用量时。 */
  readonly usage: TokenUsage | undefined
}

interface ReplayState {
  consumedEvents: SessionLogOffsetType
  header: EpochHeader | undefined
  surface: MeterSurfaceNode[]
  stepStart: { turn: number; step: number } | undefined
  anchor: MeasurementAnchor | undefined
}

/** 把互不相交的提供方用量的各分桶相加，且不重复计入推理输出。 */
function usageTokens(usage: TokenUsage): number {
  return usage.inputTokens
    + (usage.cacheReadTokens ?? 0)
    + (usage.cacheWriteTokens ?? 0)
    + usage.outputTokens
}

/** 比较可选信封，使一次无信封的估计能够跟踪之后的表面增量。 */
function optionalHeaderEquals(
  left: EpochHeader | undefined,
  right: EpochHeader | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right
  return headerEquals(left, right)
}

/** 在默认值能够掩盖陈旧或拼错的键之前拒绝它们。 */
function validateConfigKeys(config: TokenMeterConfig): void {
  for (const key of Object.keys(config)) {
    throw new Error(`TokenMeterConfig: unknown key "${key}" (no settings are supported)`)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tokenMeter: TokenMeter
  }
}

/** 一个服务级估计器与彼此隔离的按会话折叠的回放持有者。 */
export class TokenMeter extends Service {
  // Schemastery 会在一个空对象 schema 上保留不可信的 loader 键；
  // 公开类型排除设置项，而 validateConfigKeys 则拒绝它们。
  static Config: z<TokenMeterConfig> = z.object({}) as unknown as z<TokenMeterConfig>

  static inject = ['sessionProjections']

  private readonly states = new WeakMap<Session, ReplayState>()

  constructor(ctx: Context, config: TokenMeterConfig = {}) {
    super(ctx, 'tokenMeter')
    validateConfigKeys(config)

    ctx.sessionProjections.register(tokenUsageProjectionDefinition)
    ctx.sessionProjections.register(contextPressureProjectionDefinition)
    ctx.sessionProjections.register(contextBreakdownProjectionDefinition)

    // 各个读取者独立地追赶，而主动观察为普通的读取延迟设定上界，
    // 同时又不会为没有任何消费者读取过的会话创建状态。
    ctx.on('session/event', (session) => {
      if (this.states.has(session)) this._sync(session)
    })
  }

  /**
   * 通过持久化的尾部度量当前的请求压力与表面。
   *
   * 生效信封所路由到的提供方/模型，会选择每个节点所依据的请求图像定价：
   * 一个其适配器宣告了图像定价的路由，会按每张被保留图像的视觉令牌加上
   * 它模型可见的文本计价；其他路由则保留固定启发式。只有当最近一次成功
   * 调用的规范请求信封与 `requestHeader` 匹配、且它的总计不低于该调用的
   * 完整按路由计价锚点时，提供方用量才会被复用；否则完整的信封与表面
   * 都会被重新计价。该锚点包含紧邻助手消息之前的全部表面节点，
   * 包括 step/start 之后被接纳的输入。
   *
   * `requestHeader` 会为压力与节点定价替换最新已记录的信封；
   * 节点集合始终描述当前的会话表面。每次调用都会克隆那些位置节点，
   * 因此度量是 O(表面) 的。
   *
   * @param session - 要通过其当前持久化尾部回放的会话。
   * @param requestHeader - 可选的有效请求信封，替换最新已记录的信封。
   * @returns 一份已分离的、深度不可变的压力与表面度量。
   */
  measure(session: Session, requestHeader?: EpochHeader): TokenMeasurement {
    const state = this._sync(session)
    const header = requestHeader === undefined
      ? state.header
      : canonicalHeader(requestHeader)
    const pricing = this._routeImagePricing(header)
    const fileText = this._fileRequestText()
    const surface = priceSurface(state.surface, pricing, fileText)
    const anchor = state.anchor

    let baseline: TokenMeasurementBaseline
    let surfaceDeltaTokens: number
    if (anchor !== undefined && optionalHeaderEquals(anchor.header, header)) {
      // 匹配的信封共享同一条路由，因此被锚定的快照会在与当前表面
      // 相同的定价下重新计价，而带符号的增量是对同类事物的比较。
      const anchorSurfaceTokens = priceSurface(anchor.nodes, pricing, fileText).surfaceTokens
        + anchor.assistantTokens
      const estimatedAnchorTokens = estimateToolsTokens(header) + anchorSurfaceTokens
      const usage = anchor.usage
      // 只有从一个至少与匹配的完整启发式价格一样大的锚点出发，
      // 带符号的启发式增量才是保守的。
      baseline = usage !== undefined && usageTokens(usage) >= estimatedAnchorTokens
        ? { kind: 'usage', tokens: usageTokens(usage), usage }
        : { kind: 'estimated', tokens: estimatedAnchorTokens }
      surfaceDeltaTokens = surface.surfaceTokens - anchorSurfaceTokens
    } else if (header === undefined && surface.surfaceTokens === 0) {
      baseline = { kind: 'none', tokens: 0 }
      surfaceDeltaTokens = 0
    } else {
      baseline = {
        kind: 'estimated',
        tokens: estimateToolsTokens(header) + surface.surfaceTokens,
      }
      surfaceDeltaTokens = 0
    }

    return deepFreeze(structuredClone({
      logRevision: state.consumedEvents,
      baseline,
      surfaceDeltaTokens,
      totalTokens: Math.max(0, baseline.tokens + surfaceDeltaTokens),
      surfaceTokens: surface.surfaceTokens,
      nodes: surface.nodes,
    }))
  }

  /** 当 llm 服务与该路由宣告了图像定价时，解析被路由模型的图像定价。 */
  private _routeImagePricing(header: EpochHeader | undefined): LlmImageRequestPricing | undefined {
    const config = header?.config
    if (config === undefined) return undefined
    return this.ctx.get('llm')?.imageRequestPricing(config.provider, config.model)
  }

  /** 当挂载了 LLM 服务时，解析请求时的文件投影。 */
  private _fileRequestText(): (
    (ref: Parameters<LlmRuntime['fileRequestText']>[0]) => string
  ) | undefined {
    const llm = this.ctx.get('llm')
    return llm === undefined ? undefined : ref => llm.fileRequestText(ref)
  }

  /**
   * 用启发式为一条模型可见的消息计价（`estimate.ts` 中纯函数
   * `estimateMessage` 导出的实例侧门面）。
   * @param message - 要在不改动的前提下计价的消息。
   * @returns 固定服务启发式之下的内容与角色框架令牌数。
   */
  estimateMessage(message: Message): number {
    return estimateMessage(message)
  }

  /** 让一个会话的折叠追赶到当前的持久化尾部。 */
  private _sync(session: Session): ReplayState {
    let state = this.states.get(session)
    if (state === undefined) {
      state = {
        consumedEvents: SessionLogOffset(0),
        header: undefined,
        surface: [],
        stepStart: undefined,
        anchor: undefined,
      }
      this.states.set(session, state)
    }

    while (state.consumedEvents < session.seq) {
      // 连续的会话 seq 索引持久化日志；沿用现有的 Session 历史读取，迁移延后。
      // oxlint-disable-next-line typescript/no-non-null-assertion, typescript/no-deprecated
      const event = session.eventAt(SessionSeq(state.consumedEvents))!
      this._foldEvent(state, event)
      state.consumedEvents = SessionLogOffset(state.consumedEvents + 1)
    }
    return state
  }

  /**
   * 在修改回放状态之前先执行每个可能失败的步骤——表面计划与锚点校验——
   * 因此一个格式错误的事件在每次重试时都保持未读，而不是被应用一半。
   */
  private _foldEvent(state: ReplayState, event: SessionEvent): void {
    let nextHeader = state.header
    let nextStepStart = state.stepStart
    let nextAnchor = state.anchor

    switch (event.type) {
      case 'image/offload': {
        const offloaded = new Map(event.data.targets.map(target => [target.seq, new Set(target.imageIndexes)]))
        state.surface = state.surface.map((node) => {
          const indexes = offloaded.get(node.seq)
          if (indexes === undefined) return node
          return {
            ...node,
            images: node.images.map((image, index) => (indexes.has(index) ? { ...image, offloaded: true as const } : image)),
          }
        })
        break
      }
      case 'request/header':
        nextHeader = canonicalHeader(event.data.header)
        break
      case 'step/start':
        if (state.stepStart !== undefined) {
          throw new Error(
            `token meter: step/start at seq ${event.seq} arrived before turn ${state.stepStart.turn}/step ${state.stepStart.step} ended`,
          )
        }
        nextStepStart = { ...event.data }
        break
      case 'step/end':
        if (state.stepStart === undefined
          || state.stepStart.turn !== event.data.turn
          || state.stepStart.step !== event.data.step) {
          throw new Error(`token meter: step/end at seq ${event.seq} has no matching step/start event`)
        }
        nextStepStart = undefined
        break
      default:
        break
    }

    const plan = isSurfaceEvent(event)
      ? planSurfaceTokens(state.surface, event)
      : undefined

    if (event.type === 'assistant/message') {
      const stepStart = state.stepStart
      if (stepStart === undefined
        || stepStart.turn !== event.data.turn
        || stepStart.step !== event.data.step) {
        throw new Error(`token meter: assistant/message at seq ${event.seq} has no matching step/start event`)
      }

      // assistant/message 在每个追加/播种边界上都是表面必需的。
      // oxlint-disable-next-line typescript/no-non-null-assertion
      const eventTokens = plan!.tokens
      // 循环会在 step/start 之后接纳提示与用户消息；重试可能在成功之前
      // 替换它们。只有助手之前的表面会被本次调用计价。
      // 提供方输出与持久化的输出重写保持分离。
      if (event.data.usage !== undefined && nextHeader !== undefined) {
        nextAnchor = {
          header: nextHeader,
          nodes: [...state.surface],
          assistantTokens: this._estimateProviderAssistant(event),
          usage: event.data.usage,
        }
      } else {
        nextAnchor = {
          header: nextHeader,
          nodes: [...state.surface],
          assistantTokens: eventTokens,
          usage: undefined,
        }
      }
    }

    state.header = nextHeader
    state.stepStart = nextStepStart
    if (plan !== undefined) {
      commitSurfaceTokens(state.surface, plan)
    }
    state.anchor = nextAnchor
  }

  /**
   * 从该消息精确嵌入的流中重新装配提供方输出。
   */
  private _estimateProviderAssistant(
    event: SessionEvent<'assistant/message'>,
  ): number {
    const providerContent = assembleAssistantStream(event.data.stream).blocks()
    return providerContent.length === 0 ? 0 : estimateContent(providerContent) + ROLE_OVERHEAD
  }
}

export default TokenMeter
