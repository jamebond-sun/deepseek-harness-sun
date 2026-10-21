/**
 * JSONL 后端使用的 Windows 持久命名空间辅助函数。
 *
 * POSIX 通过创建目录项然后 fsync 父目录来发布一个新创建的日志。Windows
 * 并不通过 Node 暴露该父目录 fsync 契约，因此 Windows 路径改用原生的
 * 持久命名空间原语：在目标目录中创建一个暂存对象，并用
 * `MoveFileExW(..., MOVEFILE_WRITE_THROUGH)` 发布它，既不做替换，
 * 也不做跨卷复制回退。
 *
 * @module dsh-session-persistence-jsonl/win32
 */

import { createHash } from 'node:crypto'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { join, parse, resolve, toNamespacedPath } from 'node:path'

type MoveFileExW = (existing: string, replacement: string, flags: number) => number
type CreateSemaphoreW = (security: null, initial: number, maximum: number, name: string) => number
type WaitForSingleObject = (handle: number, milliseconds: number) => number
type ReleaseSemaphore = (handle: number, count: number, previous: null) => number
type CloseHandle = (handle: number) => number
type GetLastError = () => number

interface Win32Bindings {
  moveFileExW: MoveFileExW
  createSemaphoreW: CreateSemaphoreW
  waitForSingleObject: WaitForSingleObject
  releaseSemaphore: ReleaseSemaphore
  closeHandle: CloseHandle
  getLastError: GetLastError
}

interface Win32ErrnoException extends NodeJS.ErrnoException {
  win32Code: number
  dest: string
}

const MOVEFILE_WRITE_THROUGH = 0x00000008
const WAIT_OBJECT_0 = 0
const WAIT_TIMEOUT = 0x00000102
const ERROR_FILE_NOT_FOUND = 2
const ERROR_PATH_NOT_FOUND = 3
const ERROR_ACCESS_DENIED = 5
const ERROR_NOT_SAME_DEVICE = 17
const ERROR_SHARING_VIOLATION = 32
const ERROR_FILE_EXISTS = 80
const ERROR_INVALID_NAME = 123
const ERROR_ALREADY_EXISTS = 183

let bindings: Win32Bindings | undefined

/** 惰性加载这一小部分 Win32 API，使非 Windows 进程永不加载 Koffi。 */
async function win32(): Promise<Win32Bindings> {
  if (bindings !== undefined) return bindings
  const koffi = (await import('koffi')).default
  const kernel32 = koffi.load('kernel32.dll')
  bindings = {
    moveFileExW: kernel32.func('__stdcall', 'MoveFileExW', 'int', ['str16', 'str16', 'uint']) as MoveFileExW,
    createSemaphoreW: kernel32.func('__stdcall', 'CreateSemaphoreW', 'intptr', ['void*', 'int', 'int', 'str16']) as CreateSemaphoreW,
    waitForSingleObject: kernel32.func('__stdcall', 'WaitForSingleObject', 'uint', ['intptr', 'uint']) as WaitForSingleObject,
    releaseSemaphore: kernel32.func('__stdcall', 'ReleaseSemaphore', 'int', ['intptr', 'int', 'void*']) as ReleaseSemaphore,
    closeHandle: kernel32.func('__stdcall', 'CloseHandle', 'int', ['intptr']) as CloseHandle,
    getLastError: kernel32.func('__stdcall', 'GetLastError', 'uint', []) as GetLastError,
  }
  return bindings
}

function errnoCode(win32Code: number): string {
  switch (win32Code) {
    case ERROR_FILE_NOT_FOUND:
    case ERROR_PATH_NOT_FOUND:
      return 'ENOENT'
    case ERROR_ACCESS_DENIED:
      return 'EACCES'
    case ERROR_NOT_SAME_DEVICE:
      return 'EXDEV'
    case ERROR_SHARING_VIOLATION:
      return 'EBUSY'
    case ERROR_FILE_EXISTS:
    case ERROR_ALREADY_EXISTS:
      return 'EEXIST'
    case ERROR_INVALID_NAME:
      return 'EINVAL'
    default:
      return 'EIO'
  }
}

function win32Error(syscall: string, win32Code: number, path: string, dest: string): Win32ErrnoException {
  const code = errnoCode(win32Code)
  const error = new Error(`${syscall} ${code} (Win32 ${win32Code}): ${path} -> ${dest}`) as Win32ErrnoException
  error.code = code
  error.errno = win32Code
  error.syscall = syscall
  error.path = path
  error.dest = dest
  error.win32Code = win32Code
  return error
}

function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

function isEEXIST(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'EEXIST'
}

async function assertDirectory(path: string): Promise<boolean> {
  try {
    // 裸的驱动器根目录本身就很短，而 Node 会把它扩展长度的写法当作 EISDIR 拒绝。
    // 后代路径保留命名空间，用于长路径探测。
    const probe = path === parse(path).root ? path : toNamespacedPath(path)
    const info = await stat(probe)
    if (info.isDirectory()) return true
    const error = new Error(`path exists but is not a directory: ${path}`) as NodeJS.ErrnoException
    error.code = 'ENOTDIR'
    error.path = path
    throw error
  } catch (error) {
    if (isENOENT(error)) return false
    throw error
  }
}

/**
 * 以 Windows 直写式重命名的语义将 `existing` 发布到 `replacement`。
 * 目标必须尚未存在；该移动必须留在同一卷内（未设置复制回退标志）。
 * @param existing - 要移动的、已同步的暂存路径。
 * @param replacement - 最终路径，该路径必须尚未存在。
 */
export async function publishNewFileWin32(existing: string, replacement: string): Promise<void> {
  const api = await win32()
  const ok = api.moveFileExW(toNamespacedPath(existing), toNamespacedPath(replacement), MOVEFILE_WRITE_THROUGH)
  if (ok === 0) throw win32Error('MoveFileExW', api.getLastError(), existing, replacement)
}

/**
 * 以命名内核信号量（计数为 1）的形式获取会话写锁，其名字由规范的锁路径派生。
 * 内核对象永不触及文件系统，因此在持锁期间读取、搜索与目录删除都能自由进行；
 * 第二个获取者的零超时等待会超时（`EBUSY`）；而当最后一个句柄关闭时——
 * 包括任何进程死亡的情形——该对象被销毁，因此后继者的 create 从全新状态开始。
 * @param path - 派生该名字所依据的锁文件路径（已做大小写折叠：
 *   Windows 路径是大小写不敏感的）。
 * @returns 已打开的信号量句柄，通过 {@link releaseLockHandleWin32} 释放。
 */
export async function acquireLockHandleWin32(path: string): Promise<number> {
  const api = await win32()
  const name = `Local\\dsh-session-lock-${createHash('sha256').update(resolve(path).toLowerCase()).digest('hex')}`
  const handle = api.createSemaphoreW(null, 1, 1, name)
  if (handle === 0) throw win32Error('CreateSemaphoreW', api.getLastError(), path, name)
  const wait = api.waitForSingleObject(handle, 0)
  if (wait === WAIT_OBJECT_0) return handle
  api.closeHandle(handle)
  if (wait === WAIT_TIMEOUT) throw win32Error('WaitForSingleObject', ERROR_SHARING_VIOLATION, path, name)
  throw win32Error('WaitForSingleObject', api.getLastError(), path, name)
}

/**
 * 释放来自 {@link acquireLockHandleWin32} 的锁：恢复信号量计数并关闭句柄
 * （该对象随其最后一个句柄一起消失）。
 * @param handle - 已打开的信号量句柄。
 */
export async function releaseLockHandleWin32(handle: number): Promise<void> {
  const api = await win32()
  const released = api.releaseSemaphore(handle, 1, null)
  const closed = api.closeHandle(handle)
  if (released === 0 || closed === 0) throw win32Error('ReleaseSemaphore', api.getLastError(), `handle:${handle}`, `handle:${handle}`)
}

/**
 * 以持久的 Windows 命名空间发布方式创建 `target` 及其缺失的祖先目录。
 * 每个缺失的目录先被创建为一个随机的暂存同级目录，然后以
 * `MOVEFILE_WRITE_THROUGH` 移动到其最终名字；与另一个创建者的竞态，
 * 只有在确认胜出者是目录之后才被接受。
 * @param target - 当不存在时要持久创建的绝对目录路径。
 */
export async function ensureDurableDirectoryWin32(target: string): Promise<void> {
  const absolute = resolve(target)
  const root = parse(absolute).root
  await assertDirectory(root)

  const segments = absolute.slice(root.length).split(/[\\/]+/).filter(part => part.length > 0)
  let current = root
  for (const segment of segments) {
    const next = join(current, segment)
    if (!await assertDirectory(next)) await createLeafDirectoryWin32(current, next)
    current = next
  }
}

async function createLeafDirectoryWin32(parent: string, target: string): Promise<void> {
  // 让暂存部分独立于目标基名，这样一个合法的 255 字节目标组件
  // 不会让 mkdtemp 的同级名字过长。
  const staging = await mkdtemp(toNamespacedPath(join(parent, '.dsh-mkdir-')))
  try {
    await publishNewFileWin32(staging, target)
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    if (isEEXIST(error) && await assertDirectory(target)) return
    throw error
  }
}
