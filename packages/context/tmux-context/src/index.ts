/**
 * 可选择的、请求准备阶段的 tmux 位置上下文。符合条件的步骤尝试会追加
 * 持久化的、标注来源的上下文，写明本代理进程所运行的 tmux 会话、窗口与窗格，
 * 以及该窗口的窗格树布局。
 *
 * 该插件通过 `ctx.shell` 执行器服务运行一次 `tmux display-message`，
 * 在每个轮次、针对第一条请求（`step === 1`）拉取一次状态。它会将窗格的
 * `#{pane_tty}` 与本节点的控制终端进行比对，以确认本进程确实运行在
 * `$TMUX_PANE` 所指的窗格内部，因此一个仅从 tmux 祖先（例如 VS Code 集成终端）
 * 继承了 `$TMUX`/`$TMUX_PANE` 的终端会被读作“不在 tmux 中”。它仅在自上次注入以来
 * 渲染出的 tmux 状态发生变化（窗格被移动、重命名或重新布局）时才重新注入，
 * 注入之间还可选一个 `refreshIntervalMs` 下限。缺失 tmux 环境、仅有继承环境、
 * 缺失 `ctx.shell`，或查询失败都是无操作，绝不是错误：执行器拒绝会被就地
 * 容纳并作为警告记录，以便轮次继续。
 *
 * @module @deepseek-ai/dsh-tmux-context
 */

import type { Context, LoggerService } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { ShellExecutor, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Location attribution; readers preserve the content without this producer.
     * Its projection uses the kind to avoid repeated injection.
     * @persistenceAttribution
     */
    'tmux-context': { kind: 'tmux-context' } & ContextFormed
  }
}


/** 供加载器诊断使用的 Cordis 插件名称。 */
export const name = 'tmux-context'

/** 拥有预步骤处理的代理注册表。 */
export const inject = ['agents', 'sessionProjections']

/** 每个轮次的 tmux 位置调度。无效值会使插件加载失败。 */
export interface Config {
  /** 同一会话内两次持久化注入之间的最小毫秒数。省略或设为 0 表示每次符合条件的变更都注入。 */
  refreshIntervalMs?: number
}

/** 针对 {@link Config} 的 Schemastery 校验。 */
export const Config: z<Config> = z.object({
  refreshIntervalMs: z.number(),
})

/**
 * 以制表符分隔的 tmux 格式字段，按查询顺序排列。布局（`window_layout`）
 * 是窗格树描述；窗格/窗口的像素尺寸被有意排除（依包范围，仅含自身位置与布局）。
 */
const TMUX_FIELDS = [
  '#{session_name}',
  '#{window_index}',
  '#{window_name}',
  '#{pane_index}',
  '#{pane_id}',
  '#{window_active}',
  '#{pane_active}',
  '#{window_layout}',
] as const

/** 从一次 `display-message` 读数解析得到的结构化 tmux 位置。 */
interface TmuxLocation {
  sessionName: string
  windowIndex: string
  windowName: string
  paneIndex: string
  paneId: string
  windowActive: string
  paneActive: string
  windowLayout: string
}

/** 标记一次已渲染读数中、易变的轮次/步骤前导行的固定前缀。 */
const READING_PREFIX = 'tmux location (turn '

/**
 * tmux 格式字段之间的字段分隔符。tmux 不会解释格式中的 C 转义，
 * 因此字面的两个字符序列 `\t` 会被原样输出，并在此处分割回来；
 * 这避免了在命令中嵌入原始空白。
 */
const FIELD_SEP = '\\t'

/**
 * 通过 bash 接缝读取本进程的 tmux 位置，或当本进程并非真正运行在 tmux 窗格内
 * 或查询失败时返回 `undefined`。
 *
 * 仅 `$TMUX_PANE` 是不够的：一个从 tmux shell 启动的终端
 * （例如 VS Code 集成终端、桌面启动器）会从该祖先继承 `$TMUX` 和
 * `$TMUX_PANE`，因此即便本进程并不在那个窗格中，这些变量依然存在。所以该命令
 * 还会将窗格的 `#{pane_tty}` 与本节点的控制终端
 * （针对 {@link processId} 的 `ps -o tty=`）进行比对；真正的窗格拥有本进程的 tty，
 * 而继承来的环境命名的是其他某个窗格的 tty。字段仅在匹配成功时才输出，
 * 因此继承来的环境会被读作“不在 tmux 中”且不注入任何内容。
 *
 * 该位置是可选的上下文，因此执行器拒绝是一次失败的查询，而非轮次失败：
 * `resolve()` 可能因策略原因拒绝该命令，而 `run()` 只承诺对非零退出、
 * 超时与中止给出结果，因此两者都被就地容纳并作为警告报告。
 *
 * @param bash - 用于运行只读 tmux/ps 命令的执行器服务。
 * @param logger - 当执行器拒绝查询时接收警告。
 * @param processId - 本代理进程的 pid，其控制终端必须与窗格匹配。
 * @param signal - 转发给执行器的中止信号。
 * @returns 解析得到的位置，或当不在真实窗格中或发生任何失败时返回 `undefined`。
 */
async function queryTmuxLocation(
  bash: ShellExecutor,
  logger: LoggerService,
  processId: number,
  signal: AbortSignal,
): Promise<TmuxLocation | undefined> {
  const format = TMUX_FIELDS.join(FIELD_SEP)
  const command = [
    '[ -n "$TMUX_PANE" ] || exit 1',
    `self_tty=$(ps -o tty= -p ${processId} | tr -d ' ')`,
    '[ -n "$self_tty" ] || exit 1',
    'pane_tty=$(tmux display-message -t "$TMUX_PANE" -p \'#{pane_tty}\') || exit 1',
    '[ "$pane_tty" = "/dev/$self_tty" ] || exit 1',
    `exec tmux display-message -t "$TMUX_PANE" -p '${format}'`,
  ].join('\n')
  let result: ShellRunResult
  try {
    result = await (await bash.execute(bash.resolve({ command, signal }))).result()
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    logger.warn(`tmux location query failed: ${message}; injecting no location this turn`)
    return undefined
  }
  if (result.exitCode !== 0) return undefined
  const line = result.stdout.text.split('\n', 1)[0] as string
  const parts = line.split(FIELD_SEP)
  if (parts.length !== TMUX_FIELDS.length) return undefined
  const [
    sessionName,
    windowIndex,
    windowName,
    paneIndex,
    paneId,
    windowActive,
    paneActive,
    windowLayout,
  ] = parts as [string, string, string, string, string, string, string, string]
  if (paneId.length === 0) return undefined
  return {
    sessionName,
    windowIndex,
    windowName,
    paneIndex,
    paneId,
    windowActive,
    paneActive,
    windowLayout,
  }
}

/**
 * 渲染稳定的 tmux 状态块：一次读数中用于变更抑制比较的部分。
 * 它排除了轮次前导行，因此重新注入只由 tmux 状态驱动，而非由循环位置驱动。
 */
function renderState(location: TmuxLocation): string {
  return `session ${location.sessionName}, `
    + `window ${location.windowIndex} ${JSON.stringify(location.windowName)}, `
    + `pane ${location.paneIndex} ${location.paneId}\n`
    + `window active=${location.windowActive}, pane active=${location.paneActive}, `
    + `layout ${location.windowLayout}`
}

/** 渲染完整的持久化读数，包含易变的轮次前导行。 */
function renderReading(location: TmuxLocation, turn: number): string {
  return `${READING_PREFIX}${turn}):\n${renderState(location)}`
}

/**
 * 本插件最新一次持久化注入的稳定状态块，或当会话没有时返回 `undefined`。
 * 它通过扫描原始持久化事件实现，因此该调度能在压实与进程恢复后存活，
 * 无需进程局部缓存状态。
 */
/** 拒绝无法表示精确已流逝毫秒阈值的刷新间隔。 */
function validateRefreshInterval(refreshIntervalMs: number | undefined): void {
  if (refreshIntervalMs !== undefined && (
    !Number.isSafeInteger(refreshIntervalMs)
    || refreshIntervalMs < 0
  )) {
    throw new TypeError(
      `tmux-context: refreshIntervalMs must be a non-negative safe integer, got ${String(refreshIntervalMs)}`,
    )
  }
}

const tmuxContextStateSchema = zod.object({
  state: zod.string(),
  time: zod.number(),
}).nullable()

type TmuxContextState = zod.infer<typeof tmuxContextStateSchema>

/**
 * 为 `ctx` 的整个生命周期注册一个前置的预步骤监听器。
 * @param ctx - 插件上下文；监听器随其一同释放。
 * @param config - 持久化刷新调度配置。
 * @throws 当刷新间隔无效时。
 */
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** 本插件最新一次持久化注入的稳定状态块，或 null。 */
    tmuxContext: TmuxContextState
  }
}

export function apply(ctx: Context, config: Config): void {
  const refreshIntervalMs = config.refreshIntervalMs
  validateRefreshInterval(refreshIntervalMs)

  ctx.sessionProjections.register({
    key: 'tmuxContext',
    stateVersion: 1,
    stateSchema: tmuxContextStateSchema,
    init: () => null,
    apply: (state, event) => {
      if (event.type !== 'user/message'
        || event.data.source.kind !== name) return state
      const [block] = event.data.content
      if (block?.type !== 'text') return state
      const newline = block.text.indexOf('\n')
      const stableState = newline === -1 ? '' : block.text.slice(newline + 1)
      return { state: stableState, time: event.time }
    },
  })

  ctx.on('agent/pre-step', async (
    { agent, turn, step, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted || step !== 1) return decision
    const bash = ctx.get('shell')
    if (bash === undefined) return decision
    const previous = ctx.sessionProjections.stateOf(agent.session, 'tmuxContext') as TmuxContextState
    if (refreshIntervalMs !== undefined && refreshIntervalMs > 0 && previous !== null) {
      const now = Date.now()
      if (now >= previous.time && now - previous.time < refreshIntervalMs) return decision
    }
    const location = await queryTmuxLocation(bash, ctx.logger, process.pid, signal)
    if (location === undefined) return decision
    const state = renderState(location)
    if (previous !== null && previous.state === state) return decision
    const text = renderReading(location, turn)
    return {
      ...decision,
      messages: [
        createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: name, form: 'snapshot', sections: [{ name, text }] },
        }),
        ...decision.messages,
      ],
    }
  }, { prepend: true })
}
