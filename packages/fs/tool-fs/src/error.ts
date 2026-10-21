/**
 * 面向模型的、针对受守卫修改失败的诊断信息。提供者与策略保留各自操作相关的原因，
 * 而本包拥有展示给模型的稳定消息。
 * @module @deepseek-ai/dsh-tool-fs/src/error
 */

import { FsError } from '@deepseek-ai/dsh-fs'

/**
 * 为一次受守卫的修改失败渲染稳定的、面向模型的诊断信息。`FS_STALE_VERSION` 保留提供者给出的
 * 原因并追加重新读取的补救建议。`FS_NOT_OBSERVED` 把与具体操作相关的策略/提供者文案替换为
 * 一条带路径的原因与读取补救建议。原始错误仍然作为 cause 保留，两种诊断都保留其错误码以便
 * 机器路由。其他情况原样透传。
 * @param error - 写入/编辑执行中捕获到的值。
 * @param displayPath - 展示给模型的、已解析的目标路径。
 * @returns 对这两种受守卫修改错误码给出补救后的 `FsError`，否则返回原值。
 */
export function remediateFsError(error: unknown, displayPath: string): unknown {
  if (!(error instanceof FsError)) return error
  if (error.code === 'FS_NOT_OBSERVED') {
    return new FsError(
      `cannot modify "${displayPath}": file has not been read — read the file, then retry`,
      error.code,
      { cause: error },
    )
  }
  if (error.code === 'FS_STALE_VERSION') {
    return new FsError(`${error.message} — re-read the file, then retry`, error.code, { cause: error })
  }
  return error
}
