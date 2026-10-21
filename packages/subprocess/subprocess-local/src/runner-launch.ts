/** 私有原生 runner 的父进程侧调用与引导状态。 */

import type { StdioOptions } from 'node:child_process'
import { accessSync, constants as fsConstants, lstatSync, statSync } from 'node:fs'
import { extname, isAbsolute } from 'node:path'
import { inspect } from 'node:util'
import { fileURLToPath } from 'node:url'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { childEnv } from './spawn.ts'
import { controlEnvironment } from './control-spawn.ts'
import { SUBPROCESS_CONTROL_FD } from '@deepseek-ai/dsh-subprocess/control'

/** 在目标状态恢复之前被消费的唯一私有环境变量。 */
export const SUBPROCESS_RUNNER_ENV = 'DSH_SUBPROCESS_RUNNER' as const

/** 打包引导程序用于 Windows IPC runner 的哨兵值。 */
export const WINDOWS_RUNNER_SELECTION = 'windows' as const

/** 用于启动私有 runner 入口的非空命令元组。 */
export type RunnerInvocation = [string, ...string[]]

const SOURCE_TSCONFIG_PATH = fileURLToPath(new URL('../../../../tsconfig.base.json', import.meta.url))
const RUNNER_CONTROL_ENV_PREFIXES = ['NODE_', 'TSX_'] as const

/**
 * 解析调用同一 runner 核心的源码、构建产物或打包入口。
 * @returns 当前运行时形态的可执行文件与参数。
 */
export function spawnRunnerInvocation(): RunnerInvocation {
  if ('pkg' in process) return [process.execPath]
  /* v8 ignore next -- built-artifact smoke imports the emitted JavaScript runner entry;
   * source-unit coverage cannot change import.meta.url. */
  if (extname(fileURLToPath(import.meta.url)) !== '.ts') {
    return [process.execPath, fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-subprocess-local/runner'))]
  }
  return [
    process.execPath,
    '--import',
    import.meta.resolve('tsx/esm'),
    fileURLToPath(new URL('./bin.ts', import.meta.url)),
  ]
}

/**
 * 在不执行探测模式的前提下，检查具体的 runner 可执行文件与入口路径。
 * @param invocation - 已解析的可执行文件与 runner 入口参数。
 * @returns 每一个具体的可执行文件或入口路径是否都可访问。
 */
export function runnerInvocationAvailable(invocation: RunnerInvocation = spawnRunnerInvocation()): boolean {
  try {
    if (isAbsolute(invocation[0])) accessSync(invocation[0], fsConstants.X_OK)
    const entry = invocation.at(-1)
    if (entry !== undefined && entry !== invocation[0] && isAbsolute(entry)) {
      accessSync(entry, fsConstants.R_OK)
    }
    return true
  } catch {
    return false
  }
}

/**
 * 构建对引导程序安全的环境；目标覆盖项经由请求/IPC 到达。
 * @param selection - 私有 runner 选择器或 Linux 启动请求定位符。
 * @param invocation - 已解析的 runner 调用，其源码形态需要工作区路径映射。
 * @returns 在目标状态恢复之前、供 runner 使用的环境。
 */
export function runnerEnvironment(
  selection: string,
  invocation?: RunnerInvocation,
): NodeJS.ProcessEnv {
  const entry = invocation?.at(-1)
  const env = childEnv()
  for (const name of Object.keys(env)) {
    const normalized = name.toUpperCase()
    if (RUNNER_CONTROL_ENV_PREFIXES.some(prefix => normalized.startsWith(prefix))) {
      Reflect.deleteProperty(env, name)
    }
  }
  return {
    ...env,
    [SUBPROCESS_RUNNER_ENV]: selection,
    SYSTEMD_LOG_TARGET: 'null',
    ...entry?.endsWith('.ts') === true ? { TSX_TSCONFIG_PATH: SOURCE_TSCONFIG_PATH } : {},
  }
}

/**
 * 在导入或恢复目标状态之前，读取并删除私有选择器。
 * @param env - 包含私有选择器的可变环境。
 * @returns 被消费的选择器；当没有请求 runner 时为 undefined。
 */
export function consumeRunnerSelection(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const selection = env[SUBPROCESS_RUNNER_ENV]
  Reflect.deleteProperty(env, SUBPROCESS_RUNNER_ENV)
  return selection
}

/**
 * 要求存在私有 argv 分隔符，且其后至少有一个目标 argv 条目。
 * @param argv - 私有 runner 参数。
 * @returns 私有分隔符之后的、被复制的目标 argv。
 */
export function parseRunnerTargetArgv(argv: readonly string[]): string[] {
  if (argv[0] !== '--' || argv.length < 2) {
    throw new Error('subprocess runner requires target argv after a private -- delimiter')
  }
  return [...argv.slice(1)]
}

/**
 * 构建直接的 Linux 目标 stdio，或隔离的 Windows runner stdio：fd 3 上承载 IPC，
 * fd 4 到 fd 6 承载目标，可选的 control 使用 fd 7。
 * @param spec - stdio 模式被保留的普通 subprocess 请求。
 * @param ipc - 是否隔离 runner 并加入其私有 Node IPC 描述符。
 * @param stdinCarrier - runner 的 fd 4 载体；Windows 的 ignore 传入一个已打开的空设备 fd。
 * @returns 供 runner 使用的子进程 stdio 选项。
 */
export function runnerStdio(
  spec: SubprocessSpawnSpec,
  ipc: boolean,
  stdinCarrier: 'pipe' | number = 'pipe',
): StdioOptions {
  const targetStdio: StdioOptions = [
    spec.stdio.stdin === 'ignore' ? 'ignore' : 'pipe',
    spec.stdio.stdout === 'inherit' ? 'inherit' : 'pipe',
    spec.stdio.stderr === 'inherit' ? 'inherit' : 'pipe',
  ]
  if (!ipc) {
    if (spec.stdio.control === 'pipe') {
      while (targetStdio.length < SUBPROCESS_CONTROL_FD) targetStdio.push('ignore')
      targetStdio.push('overlapped')
    }
    return targetStdio
  }
  const runner: StdioOptions = [
    'ignore',
    'ignore',
    'ignore',
    'ipc',
    stdinCarrier,
    spec.stdio.stdout === 'inherit' ? 1 : 'pipe',
    spec.stdio.stderr === 'inherit' ? 2 : 'pipe',
  ]
  if (spec.stdio.control === 'pipe') runner.push('overlapped')
  return runner
}

function windowsEnvironmentValue(
  env: Readonly<Record<string, string | undefined>>,
  name: 'PATH' | 'NODEFAULTCURRENTDIRECTORYINEXEPATH',
): string | undefined {
  for (const key of Object.keys(env).sort()) {
    if (key.toUpperCase() === name) return env[key]
  }
  return undefined
}

function executableCandidateExists(candidate: string): boolean {
  try {
    return !statSync(candidate).isDirectory()
  } catch {
    try {
      const entry = lstatSync(candidate)
      return entry.isFile() || entry.isSymbolicLink()
    } catch {
      return false
    }
  }
}

function windowsPathDirectories(path: string): string[] {
  const directories: string[] = []
  let start = 0
  while (start < path.length) {
    if (path.charAt(start) === ';') {
      start += 1
      continue
    }
    const quote = path.charAt(start)
    const quoted = quote === '"' || quote === "'"
    const quoteEnd = quoted
      ? path.indexOf(quote, start + 1)
      : -1
    const separator = path.indexOf(';', quoted ? quoteEnd < 0 ? path.length : quoteEnd : start)
    const end = separator < 0 ? path.length : separator
    let directory = path.slice(start, end)
    if (directory.startsWith('"') || directory.startsWith("'")) directory = directory.slice(1)
    if (directory.endsWith('"') || directory.endsWith("'")) directory = directory.slice(0, -1)
    if (directory.length > 0) directories.push(directory)
    start = end + 1
  }
  return directories
}

function windowsFileNameStart(command: string): number {
  let start = command.length
  while (start > 0 && !/[\\/:]/u.test(command.charAt(start - 1))) start -= 1
  return start
}

function windowsSearchPathJoin(directory: string, name: string, cwd: string): string {
  let prefix = cwd
  let adjustedDirectory = directory
  const slash = (value: string): boolean => value === '\\' || value === '/'
  if (directory.length > 2 && slash(directory.charAt(0)) && slash(directory.charAt(1))) {
    prefix = ''
  } else if (directory.length >= 1 && slash(directory.charAt(0))) {
    prefix = cwd.slice(0, 2)
  } else if (
    directory.length >= 2
    && directory.charAt(1) === ':'
    && (directory.length < 3 || !slash(directory.charAt(2)))
  ) {
    if (cwd.length < 2 || cwd.slice(0, 2).toLowerCase() !== directory.slice(0, 2).toLowerCase()) {
      prefix = ''
    } else {
      adjustedDirectory = directory.slice(2)
    }
  } else if (directory.length > 2 && directory.charAt(1) === ':') {
    prefix = ''
  }

  const append = (base: string, part: string): string => {
    if (base.length === 0 || part.length === 0) return base + part
    return /[\\/:]$/u.test(base) ? base + part : `${base}\\${part}`
  }
  return append(append(prefix, adjustedDirectory), name)
}

function windowsExecutableNames(command: string, name: string): string[] {
  const dot = name.indexOf('.')
  const hasExtension = dot >= 0 && dot < name.length - 1
  const separator = name.endsWith('.') ? '' : '.'
  return [
    ...hasExtension ? [command] : [],
    `${command}${separator}com`,
    `${command}${separator}exe`,
  ]
}

/**
 * 以 libuv/Node 的 Windows 启动搜索顺序解析可执行文件路径，同时把调用方原始的
 * 命令行 argv 条目单独保留下来。
 * @param command - 原始目标 argv[0]。
 * @param cwd - 用于相对搜索根的最终目标工作目录。
 * @param env - 包含子进程 PATH 的最终目标环境。
 * @param exists - 由测试使用的、可注入的非目录候选探测。
 * @param currentEnv - 提供 PATH 回退与 cwd 搜索策略的 runner 环境。
 * @returns 适用于 `CreateProcessW` 的、已解析的应用名；当不存在任何候选时为 undefined。
 */
export function resolveWindowsExecutable(
  command: string,
  cwd: string,
  env: Readonly<Record<string, string>>,
  exists: (candidate: string) => boolean = executableCandidateExists,
  currentEnv: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const nameStart = windowsFileNameStart(command)
  const directory = command.slice(0, nameStart)
  const name = command.slice(nameStart)
  const hasPath = nameStart !== 0
  const roots: string[] = []
  if (hasPath) {
    roots.push(directory)
  } else {
    if (windowsEnvironmentValue(currentEnv, 'NODEFAULTCURRENTDIRECTORYINEXEPATH') === undefined) {
      roots.push('')
    }
    const path = windowsEnvironmentValue(env, 'PATH') ?? windowsEnvironmentValue(currentEnv, 'PATH') ?? ''
    roots.push(...windowsPathDirectories(path))
  }

  for (const root of roots) {
    const base = windowsSearchPathJoin(root, name, cwd)
    for (const candidate of windowsExecutableNames(base, name)) {
      if (exists(candidate)) return candidate
    }
  }

  return undefined
}

function throwNullByteError(property: string, value: string, argument: boolean): never {
  const subject = argument ? `The argument '${property}'` : `The property '${property}'`
  const error = new TypeError(`${subject} must be a string without null bytes. Received ${inspect(value)}`)
  Object.assign(error, { code: 'ERR_INVALID_ARG_VALUE' })
  throw error
}

function validateNoNullByte(property: string, value: string, argument = false): void {
  if (value.includes('\0')) throwNullByteError(property, value, argument)
}

/**
 * 物化并同步校验最终的目标环境。
 * @param spec - 最终目标的 argv、cwd 与环境覆盖项。
 * @returns 经过等同于 Node 的校验之后的完整目标环境。
 */
export function targetEnvironment(
  spec: Pick<SubprocessSpawnSpec, 'argv' | 'cwd' | 'env'> & { stdio?: SubprocessSpawnSpec['stdio'] },
): Record<string, string> {
  spec.argv.forEach((value, index) => {
    validateNoNullByte(index === 0 ? 'file' : `args[${String(index - 1)}]`, value, true)
  })
  validateNoNullByte('options.cwd', spec.cwd)
  const env = Object.fromEntries(
    Object.entries(childEnv(spec.env)).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  for (const [key, value] of Object.entries(env)) {
    validateNoNullByte(`options.env['${key}']`, key)
    validateNoNullByte(`options.env['${key}']`, value)
  }
  return controlEnvironment(env, spec.stdio?.control)
}
