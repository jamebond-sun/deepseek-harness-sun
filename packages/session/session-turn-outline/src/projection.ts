/**
 * `turnOutline` 投影单元：一个纯折叠，把 `turn/start` 边界、首条人类提示
 * 与最终 assistant 响应折叠成整日志的回合大纲，供聊天 rail 为客户端分页
 * 事件窗口之外的回合渲染。
 *
 * 锚定每个条目的是 `turn/start` 而非提示 `user/message`，因为其 seq 是
 * 跳转时“加载穿过”的目标：循环在该回合的提示与步骤之前记录 `turn/start`，
 * 因此一个分页回退穿过该 seq 的窗口会包含整个回合。预览镜像 rail 已加载
 * 回合的预览（空格连接的文本块、折叠后的空白、截断时的省略号），预算大小
 * 与 rail 卡片的钳制一致——一条提示行，至多三行响应行——因此一个回合在
 * 其事件加载前后显示相同的文字。响应在 `turn/end` 时，从最新一条含文本
 * 的 assistant 消息的草稿中提交；仅草稿的 apply 保留 `turns` 数组的身份，
 * 因此按身份闸门的变更流每个回合至多推送三次（边界、提示、响应）。
 *
 * @module @deepseek-ai/dsh-session-turn-outline/projection
 */

import { z } from 'zod'
import type { ZodType } from 'zod'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { TurnOutlineEntry, TurnOutlineState } from './types.ts'

/** Prompt budget: one rail-card line (13px over ~276px), ASCII worst case included. */
const PROMPT_PREVIEW_LIMIT = 50
/** Response budget: three rail-card lines (12px over ~276px). */
const RESPONSE_PREVIEW_LIMIT = 120

type MessageContent = SessionEvent<'user/message'>['data']['content']

/** 以空格连接文本块、折叠空白，并在截断时以尾随省略号截断到 `limit`。 */
function preview(content: MessageContent, limit: number): string {
  let text = ''
  let unread = false
  for (const block of content) {
    if (block.type !== 'text') continue
    if (text.length >= limit * 2) {
      unread = true
      break
    }
    // 每块的边界：折叠在每个消息事件上运行，因此单个多兆字节的块绝不能
    // 为了这么短的一个预览而被整体拼接（并做正则规范化）。
    const clipped = block.text.length > limit * 2
    const chunk = clipped ? block.text.slice(0, limit * 2) : block.text
    text += text === '' ? chunk : ` ${chunk}`
    if (clipped) {
      unread = true
      break
    }
  }
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length > limit - 1) return `${normalized.slice(0, limit - 1).trimEnd()}…`
  return unread ? `${normalized}…` : normalized
}

const turnOutlineEntriesSchema: ZodType<readonly TurnOutlineEntry[]> = z.array(z.object({
  turn: z.number().int().nonnegative(),
  seq: z.number().int().nonnegative().transform(SessionSeq),
  prompt: z.string().max(PROMPT_PREVIEW_LIMIT),
  response: z.string().max(RESPONSE_PREVIEW_LIMIT),
}).strict()).superRefine((turns, context) => {
  let previous = -1
  for (const entry of turns) {
    if (entry.turn <= previous) {
      context.addIssue({ code: 'custom', message: 'turn outline entries must be strictly increasing by turn' })
      return
    }
    previous = entry.turn
  }
})

const turnOutlineStateSchema: ZodType<TurnOutlineState> = z.object({
  turns: turnOutlineEntriesSchema,
  draft: z.string().max(RESPONSE_PREVIEW_LIMIT),
}).strict()

const EMPTY_OUTLINE: TurnOutlineState = { turns: [], draft: '' }

/** 注册在 `ctx.sessionProjections` 上的 `turnOutline` 单元（为单元 spec 而导出）。 */
export const turnOutlineProjectionDefinition = {
  key: 'turnOutline',
  stateVersion: 2,
  stateSchema: turnOutlineStateSchema,
  init: () => EMPTY_OUTLINE,
  apply: (state, event) => {
    // 每个无趣的事件都返回同一个引用（Object.is 把住驱动），而仅草稿的
    // 变化保留 `turns` 的身份（原始视图的身份闸门随后让变更流保持安静）。
    switch (event.type) {
      case 'turn/start': {
        const last = state.turns.at(-1)
        // 顺序守卫：不推进回合号的边界会让大纲保持有序，而一个被重试回合
        // 的预览会落在既有的条目上。
        if (last !== undefined && event.data.turn <= last.turn) return state
        return {
          turns: [...state.turns, { turn: event.data.turn, seq: event.seq, prompt: '', response: '' }],
          draft: '',
        }
      }
      case 'user/message': {
        // 只有最新的回合还可能正在等待它的开头人类提示；同一回合中后来的
        // 人类消息（纠偏）保留首条预览。
        if (event.data.source.kind !== 'user') return state
        const last = state.turns.at(-1)
        if (last === undefined || last.prompt !== '') return state
        const prompt = preview(event.data.content, PROMPT_PREVIEW_LIMIT)
        if (prompt === '') return state
        return { turns: [...state.turns.slice(0, -1), { ...last, prompt }], draft: state.draft }
      }
      case 'assistant/message': {
        // 最新一条含文本的消息胜出；缓冲区在 turn/end 时提交。
        const draft = preview(event.data.message.content, RESPONSE_PREVIEW_LIMIT)
        if (draft === '' || draft === state.draft) return state
        return { turns: state.turns, draft }
      }
      case 'turn/end': {
        if (state.draft === '') return state
        const last = state.turns.at(-1)
        if (last === undefined || last.response === state.draft) return { turns: state.turns, draft: '' }
        return { turns: [...state.turns.slice(0, -1), { ...last, response: state.draft }], draft: '' }
      }
      default:
        return state
    }
  },
  wire: {
    viewSchema: turnOutlineEntriesSchema,
    view: state => state.turns,
  },
} satisfies ProjectionDefinition<'turnOutline', TurnOutlineState>
