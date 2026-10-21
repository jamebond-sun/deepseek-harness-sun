/**
 * 面向模型的字面量编辑，默认要求唯一匹配。它从唯一的意图槽获取可选的守卫，直接调用
 * `ctx.fs.editText` 而不额外做一次 stat，然后记录观测到的版本；没有策略时就是一次无条件的
 * 原子编辑。
 * @module @deepseek-ai/dsh-tool-fs/src/edit
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { DiffCallView, DiffResultView, ToolResult } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-fs'
import { computeHunkDiffs, diffsFromMeta } from './diff.ts'
import { remediateFsError } from './error.ts'
import { mutationResult } from './mutation-result.ts'
import { sessionResolveOptions } from './session-cwd.ts'
import type { FsSandboxController } from './sandbox.ts'

/** 完成默认值填充并校验后的 `edit` 参数。 */
interface EditInput {
  filePath: string
  oldString: string
  newString: string
  replaceAll: boolean
}

/**
 * `edit` 工具已校验的参数：基础参数外加两个提级字段，仅在会做隔离的 `ctx.fs` 下才宣示
 * （否则这两个字段不出现在模式里，校验器会在 `execute` 之前就拒绝它们）。
 */
interface EditToolArgs {
  file_path: string
  old_string: string
  new_string: string
  replace_all?: boolean
  sandbox_permissions?: string
  justification?: string
}

/**
 * 校验模式 DSL 无法表达的值约束：`file_path` 非空白、`old_string` 非空，
 * 以及 `old_string !== new_string`（相等的一对必然是一次空操作编辑）。
 * @param args - 经模式校验过的原始工具参数。
 * @returns 驼峰化的输入，其中 `replace_all` 默认为 false。
 */
export function parseEditArgs(args: { file_path: string; old_string: string; new_string: string; replace_all?: boolean }): EditInput {
  if (args.file_path.trim().length === 0) throw new Error('file_path must be a non-empty string')
  if (args.old_string.length === 0) throw new Error('old_string must be a non-empty string')
  if (args.old_string === args.new_string) throw new Error('old_string and new_string must differ')
  return {
    filePath: args.file_path,
    oldString: args.old_string,
    newString: args.new_string,
    replaceAll: args.replace_all ?? false,
  }
}

/**
 * 把一次编辑成功（单处匹配或全部替换）格式化为面向模型的、Claude 风格的消息。
 * @param displayPath - 展示给模型的、由后端解析出的路径。
 * @param replaceAll - 为真时使用"全部出现处"的措辞，否则使用"单次替换"的措辞。
 * @returns 模型作为工具结果看到的确认语句。
 */
export function formatEditOutput(displayPath: string, replaceAll: boolean): string {
  return replaceAll
    ? `The file ${displayPath} has been updated. All occurrences were successfully replaced.`
    : `The file ${displayPath} has been updated successfully.`
}

/**
 * 注册 `edit` 工具及其随作用域变化的系统提示语。
 * @param ctx - 插件上下文；所有注册都是以它为作用域的 effect，执行时使用它的 `fs` 服务。
 * @param sandbox - 共享的沙箱提级 API（宣示、模式标记、拒绝映射）。
 */
export function applyEditTool(ctx: Context, sandbox: FsSandboxController): void {
  ctx.systemPrompt.section({
    name: 'tool:edit',
    order: ctx.systemPrompt.getSectionOrder('TOOL_EDIT'),
    text: ({ scope }) => ctx.tools.get('edit', scope) === undefined
      ? ''
      : 'Read a file before editing it (the default fs-observation-policy requires it), unless you just created or edited it in this session.',
  })

  ctx.tools.register(defineTool({
    name: 'edit',
    description: 'Edit an existing UTF-8 text file by replacing literal text.',
    parameters: {
      file_path: {
        type: 'string', required: true,
        description: 'Path to edit, resolved by the filesystem backend. '
          + 'Provide `file_path` before `old_string` and `new_string` in the arguments.',
      },
      old_string: { type: 'string', required: true, description: 'Literal text to replace.' },
      new_string: { type: 'string', required: true, description: 'Literal replacement text. Use an empty string to delete the match.' },
      replace_all: { type: 'boolean', description: 'Replace all matches. Defaults to false; when false, old_string must appear exactly once.' },
      ...sandbox.escalationModes.length > 0 ? sandbox.schemaFields() : {},
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true, description: 'Canonical absolute path in the filesystem execution world.' },
          before: { type: 'string', required: true },
          after: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: formatEditOutput(value.path, args.replace_all ?? false),
      }],
      presentationMeta: (_args, value) => ({
        path: value.path,
        diffs: computeHunkDiffs(value.path, value.before, value.after)
          .map(({ path, oldText, newText }) => ({ path, oldText, newText })),
      }),
    },
    async execute(args: EditToolArgs, exec) {
      const input = parseEditArgs(args)
      // 在执行任何东西之前先解析本次调用的沙箱策略（已批准模式 > 会话覆写 > 后端默认，
      // 外加会话的 cwd 根目录）。
      const sandboxPolicy = await sandbox.resolvePolicy('edit', args, exec)
      const target = await ctx.fs.resolve(input.filePath, await sessionResolveOptions(ctx, exec))
      // 单槽决策：策略插件返回 { version: vObserved }，或者抛出 FS_NOT_OBSERVED；
      // 裸默认值是 undefined（无条件编辑）。不做 stat —— 裸默认值从不自行编造版本基线。
      // 意图槽本身也会对未读过的目标抛出 FS_NOT_OBSERVED，所以它放在 try 内部：
      // 那次拒绝与提供者侧受守卫修改的失败都会拿到下面面向模型的补救文案。
      let outcome
      try {
        const intent = await ctx.waterfall('fs/edit-intent', target, exec, () => undefined)
        outcome = await ctx.fs.editText(
          target,
          { oldString: input.oldString, newString: input.newString, replaceAll: input.replaceAll },
          intent,
          exec.signal,
          sandboxPolicy,
        )
      } catch (error: unknown) {
        // 沙箱拒绝会变成共享的 [sandbox: …] 标记（模型从 bash 那里认识它）；
        // 受守卫的修改失败会得到稳定的面向模型诊断；其他情况原样透传。
        throw remediateFsError(sandbox.mapError(error, sandboxPolicy), target.displayPath)
      }
      return mutationResult(ctx, target, outcome, exec)
    },
    // 纯展示：由调用参数派生出的、这次字面量替换（old_string → new_string）的 diff 卡片。
    // `oldText: old_string || null` 与 claude-agent-acp 的 Edit 分支一致；
    // 这里 new_string 是必填参数，因此直接映射为 newText。
    presentCall(args): DiffCallView {
      return {
        card: 'diff',
        title: `Edit ${args.file_path}`,
        diffs: [{ path: args.file_path, oldText: args.old_string || null, newText: args.new_string }],
        locations: [{ path: args.file_path }],
      }
    },
    // 已应用的元数据会替换掉调用时刻的片段；出错或重放元数据格式有误时使用通用的结果渲染。
    presentResult(args, result: ToolResult): DiffResultView | undefined {
      if (result.isError) return undefined
      const diffs = diffsFromMeta(result.meta)
      if (diffs === undefined) return undefined
      return { card: 'diff', title: `Edit ${args.file_path}`, diffs }
    },
  }))
}
