/** 在其所属 Session 中声明文件系统交付物的作用域工具。 */
import type {} from '@deepseek-ai/dsh-working-directory'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { FsError } from '@deepseek-ai/dsh-fs'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { Session } from '@deepseek-ai/dsh-session'
import type { PresentedFile } from './types.ts'

/** 稳定的 Loader 标识。 */
export const name = 'tool-present'

/** 每次调用的交付上限。 */
export interface Config {
  /** 一次调用中文件的最大数量。 */
  maxFiles: number
}

/** 已校验的交付上限。 */
export const Config: z<Config> = z.object({
  maxFiles: z.number().default(8),
})

/** 该作用域交付工具所使用的服务。 */
export const inject = ['tools', 'fs', 'sessionProjections', 'workingDirectory']

/**
 * 以持久化的文件引用在工具结果中注册 present。
 * @param ctx - 代理作用域内的服务。
 * @param config - 每次调用的最大文件数。
 */
export function apply(ctx: Context, config: Config): void {
  if (!Number.isSafeInteger(config.maxFiles) || config.maxFiles < 1) {
    throw new Error('present requires a positive integer maxFiles')
  }
  const pending = new WeakMap<ToolExecution, { session: Session; turn: number; files: PresentedFile[] }>()
  ctx.tools.register(defineTool({
    name: 'present',
    description: 'Declare existing files as final deliverables for the user. '
      + 'Use it when the user needs a separate file, especially Office documents, spreadsheets, and slide decks; '
      + 'prefer your final response when that suffices. The user opens the current files; their contents are not copied.',
    parameters: {
      files: {
        type: 'array', required: true,
        // 4 是推荐的每次调用数量；`maxFiles` 是高于它的强制上限。
        description: 'Usually the 1-2 most important deliverables; at most 4 per call.',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            path: { type: 'string', required: true, description: 'Path of an existing regular file. Relative paths use the Session working directory.' },
            description: { type: 'string', description: 'Brief description for the user.' },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          turn: { type: 'integer', required: true },
          files: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                description: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.files.map(file => `Presented ${file.path}`).join('\n') }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('present requires an agent Session')
      const boundary = ctx.sessionProjections.stateOf(exec.agent.session, 'turnBoundary')
      if (boundary === undefined || boundary.openTurnStartSeq === null) throw new Error('present requires an open turn')
      if (args.files.length === 0 || args.files.length > config.maxFiles) throw new Error(`present accepts 1 to ${config.maxFiles} files`)
      const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
      const options = { cwd, signal: exec.signal }
      const files: PresentedFile[] = []
      for (const file of args.files) {
        if (file.path.trim().length === 0) throw new Error('present requires a non-empty file path')
        const entry = await ctx.fs.lstat(file.path, { cwd }, exec.signal)
        if (entry !== undefined && entry.type !== 'file') throw new Error(`Cannot present ${file.path}: not a regular file`)
        const target = await ctx.fs.resolve(file.path, options)
        const info = await ctx.fs.stat(target, exec.signal)
        if (info === undefined) throw new FsError(`Cannot present ${file.path}: file not found. Check the path, create the file if needed, and retry.`, 'FS_NOT_FOUND')
        if (info.type !== 'file') throw new Error(`Cannot present ${file.path}: not a regular file`)
        files.push({ ...file, path: ctx.fs.processPath(target) })
      }
      exec.signal.throwIfAborted()
      pending.set(exec, { session: exec.agent.session, turn: boundary.lastTurn, files })
      return { turn: boundary.lastTurn, files }
    },
  }))
  ctx.on('tools/result', (exec, result) => {
    const delivery = pending.get(exec)
    pending.delete(exec)
    if (delivery === undefined || result.isError) return
    const { session, turn, files } = delivery
    session.append('deliverables/presented', {
      turn, callId: exec.callId, files,
    })
  })
}
