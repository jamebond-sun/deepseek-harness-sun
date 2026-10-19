/** 已加载模块文件的磁盘身份，用于找出加载后文件发生变更的模块。 */
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 受支持文件系统里最粗的文件时间戳分辨率（FAT 以 2 秒为单位存储修改时间）。
 * 在上一次观测之前、处于该间隔内被修改的未记录文件，被视为可能已变更。
 */
const TIMESTAMP_RESOLUTION_MS = 2000

interface FileIdentity {
  /** inode、大小与修改时间。 */
  key: string
  /** 以纪元毫秒表示的修改时间。 */
  modifiedAt: number
}

function identityOf(url: string): FileIdentity | undefined {
  let stats
  try {
    stats = statSync(fileURLToPath(url))
  } catch (_error) {
    // 一个被删除或不可读的文件不再提供已加载的模块。
    return undefined
  }
  return { key: `${String(stats.ino)}:${String(stats.size)}:${String(stats.mtimeMs)}`, modifiedAt: stats.mtimeMs }
}

/**
 * 记录已加载 `file:` 模块的 inode、大小与修改时间。当模块文件消失，或其身份与
 * 所记录的不一致时，该模块即视为过期。不记录变更时间：创建一个指向文件的硬链接
 * （正如 pnpm 从它的存储中导入时那样）会变更它，却不改变内容。一个在上次观测之后
 * 才首次加载的模块没有记录；当它的文件在该观测时间点（减去时间戳分辨率）或之后被
 * 修改时，它视为过期，因此加载与下次比较之间的一次重装会被检测到，代价是重新加载
 * 一个在上述写入之后才首次加载的模块。
 */
export class ModuleFiles {
  /** 每个已记录模块的身份；`undefined` 标记一个过期模块，例如在上次观测之后才首次加载的待定模块。 */
  private records = new Map<string, string | undefined>()
  private observedAt = Date.now()

  /**
   * 操作系统为本地文件写入打上时间戳所用的时钟当前时间，从新建又随即删除的标记文件
   * 读取。系统时钟与文件时间戳可能朝任一方向相差一个时钟节拍，因此模块文件与这个
   * 时间比较；当无法创建标记文件时，使用系统时钟。
   * @returns 纪元毫秒。
   */
  now(): number {
    let directory: string
    try {
      directory = mkdtempSync(join(tmpdir(), 'dsh-hmr-clock-'))
    } catch (_error) {
      // 一个不可写的临时目录退而使用精度较低的系统时钟。
      return Date.now()
    }
    try {
      const marker = join(directory, 'now')
      writeFileSync(marker, '')
      return statSync(marker).mtimeMs
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }

  /**
   * 把已加载的文件模块与磁盘比较。
   * @param urls 要比较的已加载模块对应的 `file:` URL。
   * @returns 过期模块的 URL，以及为每个被比较的 URL 读取到的身份（`undefined` 表示文件缺失）。
   */
  compare(urls: Iterable<string>): { stale: Set<string>; seen: Map<string, string | undefined> } {
    const stale = new Set<string>()
    const seen = new Map<string, string | undefined>()
    for (const url of urls) {
      const identity = identityOf(url)
      seen.set(url, identity?.key)
      if (identity === undefined) {
        stale.add(url)
        continue
      }
      if (this.records.has(url) ? this.records.get(url) !== identity.key
        : identity.modifiedAt >= this.observedAt - TIMESTAMP_RESOLUTION_MS) stale.add(url)
    }
    return { stale, seen }
  }

  /**
   * 用给定已加载模块的身份替换每一条记录。
   * @param urls 要记录的已加载模块对应的 `file:` URL。
   * @param options `seen` 提供此前为模块读取到的身份，这些模块的缓存条目自那以后没有
   * 变化，因此后续写入仍可被检测到；其他模块现在读取，并且当它们的文件在 `at` 之后
   * 被修改时保持过期。`retained` 模块保留自己的记录，或者在它们没有记录时被标记为
   * 过期。`at` 是来自 {@link now} 的观测时间，用于未记录的模块。
   */
  observe(urls: Iterable<string>, options: {
    seen?: ReadonlyMap<string, string | undefined>
    retained?: ReadonlySet<string>
    at?: number
  } = {}): void {
    const { seen = new Map<string, string | undefined>(), retained = new Set<string>(), at = this.now() } = options
    const records = new Map<string, string | undefined>()
    for (const url of urls) {
      if (retained.has(url)) records.set(url, this.records.get(url))
      else if (seen.has(url)) records.set(url, seen.get(url))
      else {
        // 一个自 `at` 以来首次加载的模块，可能在其后的某次写入之前就已经被求值。
        // 与 `at` 处于同一文件时钟节拍内的写入算作更早，因此在比较之前刚安装的
        // 文件不会被重新加载。
        const identity = identityOf(url)
        records.set(url, identity === undefined || identity.modifiedAt > at ? undefined : identity.key)
      }
    }
    this.records = records
    this.observedAt = at
  }

  /**
   * 记录刚刚再次求值的模块当前身份，其余记录保持不变。
   * @param urls 被重新求值的模块对应的 `file:` URL。
   */
  refresh(urls: Iterable<string>): void {
    for (const url of urls) this.records.set(url, identityOf(url)?.key)
  }
}
