/**
 * JSON 后端的原子整文件替换。
 *
 * 发布协议：写入同目录的临时文件、对其 fsync，然后用 `rename()` 覆盖目标。Rename 在 POSIX 与
 * Windows 上都是原子替换（libuv 将其映射为 `MoveFileExW(..., MOVEFILE_REPLACE_EXISTING)`），
 * 且替换正是此处期望的语义——与会话日志后端的 link()+unlink() 不覆盖协议不同，一个单元文件每个进程恰好一个写入者，
 * 后写获胜是正确的。rename 之后父目录在 POSIX 上被 fsync，使新条目具备崩溃持久性。
 * @module @deepseek-ai/dsh-storage-json/src/atomic
 */

import { open, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * 持久化地以 `data` 替换 `path`。
 * @param path - 绝对目标文件路径。
 * @param data - 完整的新文件内容。
 * @returns 替换具备崩溃持久性之后的结算。
 */
export async function writeAtomic(path: string, data: string): Promise<void> {
  const tmp = join(dirname(path), `.${randomUUID()}.tmp`)
  try {
    const handle = await open(tmp, 'wx', 0o600)
    try {
      await handle.writeFile(data, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tmp, path)
    await fsyncDirectory(dirname(path))
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}

/** fsync 一个 POSIX 目录，使刚 rename 的条目具备崩溃持久性。 */
/* v8 ignore start -- Windows 拒绝 O_RDONLY 的目录打开；POSIX 覆盖会执行此分支。 */
async function fsyncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}
/* v8 ignore stop */
