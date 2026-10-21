/**
 * 按 agent 统计重复调用的建议性检测器。它用已记录的模型上下文丰富
 * post-execute 决策，但不否决也不改写调用。配置与链语义见包 README；
 * 设计理由见 repeat-tool-reminder Agent Note。
 * @module @deepseek-ai/dsh-repeat-tool-reminder
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'repeat-tool-reminder': { kind: 'repeat-tool-reminder' } & ContextFormed
  }
}

import type { MessageSource } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { PostToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'

export const name = 'repeat-tool-reminder'

/**
 * 插件配置，由同名 schemastery schema 加上 `apply` 中的加载期检查共同校验
 * （配置错误必须显式暴露：`thresholds` 为空列表、存在非整数、小于 2 或重复的
 * 值，都会在插件加载时抛错，绝不静默回退）。`include`/`exclude` 项是在调用时
 * 对工具名做 `*`-通配匹配的谓词，而不是对注册表项的引用 —— 匹配不到任何当前
 * 已注册工具的模式依然合法（在不加载任何 MCP 工具的部署中，`exclude: [mcp_*]`
 * 必须保持可用）。
 */
export interface Config {
  /** 触发提醒的连续重复次数（默认 `[3, 5, 8]`）。 */
  thresholds?: number[]
  /** 需要跟踪的工具名模式；为空表示跟踪所有工具。 */
  include?: string[]
  /** 对链透明的工具名模式（既不计数也不重置）。 */
  exclude?: string[]
  /**
   * DETAILED 提醒中引用的规范化参数的最大字符数（默认 500）。否则大载荷
   * （`write` 的正文、一条长命令）会无上限地带入下一次请求 —— 而这恰恰发生在
   * 循环场景中；该上限只约束提醒文本，从不约束检测（链的 key 始终比较完整的
   * 规范化字符串）。
   */
  argumentsPreviewChars?: number
}

export const Config: z<Config> = z.object({
  thresholds: z.array(z.number()).default([3, 5, 8]),
  include: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
  argumentsPreviewChars: z.number().default(500),
})

/**
 * 本守卫注入的每条提醒都会带上 `{kind:'repeat-tool-reminder'}` 生产者来源 ——
 * 这个标签是必需的（未标注来源的上下文在派生的历史记录中会被渲染成用户提问）。
 */
const REMINDER_SOURCE: MessageSource = { kind: 'repeat-tool-reminder' }

/**
 * 温和的首个阈值提醒。它绑定到 `thresholds[0]` 而非字面量次数，
 * 因此自定义的首个阈值仍能保持「先温和、后详细」的递进。
 */
const GENTLE_REMINDER =
  'You are repeating the exact same tool call with identical arguments. '
  + 'Carefully analyze the previous result before calling again: if the task is '
  + 'not complete, try a different approach or different arguments instead of '
  + 'repeating the call.'

/** 详细的后续阈值提醒，会指出工具名、连续次数和规范化后的参数。 */
function detailedReminder(toolName: string, count: number, canonicalArguments: string): string {
  return 'Repeated tool call detected:\n'
    + `- tool: ${toolName}\n`
    + `- consecutive_calls: ${count}\n`
    + `- arguments: ${canonicalArguments}\n`
    + 'The repeated calls are not making progress. Do not call this tool with '
    + 'these exact arguments again. Inspect the latest result and choose a '
    + 'different action, different arguments, or finish the task if enough '
    + 'evidence has been gathered.'
}

/**
 * 对解析后的 JSON 值做深层 key 排序，使仅属性顺序不同的两个参数对象规范化出
 * 相同的结果。参数以循环体 `JSON.parse` 的输出（或参数 JSON 畸形时的原始字符串
 * 回退）进入守卫，因此 JSON 的值域就是全部输入域 —— 这里不处理 bigint、循环
 * 引用或 `undefined`，因为没有输入路径能产生它们。
 */
function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortJsonValue(record[key])
    }
    return sorted
  }
  return value
}

/** 调用参数的规范化字符串形式：先深层排序 key，再序列化。 */
function canonicalize(argumentsValue: unknown): string {
  return JSON.stringify(sortJsonValue(argumentsValue))
}

/** 把单个 `*`-通配模式编译为锚定的 RegExp（其余正则元字符均按字面匹配）。 */
function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`)
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`)
}

/**
 * 从头部截断规范化参数以便在详细提醒中引用，并标注被省略的长度。
 * 只限制模型可见的文本 —— 链的 key 始终使用完整的规范化字符串。
 */
function previewArguments(canonical: string, cap: number): string {
  if (canonical.length <= cap) return canonical
  return `${canonical.slice(0, cap)}… (+${canonical.length - cap} more chars)`
}

/**
 * 按「错误显式暴露」契约校验 `thresholds`，并返回升序排序的结果
 * （递进规则把 `thresholds[0]` 视为温和档，因此顺序在这里一次性归一化）。
 */
function validateThresholds(values: number[]): number[] {
  if (values.length === 0) {
    throw new Error('repeat-tool-reminder: `thresholds` must not be empty')
  }
  for (const value of values) {
    if (!Number.isInteger(value) || value < 2) {
      throw new Error(`repeat-tool-reminder: invalid threshold ${value} — every threshold must be an integer >= 2`)
    }
  }
  if (new Set(values).size !== values.length) {
    throw new Error('repeat-tool-reminder: `thresholds` must not contain duplicates')
  }
  return [...values].sort((a, b) => a - b)
}

/**
 * 把守卫的提醒前插到最前面，同时保留每个下游上下文的来源与元数据。
 */
function prependContext(ours: UserMessage, theirs: UserMessage[] | undefined): UserMessage[] {
  return [ours, ...theirs ?? []]
}

/** 单个 agent 的连续重复链：上一次被跟踪调用的身份 key 及其连续长度。 */
interface Chain {
  key: string
  count: number
}

/**
 * 安装守卫的监听器。
 * @param ctx - 插件上下文；监听器作用于它，并随它一起释放。
 * @param config - 已校验的 {@link Config}；`thresholds` 在此再次按「错误显式暴露」方式检查。
 */
export function apply(ctx: Context, config: Config): void {
  // schemastery 的 .default() 保证这些字段在校验后已被赋值。
  const thresholds = validateThresholds(config.thresholds as number[])
  const thresholdSet = new Set(thresholds)
  const includePatterns = (config.include as string[]).map(wildcardToRegExp)
  const excludePatterns = (config.exclude as string[]).map(wildcardToRegExp)
  const argumentsPreviewChars = config.argumentsPreviewChars as number
  if (!Number.isInteger(argumentsPreviewChars) || argumentsPreviewChars < 1) {
    throw new Error(`repeat-tool-reminder: invalid argumentsPreviewChars ${argumentsPreviewChars} — must be an integer >= 1`)
  }

  const chains = new WeakMap<Agent, Chain>()

  /** 工具是否参与链路（未被跟踪的调用是透明的：既不计数也不重置）。 */
  function tracked(toolName: string): boolean {
    if (includePatterns.length > 0 && !includePatterns.some(pattern => pattern.test(toolName))) return false
    return !excludePatterns.some(pattern => pattern.test(toolName))
  }

  /**
   * 为一次尝试推进调用方 agent 的链路，若本次尝试的连续长度命中配置的阈值，
   * 则返回要投递的提醒。计数放在这里 —— 即 post-execute —— 是因为被拒绝的调用
   * 同样流经这个 waterfall（`ToolRuntime.execute` 把拒绝也路由到同一条流水线），
   * 而模型反复猛敲一个被拒绝的调用，正是值得打断的循环。
   */
  function observe(exec: ToolExecution): UserMessage | undefined {
    // 直接调用 `ctx.tools.execute()` 的调用方没有可提醒的模型，也没有可用于
    // 建链的 id；只有 agent-loop 的调用参与其中。
    if (!exec.agent) return undefined
    if (!tracked(exec.name)) return undefined
    const canonical = canonicalize(exec.arguments)
    const key = JSON.stringify([exec.name, canonical])
    const chain = chains.get(exec.agent)
    const count = chain !== undefined && chain.key === key ? chain.count + 1 : 1
    chains.set(exec.agent, { key, count })
    if (!thresholdSet.has(count)) return undefined
    const text = count === thresholds[0]
      ? GENTLE_REMINDER
      : detailedReminder(exec.name, count, previewArguments(canonical, argumentsPreviewChars))
    return createUserMessage({
      content: [{ type: 'text', text }],
      source: { ...REMINDER_SOURCE, form: 'notice', summary: `${exec.name} × ${count}` },
    })
  }

  // 只观察与增强，绝不否决：先计数（无论下游结果如何，状态都会推进），
  // 再 DELEGATE，让更靠后的监听器仍能拦截或替换，然后把提醒叠加到返回的
  // 结果上 —— additionalContexts 存在于两种决策变体中，因此被拦截的调用
  // 同样能收到这个提示。
  ctx.on('tools/post-execute', async (exec, _result, next): Promise<PostToolDecision> => {
    const reminder = observe(exec)
    const downstream = await next()
    if (!reminder) return downstream
    if (downstream.kind === 'block') {
      return { kind: 'block', feedback: downstream.feedback, additionalContexts: prependContext(reminder, downstream.additionalContexts) }
    }
    return {
      ...downstream,
      additionalContexts: prependContext(reminder, downstream.additionalContexts),
    }
  })

  // 用户插话改变了上下文；跨越它的重复不算循环。这是纯重置钩子：
  // 始终向下委派（不附加任何内容，也不否决任何内容）。
  ctx.on('agent/pre-step', ({ agent, messages }, next): Promise<PreStepDecision> => {
    if (messages.some(message => message.source.kind === 'user')) chains.delete(agent)
    return next()
  })
}
