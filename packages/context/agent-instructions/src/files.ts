/**
 * 指令文件发现，以及有界、可感知取消的提供方读取。
 *
 * @module @deepseek-ai/dsh-agent-instructions/files
 */

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { FileSystem, FsInfo, FsTarget, FsVersion } from '@deepseek-ai/dsh-fs'
import { agentsHomeDisplay, dshHomeDisplay } from '@deepseek-ai/dsh-home-paths'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { resolveConfig, resolveDiscoveryConfig, type ResolvedConfig, type ResolvedDiscoveryConfig } from './config.ts'
import { trimmedInstructionDigest } from './digest.ts'
import {
  AGENTS_GLOBAL_DIRECTORY,
  decodeScopeKey,
  escapeProjectDisplayPath,
  instructionCandidateGroup,
  renderAgentInstructionSet,
  scopeForDisplayPath,
  type RenderedAgentInstructions,
  USER_GLOBAL_DIRECTORY,
  USER_GLOBAL_DIRECTORIES,
  USER_GLOBAL_FILE,
} from './render.ts'

/** 由绝对路径与面向模型路径标识的一个指令候选。 */
export interface InstructionFile {
  absolutePath: string
  displayPath: string
}

/** 其 UTF-8 内容已被成功读取的指令文件。 */
export interface LoadedInstructionFile extends InstructionFile {
  content: string
  /** 当该文件经由 `ctx.fs` 加载时，来自提供方的鲜活令牌。 */
  version?: FsVersion
}

interface DiscoveredInstructionFile extends InstructionFile {
  target?: FsTarget
  size?: number
  version?: FsVersion
}

/** 在内容被读取之前，针对某个已探测作用域候选的提供方元数据。 */
export interface ProbedInstructionFile extends InstructionFile {
  target: FsTarget
  version: FsVersion
  size?: number
}

interface DiscoverOptions {
  cwd: string
  /**
   * 已解析的 harness 主目录。插件在挂载时解析一次并向下传递，
   * 以便对账与基线加载不会意见不一致。
   */
  dshHome?: string
  /**
   * 已解析的共享 agents 根目录。插件在挂载时解析一次并向下传递，
   * 以便对账与基线加载不会意见不一致。
   */
  agentsHome?: string
  projectRootMarkers?: string[]
  instructionFileCandidates?: string[]
  localInstructionFileCandidates?: string[]
  projectRoot?: string
  signal?: AbortSignal
}

interface UserGlobalRoot {
  /** 用于对账键的逻辑作用域目录。 */
  directory: string
  /** 持有候选文件的绝对目录。 */
  home: string
  /** 面向模型的目录标签。 */
  display: string
}

/**
 * 有序的用户全局指令根目录：先是 harness 主目录，然后是共享的 agents 根目录。
 * 两者都贡献固定的 {@link USER_GLOBAL_FILE} 候选，并构成一个候选组，
 * 因此一个与 harness 主目录内容匹配的文件只会渲染一次。
 * @param config - 归一化后的发现配置。
 * @returns 按模型优先级顺序排列的根目录。
 */
function userGlobalRoots(config: ResolvedDiscoveryConfig): UserGlobalRoot[] {
  return USER_GLOBAL_DIRECTORIES.map((directory) => {
    switch (directory) {
      case USER_GLOBAL_DIRECTORY:
        return { directory, home: config.dshHome, display: dshHomeDisplay(config.dshHome) }
      case AGENTS_GLOBAL_DIRECTORY:
        return { directory, home: config.agentsHome, display: agentsHomeDisplay(config.agentsHome) }
      /* v8 ignore next -- USER_GLOBAL_DIRECTORIES is closed; this arm only makes adding a label a compile error. */
      default:
        return assertNever(directory, 'user-global directory')
    }
  })
}

interface LoadOptions extends DiscoverOptions {
  maxBytes: number
  maxSourceBytes?: number
  replacePreviousBaseline?: boolean
}

/** 已渲染的基线，以及成功读取、并经字节预算保留的文件。 */
export interface RenderedInstructionSet {
  rendered: RenderedAgentInstructions
  /** 在内容去重与字节预算处理之前成功读取的候选。 */
  observed: LoadedInstructionFile[]
  /**
   * 因其内容与同组内更早候选重复而被丢弃的候选。
   * 与预算保留内容重复的候选仍可被探测，
   * 因为删除或更改被保留的候选可能使它们重新可见。
   */
  deduped: LoadedInstructionFile[]
  /** 经内容去重与字节预算保留的候选。 */
  included: LoadedInstructionFile[]
}
/** 三态作用域探测：区分确认的缺失与提供方失败。 */
export type ScopeInstructionProbe =
  | { kind: 'present'; file: ProbedInstructionFile }
  | { kind: 'absent' }
  | { kind: 'unavailable' }

interface StatFileInfo {
  target?: FsTarget
  size?: number
  version?: FsVersion
}

type StatFileProbe =
  | { kind: 'present'; info: StatFileInfo }
  | { kind: 'absent' }
  | { kind: 'unavailable' }

function signalOptions(signal?: AbortSignal): { signal: AbortSignal } | undefined {
  return signal === undefined ? undefined : { signal }
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

function isMissingProviderPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'FS_NOT_FOUND'
}

async function nodeStatFile(path: string, signal?: AbortSignal): Promise<StatFileProbe> {
  try {
    signal?.throwIfAborted()
    // stat（而非 lstat）会跟随末尾组件的符号链接，因此指向常规文件的
    // 链接会被加载；损坏的链接表现为 ENOENT，并在下方被当作缺失处理。
    const info = await stat(path)
    signal?.throwIfAborted()
    if (!info.isFile()) return { kind: 'absent' }
    return { kind: 'present', info: { size: info.size } }
  } catch (error: unknown) {
    signal?.throwIfAborted()
    return isMissingPathError(error) ? { kind: 'absent' } : { kind: 'unavailable' }
  }
}

async function fsStatFile(
  path: string,
  fileSystem: FileSystem,
  signal?: AbortSignal,
): Promise<StatFileProbe> {
  // resolve() 会跟随末尾组件的符号链接到其目标的稳定标识；
  // 随后 stat 对该目标进行分类。指向常规文件的链接会被加载，而
  // 缺失路径或非文件目标（包括指向目录的链接）则为缺失。
  try {
    const target = await fileSystem.resolve(path, signalOptions(signal))
    signal?.throwIfAborted()
    const info = await fileSystem.stat(target, signal)
    signal?.throwIfAborted()
    if (info?.type !== 'file') return { kind: 'absent' }
    return {
      kind: 'present',
      info: { target, version: info.version, ...info.size === undefined ? {} : { size: info.size } },
    }
  } catch {
    signal?.throwIfAborted()
    return { kind: 'unavailable' }
  }
}

async function statFile(
  path: string,
  fileSystem?: FileSystem,
  signal?: AbortSignal,
): Promise<StatFileProbe> {
  return fileSystem === undefined ? nodeStatFile(path, signal) : fsStatFile(path, fileSystem, signal)
}

async function existsAsMarker(path: string, fileSystem?: FileSystem, signal?: AbortSignal): Promise<boolean> {
  if (fileSystem !== undefined) {
    try {
      const target = await fileSystem.resolve(path, signalOptions(signal))
      return await fileSystem.stat(target, signal) !== undefined
    } catch (error: unknown) {
      signal?.throwIfAborted()
      if (isMissingProviderPathError(error)) return false
      throw error
    }
  }
  try {
    signal?.throwIfAborted()
    await stat(path)
    signal?.throwIfAborted()
    return true
  } catch (error: unknown) {
    signal?.throwIfAborted()
    if (isMissingPathError(error)) return false
    throw error
  }
}

/**
 * 向上遍历，直到第一个包含所配置根标记的目录。
 * @param cwd - 遍历开始的绝对会话工作目录。
 * @param markers - 用于标识项目根目录的子项名称。
 * @param fileSystem - 用作替代的可选提供方，而非宿主文件系统探测。
 * @param signal - 用于提供方与宿主探测的取消信号。
 * @returns 被发现的项目根目录；当不存在标记时返回 `cwd`。
 * @throws 当探测不可用时，抛出原始的标记元数据错误或取消原因。
 */
export async function findProjectRoot(
  cwd: string,
  markers: readonly string[],
  fileSystem?: FileSystem,
  signal?: AbortSignal,
): Promise<string> {
  let current = resolve(cwd)
  for (;;) {
    for (const marker of markers) {
      if (await existsAsMarker(join(current, marker), fileSystem, signal)) return current
    }
    const parent = dirname(current)
    if (parent === current) return resolve(cwd)
    current = parent
  }
}

/**
 * 构建从根目录到 cwd 的、含两端的目录链。
 * @param root - 预期包含或等于 `cwd` 的根目录。
 * @param cwd - 链中最具体的目录。
 * @returns 从最宽泛到最具体的目录顺序。
 */
export function ancestorChain(root: string, cwd: string): string[] {
  const chain: string[] = []
  let current = resolve(cwd)
  const resolvedRoot = resolve(root)
  while (current !== resolvedRoot) {
    chain.push(current)
    const parent = dirname(current)
    /* v8 ignore next -- discovery always supplies cwd or an ancestor root. */
    if (parent === current) break
    current = parent
  }
  chain.push(resolvedRoot)
  return chain.reverse()
}

/**
 * 找出 cwd 与被触及文件之间所跨越的后代目录。
 * @param root - 界定嵌套发现范围的工作目录。
 * @param touchedPath - 绝对路径，或相对于 `root` 的路径。
 * @returns 从最浅到被触及文件父目录的后代目录。
 */
export function descendantDirsBetween(root: string, touchedPath: string): string[] {
  const resolvedRoot = resolve(root)
  const targetPath = isAbsolute(touchedPath) ? resolve(touchedPath) : resolve(resolvedRoot, touchedPath)
  const targetDir = dirname(targetPath)
  const rel = relative(resolvedRoot, targetDir)
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) return []
  return ancestorChain(resolvedRoot, targetDir).slice(1)
}

/**
 * 将一个绝对指令路径转换为其项目显示路径。
 * @param root - 用作显示基址的项目根目录。
 * @param path - 待显示的绝对路径。
 * @returns 无冲突的、相对于根目录的路径。
 */
export function relativeDisplay(root: string, path: string): string {
  return escapeProjectDisplayPath(relative(root, path))
}

async function allExistingInstructionFiles(
  dir: string,
  root: string,
  instructionFileCandidates: readonly string[],
  fileSystem?: FileSystem,
  signal?: AbortSignal,
): Promise<DiscoveredInstructionFile[]> {
  const found: DiscoveredInstructionFile[] = []
  for (const candidate of instructionFileCandidates) {
    const path = join(dir, candidate)
    const probe = await statFile(path, fileSystem, signal)
    switch (probe.kind) {
      case 'present':
        found.push({ absolutePath: path, displayPath: relativeDisplay(root, path), ...probe.info })
        continue
      // 缺失的候选会被跳过；而一次瞬时提供方失败仅跳过
      // 该候选，因此其余独立的候选仍会被加载。
      case 'absent':
      case 'unavailable':
        continue
      /* v8 ignore next 2 -- StatFileProbe is closed; this arm only makes adding a kind a compile error. */
      default:
        assertNever(probe, 'StatFileProbe')
    }
  }
  return found
}

async function discoverInstructionFiles(
  options: DiscoverOptions,
  fileSystem?: FileSystem,
): Promise<DiscoveredInstructionFile[]> {
  const config = resolveDiscoveryConfig(options)
  const files: DiscoveredInstructionFile[] = []
  const seen = new Set<string>()
  const addFile = (file: DiscoveredInstructionFile): void => {
    if (seen.has(file.absolutePath)) return
    seen.add(file.absolutePath)
    files.push(file)
  }

  for (const root of userGlobalRoots(config)) {
    const absolutePath = join(root.home, USER_GLOBAL_FILE)
    const probe = await statFile(absolutePath, fileSystem, options.signal)
    switch (probe.kind) {
      case 'present':
        addFile({
          absolutePath,
          displayPath: `${root.display}/${USER_GLOBAL_FILE}`,
          ...probe.info,
        })
        continue
      case 'absent':
      case 'unavailable':
        continue
      /* v8 ignore next 2 -- StatFileProbe is closed; this arm only makes adding a kind a compile error. */
      default:
        assertNever(probe, 'StatFileProbe')
    }
  }

  const cwd = resolve(options.cwd)
  const projectRoot = options.projectRoot
    ?? await findProjectRoot(cwd, config.projectRootMarkers, fileSystem, options.signal)
  for (const dir of ancestorChain(projectRoot, cwd)) {
    for (const candidates of [config.instructionFileCandidates, config.localInstructionFileCandidates]) {
      for (const file of await allExistingInstructionFiles(dir, projectRoot, candidates, fileSystem, options.signal)) {
        addFile(file)
      }
    }
  }
  return files
}

/**
 * 发现宿主可见的用户全局，以及从根目录到 cwd 的指令候选。
 * 每个目录中所有存在的候选都会被返回；裁剪内容的重复项
 * 会在内容读取之后、稍晚再折叠。
 * @param options - cwd、已解析的 harness 主目录、根标记与候选配置。
 * @returns 按模型优先级顺序排列、且路径去重后的指令候选。
 * @throws 当发现无法识别项目根目录时，抛出原始的标记元数据错误或取消原因。
 */
export async function discoverBaselineInstructionFiles(options: DiscoverOptions): Promise<InstructionFile[]> {
  return (await discoverInstructionFiles(options)).map(({ absolutePath, displayPath }) => ({ absolutePath, displayPath }))
}

async function* nodeTextChunks(path: string, signal?: AbortSignal): AsyncIterable<string> {
  const stream = createReadStream(path, { encoding: 'utf8', signal })
  for await (const chunk of stream) yield String(chunk)
}

async function readBounded(
  file: { absolutePath: string; target?: FsTarget; size?: number },
  maxSourceBytes: number,
  fileSystem?: FileSystem,
  signal?: AbortSignal,
): Promise<string | undefined> {
  // TODO(total-instruction-read-bound): 在一份完整基线或对账批次上强制实施聚合源预算；
  // 当前渲染预算仅在所有被接纳的文件都在此每文件上限下读取之后才应用。
  signal?.throwIfAborted()
  if (file.size !== undefined && file.size > maxSourceBytes) return undefined
  try {
    const chunks = fileSystem === undefined || file.target === undefined
      ? nodeTextChunks(file.absolutePath, signal)
      : await fileSystem.streamText(file.target, signal)
    const parts: string[] = []
    let bytes = 0
    for await (const chunk of chunks) {
      signal?.throwIfAborted()
      bytes += Buffer.byteLength(chunk, 'utf8')
      if (bytes > maxSourceBytes) return undefined
      parts.push(chunk)
    }
    signal?.throwIfAborted()
    return parts.join('')
  } catch {
    signal?.throwIfAborted()
    // A file may disappear or become unreadable after its metadata probe.
    return undefined
  }
}

/**
 * 丢弃那些裁剪内容与同候选组内更早候选重复的后续候选。
 * 不同组之间即便内容相同也绝不会折叠；在同一个组内，保留发现顺序中
 * 最早的候选，并渲染其原始字节。两个用户全局根目录构成一个组，
 * 因此与 harness 主目录内容匹配的共享文件会折叠到它后面。一个通过符号链接
 * 指向兄弟文件的候选会解析为相同内容，并像任何字节相同的真实文件一样在此折叠。
 * @param files - 按发现顺序排列的已加载文件。
 * @returns 以相同顺序保留的文件。
 */
export function dedupInstructionFilesByCandidateGroup(files: LoadedInstructionFile[]): LoadedInstructionFile[] {
  const keptDigestsByGroup = new Map<string, Set<string>>()
  const kept: LoadedInstructionFile[] = []
  for (const file of files) {
    const group = instructionCandidateGroup(scopeForDisplayPath(file.displayPath))
    let digests = keptDigestsByGroup.get(group)
    if (digests === undefined) {
      digests = new Set()
      keptDigestsByGroup.set(group, digests)
    }
    const digest = trimmedInstructionDigest(file.content)
    if (digests.has(digest)) continue
    digests.add(digest)
    kept.push(file)
  }
  return kept
}

/**
 * 发现、读取并渲染基线指令链。
 * @param options - 发现、源大小、字节预算与取消配置。
 * @param fileSystem - 用作替代的可选提供方，而非宿主文件系统读取。
 * @returns 渲染后的基线上下文；当无法加载任何内容时为 undefined。
 * @throws 当发现无法识别项目根目录时，抛出原始的标记元数据错误或取消原因。
 */
export async function loadBaselineInstructions(
  options: LoadOptions,
  fileSystem?: FileSystem,
): Promise<RenderedAgentInstructions | undefined> {
  return (await loadBaselineInstructionSet(options, fileSystem))?.rendered
}

/**
 * 加载一份基线，以及渲染之后被保留的文件。
 * @param options - 发现、源大小、字节预算与取消配置。
 * @param fileSystem - 用作替代的可选提供方，而非宿主文件系统读取。
 * @returns 渲染上下文与保留文件、一个显式的空替换集，或当为空或被禁用时为 undefined。
 */
export async function loadBaselineInstructionSet(
  options: LoadOptions,
  fileSystem?: FileSystem,
): Promise<RenderedInstructionSet | undefined> {
  const config = resolveConfig(options)
  if (config.maxBytes <= 0 || !Number.isFinite(config.maxBytes)) return undefined
  if (config.maxSourceBytes <= 0 || !Number.isFinite(config.maxSourceBytes)) return undefined
  const discovered = await discoverInstructionFiles(options, fileSystem)
  const loaded: LoadedInstructionFile[] = []
  for (const file of discovered) {
    const content = await readBounded(file, config.maxSourceBytes, fileSystem, options.signal)
    if (content !== undefined) {
      loaded.push({
        absolutePath: file.absolutePath,
        displayPath: file.displayPath,
        content,
        ...file.version === undefined ? {} : { version: file.version },
      })
    }
  }
  const kept = dedupInstructionFilesByCandidateGroup(loaded)
  if (kept.length === 0) {
    if (options.replacePreviousBaseline !== true) return undefined
    const { rendered, included } = renderAgentInstructionSet([], {
      maxBytes: config.maxBytes,
      replacePreviousBaseline: true,
    })
    return {
      rendered,
      observed: [],
      deduped: [],
      included,
    }
  }
  const keptPaths = new Set(kept.map(file => file.absolutePath))
  const { rendered, included } = renderAgentInstructionSet(kept, {
    maxBytes: config.maxBytes,
    ...options.replacePreviousBaseline === undefined
      ? {}
      : { replacePreviousBaseline: options.replacePreviousBaseline },
  })
  return {
    rendered,
    observed: loaded,
    deduped: loaded.filter(file => !keptPaths.has(file.absolutePath)),
    included,
  }
}

/**
 * 解析一个逻辑指令候选的文件路径与显示路径。
 * @param scope - 包含其目录与文件名的候选作用域键。
 * @param projectRoot - 用于项目相对候选的根目录。
 * @param resolved - 用于用户全局候选的归一化主目录。
 * @returns 该候选的绝对路径与面向模型的路径。
 * @internal
 */
export function scopeInstructionFile(
  scope: string,
  projectRoot: string,
  resolved: ResolvedDiscoveryConfig,
): InstructionFile {
  const { directory, candidateName } = decodeScopeKey(scope)
  const globalRoot = userGlobalRoots(resolved).find(root => root.directory === directory)
  const dir = globalRoot?.home ?? (directory === '.' ? projectRoot : join(projectRoot, directory))
  const absolutePath = join(dir, candidateName)
  return {
    absolutePath,
    displayPath: globalRoot === undefined ? relativeDisplay(projectRoot, absolutePath) : `${globalRoot.display}/${candidateName}`,
  }
}

/**
 * 针对一个按候选指令作用域，探测当前提供方的元数据。
 * @param scope - 标识目录与候选文件的 {@link candidateScopeKey}。
 * @param projectRoot - 用于解析与显示项目作用域的项目根目录。
 * @param resolved - 归一化后的插件配置。
 * @param fileSystem - 用于解析与 stat 作用域候选的提供方。
 * @param signal - 用于提供方探测的取消信号。
 * @returns 存在的元数据、确认的缺失，或临时的不可用。
 */
export async function probeScopeInstruction(
  scope: string,
  projectRoot: string,
  resolved: ResolvedConfig,
  fileSystem: FileSystem,
  signal?: AbortSignal,
): Promise<ScopeInstructionProbe> {
  const candidate = scopeInstructionFile(scope, projectRoot, resolved)
  // resolve() 会跟随末尾组件的符号链接；随后 stat 对该目标进行分类。
  // 非文件目标（缺失，或指向目录的链接）即确认的缺失；
  // 只有提供方异常才会被报告为不可用。
  let target: FsTarget
  let info: FsInfo | undefined
  try {
    target = await fileSystem.resolve(candidate.absolutePath, signalOptions(signal))
    info = await fileSystem.stat(target, signal)
  } catch {
    signal?.throwIfAborted()
    return { kind: 'unavailable' }
  }
  if (info?.type !== 'file') return { kind: 'absent' }
  const file: ProbedInstructionFile = {
    ...candidate,
    target,
    version: info.version,
    ...info.size === undefined ? {} : { size: info.size },
  }
  return { kind: 'present', file }
}

/**
 * 在配置的源上限下读取一个已被探测的作用域候选。
 * @param file - 胜出的提供方候选及其元数据快照。
 * @param maxSourceBytes - 从源接受的最大 UTF-8 字节数。
 * @param fileSystem - 用于流式读取的提供方。
 * @param signal - 用于提供方流式的取消信号。
 * @returns 带探测版本的已加载内容；不可用时为 undefined。
 */
export async function readScopeInstruction(
  file: ProbedInstructionFile,
  maxSourceBytes: number,
  fileSystem: FileSystem,
  signal?: AbortSignal,
): Promise<LoadedInstructionFile | undefined> {
  const content = await readBounded(file, maxSourceBytes, fileSystem, signal)
  if (content === undefined) return undefined
  return {
    absolutePath: file.absolutePath,
    displayPath: file.displayPath,
    content,
    version: file.version,
  }
}
