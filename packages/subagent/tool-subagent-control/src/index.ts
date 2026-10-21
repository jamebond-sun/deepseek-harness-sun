/**
 * 全局命名的 `send_message` 与 `interrupt_agent` 工具：对
 * `ctx.subagents.sendMessage()` 与 `ctx.subagents.interrupt()` 的、面向模型的
 * 薄适配器。它们自身不执行任何生命周期路由 —— 驻留、冷恢复与中断授权属于
 * 子代理 service —— 并且它们与绑定于提供方的
 * `@deepseek-ai/dsh-tool-subagent` 实例分开存在，以便多个委托工具共享一个
 * 控制 API。
 * @module @deepseek-ai/dsh-tool-subagent-control
 */

import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subagent'
import { markAdjacentAgentSendMessageTool } from '@deepseek-ai/dsh-subagent/internal'

export const name = 'tool-subagent-control'
export const inject = ['tools', 'subagents']

/**
 * 注册 `send_message` 与 `interrupt_agent` 工具。
 * @param ctx - 承载工具注册表与子代理 service 的上下文。
 */
export function apply(ctx: Context): void {
  ctx.tools.register(markAdjacentAgentSendMessageTool(defineTool({
    name: 'send_message',
    description:
      'Send a message to an agent. A working agent receives it at its next step; an idle agent starts a new turn with it. '
      + 'Returns delivery confirmation, not the agent\'s answer.',
    parameters: {
      agent_id: {
        type: 'string',
        required: true,
        description: 'The agent id of your direct continuable child, or your direct parent when you are a resident continuable child.',
      },
      message: {
        type: 'string',
        required: true,
        description: 'The message to deliver to the agent.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          messageId: { type: 'string', required: true },
        },
      },
      render: (args, _value) => [{
        type: 'text',
        text: `message delivered to agent ${args.agent_id}`,
      }],
    },
    async execute(args, exec) {
      const sender = exec.agent
      if (!sender) {
        throw new Error('send_message requires a calling agent (exec.agent was undefined)')
      }
      const message: ContentBlock[] = [{ type: 'text', text: args.message }]
      const messageId = await ctx.subagents.sendMessage(
        sender,
        brandString<SessionId>(args.agent_id),
        message,
        { signal: exec.signal },
      )
      return { messageId }
    },
  })))

  ctx.tools.register(defineTool({
    name: 'interrupt_agent',
    description:
      'Ask a subagent to stop its current work. This call returns without waiting for it to stop. '
      + 'You can continue a local direct child\'s conversation later with send_message. '
      + 'External executions stop permanently and cannot receive follow-ups. Subagents it started will keep running.',
    parameters: {
      agent_id: {
        type: 'string',
        required: true,
        description: 'The id of an agent created under you: your direct child or a deeper descendant.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          accepted: { type: 'boolean', required: true },
        },
      },
      render: (args, _value) => [{
        type: 'text',
        text: `interrupt requested for agent ${args.agent_id}`,
      }],
    },
    execute(args, exec) {
      const caller = exec.agent
      if (!caller) {
        // 祖先授权需要一个精确的实时调用方 agent。
        throw new Error('interrupt_agent requires a calling agent (exec.agent was undefined)')
      }
      // service 针对目标所记录的血缘授权该精确的实时调用方；
      // 本工具不添加任何自身的权限。
      ctx.subagents.interrupt(brandString<SessionId>(args.agent_id), { kind: 'ancestor', agent: caller })
      return Promise.resolve({ accepted: true })
    },
  }))
}
