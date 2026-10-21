/**
 * 面向某个会话制品目录的跨进程写所有权锁，在写句柄的整个生命周期内持有。
 * 仲裁者是内核：POSIX 通过原生系统支持在日志旁边的 `session.lock` 上获取
 * 非阻塞的 `flock(2)`，Windows 则持有由该路径派生的命名内核信号量——
 * 绝不是文件锁或句柄，因此在持锁期间读取、搜索与目录删除都能自由进行。
 * 争用映射为 `SessionAlreadyOwnedError`；当持有者的描述符或最后一个对象
 * 句柄关闭时，内核会释放锁，包括任何进程死亡的情形，因此崩溃的持有者
 * 永不阻塞后继者。一个存活但卡住的持有者会一直持有锁直到其进程退出：
 * 这里刻意不设过期时间，因为那可能剥夺一个停滞写入者的所有权，而它
 * 恢复后的追加会撕裂日志。
 * POSIX 锁命名的是 inode 而非路径，因此在加锁之后持有者会校验被锁的 inode
 * 仍是锁路径上的那个文件，否则重试：被解除链接并重建的锁文件带有全新的
 * inode，而对孤立 inode 加锁证明不了任何事情。因此，删除一个活跃会话的
 * 锁文件会在 POSIX 上丧失排他性（harness 中没有任何代码这样做）；
 * Windows 则根本没有锁文件。读取方永不接触该锁。
 * 该锁在已有制品的写打开时获取；对于新创建的会话，只在其首次物化写入
 * 之前获取——未物化的会话没有任何文件系统痕迹。释放时永不删除 POSIX 锁文件：
 * 每个已获取的锁都属于一个已物化或正在物化的会话，而保留该文件可以维持
 * 后续加锁者要校验的稳定 inode。浏览器 worker 会把原生 flock 入口打桩为
 * 立即成功：它是单进程的，因此进程内的写申领已经排除了所有写入者。
 * @module @deepseek-ai/dsh-session-persistence-jsonl/lease
 */

import { mkdir, open, stat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { acquireLockHandleWin32, releaseLockHandleWin32 } from './win32.ts'

/** 会话目录内内核锁文件的基名。 */
export const LEASE_FILENAME = 'session.lock'

/** 已持有的内核锁：一个 POSIX 描述符或一个 Win32 信号量句柄。 */
type HeldLock =
  | { readonly kind: 'posix'; readonly handle: FileHandle }
  | { readonly kind: 'win32'; readonly handle: number }

/** 判断一次 flock 失败是否意味着另一个描述符持有该锁。 */
function isLockContention(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  // flock(2) 报告 EAGAIN；某些 libc 把它写作 EWOULDBLOCK。
  return code === 'EAGAIN' || code === 'EWOULDBLOCK'
}

/**
 * 一个已持有的写锁。只能由 {@link SessionWriteLease.acquire} 构造；
 * `release` 会关闭描述符或句柄，而这正是释放锁的动作。
 */
export class SessionWriteLease {
  private released = false

  private constructor(private readonly held: HeldLock) {}

  /**
   * 获取会话目录的内核写锁。
   * @param dir - 会话的制品目录（不存在时会被创建）。
   * @param id - 该锁所守护的会话，用于错误身份。
   * @returns 已持有的锁。
   * @throws {SessionAlreadyOwnedError} 当另一个持有者仍持有该锁时抛出。
   */
  static async acquire(dir: string, id: SessionId): Promise<SessionWriteLease> {
    const path = join(dir, LEASE_FILENAME)
    // 与 materializePosix 的目录一样仅所有者可访问：锁可能先创建会话目录，
    // 而两个创建者必须对权限模式达成一致。
    await mkdir(dir, { recursive: true, mode: 0o700 })
    /* v8 ignore start -- 原生 Windows 覆盖会测到这个平台分支；Linux 覆盖对应的 POSIX 分支 */
    if (process.platform === 'win32') {
      let handle: number
      try {
        handle = await acquireLockHandleWin32(path)
      } catch (error: unknown) {
        // 共享冲突：另一个句柄已经持有写排他性。
        if ((error as NodeJS.ErrnoException | null)?.code === 'EBUSY') throw new SessionAlreadyOwnedError(id)
        throw error
      }
      return new SessionWriteLease({ kind: 'win32', handle })
    }
    /* v8 ignore stop */
    // 有界重试：为一个正在释放的创建者刚解除链接的 inode（或重建的路径）
    // 加锁时，会重新打开新的文件；稳态下只需一次。
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const handle = await open(path, 'w')
      try {
        try {
          await tryLockExclusive(handle.fd)
        } catch (error: unknown) {
          if (isLockContention(error)) throw new SessionAlreadyOwnedError(id)
          throw error
        }
        const held = await handle.stat({ bigint: true })
        const current = await stat(path, { bigint: true }).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined
          throw error
        })
        if (current !== undefined && current.ino === held.ino && current.dev === held.dev) {
          return new SessionWriteLease({ kind: 'posix', handle })
        }
      } catch (error: unknown) {
        await handle.close()
        throw error
      }
      // 被锁的 inode 已不再是锁路径上的那个文件：针对现在那里的文件重新开始。
      await handle.close()
    }
    throw new SessionAlreadyOwnedError(id)
  }

  /**
   * 通过关闭其描述符或句柄来释放内核锁。POSIX 锁文件永不被删除：
   * 每个已获取的锁都属于一个已物化或正在物化的会话，而保留该文件可以维持
   * 后续加锁者要校验的稳定 inode。该操作幂等。
   */
  async release(): Promise<void> {
    if (this.released) return
    this.released = true
    /* v8 ignore start -- native Windows coverage exercises this platform branch; Linux covers the POSIX peer */
    if (this.held.kind === 'win32') {
      await releaseLockHandleWin32(this.held.handle)
      return
    }
    /* v8 ignore stop */
    await this.held.handle.close()
  }
}
