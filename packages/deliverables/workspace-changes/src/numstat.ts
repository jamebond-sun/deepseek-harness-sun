/** 解析 `git diff-tree --numstat -z` 的输出。 */

/** 一条 `--numstat` 记录；路径以斜杠分隔，且相对于仓库根目录。 */
export interface NumstatEntry {
  path: string
  /** 检测到重命名之前的路径；对保持原路径的文件则缺失。 */
  oldPath?: string
  added: number
  deleted: number
  binary: boolean
}

/**
 * 解析以 NUL 结尾的 numstat 记录。一条重命名记录携带一个空路径，
 * 其后跟着旧路径与新路径。
 * @param output - `git diff-tree -r -M -z --numstat` 的完整 stdout。
 * @returns 按 git 输出顺序排列的记录。
 * @throws 当记录格式错误时抛出，这意味着输出被截断。
 */
export function parseNumstat(output: string): NumstatEntry[] {
  const queue = output.split('\0')
  if (queue.at(-1) !== '') throw new Error('numstat output is not NUL-terminated')
  queue.pop()
  const entries: NumstatEntry[] = []
  while (queue.length > 0) {
    const record = queue.shift() as string
    // 只有前两个制表符分隔字段；文件名保留它自身的制表符。
    const first = record.indexOf('\t')
    const second = first < 0 ? -1 : record.indexOf('\t', first + 1)
    if (second < 0) throw new Error(`malformed numstat record: ${record}`)
    const added = record.slice(0, first)
    const deleted = record.slice(first + 1, second)
    const path = record.slice(second + 1)
    let target = path
    let oldPath: string | undefined
    if (target === '') {
      oldPath = queue.shift()
      const renamed = queue.shift()
      if (oldPath === undefined || renamed === undefined) throw new Error('malformed numstat rename record')
      target = renamed
    }
    const binary = added === '-'
    entries.push({
      path: target,
      ...oldPath === undefined ? {} : { oldPath },
      added: binary ? 0 : Number(added),
      deleted: binary ? 0 : Number(deleted),
      binary,
    })
  }
  return entries
}
