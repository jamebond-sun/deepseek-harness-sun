/**
 * 面向模型的整文件写入。它从唯一的策略槽获取可选意图，不做 stat 直接调用
 * `ctx.fs.writeText`，然后记录产生的版本；没有策略时就是一次无条件的原子创建或覆盖。
 * @module @deepseek-ai/dsh-tool-fs/src/write
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { DiffCallView, DiffResultView, ToolResult } from '@deepseek-ai/dsh-tools'
import type { FsWriteOutcome } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-fs'
import { computeHunkDiffs, diffsFromMeta, pathFromMeta } from './diff.ts'
import { remediateFsError } from './error.ts'
import { mutationResult } from './mutation-result.ts'
import { sessionResolveOptions } from './session-cwd.ts'
import type { FsSandboxController } from './sandbox.ts'

/**
 * 校验模式 DSL 无法表达的值约束：只要求 `file_path` 非空白 ——
 * 空的 `content` 是合法的（它会写出一个空文件）。
 * @param args - 经模式校验过的原始工具参数。
 * @returns 驼峰化的输入；`content` 原样透传。
 */
export function parseWriteArgs(args: { file_path: string; content: string }): { filePath: string; content: string } {
  if (args.file_path.trim().length === 0) throw new Error('file_path must be a non-empty string')
  return { filePath: args.file_path, content: args.content }
}

/**
 * 把一次写入结果格式化为一个面向模型的文本块正文。
 * @param displayPath - 由后端解析、渲染在信封 `<path>` 元素中的路径。
 * @param outcome - 写入结果；其 `operation` 决定使用 Created 还是 Updated 措辞。
 * @returns 面向模型的确认信封（不回显文件内容）。
 */
export function formatWriteOutput(displayPath: string, outcome: Pick<FsWriteOutcome, 'operation'>): string {
  const verb = outcome.operation === 'create' ? 'Created' : 'Updated'
  return `<path>${displayPath}</path>
<type>file</type>
<content>
${verb} file
</content>`
}

/**
 * `write` 工具已校验的参数：基础参数外加两个提级字段，仅在会做隔离的 `ctx.fs` 下才宣示
 * （否则它们不出现在模式里，校验器会在 `execute` 之前就拒绝）。
 */
interface WriteToolArgs {
  file_path: string
  content: string
  sandbox_permissions?: string
  justification?: string
}

/**
 * 注册 `write` 工具及其随作用域变化的系统提示语。
 * @param ctx - 插件上下文；所有注册都是以它为作用域的 effect，执行时使用它的 `fs` 服务。
 * @param sandbox - 共享的沙箱提级 API（宣示、模式标记、拒绝映射）。
 */
export function applyWriteTool(ctx: Context, sandbox: FsSandboxController): void {
  ctx.systemPrompt.section({
    name: 'tool:write',
    order: ctx.systemPrompt.getSectionOrder('TOOL_WRITE'),
    text: ({ scope }) => ctx.tools.get('write', scope) === undefined
      ? ''
      : 'Read an existing file before overwriting it with write (the default fs-observation-policy requires it)'
        + (ctx.tools.get('edit', scope) === undefined ? '' : ' and prefer edit for targeted changes')
        + '.',
  })

  ctx.tools.register(defineTool({
    name: 'write',
    description: 'Create or fully replace a UTF-8 text file.',
    parameters: {
      file_path: {
        type: 'string', required: true,
        description: 'Path to write, resolved by the filesystem backend. '
          + 'Provide `file_path` before `content` in the arguments.',
      },
      content: { type: 'string', required: true, description: 'Full UTF-8 text content to write.' },
      ...sandbox.escalationModes.length > 0 ? sandbox.schemaFields() : {},
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true, description: 'Canonical absolute path in the filesystem execution world.' },
          operation: { type: 'string', required: true, enum: ['create', 'update'] },
          before: {
            required: true,
            oneOf: [
              { type: 'string' },
              { type: 'null' },
            ],
          },
          after: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatWriteOutput(value.path, value) }],
      presentationMeta: (_args, value) => ({
        operation: value.operation,
        path: value.path,
        diffs: value.before === null
          ? []
          : computeHunkDiffs(value.path, value.before, value.after)
            .map(({ path, oldText, newText }) => ({ path, oldText, newText })),
      }),
    },
    async execute(args: WriteToolArgs, exec) {
      const input = parseWriteArgs(args)
      // 在执行任何东西之前先解析本次调用的沙箱策略（已批准模式 > 会话覆写 > 后端默认，
      // 外加会话的 cwd 根目录）；提级调用在任何非授权情况下抛出其特有的文案。
      const sandboxPolicy = await sandbox.resolvePolicy('write', args, exec)
      const target = await ctx.fs.resolve(input.filePath, await sessionResolveOptions(ctx, exec))
      // 单槽决策：策略插件产出 createIfAbsent/replaceIfVersion；裸默认值是 undefined
      //（无条件写入）。不做 stat。
      const intent = await ctx.waterfall('fs/write-intent', target, exec, () => undefined)
      let outcome: FsWriteOutcome
      try {
        outcome = await ctx.fs.writeText(target, input.content, intent, exec.signal, sandboxPolicy)
      } catch (error: unknown) {
        // 沙箱拒绝会变成共享的 [sandbox: …] 标记（模型从 bash 那里认识它）；
        // 受守卫的修改失败会得到稳定的面向模型诊断；其他情况原样透传。
        throw remediateFsError(sandbox.mapError(error, sandboxPolicy), target.displayPath)
      }
      return mutationResult(ctx, target, outcome, exec)
    },
    // 纯展示：一张 diff 卡片。调用时刻的展示层拿不到此前的文件内容，
    // 所以这里的 `oldText: null` 同样表示一次覆盖。
    presentCall(args): DiffCallView {
      return {
        card: 'diff',
        title: `Write ${args.file_path}`,
        diffs: [{ path: args.file_path, oldText: null, newText: args.content }],
        locations: [{ path: args.file_path }],
      }
    },
    // 结果时刻的展示重复这张 diff，因为已完成视图会替换掉进行中的视图。
    // 覆盖使用已应用的元数据；创建与内容相同的覆盖则使用可重放的 args 回退方案。
    presentResult(args, result: ToolResult): DiffResultView | undefined {
      if (result.isError) return undefined
      const diffs = diffsFromMeta(result.meta)
        ?? [{ path: pathFromMeta(result.meta) ?? args.file_path, oldText: null, newText: args.content }]
      return { card: 'diff', title: `Write ${args.file_path}`, diffs }
    },
  }))
}
