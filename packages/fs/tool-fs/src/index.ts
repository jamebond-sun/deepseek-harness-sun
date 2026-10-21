/**
 * 建立在 `ctx.fs` 之上、面向模型的 read、read_image、write 与 edit 工具。本包负责模式定义、
 * 校验、读取窗口、格式化以及观测事件，绝不提供具体提供者实现。可选的事件策略提供修改守卫；
 * 没有策略时，工具使用无条件的提供者调用。
 * @module @deepseek-ai/dsh-tool-fs
 */

import type {} from '@deepseek-ai/dsh-working-directory'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-user-approval'
import { applyReadTool, READ_LIMIT, STREAM_MIN_SIZE } from './read.ts'
import { applyWriteTool } from './write.ts'
import { applyEditTool } from './edit.ts'
import { applyReadImageTool } from './read-image.ts'
import { READ_MAX_BYTES, READ_MAX_LINE_LENGTH } from './read-render.ts'
import { FsSandboxController } from './sandbox.ts'

/** 供加载器诊断使用的 Cordis 插件名。 */
export const name = 'tool-fs'

/** 文件系统工具套件所需的服务。 */
export const inject = ['tools', 'fs', 'systemPrompt', 'workingDirectory']

/** 插件配置（全部可选 —— `Config` 提供默认值）。 */
export interface Config {
  /** 注册 `read` 及其提示。默认为 true。 */
  read?: boolean
  /** 在挂载了附件存储时注册 `read_image`。默认为 true。 */
  readImage?: boolean
  /** 注册 `write` 及其提示。默认为 true。 */
  write?: boolean
  /** 注册 `edit` 及其提示。默认为 true。 */
  edit?: boolean
  /** 单次 `read` 调用返回的默认行数与最大行数。 */
  readLimit?: number
  /** 单行在被截断之前返回的最大字符数。 */
  readMaxLineLength?: number
  /** 单次 `read` 调用对所选行返回的最大字节数。 */
  readMaxBytes?: number
  /** 达到或超过该大小的文件改用流式读取，而不是整体载入内存。 */
  readStreamMinSize?: number
}

export const Config: z<Config> = z.object({
  read: z.boolean().default(true),
  readImage: z.boolean().default(true),
  write: z.boolean().default(true),
  edit: z.boolean().default(true),
  readLimit: z.number().default(READ_LIMIT),
  readMaxLineLength: z.number().default(READ_MAX_LINE_LENGTH),
  readMaxBytes: z.number().default(READ_MAX_BYTES),
  readStreamMinSize: z.number().default(STREAM_MIN_SIZE),
})

/** schemastery 应用默认值之后的配置。 */
type ResolvedConfig = Required<Config>

/** 每个读取上限都以行/字符/字节计 —— 必须是正整数，否则窗口算术会静默出错。 */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`tool-fs: ${name} must be a positive integer`)
  }
}

/** 注册所选的文件系统工具；`read_image` 还额外要求已挂载附件存储。 */
export function apply(ctx: Context, config: Config): void {
  // schemastery（Config）已经填好所有带默认值的字段。
  const resolved = config as ResolvedConfig
  assertPositiveInteger('readLimit', resolved.readLimit)
  assertPositiveInteger('readMaxLineLength', resolved.readMaxLineLength)
  assertPositiveInteger('readMaxBytes', resolved.readMaxBytes)
  assertPositiveInteger('readStreamMinSize', resolved.readStreamMinSize)
  if (resolved.read) {
    applyReadTool(ctx, {
      limit: resolved.readLimit,
      maxLineLength: resolved.readMaxLineLength,
      maxBytes: resolved.readMaxBytes,
      streamMinSize: resolved.readStreamMinSize,
    })
  }
  // read_image 是按组合决定的：没有挂载附件存储时，该部署无法持久保存图片字节，
  // 因此这个工具永不注册；执行体内对直接调用者保留了一次防御性复检。
  if (resolved.readImage) {
    ctx.inject(['attachments'], (imageCtx) => {
      applyReadImageTool(imageCtx)
    })
  }
  // 两个修改类工具共享同一套提级 API：宣示开关、按次调用的策略解析与拒绝标记映射，
  // 全部取决于已挂载的 ctx.fs 是否做隔离（ctx.fs.sandboxMode）。
  if (resolved.write || resolved.edit) {
    const sandbox = new FsSandboxController(ctx)
    if (resolved.write) applyWriteTool(ctx, sandbox)
    if (resolved.edit) applyEditTool(ctx, sandbox)
  }
}
