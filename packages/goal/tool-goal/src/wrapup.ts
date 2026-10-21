/** 终态自主目标更新时注入的模型可见收尾指令。 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'

const GROUNDING =
  'Report only what earlier rounds and tool results in this session actually establish; '
  + 'when a detail is not in the session, say so instead of inventing it. '

/**
 * 渲染在自主 goal 轮次上报 `complete` 或 `blocked` 之后注入的收尾消息指令，
 * 用以取代原先的硬性轮次终止，使模型在轮次结束前仍能面向用户作一次回应。
 * @param objective - 终态目标的目标描述，回显以作事实依据。
 * @param blockedReason - `blocked` 的已校验上报内容；`complete` 时省略。
 * @returns 供 `ToolRunContext.deferContext()` 使用的全新单块上下文。
 */
export function renderWrapupContext(objective: string, blockedReason?: string): ContentBlock[] {
  const heading = `Objective: ${JSON.stringify(objective)}\n`
  const text = blockedReason === undefined
    ? '<goal_complete>\n'
      + heading
      + 'The goal is marked complete and this autonomous run is ending. Write the closing '
      + 'message to the user now: state the outcome, summarize what was done and how it was '
      + 'verified, and point to the concrete results (files, commits, or other artifacts). '
      + GROUNDING
      + 'Note anything the user should review or do next. Address the user directly. Do not '
      + "call any more tools in this run; further work waits for the user's next instruction.\n"
      + '</goal_complete>'
    : '<goal_blocked>\n'
      + heading
      + `Blocked: ${JSON.stringify(blockedReason)}\n`
      + 'The goal is marked blocked and this autonomous run is ending. Write the closing '
      + 'message to the user now: state what has been completed so far, describe the concrete '
      + 'blocking condition and what you tried, and say exactly what you need from the user to '
      + 'continue. '
      + GROUNDING
      + 'Address the user directly. Do not call any more tools in this run; further work '
      + "waits for the user's next instruction.\n"
      + '</goal_blocked>'
  return [{ type: 'text', text }]
}
