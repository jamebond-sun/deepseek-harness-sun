/** 原生 subprocess runner 所共享的封闭私有传输。 */

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'

/** 由 Linux 引导程序在 systemd 建立 scope 之后恢复的目标状态。 */
export interface LinuxLaunchRequest {
  cwd: string
  env: Record<string, string>
  control?: 'pipe'
}

/** 允许跨私有 runner 边界传递的、有界的 Node 形态错误字段。 */
export interface SerializedRunnerError {
  name: string
  message: string
  code?: string
  syscall?: string
  path?: string
}

/** 与已消费请求并列发布的、Linux 预执行失败。 */
export type LinuxStartupError =
  { type: 'error'; error: SerializedRunnerError }

/** Windows 上唯一的“父进程到 runner”启动消息。 */
export interface WindowsStartRequest {
  type: 'start'
  cwd: string
  env: Record<string, string>
  control?: 'pipe'
}

/** Windows 上唯一的“父进程到 runner”控制消息。 */
export interface WindowsTerminateRequest {
  type: 'terminate'
}

/** 一个已连接的 Windows runner 只发送其中一条直接结果分支。 */
export type WindowsRunnerResult =
  | { type: 'target-exit'; exitCode: number }
  | { type: 'error'; error: SerializedRunnerError }

/** 一次 Linux 普通或 PTY 启动所拥有的私有路径。 */
export interface LinuxLaunchFiles {
  directory: string
  requestPath: string
  startupErrorPath: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional])
  return required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => allowed.has(key))
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(entry => typeof entry === 'string')
}

function isSerializedRunnerError(value: unknown): value is SerializedRunnerError {
  if (!isRecord(value) || !hasExactKeys(
    value,
    ['name', 'message'],
    ['code', 'syscall', 'path'],
  )) return false
  return typeof value.name === 'string'
    && typeof value.message === 'string'
    && (value.code === undefined || typeof value.code === 'string')
    && (value.syscall === undefined || typeof value.syscall === 'string')
    && (value.path === undefined || typeof value.path === 'string')
}

function parseErrorResult(value: Record<string, unknown>): LinuxStartupError {
  if (!hasExactKeys(value, ['type', 'error']) || !isSerializedRunnerError(value.error)) {
    throw new Error('subprocess runner emitted an invalid error result')
  }
  if (value.type !== 'error') {
    throw new Error('subprocess runner emitted an unknown error result')
  }
  return { type: 'error', error: value.error }
}

/**
 * 创建一个私有 0700 目录，以及一份完整的 0600 启动请求。
 * @param request - 供引导程序使用的目标 cwd 与完整环境。
 * @returns 本次启动所拥有的私有路径。
 */
export function createLinuxLaunchFiles(request: LinuxLaunchRequest): LinuxLaunchFiles {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-subprocess-launch-'))
  const files = {
    directory,
    requestPath: join(directory, 'launch-request.json'),
    startupErrorPath: join(directory, 'startup-error.json'),
  }
  try {
    chmodSync(directory, 0o700)
    writeFileSync(files.requestPath, JSON.stringify(request), { flag: 'wx', mode: 0o600 })
    return files
  } catch (error) {
    cleanupLinuxLaunchFiles(files)
    throw error
  }
}

/**
 * 从绝对请求定位符推导出唯一允许的启动错误路径。
 * @param requestPath - 私有启动请求文件的绝对路径。
 * @returns 本次启动经过校验的同级路径。
 */
export function linuxLaunchFilesFromLocator(requestPath: string): LinuxLaunchFiles {
  if (!isAbsolute(requestPath) || basename(requestPath) !== 'launch-request.json') {
    throw new Error('subprocess runner received an invalid Linux launch-request locator')
  }
  const directory = dirname(requestPath)
  return { directory, requestPath, startupErrorPath: join(directory, 'startup-error.json') }
}

/**
 * 严格读取并删除一份一次性的 Linux 启动请求。
 * @param requestPath - 待消费的私有启动请求路径。
 * @returns 经过校验的目标 cwd 与环境。
 */
export function consumeLinuxLaunchRequest(requestPath: string): LinuxLaunchRequest {
  const text = readFileSync(requestPath, 'utf8')
  unlinkSync(requestPath)
  const value: unknown = JSON.parse(text)
  if (!isRecord(value) || !hasExactKeys(value, ['cwd', 'env'], ['control'])
    || typeof value.cwd !== 'string' || !isStringRecord(value.env)
    || (value.control !== undefined && value.control !== 'pipe')) {
    throw new Error('subprocess runner received an invalid Linux launch request')
  }
  return { cwd: value.cwd, env: value.env, ...value.control === 'pipe' ? { control: 'pipe' as const } : {} }
}

/**
 * 发布一份严格的 0600 Linux 预执行错误。
 * @param files - 本次启动的私有路径。
 * @param error - 要发布的、有界的启动或 runner 失败。
 */
export function writeLinuxStartupError(files: LinuxLaunchFiles, error: LinuxStartupError): void {
  writeFileSync(files.startupErrorPath, JSON.stringify(error), { flag: 'wx', mode: 0o600 })
}

/**
 * 读取 Linux 预执行错误，前提是引导程序已发布过。
 * @param path - 预期的启动错误路径。
 * @returns 经过校验的失败；当未发布任何内容时为 undefined。
 */
export function readLinuxStartupError(path: string): LinuxStartupError | undefined {
  if (!existsSync(path)) return undefined
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!isRecord(value)) throw new Error('subprocess runner emitted an invalid startup error')
  return parseErrorResult(value)
}

/**
 * 严格解析唯一一条 Windows 启动消息。
 * @param value - 不可信的 IPC 载荷。
 * @returns 经过校验的目标启动请求。
 */
export function parseWindowsStartRequest(value: unknown): WindowsStartRequest {
  if (!isRecord(value) || !hasExactKeys(value, ['type', 'cwd', 'env'], ['control'])
    || value.type !== 'start' || typeof value.cwd !== 'string' || !isStringRecord(value.env)
    || (value.control !== undefined && value.control !== 'pipe')) {
    throw new Error('subprocess runner received an invalid Windows start request')
  }
  return { type: 'start', cwd: value.cwd, env: value.env, ...value.control === 'pipe' ? { control: 'pipe' as const } : {} }
}

/**
 * 仅对精确且不含载荷的 Windows 终止控制返回 true。
 * @param value - 不可信的 IPC 载荷。
 * @returns 该载荷是否就是精确的终止请求。
 */
export function isWindowsTerminateRequest(value: unknown): value is WindowsTerminateRequest {
  return isRecord(value) && hasExactKeys(value, ['type']) && value.type === 'terminate'
}

/**
 * 严格解析两条 Windows 直接结果分支中的一条。
 * @param value - 不可信的 IPC 载荷。
 * @returns 经过校验的直接结果消息。
 */
export function parseWindowsRunnerResult(value: unknown): WindowsRunnerResult {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new Error('subprocess runner emitted an invalid Windows result')
  }
  if (value.type === 'error') return parseErrorResult(value)
  if (value.type === 'target-exit') {
    const validExitCode = typeof value.exitCode === 'number'
      && Number.isSafeInteger(value.exitCode)
      && value.exitCode >= 0
    if (!hasExactKeys(value, ['type', 'exitCode']) || !validExitCode) {
      throw new Error('subprocess runner emitted an invalid target-exit result')
    }
    return {
      type: 'target-exit',
      exitCode: value.exitCode as number,
    }
  }
  throw new Error(`subprocess runner emitted an unknown Windows result: ${value.type}`)
}

/**
 * 将一个未知失败转换为有界的跨进程错误记录。
 * @param error - 在进程边界处捕获的失败。
 * @returns 有界的可序列化错误字段。
 */
export function serializeRunnerError(error: unknown): SerializedRunnerError {
  const source = error instanceof Error ? error : new Error(String(error))
  const node = source as NodeJS.ErrnoException & { path?: string }
  return {
    name: source.name,
    message: source.message,
    ...typeof node.code === 'string' ? { code: node.code } : {},
    ...typeof node.syscall === 'string' ? { syscall: node.syscall } : {},
    ...typeof node.path === 'string' ? { path: node.path } : {},
  }
}

/**
 * 从一份严格的 runner 记录重建一个 Node 形态 Error。
 * @param serialized - 经过校验的有界错误字段。
 * @returns 带有受支持 Node 字段的、重建后的 Error。
 */
export function deserializeRunnerError(serialized: SerializedRunnerError): Error {
  const error = new Error(serialized.message)
  error.name = serialized.name
  return Object.assign(error, {
    ...serialized.code === undefined ? {} : { code: serialized.code },
    ...serialized.syscall === undefined ? {} : { syscall: serialized.syscall },
    ...serialized.path === undefined ? {} : { path: serialized.path },
  })
}

/**
 * 尽最大努力、只移除为本次 Linux 启动创建的私有路径。
 * @param files - 本次启动精确拥有的私有路径。
 */
export function cleanupLinuxLaunchFiles(files: LinuxLaunchFiles): void {
  try {
    if (lstatSync(files.directory).isSymbolicLink()) {
      unlinkSync(files.directory)
      return
    }
    for (const path of [
      files.requestPath,
      files.startupErrorPath,
    ]) {
      try { unlinkSync(path) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    rmdirSync(files.directory)
  } catch {
    // 崩溃残留仍是私有的，且后续任何启动都不会复用这个目录。
  }
}
