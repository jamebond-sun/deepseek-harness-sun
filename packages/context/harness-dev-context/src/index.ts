/**
 * @deepseek-ai/dsh-harness-dev-context —— 面向这样一个代理的模型上下文：
 * 它能够检视并扩展为其 Web GUI 提供服务的 DeepSeek Harness。它注册与路径和
 * URL 无关的提示段落，并将当前的实现签出与 Web GUI URL 声明为运行时上下文，
 * 因此从一个不同的签出、端口或安装启动的进程不会改变系统提示。一个其已接纳
 * 提示持有内嵌了这些值的段落的会话，会逐字保留它们，从而恢复时绝不会重写
 * 其已记录的提示。
 * @module @deepseek-ai/dsh-harness-dev-context
 */

import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { z as zod } from 'zod'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-web-app'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'

/** 稳定的 Cordis 插件名称。 */
export const name = 'harness-dev-context'

/** 提示注册表、投影注册表，以及其 URL 供模型获知的 Web GUI。 */
export const inject = ['systemPrompt', 'sessionProjections', 'webApp']

/** 本次安装的根目录，位于本包源码或构建入口向上四级处。 */
const SOURCE_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))

/** 实现签出对应的提示段落与运行时上下文名称。 */
const HARNESS_SOURCE = 'harness:source'

/** Web GUI 定位及其 URL 对应的提示段落与运行时上下文名称。 */
const WEB_SURFACE = 'app:web-surface'

const HARNESS_SOURCE_GUIDANCE = 'The checkout location and current working directory are separate values and may differ; '
  + 'never infer the working directory from the checkout path. Use pwd to determine the current working directory. '
  + 'Use this checkout only to inspect or extend DSH itself.'

const HARNESS_SOURCE_PROMPT = `The runtime context names the DeepSeek Harness implementation checkout. ${HARNESS_SOURCE_GUIDANCE}`

const WEB_SURFACE_GUIDANCE = 'When the user refers to "this page", "this GUI", or "this app" without naming another target, they mean this GUI. '
  + 'The browser provides no implicit DOM, route, or screenshot context. '
  + 'The client-plugin HMR receiver is active, but client-plugin changes reload without a refresh only while '
  + '`pnpm run dev:web` is also running from this same checkout to rebuild their bundles; verify that watcher before promising automatic updates. '
  + 'Every other change — the apps/web shell and plain packages — requires rebuilding the affected Web artifacts and verifying this existing URL after a page refresh. '
  + 'Starting another server does not update this GUI. '
  + 'The apps/web Vite entry builds the shell but is not a standalone application because only dsh web injects window.__DSH_BOOT__. '
  + 'Do not start a replacement server unless the user asks; if one is needed, use a managed background job and verify its exact URL.'

const WEB_SURFACE_PROMPT = `You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names. ${WEB_SURFACE_GUIDANCE}`

/**
 * 内嵌某个值的每个段落中、围绕该值的固定文本，冻结为那些版本所渲染的样子：
 * 绝不要将这些与当前指引一同编辑，否则持有更早段落的会话会停止匹配，
 * 并重写其已记录的提示。
 */
const LEGACY_SOURCE = {
  prefix: 'The DeepSeek Harness implementation checkout is at ',
  suffix: '. The checkout location and current working directory are separate values and may differ; '
    + 'never infer the working directory from this path. Use pwd to determine the current working directory. '
    + 'Use this checkout only to inspect or extend DSH itself.',
}
// 这份冻结副本是有意重复当前指引的；两者日后可能分叉。
/* jscpd:ignore-start */
const LEGACY_WEB_SURFACE = {
  prefix: 'You are interacting with the user through the DeepSeek Harness Web GUI at ',
  suffix: '. When the user refers to "this page", "this GUI", or "this app" without naming another target, they mean this GUI. '
    + 'The browser provides no implicit DOM, route, or screenshot context. '
    + 'The client-plugin HMR receiver is active, but client-plugin changes reload without a refresh only while '
    + '`pnpm run dev:web` is also running from this same checkout to rebuild their bundles; verify that watcher before promising automatic updates. '
    + 'Every other change — the apps/web shell and plain packages — requires rebuilding the affected Web artifacts and verifying this existing URL after a page refresh. '
    + 'Starting another server does not update this GUI. '
    + 'The apps/web Vite entry builds the shell but is not a standalone application because only dsh web injects window.__DSH_BOOT__. '
    + 'Do not start a replacement server unless the user asks; if one is needed, use a managed background job and verify its exact URL.',
}
/* jscpd:ignore-end */

/** 仅宿主侧的投影键，对应会话所接纳的、承载值的段落。 */
const LEGACY_PROMPT = 'harnessDevLegacyPrompt'

const legacyPromptSchema = zod.object({ source: zod.string().nullable(), web: zod.string().nullable() })

/** 会话所提交的、最新非空系统提示中承载值的段落；当其没有时为 `null`。 */
type LegacyPrompt = zod.infer<typeof legacyPromptSchema>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** 最新非空、已接纳系统提示中，承载值的 harness-source 与 Web-surface 段落。 */
    harnessDevLegacyPrompt: LegacyPrompt
  }
}

/** `prefix` 与 `suffix` 之间完整的单行段落，当提示没有时为 `null`。 */
function legacyParagraph(prompt: string, { prefix, suffix }: { prefix: string; suffix: string }): string | null {
  const start = prompt.indexOf(prefix)
  if (start < 0) return null
  const end = prompt.indexOf(suffix, start + prefix.length)
  if (end < 0) return null
  const paragraph = prompt.slice(start, end + suffix.length)
  return paragraph.includes('\n') ? null : paragraph
}

/**
 * 将一个已提交的事件折入已接纳的段落。与循环自身的提示版本读取一样，
 * 只有一个非空文本块才算一个提示版本；被清空或其他版本保留先前状态，
 * 因为一次系列合并可能只记录被清空的后续版本。
 */
function foldLegacyPrompt(state: LegacyPrompt, event: SessionEvent): LegacyPrompt {
  if (event.type !== 'system/message') return state
  const { content } = event.data.message
  const [block] = content
  if (content.length !== 1 || block?.type !== 'text' || block.text === '') return state
  const source = legacyParagraph(block.text, LEGACY_SOURCE)
  const web = legacyParagraph(block.text, LEGACY_WEB_SURFACE)
  return source === state.source && web === state.web ? state : { source, web }
}

const ADMITS_NOTHING: LegacyPrompt = { source: null, web: null }

/**
 * 注册这两个段落、它们的运行时上下文值，以及保留会话已接纳段落的投影。
 * @param ctx - 带有每个 {@link inject} 服务的插件上下文。
 */
export function apply(ctx: Context): void {
  ctx.sessionProjections.register({
    key: LEGACY_PROMPT,
    stateVersion: 1,
    stateSchema: legacyPromptSchema,
    init: () => ADMITS_NOTHING,
    apply: foldLegacyPrompt,
  })
  const admitted = (context: AssembleContext): LegacyPrompt => {
    const session = context.agent?.session
    // 本插件注册了上方的单元，因此其状态对每个会话都存在。
    return session === undefined ? ADMITS_NOTHING : ctx.sessionProjections.stateOf(session, LEGACY_PROMPT) as LegacyPrompt
  }
  ctx.systemPrompt.section({
    name: HARNESS_SOURCE,
    order: ctx.systemPrompt.getSectionOrder('HARNESS_SOURCE'),
    interpolate: false,
    text: context => admitted(context).source ?? HARNESS_SOURCE_PROMPT,
  })
  ctx.systemPrompt.context({
    name: HARNESS_SOURCE,
    order: ctx.systemPrompt.getContextOrder('HARNESS_SOURCE'),
    interpolate: false,
    text: `Current DeepSeek Harness implementation checkout: ${JSON.stringify(SOURCE_ROOT)}.`,
  })
  ctx.systemPrompt.section({
    name: WEB_SURFACE,
    order: ctx.systemPrompt.getSectionOrder('WEB_SURFACE'),
    interpolate: false,
    text: context => admitted(context).web ?? WEB_SURFACE_PROMPT,
  })
  ctx.systemPrompt.context({
    name: WEB_SURFACE,
    order: ctx.systemPrompt.getContextOrder('WEB_SURFACE'),
    interpolate: false,
    text: () => `Current DeepSeek Harness Web GUI URL: ${JSON.stringify(ctx.webApp.getAdvertisedUrl())}.`,
  })
}
