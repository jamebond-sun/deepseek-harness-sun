/**
 * 文件工具编辑周围的整文件捕获：一个路径在回合首次变更它之前与回合结束时的内容，
 * 以内容寻址方式保存在 Session 的临时目录下，从而比较的两侧都能
 * 在后续编辑之后保留下来，而无需依赖 git。
 */
import { createHash } from 'node:crypto'
import { mkdir, open, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** git 在将内容视为二进制之前、为其检查 NUL 字节的字节数。 */
const BINARY_PROBE_BYTES = 8000

/** 一个路径被捕获的一侧。 */
export type Capture =
  /** 该路径处没有文件。 */
  | { kind: 'absent' }
  /** 大于配置上限的常规文件；其内容不被保存。 */
  | { kind: 'oversized' }
  /** 一份已保存的副本，以自身字节的 SHA-1 命名。 */
  | { kind: 'file'; file: string; binary: boolean }

/** 一个文件系统错误是否指向缺失的路径。 */
function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}

/**
 * 保存一个路径的当前内容。最多读取 `maxBytes + 1` 个字节，
 * 从而一个在读取期间增长到超过上限的文件，其内存开销不超过上限。
 * @param absolute - 该文件的规范绝对路径。
 * @param directory - 持有内容寻址副本的目录；缺失时创建。
 * @param maxBytes - 已保存副本的含上限字节数。
 * @returns 捕获结果；对既非缺失也非常规文件的路径为 undefined。
 * @throws 当路径因缺失以外的原因无法打开或读取，或副本无法写入时抛出。
 */
export async function captureFile(absolute: string, directory: string, maxBytes: number): Promise<Capture | undefined> {
  let handle
  try {
    handle = await open(absolute, 'r')
  } catch (error: unknown) {
    /* v8 ignore next -- 一个无法打开的 present 文件需要测试无法在每台宿主上撤销的权限。 */
    if (!isMissing(error)) throw error
    return { kind: 'absent' }
  }
  let bytes: Buffer
  try {
    if (!(await handle.stat()).isFile()) return undefined
    const probe = Buffer.allocUnsafe(maxBytes + 1)
    let length = 0
    while (length < probe.length) {
      const { bytesRead } = await handle.read(probe, length, probe.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    if (length > maxBytes) return { kind: 'oversized' }
    bytes = probe.subarray(0, length)
  } finally {
    await handle.close()
  }
  const file = join(directory, createHash('sha1').update(bytes).digest('hex'))
  await mkdir(directory, { recursive: true })
  // 跨路径与回合的相同内容共享同一份副本；`wx` 会原样保留已存在的副本。
  await writeFile(file, bytes, { flag: 'wx' }).catch((error: unknown) => {
    /* v8 ignore next -- 一份无法写入的副本需要测试无法在每台宿主上设为不可写的目录。 */
    if ((error as { code?: unknown }).code !== 'EEXIST') throw error
  })
  return { kind: 'file', file, binary: bytes.subarray(0, BINARY_PROBE_BYTES).includes(0) }
}

/**
 * 两个捕获是否已知持有相同内容。两个缺失侧
 * 视为相同；两个已保存副本在字节哈希一致时视为相同；
 * 超大侧永远无法确认与任何内容匹配，因为其内容
 * 未被读取。
 * @param a - 一侧。
 * @param b - 另一侧。
 * @returns 仅当两侧已知匹配时为真。
 */
export function sameCapture(a: Capture, b: Capture): boolean {
  if (a.kind === 'absent' || b.kind === 'absent') return a.kind === b.kind
  return a.kind === 'file' && b.kind === 'file' && a.file === b.file
}
