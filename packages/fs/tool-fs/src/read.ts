/**
 * 面向模型的 UTF-8 读取。它执行一次提供者 stat 以获得类型、路由与观测版本，对大文件或大小
 * 未知的文件采用流式读取，渲染一个有界的窗口，然后发出观测事件。
 * @module @deepseek-ai/dsh-tool-fs/src/read
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ReadResultView, ToolResult } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-fs'
import { buildWindow, formatReadOutput, langFromPath, readMetaFromMeta } from './read-render.ts'
import { resolveRegularReadTarget } from './read-target.ts'

/** 单次 `read` 调用返回的默认行数与最大行数（即 `readLimit` 配置）。 */
export const READ_LIMIT = 2000

/**
 * 默认的流式读取阈值（即 `readStreamMinSize` 配置）：达到或超过该大小的文件走流式读取；
 * 更小的文件整体读入内存。
 */
export const STREAM_MIN_SIZE = 10 * 1024 * 1024

/** 已解析的读取工具上限 —— 完成默认值填充后的插件配置（见 index.ts 的 `Config`）。 */
export interface ReadToolCaps {
  /** 单次调用返回的默认行数与最大行数。 */
  limit: number
  /** 单行返回的最大字符数。 */
  maxLineLength: number
  /** 所选文件行返回的最大字节数。 */
  maxBytes: number
  /** 达到或超过该大小的文件走流式读取；更小的文件整体读入内存。 */
  streamMinSize: number
}

/** 完成默认值填充并校验后的 `read` 参数。 */
interface ReadInput {
  filePath: string
  offset: number
  limit: number
}

function parsePositiveInteger(value: number, name: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

/**
 * 校验模式 DSL 无法表达的值约束。`maxLimit` 是该部署的行数上限。
 * @param args - 经模式校验过的原始工具参数；`offset`/`limit` 在给出时必须为正整数。
 * @param maxLimit - 已配置的行数上限：既是 `limit` 的默认值，也是被接受的最大值。
 * @returns 已校验的输入，其中 `offset` 默认为 1、`limit` 默认为 `maxLimit`。
 */
export function parseReadArgs(args: { file_path: string; offset?: number; limit?: number }, maxLimit: number): ReadInput {
  if (args.file_path.trim().length === 0) throw new Error('file_path must be a non-empty string')
  const offset = args.offset === undefined ? 1 : parsePositiveInteger(args.offset, 'offset')
  const limit = args.limit === undefined ? maxLimit : parsePositiveInteger(args.limit, 'limit')
  if (limit > maxLimit) throw new Error(`limit must be less than or equal to ${maxLimit}`)
  return { filePath: args.file_path, offset, limit }
}

/**
 * 注册 `read` 工具及其随作用域变化的系统提示语。
 * @param ctx - 插件上下文；所有注册都是以它为作用域的 effect，执行时使用它的 `fs` 服务。
 * @param caps - 该部署已解析的读取上限（完成默认值填充后的插件配置）。
 */
export function applyReadTool(ctx: Context, caps: ReadToolCaps): void {
  ctx.systemPrompt.section({
    name: 'tool:read',
    order: ctx.systemPrompt.getSectionOrder('TOOL_READ'),
    text: ({ scope }) => ctx.tools.get('read', scope) === undefined
      ? ''
      : 'Use the read tool — not shell commands like cat — to inspect text files. Use offset and limit to continue reading large files.',
  })

  ctx.tools.register(defineTool({
    name: 'read',
    description: 'Read a UTF-8 text file and return line-numbered content.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to read, resolved by the filesystem backend.' },
      offset: { type: 'number', description: '1-based first line to return. Defaults to 1.' },
      limit: { type: 'number', description: `Maximum number of lines to return. Defaults to ${caps.limit}.` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true, description: 'Canonical absolute path in the filesystem execution world.' },
          offset: { type: 'integer', required: true },
          lines: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                number: { type: 'integer', required: true },
                text: { type: 'string', required: true },
              },
            },
          },
          totalLines: { type: 'integer', required: true },
        },
      },
      render: (args, value) => {
        const input = parseReadArgs(args, caps.limit)
        const endLine = value.lines.at(-1)?.number ?? Math.max(0, value.offset - 1)
        const truncatedByBytes = value.lines.length < input.limit && endLine < value.totalLines
        return [{
          type: 'text',
          text: formatReadOutput(value.path, {
            offset: value.offset,
            lines: value.lines,
            totalLines: value.totalLines,
            ...truncatedByBytes ? { truncatedByBytes: true } : {},
          }),
        }]
      },
      // 把结构化的窗口投影到持久化的 `meta` 上，使 UI 的读取卡片能在重放后存活：
      // 原始的规范输出对象并不在线路上，只有面向模型的文本，而从中无法还原行号/语言信息。
      presentationMeta: (_args, value) => {
        const lang = langFromPath(value.path)
        return {
          path: value.path,
          offset: value.offset,
          lines: value.lines.map(({ number, text }) => ({ number, text })),
          totalLines: value.totalLines,
          ...lang === undefined ? {} : { lang },
        }
      },
    },
    // 观测竞态"失败即关闭"，因为受守卫的修改会在锁内重新校验版本。
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const input = parseReadArgs(args, caps.limit)
      // 一次 stat：既用于观测不存在，也用于类型检查 + 大小路由 + 当前版本。
      // 一次并发写入只会让之后受守卫的修改因过期而失败，并要求重新读取。
      const { target, info } = await resolveRegularReadTarget(ctx, exec, input.filePath)

      // 当文件很大**或**大小未知时走流式读取，这样没有大小信息的后端永远不会缓冲
      // 任意大的文件。
      const chunks = info.size === undefined || info.size >= caps.streamMinSize
        ? await ctx.fs.streamText(target, exec.signal)
        : [await ctx.fs.readText(target, exec.signal)]
      const window = await buildWindow(
        chunks,
        { offset: input.offset, limit: input.limit, maxLineLength: caps.maxLineLength, maxBytes: caps.maxBytes },
        target.displayPath,
      )

      const outcome = {
        path: ctx.fs.processPath(target),
        offset: input.offset,
        lines: window.lines,
        totalLines: window.totalLines,
      }
      // 记录"存在"的观测（没有策略插件监听时是空操作）。读取已经成功；
      // 按契约 `fs/observed` 的监听器是一个同步且无副作用的记录者。
      ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
      return outcome
    },
    // 结果时刻的展示：一张 `read` 卡片，携带结构化的行窗口，有能力的 UI 会把它渲染成
    // 带行号、语法高亮的视图。这些结构化数据是从持久化的 `meta` 收窄而来的（可重放）；
    // 剥去信封的面向模型文本则作为 `content` 随行附带，使不具备读取能力的 UI 仍能显示
    // 文件文本。元数据缺失或格式有误，或者结果文本不是读取信封时，一律退化为
    // `undefined`（即通用回退），绝不在重放过时的日志输出时抛错。
    presentResult(_args, result: ToolResult): ReadResultView | undefined {
      if (result.isError) return undefined
      const meta = readMetaFromMeta(result.meta)
      if (meta === undefined) return undefined
      const only = result.content.length === 1 ? result.content[0] : undefined
      const text = only?.type === 'text' ? only.text : undefined
      if (text === undefined) return undefined
      // 信封匹配时，分组 1 总能捕获到内容（可能为空）。
      const body = /^<path>[^\n]*<\/path>\n<type>file<\/type>\n<content>\n([\s\S]*)\n<\/content>$/u.exec(text)?.[1]
      if (body === undefined) return undefined
      return {
        card: 'read',
        path: meta.path,
        offset: meta.offset,
        lines: meta.lines,
        totalLines: meta.totalLines,
        ...meta.lang === undefined ? {} : { lang: meta.lang },
        content: [{ type: 'text', text: body }],
      }
    },
    // 纯展示：一张以文件名标题的通用卡片，后面附上读取窗口（`Read
    // foo.txt (5 - 8)`）、`read` 类型（图标），以及一个跟随位置，其行号取自本次读取的
    // offset（默认为 1）。窗口反映的是原始参数，因此省略 limit 时标题保持朴素，
    // 而不是把配置偷渡进这个纯展示器。
    presentCall(args): GenericCallView {
      const { offset, limit } = args
      const window = limit !== undefined && limit > 0
        ? ` (${offset ?? 1} - ${(offset ?? 1) + limit - 1})`
        : offset !== undefined ? ` (from line ${offset})` : ''
      return {
        card: 'generic',
        title: `Read ${args.file_path}${window}`,
        kind: 'read',
        locations: [{ path: args.file_path, line: offset ?? 1 }],
      }
    },
  }))
}
