/**
 * 面向模型的整列表替换。每次调用都会向调用 Agent 的会话追加一条 `todo/write`
 * 快照；重放采用后写覆盖，UI 从会话事件渲染。非 Agent 调用者没有所属列表，会被拒绝。
 * 具名导出保留了加载器注入元数据。
 * @module @deepseek-ai/dsh-tool-todo
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { TodoItem } from './types.ts'
// 仅类型：解析所需的 ctx.sessionProjections 服务声明。
import type {} from '@deepseek-ai/dsh-session-projection'
// `todos` 投影键声明位于 src/types.ts（其唯一归属）；
// 此再导出将类型面向投影到包根，并保留
// 发出到 index.d.ts 中的模块边界，因此消费这些
// 声明的聚合程序仍能收到 SessionProjectionMap 的合并。
export type * from './types.ts'

export const name = 'tool-todo'
export const inject = ['tools', 'sessionProjections']

/** 合法的 {@link TodoItem} 状态集合，作为运行时集合用于输入收窄。 */
const STATUSES = ['pending', 'in_progress', 'completed'] as const

/** 面向模型的 todo 工具配置。 */
export interface Config {
  /**
   * 关于是否允许多个 todo 同时处于 `in_progress` 的必填部署选择。
   * 为 true 适用于并发执行工作的 Agent —— 子 Agent、后台命令、工作流扇出 ——
   * 此时描述会指示模型标记每一个正在积极处理的任务。为 false 则恢复单一
   * 活动纪律：描述要求恰好一个，标记更多的调用会被拒绝。
   */
  allowParallelInProgress: boolean
}

/** todo 工具消费者的 Schemastery 配置。 */
export const Config: z<Config> = z.object({
  allowParallelInProgress: z.boolean().required(),
})

const DESCRIPTION_HEAD =
  'Record and update a task list to plan multi-step work and show progress; skip it for trivial '
  + 'single-step tasks. Add one todo per concrete step before you start. '

const DESCRIPTION_PARALLEL =
  'While work remains, keep the todos being worked on `in_progress`, several only when work runs in parallel. '

const DESCRIPTION_SINGLE =
  'While work remains, keep exactly one todo `in_progress`. '

const DESCRIPTION_TAIL = 'Mark each todo `completed` as soon as it is done.'

/**
 * 一次激活时面向模型的描述。唯一变化的部分是活动状态子句，
 * 因为它是并行策略唯一会改变的指令。
 * @param allowParallel - 是否允许多个 todo 同时处于 `in_progress`。
 * @returns 组合出的工具描述。
 */
function describe(allowParallel: boolean): string {
  return DESCRIPTION_HEAD
    + (allowParallel ? DESCRIPTION_PARALLEL : DESCRIPTION_SINGLE)
    + DESCRIPTION_TAIL
}

/**
 * 校验 ParameterSchemaSpec 无法表达的值约束，并构建规范的 {@link
 * TodoItem}[]：去除首尾空白的非空唯一 content，且除非部署允许
 * 并行工作，否则至多一个 `in_progress` 项。注册表已经强制执行
 * 了状态枚举并拒绝了未知条目键（`additionalProperties: false` ——
 * 记录的快照必须等于模型认为自己写入的内容，因此嵌套/扩展的
 * 条目形状会在 schema 边界处大声失败，而不是静默扁平化）；
 * 下面的转换记录了这一保证。
 * @param raw - 模型提供的列表，已通过 schema 校验。
 * @param allowParallel - 是否允许多个条目同时处于 `in_progress`。
 * @returns 规范列表。
 */
function toTodoList(raw: { content: string; status: string }[], allowParallel: boolean): TodoItem[] {
  const todos: TodoItem[] = []
  const seen = new Set<string>()
  let active = 0
  for (const item of raw) {
    const content = item.content.trim()
    if (content.length === 0) {
      throw new Error('invalid todo: `content` must be a non-empty string')
    }
    if (seen.has(content)) {
      throw new Error(`invalid todos: duplicate content ${JSON.stringify(content)}`)
    }
    seen.add(content)
    if (item.status === 'in_progress') active++
    todos.push({ content, status: item.status as TodoItem['status'] })
  }
  if (!allowParallel && active > 1) {
    throw new Error(`invalid todos: at most one task may be in_progress (got ${active})`)
  }
  return todos
}

/** `todos` 投影的有线负载 schema（整列表，或首次写入前的 null）。 */
const todosProjectionSchema: ZodType<TodoItem[] | null> = zod.union([
  zod.array(zod.object({
    content: zod.string(),
    status: zod.union([zod.literal('pending'), zod.literal('in_progress'), zod.literal('completed')]),
  })),
  zod.null(),
])

/**
 * 在 `ctx.tools` 上注册 `todo_write` 工具，并在
 * `ctx.sessionProjections` 上注册 `todos` 单元。
 * @param ctx - 携带工具和会话投影注册表的注册者上下文。
 * @param config - 部署的显式 todo 策略。
 */
export function apply(ctx: Context, config: Config): void {
  const allowParallel = config.allowParallelInProgress
  // 常驻计划折叠：最新的整 todo/write 列表，在下一回合/开始时
  // 清空（turn/end 保留已完成清单可见）；首次写入前或后续
  // 回合开始后为空；所有其他事件返回相同状态引用。
  ctx.sessionProjections.register<'todos', TodoItem[] | null>({
    key: 'todos',
    stateSchema: todosProjectionSchema,
    init: () => null,
    apply: (state, event) => {
      if (event.type === 'todo/write') return event.data.todos
      if (event.type === 'turn/start') return null
      return state
    },
    wire: { viewSchema: todosProjectionSchema, view: state => state },
    stateVersion: 2,
  })
  ctx.tools.register(defineTool({
    name: 'todo_write',
    description: describe(allowParallel),
    parameters: {
      todos: {
        type: 'array',
        required: true,
        description: 'The COMPLETE task list, replacing any previous list.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            content: { type: 'string', required: true, description: 'What the task is — a short imperative line.' },
            status: {
              type: 'string',
              required: true,
              enum: [...STATUSES],
              description: 'pending (not started) | in_progress (now) | completed (done).',
            },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          todos: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                content: { type: 'string', required: true },
                status: { type: 'string', required: true, enum: [...STATUSES] },
              },
            },
          },
          counts: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              pending: { type: 'integer', required: true },
              inProgress: { type: 'integer', required: true },
              completed: { type: 'integer', required: true },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Updated todo list: ${value.counts.pending} pending, ${value.counts.inProgress} in progress, ${value.counts.completed} completed.`,
      }],
    },
    execute(args, exec) {
      const todos = toTodoList(args.todos, allowParallel)
      if (!exec.agent) {
        // 列表是按 Agent 会话的状态；非 Agent 调用者（无所属
        // 会话）无处写入。拒绝而非静默空操作。
        throw new Error('todo_write requires an owning agent session')
      }
      exec.agent.session.append('todo/write', { todos })
      const count = (status: TodoItem['status']): number => todos.filter(t => t.status === status).length
      return Promise.resolve({
        todos: todos.map(todo => ({ content: todo.content, status: todo.status })),
        counts: {
          pending: count('pending'),
          inProgress: count('in_progress'),
          completed: count('completed'),
        },
      })
    },
    presentCall: args => ({ card: 'generic', title: 'Update todo list', kind: 'other', rawInput: args.todos }),
  }))
}
