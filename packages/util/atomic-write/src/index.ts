/**
 * 零依赖的原子文件替换与写入方协调机制。
 * `writeFileAtomic` 以独占创建方式写入一个随机后缀的同级文件，并带有
 * 调用方的权限位，随后将其重命名覆盖目标文件，因此读取方要么看到旧的
 * 完整内容，要么看到新的完整内容，而被替换的文件最终具有精确的声明
 * 权限模式。`withFileLock` 通过一个以 `wx` 创建的 `<file>.lock` 同级文件
 * 来串行化对同一文件的跨进程写入方，因此读取-修改-写入周期永远不会复活
 * 另一个写入方刚刚替换掉的状态；由于重命名提交是原子的，读取方无需加锁。
 * 记录中的持有进程已不存在的锁会被接管。
 * @module @deepseek-ai/dsh-atomic-write
 */

import { createHash, randomBytes } from 'node:crypto'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'

const WINDOWS_TRANSIENT_RENAME_ERRORS: ReadonlySet<string> = new Set(['EACCES', 'EBUSY', 'EPERM'])
const WINDOWS_RENAME_RETRY_INITIAL_MS = 20
const WINDOWS_RENAME_RETRY_MAX_MS = 200
const WINDOWS_RENAME_RETRY_LIMIT = 8

/** Windows 是否报告了干扰原子替换的暂时性错误。 */
function isTransientWindowsRenameError(error: unknown): boolean {
  if (process.platform !== 'win32') return false
  return WINDOWS_TRANSIENT_RENAME_ERRORS.has((error as NodeJS.ErrnoException | null)?.code ?? '')
}

/** 针对 Windows 的暂时性干扰，在有限次重试后完成替换。 */
async function renameAtomicTemp(temp: string, filename: string): Promise<void> {
  let delay = WINDOWS_RENAME_RETRY_INITIAL_MS
  for (let retries = 0;; retries += 1) {
    try {
      await rename(temp, filename)
      return
    } catch (error) {
      if (!isTransientWindowsRenameError(error)) throw error
      if (retries >= WINDOWS_RENAME_RETRY_LIMIT) throw error
    }
    await new Promise(resolve => setTimeout(resolve, delay))
    delay = Math.min(delay * 2, WINDOWS_RENAME_RETRY_MAX_MS)
  }
}

/**
 * {@link writeFileAtomic} 的文件系统选项；`mode` 为必填项，以便
 * 权限决策在每个调用点都保持可见。
 */
export interface WriteFileAtomicOptions {
  /**
   * 打在新临时 inode 上、并随重命名一并保留的权限位
   * （与每个新 inode 一样，受进程 umask 影响）。
   */
  mode: number
  /**
   * 本次调用所创建父目录的权限位（受 umask 影响；已存在的目录保持
   * 其原有模式）。省略时使用 mkdir 的默认值——当目录树包含用户私有
   * 数据时，请传入 `0o700`。
   */
  dirMode?: number
}

/**
 * 以单个原子步骤用 `content` 替换 `filename`，并在需要时创建父目录。
 * 内容首先写入一个以独占创建方式打开（`wx`）的随机后缀同级文件：该
 * 打开操作拒绝跟随被放置在临时路径上的符号链接，且新 inode 会通过
 * 重命名携带 `options.mode`，因此替换一个权限更宽的文件时无需经历
 * chmod 竞争即可收窄其权限。重命名也会替换符号链接目标本身，而非写入
 * 其指向对象，而同一目录下的同级文件使重命名保持在同一个文件系统内。
 * Windows 上的替换会在有限时间内重试 `EACCES`、`EBUSY` 和 `EPERM` 等
 * 暂时性失败，此时完整的临时文件仍是重命名源。若仍有失败，则删除临时
 * 文件并重新抛出失败。崩溃持久性（fsync）不在本范围内。
 * @param filename - 接收内容的最终路径。
 * @param content - 完整的下一个文件内容。
 * @param options - 替换 inode 的权限位。
 */
export async function writeFileAtomic(filename: string, content: string | Uint8Array, options: WriteFileAtomicOptions): Promise<void> {
  await mkdir(dirname(filename), {
    recursive: true,
    ...options.dirMode === undefined ? {} : { mode: options.dirMode },
  })
  // TODO(settings-atomic-durability): 采用会对文件及其父目录执行 fsync、
  // 并在 Windows 上保留仅所有者权限的替换实现。
  const temp = `${filename}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temp, content, { mode: options.mode, flag: 'wx' })
    await renameAtomicTemp(temp, filename)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

/** 独占创建是否遇到了已存在的锁。 */
async function isLockContention(error: unknown, lockPath: string): Promise<boolean> {
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (code === 'EEXIST') return true
  if (code !== 'EPERM') return false
  try {
    await lstat(lockPath)
    return true
  } catch {
    // 当锁是否存在无法证实时，仍以原始的 EPERM 为准。
    return false
  }
}

/** 一条 `<pid>\n` 记录所指向的持有方是否已被证明退出：信号探测找不到该进程。 */
function holderExited(record: string): boolean {
  // 任何其他内容都正在被写入或被截断，对于其持有方无法证明任何结论。
  if (!/^\d+\n$/.test(record)) return false
  const pid = Number(record.trim())
  // PID 0 指向调用方的进程组，而探测仅接受正的 int32 PID。
  if (pid === 0 || pid > 0x7fffffff) return false
  // 本进程正在运行；一个无法看见自身进程的运行时绝不能接管自己的锁。
  if (pid === process.pid) return false
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    // EPERM 表示该进程在另一用户下存在。
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

/** 锁文件的内容；无法读取时为 undefined。 */
async function readLockRecord(lockPath: string): Promise<string | undefined> {
  try {
    return await readFile(lockPath, 'utf8')
  } catch (error) {
    // 一个已消失、或 Windows 仍在删除的锁，对于持有方无法证明任何结论。
    void error
    return undefined
  }
}

/**
 * 当记录中的持有方已退出时移除该锁。读取同一记录的其他竞争方会基于
 * 该记录串行地争用一个以其命名的声明文件。在声明之下，声明方重新读取
 * 锁并再次探测其 PID，仅当锁仍持有该记录且对应 PID 仍不存在时才将其
 * 移除：记录的持有方已无法再释放它，而没有声明文件的其他竞争方也无法
 * 移除它，因此一次移除绝不会删除另一个竞争方在已退出持有方之后获取的
 * 锁，包括某个持有方复用了同一 PID 的情况。
 * @returns 本次调用是否移除了已退出持有方的锁。
 */
async function takeOverExitedLock(lockPath: string): Promise<boolean> {
  const record = await readLockRecord(lockPath)
  if (record === undefined || !holderExited(record)) return false
  const claim = `${lockPath}.takeover-${createHash('sha256').update(record).digest('hex').slice(0, 16)}`
  try {
    await writeFile(claim, `${process.pid}\n`, { mode: 0o600, flag: 'wx' })
  } catch (error) {
    // 另一竞争方拥有该记录对应的声明文件，或 Windows 仍在删除其已释放的声明文件。
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST' || code === 'EPERM') return false
    throw error
  }
  try {
    if (await readLockRecord(lockPath) !== record || !holderExited(record)) return false
    try {
      await rm(lockPath, { force: true })
    } catch (error) {
      // Windows 可能在其他软件短暂持有该文件时拒绝删除；下一次尝试会重试。
      void error
      return false
    }
    return true
  } finally {
    await rm(claim, { force: true }).catch((error: unknown) => {
      // 遗留的声明文件指向一条不再作为锁的记录，因此不会阻塞之后的任何接管。
      void error
    })
  }
}

/**
 * 竞争锁的重试节奏。这些是跨进程写入协议的健壮性不变量，而非部署可调
 * 参数：它们决定竞争方多久询问一次，没有任何调用方有理由去改变它。
 */
const LOCK_RETRY_INITIAL_MS = 20
const LOCK_RETRY_MAX_MS = 200

/**
 * 当调用方未声明上限时，一个竞争方等待的时长——其大小对应于本包编写时
 * 每个调用点都有的渲染-重命名周期。超时会使竞争方失败，而不是去猜测
 * 现有锁是否仍有所有者。*值得*等待多久，是锁持有方所运行操作的性质，
 * 这正是 {@link FileLockOptions.waitMs} 存在的原因；此处的值是仅做文件
 * 操作时该操作的下限。
 */
const DEFAULT_LOCK_WAIT_MS = 2_000

/** 一次 {@link withFileLock} 获取的选项。 */
export interface FileLockOptions {
  /** 取消获取与竞争等待；操作开始后由它自己负责取消。 */
  signal?: AbortSignal
  /**
   * 等待该锁的最长时间，单位为毫秒。当持有方的操作合法地运行得比文件
   * 操作更久时应显式声明——例如刷新令牌的凭据变更会在持有锁的同时执行
   * 一次网络往返，若保留默认值，在这段时间内会令同一文件的其他每个
   * 写入方都失败。等待是有意义的：之后获取到锁的竞争方会重新读取已
   * 提交的状态。
   */
  waitMs?: number
}

/**
 * 在单个操作外层为 `filename` 持有跨进程的写入方锁。该锁是一个以 `wx`
 * 创建的同级文件（`<filename>.lock`）；配合 {@link writeFileAtomic} 基于
 * 重命名的提交，读取方无需加锁，只有写入方才会竞争。`EEXIST` 直接表示
 * 竞争；而 `EPERM` 仅在全新的 `lstat` 确认锁路径存在时才表示竞争，以
 * 覆盖 Windows 的独占创建行为。Windows 会对一次未确认的 EPERM 重试一次，
 * 因为持有方可能在探测前就已释放；重复的未确认权限错误会被重新抛出。
 * 该锁记录其持有方的 PID。当不存在具有该 PID 的进程（`ESRCH`）时，竞争
 * 方会移除该锁并立即重试；任何其他锁，包括持有方在另一用户下存在
 * （`EPERM`）或记录不完整的锁，都会被等待。竞争采用指数退避，并在
 * 截止时间后超时。持有方 PID 被一个活动进程复用后，其锁会保留直到
 * 操作员将其移除。接管只能证明被记录进程已退出：一个会启动其他写入方
 * 的操作，必须与之一同停止它们，或为其后继者留下找到它们的方式。PID
 * 在竞争方所在主机上比较，因此其他主机上或共享该文件的其他 PID 命名
 * 空间中的写入方不受支持，二者可能同时持有该锁。父目录必须已存在。
 * @param filename - 本锁所要串行化其写入方的文件。
 * @param operation - 持有锁期间运行的读取-渲染-提交周期。
 * @param options - 获取选项；省略时等待 {@link DEFAULT_LOCK_WAIT_MS}。
 * @returns 操作的结果；无论结果如何，锁都会释放。
 */
export async function withFileLock<T>(
  filename: string,
  operation: () => Promise<T>,
  options?: FileLockOptions,
): Promise<T> {
  const lockPath = `${filename}.lock`
  const deadline = Date.now() + (options?.waitMs ?? DEFAULT_LOCK_WAIT_MS)
  let delay = LOCK_RETRY_INITIAL_MS
  let retriedUnconfirmedPermissionError = false
  for (;;) {
    options?.signal?.throwIfAborted()
    try {
      await writeFile(lockPath, `${process.pid}\n`, { mode: 0o600, flag: 'wx' })
      break
    } catch (error) {
      if (!await isLockContention(error, lockPath)) {
        // Windows 可能在独占创建与 lstat 之间释放了竞争锁。
        if (process.platform !== 'win32'
          || (error as NodeJS.ErrnoException | null)?.code !== 'EPERM'
          || retriedUnconfirmedPermissionError) throw error
        retriedUnconfirmedPermissionError = true
      } else if (await takeOverExitedLock(lockPath)) continue
    }
    if (Date.now() >= deadline) {
      throw new Error(`atomic-write: timed out waiting for the writer lock at ${lockPath}`)
    }
    await wait(delay, undefined, { signal: options?.signal })
    delay = Math.min(delay * 2, LOCK_RETRY_MAX_MS)
  }
  try {
    options?.signal?.throwIfAborted()
    return await operation()
  } finally {
    await rm(lockPath, { force: true })
  }
}
