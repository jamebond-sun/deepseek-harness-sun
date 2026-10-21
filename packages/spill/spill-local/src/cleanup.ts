/** 本地溢出根目录的启动清理机制。 */
import { lstat, readdir, realpath, rmdir, unlink } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { DEFAULT_ROOT_PREFIX, isErrno } from './store.ts'

/**
 * 后端生成的默认根目录名：`dsh-spill-` 加上 `mkdtemp` 追加的 6 个字符后缀。
 * 发现过程匹配这个精确形状，而不是裸前缀，因此一个无关的
 * `dsh-spill-test-*` fixture，或某个外来工具形状不同的 `dsh-spill-…` 目录，
 * 绝不会被误认为是要清理的后端根目录。
 */
const DEFAULT_ROOT_RE = new RegExp(`^${DEFAULT_ROOT_PREFIX}[A-Za-z0-9]{6}$`)

/**
 * 后端生成的会话目录名：`session-` 加上 {@link sessionDir} 从
 * `sha256(sessionId)` 派生出的 12 个小写十六进制字符。清理只会进入
 * 这个精确形状的条目，因此共享配置根目录下的一个无关的
 * `session-backup` 目录绝不会被清理。
 */
const SESSION_DIR_RE = /^session-[0-9a-f]{12}$/

/** 一个已解析为单一稳定文件系统身份的现有根目录。 */
interface ResolvedRoot {
  /** 清理使用的规范绝对路径。 */
  path: string
  /** 用于文件系统别名去重的设备/inode 身份。 */
  identity: string
}

/** 单参数告警出口 —— 清理在失败时唯一的副作用（绝不会抛出）。 */
export type WarnFn = (message: string) => void

/** 上报一次尽力而为的清理失败，同时不允许告警出口让清理被拒绝。 */
function warnSafely(warn: WarnFn, message: string): void {
  try {
    warn(message)
  } catch {
    // 告警出口只是观察性回调；即使某个日志实现抛出，清理也必须保持尽力而为。
  }
}

/** 判断其他本地 OS 用户是否无法替换该目录下的子项。 */
function isTrustedDirectory(stats: Stats): boolean {
  if (!stats.isDirectory()) return false
  /* v8 ignore next -- POSIX 的属主与模式位在 Windows 上没有对应物。 */
  if (process.platform === 'win32' || process.geteuid === undefined) return true
  /* v8 ignore start -- Windows 走上面的返回；POSIX 测试会覆盖属主与模式的拒绝分支。 */
  return stats.uid === process.geteuid() && (stats.mode & 0o022) === 0
  /* v8 ignore stop */
}

/** 用于对同一个根目录的别名去重的稳定身份。 */
function rootIdentity(path: string, stats: Stats): string {
  /* v8 ignore next -- Windows 的文件索引不是可移植的 inode 身份。 */
  if (process.platform === 'win32') return path.toLowerCase()
  /* v8 ignore start -- Windows 使用上面的规范路径身份；POSIX 测试会覆盖
     设备与 inode 身份。 */
  return `${String(stats.dev)}:${String(stats.ino)}`
  /* v8 ignore stop */
}

/**
 * 检查是否没有任何祖先允许其他本地 OS 用户替换被选中的子项。
 * 带 sticky 位的可写祖先是安全的，因为该子项归当前用户所有；
 * 这使得 `/tmp` 之下普通的每进程根目录得以通过。
 */
async function hasProtectedAncestors(path: string): Promise<boolean> {
  /* v8 ignore next -- POSIX 的祖先检查在 Windows ACL 中没有对应物。 */
  if (process.platform === 'win32' || process.geteuid === undefined) return true
  /* v8 ignore start -- Windows 走上面的返回；POSIX 测试会覆盖
     祖先的属主与模式策略。 */
  const currentUid = process.geteuid()
  let child = path
  let childStats = await lstat(child)
  for (;;) {
    const parent = dirname(child)
    if (parent === child) return true
    const stats = await lstat(parent)
    /* v8 ignore next -- 成功解析出的路径的每个祖先都是目录。 */
    if (!stats.isDirectory()) return false
    const writableByOthers = (stats.mode & 0o022) !== 0
    const sticky = (stats.mode & 0o1000) !== 0
    if (writableByOthers && !sticky) return false
    /* v8 ignore next -- 需要一个位于可写 sticky 父目录之下、且由另一个 OS
       账号拥有的祖先；普通测试 fixture 无法改变 uid。 */
    if (writableByOthers && childStats.uid !== currentUid) return false
    child = parent
    childStats = stats
  }
  /* v8 ignore stop */
}

/**
 * 解析一个现有根目录，同时不接纳在基于路径的清理期间可能被其他本地用户
 * 替换的目录。配置的根目录可以是符号链接；发现过程传入 `false`，
 * 使符号链接无法冒充默认根目录。
 *
 * @param path 候选根目录路径。
 * @param allowSymlink 候选本身是否可以是被配置的符号链接。
 * @param warn 被跳过或检查失败的上报出口。
 * @returns 受信任的规范根目录；不存在或不安全时为 `undefined`。
 */
async function resolveRoot(path: string, allowSymlink: boolean, warn: WarnFn): Promise<ResolvedRoot | undefined> {
  let initial: Stats
  try {
    initial = await lstat(path)
  } catch (error: unknown) {
    /* v8 ignore start -- 非 ENOENT 的检查失败取决于宿主 ACL 或条目竞态消失，
       无法可移植地复现。 */
    if (!isErrno(error, 'ENOENT')) warnSafely(warn, `spill-local: failed to inspect root ${path}: ${String(error)}`)
    return undefined
    /* v8 ignore stop */
  }
  if (initial.isSymbolicLink()) {
    if (!allowSymlink) return undefined
  } else if (!isTrustedDirectory(initial)) {
    warnSafely(warn, `spill-local: skipped unsafe root ${path}: expected a directory owned by the current user and not writable by group or others`)
    return undefined
  }

  let canonical: string
  let stats: Stats
  try {
    canonical = await realpath(path)
    stats = await lstat(canonical)
  } catch (error: unknown) {
    /* v8 ignore start -- 上面已 lstat 成功的根目录走到这里，只能是竞态消失
       或宿主特有的 realpath 失败。 */
    if (!isErrno(error, 'ENOENT')) warnSafely(warn, `spill-local: failed to resolve root ${path}: ${String(error)}`)
    return undefined
    /* v8 ignore stop */
  }
  let protectedAncestors = false
  try {
    protectedAncestors = await hasProtectedAncestors(canonical)
  } catch (error: unknown) {
    /* v8 ignore start -- 规范祖先只能通过竞态消失；其他失败取决于宿主 ACL。 */
    if (!isErrno(error, 'ENOENT')) warnSafely(warn, `spill-local: failed to inspect ancestors of root ${canonical}: ${String(error)}`)
    return undefined
    /* v8 ignore stop */
  }
  /* v8 ignore start -- Windows 没有 POSIX 的属主或模式拒绝路径；
     POSIX 测试会覆盖两种不安全目录情形。 */
  if (!isTrustedDirectory(stats) || !protectedAncestors) {
    warnSafely(warn, `spill-local: skipped unsafe root ${canonical}: expected a current-user-owned directory with protected write and ancestor permissions`)
    return undefined
  }
  /* v8 ignore stop */
  return { path: canonical, identity: rootIdentity(canonical, stats) }
}

/** 一个待清理的根目录，以及根目录本身在清空后是否可以被剪除。 */
export interface SweepRoot {
  /** 待清理的绝对溢出根目录。 */
  path: string
  /**
   * 为 `true` 时，在其空的 `session-*` 子目录被剪除之后删除该根目录。
   * 只对既往默认 `dsh-spill-*` 根目录（每个过去进程一个）设置 ——
   * 否则它们会永远空着累积下去；绝不对活着的进程仍在写入的当前根目录设置。
   * 每个根目录都会剪除空的会话目录；若写操作与之竞态，写入会重试。
   */
  pruneWhenEmpty: boolean
}

/** {@link sweepSpillRoots} 的选项 —— 待扫描的根目录、时间截止点，以及故障出口。 */
export interface SweepOptions {
  /** 待清理的根目录（配置的/当前的根目录，及/或发现的既往默认根目录）。 */
  roots: SweepRoot[]
  /**
   * 以纪元毫秒表示的截止点：普通文件的 `mtime` 严格早于它时会被删除。
   * 调用方由 `now - cleanupPeriodDays` 推导，因此恰好写在边界上的文件会被
   * 保留（只有严格更早的才过期）。
   */
  cutoffMs: number
  /** 已消化的文件系统故障的上报位置；清理本身绝不抛出。 */
  warn: WarnFn
}

/**
 * 删除单个路径，把并发竞态导致的消失当作成功。一个并行进程（或另一次
 * 清理）可能在我们的扫描与我们自己的 `unlink` 之间 `unlink` 同一个文件 ——
 * 此时的 ENOENT 意味着目标（文件已消失）已然成立，因此不算失败。
 * 其他任何错误都会被上报并吞掉。
 *
 * @param path 要删除的绝对文件路径。
 * @param warn 非 ENOENT 失败消息的上报出口。
 * @returns 删除尝试结束后 resolve（绝不拒绝）。
 */
async function unlinkIdempotent(path: string, warn: WarnFn): Promise<void> {
  try {
    await unlink(path)
  } catch (error: unknown) {
    /* v8 ignore start -- 仅当被选中删除的文件（一个通过了 lstat 的普通文件）
       随后 unlink 失败时才会走到这里：要么它竞态消失了（ENOENT），
       要么在 stat 与 unlink 之间出现了权限/IO 故障。两者都无法在进程内
       确定性复现。 */
    if (isErrno(error, 'ENOENT')) return
    warnSafely(warn, `spill-local: failed to delete ${path}: ${String(error)}`)
    /* v8 ignore stop */
  }
}

/**
 * 清理一个溢出会话目录：删除过期的普通文件，跳过其他一切，并在之后
 * 报告该目录是否为空，以便调用方剪除它。`dir` 条目必须是真实目录 ——
 * 调用方先 `lstat` 它并跳过符号链接，因此这里绝不会顺着 `session-*`
 * 符号链接进入外部目录树。目录内部的符号链接或任何非普通条目（socket、
 * fifo、嵌套目录）都不会被触碰 —— `lstat` 绝不跟随链接，因此一个
 * 预置的符号链接既不可能被删除，也不可能重定向时间检查。
 * 每个条目的失败都被就地消化：一个不可读的文件不会中断整个目录。
 *
 * @param dir 待扫描的绝对会话目录（已确认为真实目录）。
 * @param cutoffMs `mtime` 严格早于该值的文件会被删除。
 * @param warn 已消化的文件系统故障的上报出口。
 * @returns 清理后该目录不含任何条目时为 `true`（即可剪除的候选）。
 */
async function sweepSessionDir(dir: string, cutoffMs: number, warn: WarnFn): Promise<boolean> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (error: unknown) {
    /* v8 ignore start -- 调用方刚刚 lstat 过这个条目并确认是真实目录，
       因此 readdir 只会在该目录竞态消失（ENOENT）或在这个时间窗内出现
       权限/IO 故障时才失败；无法确定性复现。返回 false 使其不进入剪除步骤。 */
    warnSafely(warn, `spill-local: failed to read ${dir}: ${String(error)}`)
    return false
    /* v8 ignore stop */
  }
  let remaining = names.length
  for (const name of names) {
    const path = join(dir, name)
    let stats
    try {
      stats = await lstat(path)
    } catch (error: unknown) {
      /* v8 ignore start -- readdir 刚返回的条目随后 lstat 失败，只能是竞态
         消失（ENOENT）或权限/IO 故障；把它排除在确定性测试面之外。 */
      if (isErrno(error, 'ENOENT')) { remaining--; continue }
      warnSafely(warn, `spill-local: failed to stat ${path}: ${String(error)}`)
      continue
      /* v8 ignore stop */
    }
    // 只有普通文件会过期。符号链接与其他特殊条目会被跳过（且绝不被跟随），
    // 因此清理既不会被重定向，也不会删除一个链接。
    if (!stats.isFile()) continue
    if (stats.mtimeMs >= cutoffMs) continue
    await unlinkIdempotent(path, warn)
    remaining--
  }
  return remaining === 0
}

/**
 * 尽力而为的一次性清理：在每个根目录下，删除其 `session-*` 目录中过期的
 * 普通文件，并剪除每一个空的会话目录。只有被发现的既往默认根目录本身
 * 会被删除。当剪除与本地写入竞态时，写入会重建会话目录。
 * 所有文件系统故障与告警出口故障都被就地消化，因此调用方可以在
 * 激活/dispose 期间 await 它，而它绝不会拒绝。
 *
 * @param options 待清理的根目录、时间截止点，以及故障出口。
 * @returns 清理完成时 resolve（绝不拒绝）。
 */
export async function sweepSpillRoots(options: SweepOptions): Promise<void> {
  const { cutoffMs, warn } = options
  const roots = new Map<string, SweepRoot>()
  for (const candidate of options.roots) {
    const resolved = await resolveRoot(candidate.path, false, warn)
    if (resolved === undefined) continue
    const existing = roots.get(resolved.identity)
    roots.set(resolved.identity, {
      path: resolved.path,
      pruneWhenEmpty: (existing?.pruneWhenEmpty ?? true) && candidate.pruneWhenEmpty,
    })
  }
  for (const root of roots.values()) {
    let entries: string[]
    try {
      entries = await readdir(root.path)
    } catch (error: unknown) {
      // 根目录尚不存在（从未写入过任何溢出）是常见情况，而非错误：
      // ENOENT 静默处理，其他任何错误都会上报。
      /* v8 ignore start -- 受信任的根目录刚刚在上面被解析成功；此时读取
         失败需要竞态或宿主特有的 ACL 故障。 */
      if (!isErrno(error, 'ENOENT')) warnSafely(warn, `spill-local: failed to read root ${root.path}: ${String(error)}`)
      continue
      /* v8 ignore stop */
    }
    // 跟踪根目录是否仍持有任何未被清理完全回收的条目，这样只有什么都不剩时
    // 才能剪除一个被发现的既往默认根目录。
    let rootEmptiable = true
    for (const name of entries) {
      // 只有后端自己的 `session-<12 hex>` 目录会被清理；无关的兄弟条目
      // （`session-backup`、一个游离文件）保持不动，并阻止剪除该根目录。
      if (!SESSION_DIR_RE.test(name)) { rootEmptiable = false; continue }
      const dir = join(root.path, name)
      let stats
      try {
        // 对会话条目本身做 lstat：绝不能跟随 `session-*` 符号链接
        // （经由它的 readdir/unlink 会删掉外部目标里的文件）。
        // 只有真实目录才会被清理。
        stats = await lstat(dir)
      } catch (error: unknown) {
        /* v8 ignore start -- readdir 刚返回的条目随后 lstat 失败，只能是竞态
           消失（ENOENT）或权限/IO 故障；无法确定性复现。 */
        if (!isErrno(error, 'ENOENT')) warnSafely(warn, `spill-local: failed to stat ${dir}: ${String(error)}`)
        continue
        /* v8 ignore stop */
      }
      if (!isTrustedDirectory(stats)) {
        warnSafely(warn, `spill-local: skipped unsafe session directory ${dir}`)
        rootEmptiable = false
        continue
      }
      const empty = await sweepSessionDir(dir, cutoffMs, warn)
      if (!empty) { rootEmptiable = false; continue }
      try {
        await rmdir(dir)
      } catch (error: unknown) {
        /* v8 ignore start -- 剪除只在一个被观察到为空的目录上运行；这里的
           失败意味着并发写入方新增了文件（ENOTEMPTY），或出现了权限/IO
           故障 —— 两者都属于确定性进程内测试之外的竞态。 */
        rootEmptiable = false
        if (!isErrno(error, 'ENOENT') && !isErrno(error, 'ENOTEMPTY')) {
          warnSafely(warn, `spill-local: failed to prune ${dir}: ${String(error)}`)
        }
        /* v8 ignore stop */
      }
    }
    // 一个被发现的既往默认根目录（每个过去进程一个）在其最后一个会话目录
    // 消失后被删除 —— 否则空根目录会永远累积，且未来每次启动都要重新扫描它们。
    // 当前根目录自身绝不会被剪除。
    if (root.pruneWhenEmpty && rootEmptiable) {
      try {
        await rmdir(root.path)
      } catch (error: unknown) {
        /* v8 ignore start -- 剪除只在其所有子项都已被回收的根目录上运行；
           这里的失败意味着并发写入方在我们的扫描之后新增了一次新的溢出
           （ENOTEMPTY），或根目录已被删除（ENOENT），或出现了权限/IO 故障 ——
           全部属于确定性进程内测试之外的竞态。 */
        if (!isErrno(error, 'ENOENT') && !isErrno(error, 'ENOTEMPTY')) {
          warnSafely(warn, `spill-local: failed to prune root ${root.path}: ${String(error)}`)
        }
        /* v8 ignore stop */
      }
    }
  }
}

/**
 * 发现既往的默认溢出根目录：早期使用默认根目录的运行在 `base`（OS 临时
 * 目录）之下直接创建的 `dsh-spill-<6 chars>` 目录。一个带配置根目录的
 * 长期部署一个都找不到；而一系列使用默认根目录的运行会为每个进程累积
 * 一个，因此启动清理会把它们全部回收。匹配的是精确的 `mkdtemp` 形状
 * （见 {@link DEFAULT_ROOT_RE}），而不是裸前缀，因此一个无关的
 * `dsh-spill-test-*` fixture 或形状不同的外来目录绝不会被清理；
 * 符号链接与非目录同样被排除 —— 只有后端可能创建过的真实目录才入选。
 *
 * @param warn 读取 `base` 失败时的上报出口（失败时返回 `[]`）。
 * @param base 待扫描的目录；默认为 OS 临时目录（一个测试接缝）。
 * @returns 发现的默认根目录的绝对路径（可能为空）。
 */
async function discoverDefaultRootRecords(warn: WarnFn, base: string): Promise<ResolvedRoot[]> {
  let entries: string[]
  try {
    entries = await readdir(base)
  } catch (error: unknown) {
    warnSafely(warn, `spill-local: failed to scan ${base} for default roots: ${String(error)}`)
    return []
  }
  const roots: ResolvedRoot[] = []
  for (const name of entries) {
    if (!DEFAULT_ROOT_RE.test(name)) continue
    const path = join(base, name)
    const resolved = await resolveRoot(path, false, warn)
    if (resolved !== undefined) roots.push(resolved)
  }
  return roots
}

/**
 * 在 OS 临时目录之下发现受信任的既往默认根目录。
 *
 * @param warn 已消化的发现故障的上报出口。
 * @param base 待扫描的目录；默认为 OS 临时目录。
 * @returns 受信任的默认根目录的规范路径。
 */
export async function discoverDefaultRoots(warn: WarnFn, base: string = tmpdir()): Promise<string[]> {
  return (await discoverDefaultRootRecords(warn, base)).map(root => root.path)
}

/**
 * 收集并去重一次启动清理所用的受信任根目录。当前配置的路径可以是符号
 * 链接；它解析出的身份会覆盖匹配的已发现根目录，从而使活动目标绝不会
 * 被标记为可剪除。
 *
 * @param activeRoot 当前配置的根目录。
 * @param warn 已消化的检查失败的上报出口。
 * @param defaultRootsBase 存放既往默认根目录的目录。
 * @returns 受信任的根目录，其中当前身份被标记为不可剪除。
 */
export async function gatherSweepRoots(
  activeRoot: string,
  warn: WarnFn,
  defaultRootsBase: string = tmpdir(),
): Promise<SweepRoot[]> {
  const [discovered, active] = await Promise.all([
    discoverDefaultRootRecords(warn, defaultRootsBase),
    resolveRoot(activeRoot, true, warn),
  ])
  const roots = new Map<string, SweepRoot>()
  for (const root of discovered) roots.set(root.identity, { path: root.path, pruneWhenEmpty: true })
  if (active !== undefined) roots.set(active.identity, { path: active.path, pruneWhenEmpty: false })
  return [...roots.values()]
}
