import { Context } from '@deepseek-ai/cordis'
import type { BuildFailure } from 'esbuild'
import { codeFrameColumns } from '@babel/code-frame'
import { readFileSync } from 'node:fs'

function isBuildFailure(e: unknown): e is BuildFailure {
  return e !== null && typeof e === 'object' && 'errors' in e && Array.isArray(e.errors)
    && e.errors.every((error: unknown) => error !== null && typeof error === 'object'
      && 'text' in error && typeof error.text === 'string')
}

/** 在源码位置可用时，附带代码框记录 HMR 构建失败。
 * @param ctx 拥有重新加载诊断信息的上下文。
 * @param e 来自模块加载器或编译器的失败。
 */
export function handleError(ctx: Context, e: unknown): void {
  if (!isBuildFailure(e)) {
    ctx.logger.warn(e)
    return
  }

  for (const error of e.errors) {
    if (!error.location) {
      ctx.logger.warn(error.text)
      continue
    }
    try {
      const { file, line, column } = error.location
      const source = readFileSync(file, 'utf8')
      const formatted = codeFrameColumns(source, {
        start: { line, column },
      }, {
        highlightCode: true,
        message: error.text,
      })
      ctx.logger.warn(`File: ${file}:${line}:${column}\n` + formatted)
    } catch (e) {
      ctx.logger.warn(e)
    }
  }
}
