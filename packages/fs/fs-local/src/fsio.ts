/**
 * 不依赖 Cordis 的本地文件系统机制。该提供者层返回已校验的 UTF-8 文本、流式读取大文件并
 * 拒绝二进制数据；行窗口属于 `dsh-tool-fs` 的职责。写入时在一个私有的同级目录中暂存一个
 * 排他的仅属主文件，再原子地发布它。
 * @module @deepseek-ai/dsh-fs-local/fsio
 */

import { randomUUID } from 'node:crypto'
import { createReadStream, realpath as realpathCallback } from 'node:fs'
import { chmod, link, lstat, mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import type { BigIntStats, Dirent, Stats } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { TextDecoder, promisify } from 'node:util'
import { FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import { copyFileDaclWin32, replaceFileWin32 } from './win32.ts'

const BINARY_SAMPLE_BYTES = 8192
const realpath = promisify(realpathCallback.native)
// 为一次不可中断的 FileHandle.read 设界，使取消能在分块之间被观察到。
const DIFF_BASIS_READ_CHUNK_BYTES = 64 * 1024

function isENOENT(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function isEEXIST(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}

/**
 * 某个本应是目录的路径分量实际上是常规文件（例如当 `afile` 是文件时去解析
 * `afile/child.txt`）。与 `ENOENT` 一样，目标不可能存在 —— 因此解析/探测路径把它当作
 * "不存在"，而不是让一个原始的 Node 错误绕过结构化的 `FsError` 分类体系逃逸出去。
 */
function isENOTDIR(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOTDIR'
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/* v8 ignore start -- 用于组合二级清理失败消息，需要在主失败之后再发生一次文件系统/内核故障。 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
/* v8 ignore stop */

function isPermissionError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'EACCES' || error.code === 'EPERM')
}

function throwIfAborted(signal: AbortSignal | undefined, verb: string): void {
  if (signal?.aborted) throw new FsError(`${verb} aborted`, 'FS_ABORTED')
}

/**
 * 带 signal 的 `readFile`，把读取中途的 `AbortError` 翻译成该接缝结构化的
 * `FsError('FS_ABORTED')`（Node 会以裸 `AbortError` reject 被中断的 `readFile`，
 * 否则就会逃出接缝的错误分类体系 —— 流式读取/写入路径也做同样的翻译）。
 */
async function readFileAbortable(absolutePath: string, verb: 'read' | 'edit', signal?: AbortSignal): Promise<Buffer> {
  try {
    return await readFile(absolutePath, signal ? { signal } : {})
  } catch (error: unknown) {
    /* v8 ignore next 2 -- 非中断导致的 readFile 失败需要一个与已打开文件竞态的权限/IO 故障。 */
    if (!isAbortError(error)) throw error
    throw new FsError(`${verb} aborted`, 'FS_ABORTED')
  }
}

/** 由高分辨率的同一性与新鲜度元数据派生出的不透明版本令牌。 */
function versionOf(info: BigIntStats): FsVersion {
  return FsVersion(`${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`)
}

/**
 * 测试钩子：让测试钉住原子写入的临时名称（以便在无命名竞态的情况下证明排他打开行为）、
 * 覆写原生边界，并在发布之前观察已暂存的临时文件。
 */
export interface FsIoInternals {
  /** 覆写宿主平台，用于原生发布路径的单元测试覆盖。 */
  platform?: NodeJS.Platform
  /** 覆写生成的私有暂存目录名（相对目标目录）。 */
  tempDirName?: (writePath: string) => string
  /** 覆写生成的临时文件名（相对私有暂存目录）。 */
  tempName?: (writePath: string) => string
  /** 覆写 Win32 DACL 复制边界。 */
  copyFileDacl?: (source: string, destination: string) => Promise<void>
  /** 覆写保留安全描述符的 Win32 替换边界。 */
  replaceFile?: (replaced: string, replacement: string) => Promise<void>
  /** 覆写硬链接的不可替换发布边界。 */
  linkFile?: (existingPath: string, newPath: string) => Promise<void>
  /** 覆写受守卫发布失败之后的目标检查。 */
  inspectPublicationTarget?: (path: string) => Promise<BigIntStats>
  /** 覆写暂存目录的移除，用于提交点失败的覆盖。 */
  removeStagingDir?: (stagingDir: string) => Promise<void>
  /** 临时文件写入/同步之后、最终 chmod 与发布之前的测试钩子。 */
  inspectTemp?: (paths: { stagingDir: string; tempPath: string }) => void | Promise<void>
  /** 原始读取的 stat 预检之后、受限内容 IO 之前的测试钩子。 */
  inspectReadBytesAfterStat?: (target: LocalTarget) => void | Promise<void>
}

/** 已解析的本地路径：展示给调用方的绝对路径及其 realpath 同一性标识。 */
export interface LocalTarget {
  /** 绝对路径（未解析符号链接）—— 用于展示。 */
  displayPath: string
  /** Realpath 同一性 —— 用作稳定的目标键与 IO 路径。 */
  targetKey: FsTargetKey
}

/** 路径探测的结果：路径不存在时为 null。 */
export interface PathInfo {
  version: FsVersion
  mode: number
  type: 'file' | 'directory' | 'other'
  size: number
}

/** 不跟随最后一个符号链接分量的路径探测结果。 */
export interface PathLinkInfo {
  version: FsVersion
  mode: number
  type: 'file' | 'directory' | 'symlink' | 'other'
  size: number
}

/** 一个本地目录子项，带有已解析的目标与廉价的元数据。 */
export interface LocalDirEntry {
  name: string
  type: 'file' | 'directory' | 'other'
  target: LocalTarget
  version?: FsVersion
  size?: number
}

/**
 * 依据原生驱动器语义与 POSIX 物理父目录遍历来锚定一个路径。
 * @param cwd - 相对路径所用的提供者基准目录。
 * @param path - 非空的请求路径。
 * @returns 目标解析与不跟随元数据共用的绝对展示拼写。
 */
export function localDisplayPath(cwd: string, path: string): string {
  const absoluteCwd = isAbsolute(cwd) ? cwd : `${process.cwd()}${sep}${cwd}`
  const raw = isAbsolute(path) ? path : `${absoluteCwd}${sep}${path}`
  const physicalSpelling = /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(raw) ? raw : resolve(cwd, path)
  /* v8 ignore next -- 原生 Windows 测试覆盖 DOS 驱动器相对路径解析；POSIX 保留物理遍历。 */
  return process.platform === 'win32' ? resolve(cwd, path) : physicalSpelling
}

/**
 * 把一个路径解析为它的绝对展示路径与 realpath 同一性。对于缺失的目标，先对最近的已存在
 * 祖先做 realpath，再拼接缺失的后缀，从而在符号链接祖先中保持创建前后的同一性。
 * @param cwd - 相对 `path` 解析所依据的基准目录。
 * @param path - 绝对路径或相对路径；空串/纯空白会抛出 `FS_NOT_FOUND`。
 * @returns 绝对展示路径加上由 realpath 派生的稳定目标键。
 */
export async function resolveLocalTarget(cwd: string, path: string): Promise<LocalTarget> {
  if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
  const displayPath = localDisplayPath(cwd, path)
  try {
    // 优先使用文件自身的 realpath（把符号链接文件解析到它指向的目标）。
    return { displayPath, targetKey: FsTargetKey(await realpath(displayPath)) }
  } catch (error: unknown) {
    // 某个路径分量是文件而不是目录（例如 "afile/child.txt" 中 "afile" 是常规文件）：
    // 目标既不可能存在也无法被创建，因此上报结构化分类体系，而不是原始的 Node ENOTDIR。
    /* v8 ignore next -- Windows 把这种情况报成 ENOENT，并在下面的祖先回溯中修复。 */
    if (isENOTDIR(error)) throw new FsError(`cannot resolve "${displayPath}": a parent path segment is not a directory`, 'FS_NOT_FOUND')
    /* v8 ignore next -- 非 ENOENT 的 realpath 失败需要权限/IO 故障；ENOENT 会走到祖先解析逻辑。 */
    if (!isENOENT(error)) throw error
  }
  // 文件不存在：对最近的已存在祖先做 realpath，再拼回缺失的后缀（文件基名加上任何
  // 尚未创建的中间目录），使键在这些目录被创建之后仍保持稳定。
  const missing = [basename(displayPath)]
  let ancestor = dirname(displayPath)
  while (true) {
    try {
      const realAncestor = await realpath(ancestor)
      /* v8 ignore next -- POSIX 拒绝这种遍历；Windows 在文件系统查找之前会规范化父目录分量。 */
      if (missing.includes('..')) throw new FsError(`cannot resolve "${displayPath}": parent traversal crosses a missing directory`, 'FS_NOT_FOUND')
      // 在 Windows 上，对常规文件做 realpath 在 POSIX 返回 ENOTDIR 的场景下会成功
      // （该操作系统对 `regular-file/child` 报的是 ENOENT 而不是 ENOTDIR）。
      // 对祖先做一次 stat 以恢复语义区分：非目录的祖先意味着目标要穿过一个文件，
      // 因而永远不可能被创建。
      /* v8 ignore start -- 原生 Windows 覆盖会走到这段修复；POSIX 在此之前就报了 ENOTDIR。 */
      if (process.platform === 'win32') {
        const parentInfo = await stat(realAncestor)
        if (!parentInfo.isDirectory()) {
          throw new FsError(`cannot resolve "${displayPath}": a parent path segment is not a directory`, 'FS_NOT_FOUND')
        }
      }
      /* v8 ignore stop */
      return { displayPath, targetKey: FsTargetKey(join(realAncestor, ...missing)) }
    } catch (error: unknown) {
      /* v8 ignore next -- 原生 Windows 覆盖会走到上面修复逻辑抛出的 FsError。 */
      if (error instanceof FsError) throw error
      /* v8 ignore next -- 非 ENOENT 的 realpath 失败需要权限/IO 故障。 */
      if (!isENOENT(error)) throw error
      const parent = dirname(ancestor)
      /* v8 ignore next -- 文件系统根目录总能被 realpath，因此回溯会在 parent === ancestor 之前终止。 */
      if (parent === ancestor) return { displayPath, targetKey: FsTargetKey(displayPath) }
      missing.unshift(basename(ancestor))
      ancestor = parent
    }
  }
}

function pathType(info: Stats | BigIntStats): PathInfo['type'] {
  if (info.isFile()) return 'file'
  /* v8 ignore else -- Windows 没有针对非目录分支的特殊条目测试夹具。 */
  if (info.isDirectory()) return 'directory'
  /* v8 ignore next -- 对应的特殊条目返回值在 POSIX 上被测到。 */
  return 'other'
}

function pathLinkType(info: Stats | BigIntStats): PathLinkInfo['type'] {
  if (info.isSymbolicLink()) return 'symlink'
  return pathType(info)
}

async function probeStats<T extends Stats | BigIntStats>(
  absolutePath: string,
  readStats: (path: string) => Promise<T>,
): Promise<T | null> {
  try {
    return await readStats(absolutePath)
  } catch (error: unknown) {
    // ENOENT（无此文件）与 ENOTDIR（某个父分量是文件）都意味着目标不存在；
    // 任何其他元数据失败都是真实的权限/IO 故障。
    /* v8 ignore next -- 非 ENOENT/ENOTDIR 的元数据失败需要权限/IO 故障；直接抛出去。 */
    if (!isENOENT(error) && !isENOTDIR(error)) throw error
    return null
  }
}

/**
 * 探测路径的版本、模式、类型与大小。不存在时为 null。
 * @param absolutePath - 待 stat 的路径（通常是目标键；符号链接会被跟随）。
 * @returns 元数据；当该路径 —— 或某个父分量 —— 不存在时为 null。
 */
export async function probe(absolutePath: string): Promise<PathInfo | null> {
  const info = await probeStats(absolutePath, path => stat(path, { bigint: true }))
  if (!info) return null
  return {
    version: versionOf(info),
    mode: Number(info.mode & 0o777n),
    type: pathType(info),
    size: Number(info.size),
  }
}

/**
 * 在不跟随最后一个符号链接分量的前提下探测路径。
 * @param absolutePath - 以 `lstat` 语义检查的路径条目。
 * @returns 路径条目的元数据；条目不存在时为 null。
 */
export async function probeNoFollow(absolutePath: string): Promise<PathLinkInfo | null> {
  const info = await probeStats(absolutePath, path => lstat(path, { bigint: true }))
  if (!info) return null
  return {
    version: versionOf(info),
    mode: Number(info.mode & 0o777n),
    type: pathLinkType(info),
    size: Number(info.size),
  }
}

// --- 目录列举 ---

function listingIoError(displayPath: string, error: unknown): FsError {
  /* v8 ignore next -- 防御性透传：子条目解析器已经产出结构化 FsError 时的竞态分支。 */
  if (error instanceof FsError) return error
  /* v8 ignore next -- 需要被列举的目标/父目录在成功的预检与列举/子条目解析之间消失。 */
  if (isENOENT(error) || isENOTDIR(error)) return new FsError(`cannot list "${displayPath}": not found`, 'FS_NOT_FOUND', { cause: error })
  /* v8 ignore next -- Windows 的 chmod 不会拒绝目录列举；POSIX 覆盖了权限翻译。 */
  if (isPermissionError(error)) return new FsError(`cannot list "${displayPath}": permission denied`, 'FS_PERMISSION_DENIED', { cause: error })
  return new FsError(`cannot list "${displayPath}": ${errorMessage(error)}`, 'FS_IO_ERROR', { cause: error })
}

async function resolveListedChildTarget(parent: LocalTarget, name: string): Promise<LocalTarget> {
  const identity = await resolveLocalTarget(parent.targetKey, name)
  return { displayPath: localDisplayPath(parent.displayPath, name), targetKey: identity.targetKey }
}

/**
 * 以稳定的名称顺序列出目录的直接子项。每个子项包含已解析的目标以及在仍然可用时的 stat
 * 元数据；绝不读取文件内容。
 * @param target - 待列举的已解析目录；目标缺失或不是目录时抛出错误。
 * @param signal - 中断列举，在子项之间检查（`FS_ABORTED`）。
 * @returns 每个直接子项一个条目，按名称排序。
 */
export async function listDirectory(target: LocalTarget, signal?: AbortSignal): Promise<LocalDirEntry[]> {
  throwIfAborted(signal, 'list')
  let info: PathInfo | null
  try {
    info = await probe(target.targetKey)
  } catch (error: unknown) {
    throw listingIoError(target.displayPath, error)
  }
  if (!info) throw new FsError(`cannot list "${target.displayPath}": not found`, 'FS_NOT_FOUND')
  if (info.type !== 'directory') throw new FsError(`cannot list "${target.displayPath}": not a directory`, 'FS_NOT_DIRECTORY')

  let entries: Dirent[]
  try {
    entries = await readdir(target.targetKey, { withFileTypes: true, encoding: 'utf8' })
  } catch (error: unknown) {
    /* v8 ignore next -- 需要 readdir 在成功的目录 stat 之后发生权限/内核故障。 */
    throw listingIoError(target.displayPath, error)
  }
  throwIfAborted(signal, 'list')

  const result: LocalDirEntry[] = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    throwIfAborted(signal, 'list')
    try {
      const childTarget = await resolveListedChildTarget(target, entry.name)
      const childInfo = await probe(childTarget.targetKey)
      result.push({
        name: entry.name,
        type: childInfo?.type ?? 'other',
        target: childTarget,
        ...(childInfo ? { version: childInfo.version } : {}),
        ...(childInfo?.type === 'file' ? { size: childInfo.size } : {}),
      })
    } catch (error: unknown) {
      throw listingIoError(localDisplayPath(target.displayPath, entry.name), error)
    }
    throwIfAborted(signal, 'list')
  }
  return result
}

// --- 读取 ---

function notTextError(verb: 'read' | 'edit', displayPath: string): FsError {
  return new FsError(`cannot ${verb} "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT')
}

function decodeUtf8(buffer: Uint8Array, verb: 'read' | 'edit', displayPath: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch (error: unknown) {
    /* v8 ignore next 2 -- TextDecoder({fatal}) 只在遇到非法字节时抛 TypeError；其他抛出都是不可达的运行时故障。 */
    if (!(error instanceof TypeError)) throw error
    throw notTextError(verb, displayPath)
  }
}

function decodeUtf8Stream(
  decoder: TextDecoder,
  chunk: Uint8Array | undefined,
  verb: 'read' | 'edit',
  displayPath: string,
): string {
  try {
    return chunk ? decoder.decode(chunk, { stream: true }) : decoder.decode()
  } catch (error: unknown) {
    /* v8 ignore next 2 -- TextDecoder({fatal}) 只在遇到非法字节时抛 TypeError；其他抛出都是不可达的运行时故障。 */
    if (!(error instanceof TypeError)) throw error
    throw notTextError(verb, displayPath)
  }
}

async function statRegularFile(target: LocalTarget, verb: 'read', signal?: AbortSignal): Promise<Stats> {
  throwIfAborted(signal, verb)
  let info: Stats
  try {
    info = await stat(target.targetKey)
  } catch (error: unknown) {
    /* v8 ignore next 2 -- 非 ENOENT 的 stat 失败需要权限/IO 故障；测试中只能到达"未找到"这条路径。 */
    if (!isENOENT(error)) throw error
    throw new FsError(`cannot ${verb} "${target.displayPath}": not found`, 'FS_NOT_FOUND')
  }
  if (!info.isFile()) throw new FsError(`cannot ${verb} "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
  return info
}

/**
 * 把整个常规 UTF-8 文本文件读成一个已解码的字符串。拒绝非常规文件、非法 UTF-8
 * 以及含 NUL 字节的二进制样本。
 * @param target - 待读取的已解析文件。
 * @param signal - 中断读取（`FS_ABORTED`）。
 * @returns 完整解码后的文本，逐字节保持原样（不做规范化）。
 */
export async function readWholeText(target: LocalTarget, signal?: AbortSignal): Promise<string> {
  await statRegularFile(target, 'read', signal)
  const raw = await readFileAbortable(target.targetKey, 'read', signal)
  throwIfAborted(signal, 'read')
  if (raw.subarray(0, BINARY_SAMPLE_BYTES).includes(0)) {
    throw new FsError(`cannot read "${target.displayPath}": binary file`, 'FS_NOT_TEXT')
  }
  return decodeUtf8(raw, 'read', target.displayPath)
}

/**
 * 把整个常规文件读成原始字节，不做任何解码与二进制拒绝。`maxBytes` 限制的是完整内容：
 * stat 出来的大小会在任何内容 IO 之前短路掉过大的文件，而流最多再读一个字节超过上限，
 * 从而让 stat 之后增长的文件无法造成无界缓冲。
 * @param target - 待读取的已解析文件。
 * @param signal - 中断读取（`FS_ABORTED`）。
 * @param maxBytes - 对完整内容的字节上限，含边界值（`FS_TOO_LARGE`）。
 * @param internals - 用于确定性地制造 stat 之后增长竞态的测试接缝。
 * @returns 完整的原始内容，长度至多为 `maxBytes`。
 */
export async function readWholeBytes(
  target: LocalTarget,
  signal: AbortSignal | undefined,
  maxBytes: number,
  internals: FsIoInternals = {},
): Promise<Uint8Array> {
  const info = await statRegularFile(target, 'read', signal)
  if (info.size > maxBytes) {
    throw new FsError(`cannot read "${target.displayPath}": ${info.size} bytes exceeds the ${maxBytes}-byte limit`, 'FS_TOO_LARGE')
  }
  await internals.inspectReadBytesAfterStat?.(target)
  const stream = createReadStream(target.targetKey, {
    end: maxBytes,
    ...signal ? { signal } : {},
  })
  const chunks: Buffer[] = []
  let bytes = 0
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      bytes += chunk.length
      if (bytes > maxBytes) {
        throw new FsError(`cannot read "${target.displayPath}": content exceeds the ${maxBytes}-byte limit`, 'FS_TOO_LARGE')
      }
      chunks.push(chunk)
    }
  } catch (error: unknown) {
    /* v8 ignore next 2 -- 流中途中断需要取消与活跃读取竞态；预先中断是确定性的。 */
    if (isAbortError(error)) throw new FsError('read aborted', 'FS_ABORTED')
    throw error
  }
  return Buffer.concat(chunks, bytes)
}

/**
 * 读取常规文件 `[offset, offset + length)` 处的字节，不做任何解码与二进制拒绝。
 * 界限就是窗口：流从 `offset` 打开并在读取 `length` 字节后关闭，因此无论文件多大，
 * 缓冲的永远不超过窗口大小；窗口位于或超过文件末尾时结果为空。
 * @param target - 待读取的已解析文件。
 * @param range - `offset` 为 0 基的首字节位置，`length` 为最大字节数。
 * @param signal - 中断读取（`FS_ABORTED`）。
 * @returns 窗口内的字节，长度至多为 `length`。
 */
export async function readByteWindow(
  target: LocalTarget,
  range: { offset: number; length: number },
  signal?: AbortSignal,
): Promise<Uint8Array> {
  await statRegularFile(target, 'read', signal)
  if (range.length === 0) return new Uint8Array(0)
  const stream = createReadStream(target.targetKey, {
    start: range.offset,
    end: range.offset + range.length - 1,
    ...signal ? { signal } : {},
  })
  const chunks: Buffer[] = []
  let bytes = 0
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      chunks.push(chunk)
      bytes += chunk.length
    }
  } catch (error: unknown) {
    /* v8 ignore next 2 -- 流中途中断需要取消与活跃读取竞态；预先中断是确定性的。 */
    if (isAbortError(error)) throw new FsError('read aborted', 'FS_ABORTED')
    /* v8 ignore next -- 任何其他流失败都需要一次成功 stat 之后的 IO 故障。 */
    throw error
  }
  return Buffer.concat(chunks, bytes)
}

/**
 * 以已解码的文本分块流式读取整个常规 UTF-8 文本文件。文本语义与 {@link readWholeText}
 * 相同（常规文件检查、二进制/NUL 拒绝、跨分块 UTF-8 解码），但从不把整个文件留在内存里。
 * @param target - 待流式读取的已解析文件。
 * @param signal - 中断流读取，包括分块之间的中断（`FS_ABORTED`）。
 * @returns 按文件顺序的已解码文本分块；分块边界不携带任何含义。
 */
export async function* streamWholeText(target: LocalTarget, signal?: AbortSignal): AsyncIterable<string> {
  await statRegularFile(target, 'read', signal)
  const stream = createReadStream(target.targetKey, signal ? { signal } : {})
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let sampledBytes = 0

  function scanBinarySample(chunk: Buffer): void {
    if (sampledBytes >= BINARY_SAMPLE_BYTES) return
    const sample = chunk.subarray(0, Math.min(chunk.length, BINARY_SAMPLE_BYTES - sampledBytes))
    if (sample.includes(0)) {
      throw new FsError(`cannot read "${target.displayPath}": binary file`, 'FS_NOT_TEXT')
    }
    sampledBytes += sample.length
  }

  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      scanBinarySample(chunk)
      yield decodeUtf8Stream(decoder, chunk, 'read', target.displayPath)
    }
    yield decodeUtf8Stream(decoder, undefined, 'read', target.displayPath)
  } catch (error: unknown) {
    /* v8 ignore next 4 -- 流中途的错误需要与循环竞态的中断/IO 故障；预先中断由 throwIfAborted 捕获。 */
    if (isAbortError(error)) throw new FsError('read aborted', 'FS_ABORTED')
    throw error
  }
}

// --- 写入 ---

async function removeStagingDirOrThrow(
  stagingDir: string,
  originalError: unknown,
  removeStagingDir: (path: string) => Promise<void>,
): Promise<never> {
  try {
    await removeStagingDir(stagingDir)
  } catch (cleanupError: unknown) {
    /* v8 ignore next 1 -- 这里的清理失败需要在主写入失败之后再来一次文件系统故障。 */
    throw new FsError(`write failed (${errorMessage(originalError)}) and temp cleanup failed (${errorMessage(cleanupError)})`, 'FS_NOT_FOUND', { cause: originalError })
  }
  throw originalError
}

async function throwGuardedCreateFailure(
  error: unknown,
  absolutePath: string,
  displayPath: string,
  inspectPublicationTarget: (path: string) => Promise<BigIntStats>,
): Promise<never> {
  let existing: BigIntStats | undefined
  try {
    existing = await inspectPublicationTarget(absolutePath)
  } catch (metadataError: unknown) {
    if (!isENOENT(metadataError) && !isENOTDIR(metadataError)) {
      throw new FsError(`cannot write "${displayPath}": ${errorMessage(metadataError)}`, 'FS_IO_ERROR', { cause: metadataError })
    }
  }

  // 链接的 errno 取值随平台与文件系统而异。在失败之后检查目标条目，
  // 以免把冲突误判成缺少硬链接支持。
  if (existing !== undefined) {
    if (!existing.isFile()) {
      throw new FsError(`cannot write "${displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE', { cause: error })
    }
    throw new FsError(
      `cannot overwrite existing "${displayPath}" without reading it first`,
      'FS_NOT_OBSERVED',
      { cause: error },
    )
  }
  if (isEEXIST(error)) {
    throw new FsError(
      `cannot overwrite existing "${displayPath}" without reading it first`,
      'FS_NOT_OBSERVED',
      { cause: error },
    )
  }
  throw new FsError(`cannot write "${displayPath}": ${errorMessage(error)}`, 'FS_IO_ERROR', { cause: error })
}

/**
 * 通过同一目录下私有的、已同步的暂存文件原子地替换一个文件。POSIX 用 `0o700` 与 `0o600`
 * 保护暂存目录与暂存文件。Windows 上的新文件继承目标目录的 DACL；替换则会先在写入之前
 * 把已有目标的 DACL 复制到空的临时文件上，并在发布时保留目标描述符。
 * @param absolutePath - 目标路径；缺失的父目录会被创建。
 * @param content - 待写入的完整 UTF-8 文本。
 * @param mode - 已有目标的 POSIX 模式，用于保留；新文件为 `undefined`；在 Windows 上
 * 作为模式不起作用，但标识了替换的安全语义。
 * @param signal - 在最终发布之前检查的取消信号。
 * @param internals - 用于钉住临时名称与观察暂存文件的测试钩子。
 * @param createIfAbsent - 给定该参数时使用硬链接的不可替换原语发布；并发创建者的文件会被
 * 保留，本次写入则用所提供的展示路径以 `FS_NOT_OBSERVED` 被拒绝。
 */
export async function writeFileAtomic(
  absolutePath: string,
  content: string,
  mode: number | undefined,
  signal: AbortSignal | undefined,
  internals: FsIoInternals = {},
  createIfAbsent?: { displayPath: string },
): Promise<void> {
  throwIfAborted(signal, 'write')
  const directory = dirname(absolutePath)
  await mkdir(directory, { recursive: true })

  throwIfAborted(signal, 'write')
  const stagingDirName = internals.tempDirName?.(absolutePath) ?? `.${basename(absolutePath)}.${process.pid}.${randomUUID()}.tmpdir`
  const stagingDir = join(directory, stagingDirName)
  const tempName = internals.tempName?.(absolutePath) ?? `${basename(absolutePath)}.tmp`
  const tempPath = join(stagingDir, tempName)
  const platform = internals.platform ?? process.platform
  const copyFileDacl = internals.copyFileDacl ?? copyFileDaclWin32
  const replaceFile = internals.replaceFile ?? replaceFileWin32
  const linkFile = internals.linkFile ?? link
  const inspectPublicationTarget = internals.inspectPublicationTarget
    ?? (path => lstat(path, { bigint: true }))
  const removeStagingDir = internals.removeStagingDir
    ?? (path => rm(path, { recursive: true, force: true }))
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let stagingCreated = false
  try {
    await mkdir(stagingDir, { mode: 0o700 })
    stagingCreated = true
    await chmod(stagingDir, 0o700)

    handle = await open(tempPath, 'wx', 0o600)
    await handle.chmod(0o600)
    if (platform === 'win32' && mode !== undefined) {
      await copyFileDacl(absolutePath, tempPath)
    }
    await handle.writeFile(content, { encoding: 'utf8', ...signal ? { signal } : {} })
    await handle.sync()
    await internals.inspectTemp?.({ stagingDir, tempPath })
    if (mode !== undefined) await handle.chmod(mode)
    await handle.close()
    handle = undefined

    throwIfAborted(signal, 'write')
    if (createIfAbsent !== undefined) {
      try {
        await linkFile(tempPath, absolutePath)
      } catch (error: unknown) {
        await throwGuardedCreateFailure(error, absolutePath, createIfAbsent.displayPath, inspectPublicationTarget)
      }
    } else if (platform === 'win32' && mode !== undefined) {
      try {
        await replaceFile(absolutePath, tempPath)
      } catch (error: unknown) {
        // 如果被观测到的目标在暂存期间消失，已经复制到临时文件上的受保护 DACL
        // 在重建时依然是权威依据。
        if (!isENOENT(error)) throw error
        await rename(tempPath, absolutePath)
      }
    } else {
      await rename(tempPath, absolutePath)
    }
    try {
      await removeStagingDir(stagingDir)
    } catch (_committedStagingCleanupFailure) {
      // 目标已提交；仅属主的暂存残留不能把这次写入变成失败。
    }
  } catch (error: unknown) {
    /* v8 ignore next -- 写入中途中断需要 writeFile 与 signal 竞态；非中断（rename/open）一侧已被测到。 */
    let failure: unknown = isAbortError(error) ? new FsError('write aborted', 'FS_ABORTED') : error
    /* v8 ignore next 8 -- 仅在 writeFile/sync 于句柄打开期间抛出时到达（IO 故障）；关闭失败属于双重故障。 */
    if (handle) {
      try {
        await handle.close()
      } catch (closeError: unknown) {
        failure = new FsError(`write failed (${errorMessage(failure)}) and temp close failed (${errorMessage(closeError)})`, 'FS_NOT_FOUND', { cause: failure })
      }
    }
    if (!stagingCreated) throw failure
    return removeStagingDirOrThrow(stagingDir, failure, removeStagingDir)
  }
}

// --- 编辑 ---

/** 在 LF 规范化之前检测到的行尾风格。 */
export type LineEndings = 'LF' | 'CRLF'

/**
 * 把 CRLF 折叠为 LF —— 每次编辑/diff 基线所用的规范内存形式。孤立的 `\r`
 * （后面不跟 `\n`）保持原样。
 * @param content - 以文件原有行尾风格解码出的文本。
 * @returns 所有 `\r\n` 对都被替换为 `\n` 的文本。
 */
function normalizeLineEndings(content: string): string {
  return content.replaceAll('\r\n', '\n')
}

function detectLineEndings(raw: string): LineEndings {
  const sample = raw.slice(0, 4096)
  const crlfCount = sample.split('\r\n').length - 1
  const lfCount = sample.split('\n').length - 1 - crlfCount
  return crlfCount > lfCount ? 'CRLF' : 'LF'
}

/**
 * 把 LF 规范化的内容还原成读取时检测到的行尾风格，用于写回。`LF` 原样返回内容；
 * `CRLF` 先再做一次规范化，以免已经是 CRLF 的序列被重复成 `\r\r\n`。
 * @param content - LF 规范化（已编辑）的文本。
 * @param lineEndings - 原文件的风格，由 {@link readForEdit} 检测得出。
 * @returns 以原文件行尾风格表示的文本。
 */
function restoreLineEndings(content: string, lineEndings: LineEndings): string {
  return lineEndings === 'LF' ? content : normalizeLineEndings(content).split('\n').join('\r\n')
}

function countOccurrences(content: string, needle: string): number {
  let count = 0
  let index = 0
  while (true) {
    const found = content.indexOf(needle, index)
    if (found === -1) return count
    count += 1
    index = found + needle.length
  }
}

/**
 * 读取并解码待编辑的文件：拒绝二进制文件，返回 LF 规范化的内容以及用于写回的原有行尾风格。
 * @param absolutePath - 待读取的文件（通常是目标键）。
 * @param displayPath - 面向调用方、用于错误消息的路径。
 * @param signal - 中断读取（`FS_ABORTED`）。
 * @returns LF 规范化的内容以及检测到、待写回时还原的风格。
 */
export async function readForEdit(
  absolutePath: string,
  displayPath: string,
  signal?: AbortSignal,
): Promise<{ content: string; lineEndings: LineEndings }> {
  throwIfAborted(signal, 'edit')
  const buffer = await readFileAbortable(absolutePath, 'edit', signal)
  throwIfAborted(signal, 'edit')
  if (buffer.includes(0)) throw new FsError(`cannot edit "${displayPath}": binary file`, 'FS_NOT_TEXT')
  const raw = decodeUtf8(buffer, 'edit', displayPath)
  return { content: normalizeLineEndings(raw), lineEndings: detectLineEndings(raw) }
}

/**
 * 尽力而为的覆盖 diff 基线。当文件是二进制、非法 UTF-8、达到或超过字节上限，或者在调用方
 * 预检之后被删除/变得不可读时返回 `null`，这样写入仍能成功，展示层则回退到整文件 diff。
 * 该限制是在已打开的描述符上强制执行的，而不是依赖此前的路径 stat，因此并发的外部替换或
 * 大小变化都无法让这个辅助函数缓冲超过 `maxBytes` 的内容。
 * @param absolutePath - 待读取的文件（通常是目标键）。
 * @param maxBytes - 作为上下文 diff 基线所持有字节数的排他上界。
 * @param signal - 中断读取（`FS_ABORTED`）；与 IO 失败不同，取消会向上传播。
 * @returns LF 规范化的文本；对非常规文件、达到/超过上限的文件、二进制、非 UTF-8、
 * 描述符大小发生变化或不可读的文件返回 null。
 */
export async function readTextForDiff(
  absolutePath: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string | null> {
  throwIfAborted(signal, 'read')
  try {
    const handle = await open(absolutePath, 'r')
    let buffer: Buffer
    let total = 0
    let openedSize = 0
    try {
      throwIfAborted(signal, 'read')
      const info = await handle.stat()
      throwIfAborted(signal, 'read')
      if (!info.isFile()) return null
      if (info.size >= maxBytes) return null
      openedSize = info.size
      // 多分配一个字节即可检测到 stat 之后的增长，而不必保留每次读取的后备缓冲区。
      buffer = Buffer.allocUnsafe(openedSize + 1)
      while (total < buffer.length) {
        throwIfAborted(signal, 'read')
        const length = Math.min(buffer.length - total, DIFF_BASIS_READ_CHUNK_BYTES)
        const { bytesRead } = await handle.read(buffer, total, length, null)
        if (bytesRead === 0) break
        total += bytesRead
      }
    } finally {
      await handle.close()
    }
    throwIfAborted(signal, 'read')
    if (total !== openedSize) return null
    const basis = buffer.subarray(0, total)
    if (basis.includes(0)) return null
    try {
      return normalizeLineEndings(new TextDecoder('utf-8', { fatal: true }).decode(basis))
    } catch (error: unknown) {
      /* v8 ignore next 2 -- TextDecoder({fatal}) 只在遇到非法字节时抛 TypeError；
       * 其他抛出都是不可达的运行时故障。 */
      if (!(error instanceof TypeError)) throw error
      return null
    }
  } catch (error: unknown) {
    // 取消是调用方的意图，仍然向上传播。
    if (error instanceof FsError) throw error
    // 描述符阶段的 errno —— 在调用方预检之后被删除或变得不可读，或者读取发生故障 ——
    // 只会损失这份可选的基线：一次已提交的写入不应因为仅用于展示的预读而失败。
    if (error instanceof Error && 'code' in error) return null
    throw error
  }
}

/**
 * 对 LF 规范化的内容执行一次字面量替换。空的或搜不到的查找文本抛出 `FS_EDIT_NOT_FOUND`；
 * 多处命中抛出 `FS_AMBIGUOUS_EDIT`，除非 `replaceAll` 为 true。
 * @param content - 当前文件内容，已完成 LF 规范化。
 * @param oldString - 待查找的字面量文本；其中包含的 CRLF 会在匹配之前被规范化为 LF。
 * @param newString - 字面的替换文本，以相同方式规范化。
 * @param replaceAll - 替换所有命中项，而不是要求恰好命中一处。
 * @param displayPath - 面向调用方、用于错误消息的路径。
 * @returns 编辑后的 LF 规范化内容以及被替换的处数。
 */
export function applyLiteralEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
  displayPath: string,
): { content: string; replacements: number } {
  const oldNorm = normalizeLineEndings(oldString)
  if (oldNorm.length === 0) {
    throw new FsError('old_string must be a non-empty string', 'FS_EDIT_NOT_FOUND')
  }
  const newNorm = normalizeLineEndings(newString)
  const replacements = countOccurrences(content, oldNorm)
  if (replacements === 0) {
    throw new FsError(`old_string was not found in "${displayPath}"`, 'FS_EDIT_NOT_FOUND')
  }
  if (!replaceAll && replacements > 1) {
    throw new FsError(`old_string matched ${replacements} times in "${displayPath}"; provide a more specific old_string or set replace_all to true`, 'FS_AMBIGUOUS_EDIT')
  }
  return { content: content.split(oldNorm).join(newNorm), replacements }
}

export { normalizeLineEndings, restoreLineEndings }
