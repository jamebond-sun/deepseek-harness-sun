/** 建立在共享绑定表之上的、带类型的 Win32 进程操作。 */

import * as abi from './abi.ts'
import { inheritedControlStdio } from './control-stdio.ts'
import {
  allocProcessInfo,
  allocPtrSlot,
  allocStartupInfo,
  allocUint32,
  decodeProcessInfo,
  decodePtr,
  decodeUint32,
  encodeStartupInfo,
  isNullPtr,
  throwLastError,
  throwWin32,
} from './ffi.ts'
import type { CurrentTokenProcessBindings, NativePtr, Win32ProcessBindings } from './ffi.ts'
import { requireKoffi } from './koffi.ts'

/**
 * 依据 CommandLineToArgvW 的解析规则引用一个参数。
 * @param argument - 一个 argv 条目。
 * @returns 裸写或带引号的命令行片段。
 */
export function quoteArg(argument: string): string {
  if (argument === '') return '""'
  if (!/[\s"]/u.test(argument)) return argument
  let quoted = '"'
  for (let index = 0; index < argument.length; index++) {
    let backslashes = 0
    while (index < argument.length && argument.charAt(index) === '\\') {
      backslashes += 1
      index += 1
    }
    if (index === argument.length) {
      quoted += '\\'.repeat(backslashes * 2)
    } else if (argument.charAt(index) === '"') {
      quoted += '\\'.repeat(backslashes * 2 + 1) + '"'
    } else {
      quoted += '\\'.repeat(backslashes) + argument.charAt(index)
    }
  }
  return quoted + '"'
}

/**
 * 构建 CreateProcessAsUserW 所接受的、可变的命令行。
 * @param program - 可执行文件的 argv 条目。
 * @param args - 其余 argv 条目。
 * @returns 拼接后的 Win32 命令行。
 */
export function buildCommandLine(program: string, args: readonly string[]): string {
  return [program, ...args].map(quoteArg).join(' ')
}

function compareWindowsEnvironmentKeys(
  [left]: readonly [string, string],
  [right]: readonly [string, string],
): number {
  const foldedLeft = left.toUpperCase()
  const foldedRight = right.toUpperCase()
  return foldedLeft < foldedRight ? -1 : foldedLeft > foldedRight ? 1 : 0
}

function encodeWindowsEnvironment(env: Readonly<Record<string, string>>): Buffer {
  const entries = Object.entries(env).sort(compareWindowsEnvironmentKeys)
  const strings = entries.map(([key, value]) => `${key}=${value}`)
  return Buffer.from(`${strings.join('\0')}\0\0`, 'utf16le')
}

interface ProcessSpawnOptions {
  /** 经由 CreateProcess 传入的可执行文件 argv 条目。 */
  command: string
  /** 不含可执行文件在内的参数。 */
  args: readonly string[]
  /** 既有的子进程工作目录。 */
  cwd: string
}

/** 由本地 Win32 runner 使用的普通进程创建输入。 */
export interface CurrentTokenProcessSpawnOptions extends ProcessSpawnOptions {
  /** 与保留的 argv 条目分开传入的、已解析的可执行文件路径。 */
  applicationName: string
  /** 在不改动 runner 的前提下传入的完整目标环境。 */
  env: Readonly<Record<string, string>>
  /** 携带目标 stdin、stdout 与 stderr 的 runner CRT 描述符。 */
  stdio: CurrentTokenStdioFileDescriptors
}

/** 其 OS 句柄会成为目标标准句柄的 runner CRT 描述符。 */
export interface CurrentTokenStdioFileDescriptors {
  stdin: number
  stdout: number
  stderr: number
  /** 针对被继承控制管道的可选载体与目标描述符。 */
  control?: 7
}

/** 由 Windows ACL 沙箱拥有的、受限令牌的进程创建输入。 */
export interface RestrictedProcessSpawnOptions extends ProcessSpawnOptions {
  /** 由沙箱策略提供的受限主令牌。 */
  token: NativePtr
  /** 在载荷中以相同描述符被继承的可选控制管道。 */
  controlFileDescriptor?: 7
}

/** 其进程与读取句柄仍由调用方拥有的、管道化的子进程资源。 */
export interface SpawnedPipedProcess {
  /** 直接子进程 id。 */
  pid: number
  /** 由 waitForProcessExit 关闭的进程句柄。 */
  process: NativePtr
  /** 由 drainPipe 关闭的 stdout 管道读取端。 */
  stdoutRead: NativePtr
  /** 由 drainPipe 关闭的 stderr 管道读取端。 */
  stderrRead: NativePtr
}

/** 在恢复之前被指派给一个调用方拥有的 kill-on-close Job 的暂停子进程。 */
export interface SpawnedJobProcess {
  /** 直接子进程 id。 */
  pid: number
  /** 由 waitForProcessExit 关闭的进程句柄。 */
  process: NativePtr
  /** 由生命周期所有者关闭的 Job 句柄。 */
  job: NativePtr
}

interface PipePair {
  read: NativePtr
  write: NativePtr
}

function freeNative(pointer: NativePtr | undefined): void {
  if (pointer !== undefined) requireKoffi().free(pointer)
}

function closeBestEffort(api: Win32ProcessBindings, handle: NativePtr | null | undefined): void {
  if (!isNullPtr(handle)) api.closeHandle(handle)
}

function createPipe(api: Win32ProcessBindings, owned: Set<NativePtr>): PipePair {
  const readSlot = allocPtrSlot()
  let writeSlot: NativePtr | undefined
  try {
    writeSlot = allocPtrSlot()
    if (api.createPipe(readSlot, writeSlot, null, 0) === 0) throwLastError(api, 'CreatePipe')
    const read = decodePtr(readSlot)
    const write = decodePtr(writeSlot)
    if (read === null || write === null) {
      closeBestEffort(api, read)
      closeBestEffort(api, write)
      throwLastError(api, 'CreatePipe', 'null pipe handle')
    }
    owned.add(read)
    owned.add(write)
    return { read, write }
  } finally {
    freeNative(writeSlot)
    requireKoffi().free(readSlot)
  }
}

function closeOwned(api: Win32ProcessBindings, owned: Set<NativePtr>, handle: NativePtr): void {
  /* v8 ignore next -- 每一个被成功解码的管道端都是唯一拥有的。 */
  if (!owned.delete(handle)) return
  api.closeHandle(handle)
}

function closeAllOwned(api: Win32ProcessBindings, owned: Set<NativePtr>): void {
  for (const handle of owned) api.closeHandle(handle)
  owned.clear()
}

function createRestrictedProcess(
  api: Win32ProcessBindings,
  options: RestrictedProcessSpawnOptions,
  commandLine: string,
  creationFlags: number,
  startupInfo: NativePtr,
  processInfo: NativePtr,
): number {
  // 沙箱在这次调用之前会改变其进程环境。经由 Koffi 传入一个显式环境块会让
  // CreateProcessAsUserW 以 ERROR_INVALID_PARAMETER 拒绝该请求，因此 lpEnvironment 保持 NULL。
  return api.createProcessAsUserW(
    options.token,
    null,
    commandLine,
    null,
    null,
    1,
    creationFlags,
    null,
    options.cwd,
    startupInfo,
    processInfo,
  )
}

/**
 * 以匿名管道 stdout/stderr 与立即的 stdin EOF 启动一个进程。
 * 新的控制台窗口以隐藏方式启动，且不改变控制台继承关系。
 * @param api - 当前活动的绑定表。
 * @param options - 命令、cwd、参数，以及受限主令牌。
 * @returns 由调用方拥有的进程与管道读取句柄。
 */
export function spawnPipedProcess(
  api: Win32ProcessBindings,
  options: RestrictedProcessSpawnOptions,
): SpawnedPipedProcess {
  const owned = new Set<NativePtr>()
  let startupInfo: NativePtr | undefined
  let processInfo: NativePtr | undefined
  try {
    const stdIn = createPipe(api, owned)
    const stdOut = createPipe(api, owned)
    const stdErr = createPipe(api, owned)
    for (const [handle, label] of [
      [stdIn.read, 'stdin read end'],
      [stdOut.write, 'stdout write end'],
      [stdErr.write, 'stderr write end'],
    ] as const) {
      if (api.setHandleInformation(handle, abi.HANDLE_FLAG_INHERIT, abi.HANDLE_FLAG_INHERIT) === 0) {
        throwLastError(api, 'SetHandleInformation', label)
      }
    }
    startupInfo = allocStartupInfo()
    encodeStartupInfo(startupInfo, {
      cb: abi.STARTUPINFOW_SIZE,
      dwFlags: abi.STARTF_USESTDHANDLES | abi.STARTF_USESHOWWINDOW,
      wShowWindow: abi.SW_HIDE,
      hStdInput: stdIn.read,
      hStdOutput: stdOut.write,
      hStdError: stdErr.write,
    })
    processInfo = allocProcessInfo()
    const created = createRestrictedProcess(
      api,
      options,
      buildCommandLine(options.command, options.args),
      0,
      startupInfo,
      processInfo,
    )
    if (created === 0) {
      const win32Code = api.getLastError()
      throwWin32(api, 'CreateProcessAsUserW', win32Code, `command: ${options.command}, cwd: ${options.cwd}`)
    }
    const info = decodeProcessInfo(processInfo)
    if (info.hProcess === null || info.hThread === null) {
      if (info.hProcess !== null) api.terminateProcess(info.hProcess, 1)
      closeBestEffort(api, info.hThread)
      closeBestEffort(api, info.hProcess)
      throw new Error(`CreateProcessAsUserW succeeded but returned null process/thread handles (pid ${info.dwProcessId})`)
    }
    closeOwned(api, owned, stdIn.read)
    closeOwned(api, owned, stdIn.write)
    closeOwned(api, owned, stdOut.write)
    closeOwned(api, owned, stdErr.write)
    closeBestEffort(api, info.hThread)
    owned.delete(stdOut.read)
    owned.delete(stdErr.read)
    return {
      pid: info.dwProcessId,
      process: info.hProcess,
      stdoutRead: stdOut.read,
      stderrRead: stdErr.read,
    }
  } catch (error) {
    closeAllOwned(api, owned)
    throw error
  } finally {
    freeNative(processInfo)
    freeNative(startupInfo)
  }
}

/**
 * 排空一个匿名管道，直到写入端将其关闭。
 * @param api - 当前活动的绑定表。
 * @param handle - 由调用方拥有的管道读取端。
 * @returns 在 EOF 之前读取到的完整字节；该句柄总是会被关闭。
 * @throws 当某个 Win32 管道操作失败时。
 */
export async function drainPipe(
  api: Win32ProcessBindings,
  handle: NativePtr,
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let countSlot: NativePtr | undefined
  try {
    countSlot = allocUint32()
    for (;;) {
      const peeked = api.peekNamedPipe(handle, null, 0, null, countSlot, null)
      if (peeked === 0) {
        const win32Code = api.getLastError()
        if (win32Code === abi.ERROR_BROKEN_PIPE || win32Code === abi.ERROR_NO_DATA) break
        throwLastError(api, 'PeekNamedPipe', `drain failure after ${chunks.length} chunk(s)`)
      }
      const available = decodeUint32(countSlot)
      if (available > 0) {
        const chunk = Buffer.alloc(available)
        if (api.readFile(handle, chunk, chunk.length, countSlot, null) === 0) {
          throwLastError(api, 'ReadFile', `drain failure after ${chunks.length} chunk(s)`)
        }
        chunks.push(chunk.subarray(0, decodeUint32(countSlot)))
      }
      await new Promise<void>(resolve => setTimeout(resolve, 1))
    }
    return Buffer.concat(chunks)
  } finally {
    freeNative(countSlot)
    api.closeHandle(handle)
  }
}

/**
 * 等待一个进程，并始终关闭其句柄。
 * @param api - 当前活动的绑定表。
 * @param process - 由调用方拥有的进程句柄。
 * @returns 直接进程退出码。
 */
export function waitForProcessExit(api: Win32ProcessBindings, process: NativePtr): number {
  let exitCodeSlot: NativePtr | undefined
  try {
    if (api.waitForSingleObject(process, abi.INFINITE) === 0xFFFFFFFF) {
      throwLastError(api, 'WaitForSingleObject')
    }
    exitCodeSlot = allocUint32()
    if (api.getExitCodeProcess(process, exitCodeSlot) === 0) throwLastError(api, 'GetExitCodeProcess')
    return decodeUint32(exitCodeSlot)
  } finally {
    freeNative(exitCodeSlot)
    api.closeHandle(process)
  }
}

function createKillOnCloseJob(api: Win32ProcessBindings): NativePtr {
  const job = api.createJobObjectW(null, null)
  if (isNullPtr(job)) throwLastError(api, 'CreateJobObjectW')
  const information = Buffer.alloc(abi.JOBOBJECT_EXTENDED_LIMIT_SIZE)
  information.writeUInt32LE(
    abi.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    abi.JOBOBJECT_EXTENDED_LIMIT_FLAGS_OFFSET,
  )
  if (api.setInformationJobObject(
    job,
    abi.JobObjectExtendedLimitInformation,
    information,
    information.length,
  ) === 0) {
    const win32Code = api.getLastError()
    api.closeHandle(job)
    throwWin32(api, 'SetInformationJobObject', win32Code)
  }
  return job
}

interface ProcessStandardHandles {
  stdin: NativePtr
  stdout: NativePtr
  stderr: NativePtr
  control?: { fileDescriptor: 7; handle: NativePtr }
}

// 在受支持的 Windows 主机上，Koffi 把 PVOID 暴露为一个无符号 64 位 bigint。
const UV_INVALID_OS_FILE_HANDLE = 0xffff_ffff_ffff_ffffn
const UV_INVALID_FILE_DESCRIPTOR = 0xffff_ffff_ffff_fffen

function inheritedStandardHandles(api: Win32ProcessBindings, controlFileDescriptor?: 7): ProcessStandardHandles {
  const get = (selector: number, label: string): NativePtr => {
    const handle = api.getStdHandle(selector)
    if (!isNullPtr(handle)) return handle
    throwLastError(api, 'GetStdHandle', `null ${label} handle`)
  }
  return {
    stdin: get(abi.STD_INPUT_HANDLE, 'stdin'),
    stdout: get(abi.STD_OUTPUT_HANDLE, 'stdout'),
    stderr: get(abi.STD_ERROR_HANDLE, 'stderr'),
    ...controlFileDescriptor === undefined ? {} : {
      control: { fileDescriptor: controlFileDescriptor, handle: descriptorHandle(api, controlFileDescriptor, 'control') },
    },
  }
}

function descriptorHandle(api: Win32ProcessBindings, fileDescriptor: number, label: string): NativePtr {
  const handle = api.uvGetOsfhandle(fileDescriptor)
  if (
    isNullPtr(handle)
      || handle === UV_INVALID_OS_FILE_HANDLE
      || handle === UV_INVALID_FILE_DESCRIPTOR
  ) {
    throw new Error(`uv_get_osfhandle returned an invalid handle for target ${label} fd ${String(fileDescriptor)}`)
  }
  return handle
}

function targetCarrierHandles(
  api: CurrentTokenProcessBindings,
  descriptors: CurrentTokenStdioFileDescriptors,
): ProcessStandardHandles {
  return {
    stdin: descriptorHandle(api, descriptors.stdin, 'stdin'),
    stdout: descriptorHandle(api, descriptors.stdout, 'stdout'),
    stderr: descriptorHandle(api, descriptors.stderr, 'stderr'),
    ...descriptors.control === undefined ? {} : {
      control: { fileDescriptor: descriptors.control, handle: descriptorHandle(api, descriptors.control, 'control') },
    },
  }
}

/** 共享的“暂停创建、Job 指派、恢复”生命周期。 */
function spawnJobProcess(
  api: Win32ProcessBindings,
  options: ProcessSpawnOptions,
  resolveStdio: () => ProcessStandardHandles,
  createName: 'CreateProcessAsUserW' | 'CreateProcessW',
  create: (startupInfo: NativePtr, processInfo: NativePtr) => number,
): SpawnedJobProcess {
  const job = createKillOnCloseJob(api)
  const enabled: NativePtr[] = []
  let startupInfo: NativePtr | undefined
  let processInfo: NativePtr | undefined
  let controlDescriptorBlock: { pointer: NativePtr; length: number } | undefined
  let created = 0
  let createFailureCode = 0
  try {
    const stdio = resolveStdio()
    const inherited: Array<readonly [NativePtr, string]> = [
      [stdio.stdin, 'stdin'],
      [stdio.stdout, 'stdout'],
      [stdio.stderr, 'stderr'],
    ]
    if (stdio.control !== undefined) inherited.push([stdio.control.handle, 'control'])
    for (const [handle, label] of inherited) {
      if (api.setHandleInformation(handle, abi.HANDLE_FLAG_INHERIT, abi.HANDLE_FLAG_INHERIT) === 0) {
        throwLastError(api, 'SetHandleInformation', `${label} (enable inherit)`)
      }
      enabled.push(handle)
    }
    const controlBytes = stdio.control === undefined
      ? undefined
      : inheritedControlStdio(api, { ...stdio, control: stdio.control })
    if (controlBytes !== undefined) {
      const koffi = requireKoffi()
      controlDescriptorBlock = { pointer: koffi.alloc('uint8', controlBytes.length) as NativePtr, length: controlBytes.length }
      koffi.encode(controlDescriptorBlock.pointer, 'uint8', controlBytes, controlBytes.length)
    }
    startupInfo = allocStartupInfo()
    encodeStartupInfo(startupInfo, {
      cb: abi.STARTUPINFOW_SIZE,
      // Preserve console inheritance: CREATE_NO_WINDOW can fail restricted-token DLL initialization.
      dwFlags: abi.STARTF_USESTDHANDLES | abi.STARTF_USESHOWWINDOW,
      wShowWindow: abi.SW_HIDE,
      hStdInput: stdio.stdin,
      hStdOutput: stdio.stdout,
      hStdError: stdio.stderr,
      ...controlDescriptorBlock === undefined ? {} : {
        cbReserved2: controlDescriptorBlock.length,
        lpReserved2: controlDescriptorBlock.pointer,
      },
    })
    processInfo = allocProcessInfo()
    created = create(startupInfo, processInfo)
    if (created === 0) createFailureCode = api.getLastError()
  } catch (error) {
    freeNative(processInfo)
    api.closeHandle(job)
    throw error
  } finally {
    freeNative(startupInfo)
    freeNative(controlDescriptorBlock?.pointer)
    for (const handle of enabled) {
      // 该 runner 不会生成其他东西；清理失败绝不能掩盖子进程。
      api.setHandleInformation(handle, abi.HANDLE_FLAG_INHERIT, 0)
    }
  }
  if (created === 0) {
    freeNative(processInfo)
    api.closeHandle(job)
    throwWin32(
      api,
      createName,
      createFailureCode,
      `command: ${options.command}, cwd: ${options.cwd}`,
    )
  }
  let info: ReturnType<typeof decodeProcessInfo>
  try {
    info = decodeProcessInfo(processInfo)
  } finally {
    freeNative(processInfo)
  }
  if (info.hProcess === null || info.hThread === null) {
    if (info.hProcess !== null) api.terminateProcess(info.hProcess, 1)
    api.closeHandle(job)
    closeBestEffort(api, info.hThread)
    closeBestEffort(api, info.hProcess)
    throw new Error(`${createName} succeeded but returned null process/thread handles (pid ${info.dwProcessId})`)
  }
  if (api.assignProcessToJobObject(job, info.hProcess) === 0) {
    const win32Code = api.getLastError()
    api.terminateProcess(info.hProcess, 1)
    closeBestEffort(api, info.hThread)
    closeBestEffort(api, info.hProcess)
    api.closeHandle(job)
    throwWin32(api, 'AssignProcessToJobObject', win32Code, `pid ${info.dwProcessId}`)
  }
  if (api.resumeThread(info.hThread) === 0xFFFFFFFF) {
    const win32Code = api.getLastError()
    closeBestEffort(api, info.hThread)
    closeBestEffort(api, info.hProcess)
    api.closeHandle(job)
    throwWin32(api, 'ResumeThread', win32Code, `pid ${info.dwProcessId}`)
  }
  closeBestEffort(api, info.hThread)
  return { pid: info.dwProcessId, process: info.hProcess, job }
}

/**
 * 以一个受限令牌启动一个暂停的进程（初始窗口隐藏），指派其 Job，然后恢复它。
 * @param api - 当前活动的绑定表。
 * @param options - 命令、cwd、参数，以及受限主令牌。
 * @returns 恢复成功后由调用方拥有的进程与 Job 句柄。
 * @remarks Node 在启动时会通过 uv_disable_stdio_inheritance 清除 stdio 句柄的
 * 可继承性。本操作临时恢复 STARTF_USESTDHANDLES 所需的位。事后再恢复它们是尽力而为的：
 * 失败绝不能取代已经创建的子进程的结果。
 */
export function spawnInheritedJobProcess(
  api: Win32ProcessBindings,
  options: RestrictedProcessSpawnOptions,
): SpawnedJobProcess {
  const commandLine = buildCommandLine(options.command, options.args)
  return spawnJobProcess(api, options, () => inheritedStandardHandles(api, options.controlFileDescriptor), 'CreateProcessAsUserW', (startupInfo, processInfo) =>
    createRestrictedProcess(
      api,
      options,
      commandLine,
      abi.CREATE_SUSPENDED,
      startupInfo,
      processInfo,
    ))
}

/**
 * 以一个普通进程启动一个暂停的进程（初始窗口隐藏），指派其 Job，然后恢复它。
 * @param api - 当前活动的绑定表。
 * @param options - 命令、cwd、argv，以及目标载体描述符。
 * @returns 恢复成功后由调用方拥有的进程与 Job 句柄。
 */
export function spawnCurrentTokenJobProcess(
  api: CurrentTokenProcessBindings,
  options: CurrentTokenProcessSpawnOptions,
): SpawnedJobProcess {
  const commandLine = buildCommandLine(options.command, options.args)
  const environment = encodeWindowsEnvironment(options.env)
  return spawnJobProcess(api, options, () => targetCarrierHandles(api, options.stdio), 'CreateProcessW', (startupInfo, processInfo) =>
    api.createProcessW(
      options.applicationName,
      commandLine,
      null,
      null,
      1,
      abi.CREATE_SUSPENDED | abi.CREATE_UNICODE_ENVIRONMENT,
      environment,
      options.cwd,
      startupInfo,
      processInfo,
    ))
}

/**
 * 验证一个无名的 kill-on-close Job 现在可以被创建并释放。
 * @param api - 当前活动的绑定表。
 */
export function probeCurrentTokenJobSupport(api: CurrentTokenProcessBindings): void {
  const job = createKillOnCloseJob(api)
  closeHandleChecked(api, job, 'current-token Job capability probe')
}

/**
 * 在不阻塞 runner 事件循环的前提下轮询一个进程句柄。
 * @param api - 当前活动的绑定表。
 * @param process - 由调用方拥有的进程句柄。
 * @returns 被触发时的直接退出码；仍在运行时为 undefined。
 */
export function pollProcessExit(api: Win32ProcessBindings, process: NativePtr): number | undefined {
  const waitResult = api.waitForSingleObject(process, 0)
  if (waitResult === abi.WAIT_TIMEOUT) return undefined
  if (waitResult === 0xFFFFFFFF) throwLastError(api, 'WaitForSingleObject')
  const exitCodeSlot = allocUint32()
  try {
    if (api.getExitCodeProcess(process, exitCodeSlot) === 0) throwLastError(api, 'GetExitCodeProcess')
    return decodeUint32(exitCodeSlot)
  } finally {
    requireKoffi().free(exitCodeSlot)
  }
}

/**
 * 返回一个 Job 是否没有活动进程。
 * @param api - 当前活动的绑定表。
 * @param job - 由调用方拥有的 Job 句柄。
 * @returns 当 Job 报告零个活动进程时为 true。
 */
export function isJobEmpty(api: Win32ProcessBindings, job: NativePtr): boolean {
  const information = Buffer.alloc(abi.JOBOBJECT_BASIC_ACCOUNTING_SIZE)
  if (api.queryInformationJobObject(
    job,
    abi.JobObjectBasicAccountingInformation,
    information,
    information.length,
    null,
  ) === 0) {
    throwLastError(api, 'QueryInformationJobObject', 'active process count')
  }
  return information.readUInt32LE(abi.JOBOBJECT_BASIC_ACCOUNTING_ACTIVE_PROCESSES_OFFSET) === 0
}

/**
 * 终止一个 Job 中的每一个进程。
 * @param api - 当前活动的绑定表。
 * @param job - 由调用方拥有的 Job 句柄。
 * @param exitCode - 指派给成员的、直接的 Windows 退出码。
 */
export function terminateJob(api: Win32ProcessBindings, job: NativePtr, exitCode: number): void {
  if (api.terminateJobObject(job, exitCode) === 0) throwLastError(api, 'TerminateJobObject')
}

/**
 * 关闭一个由调用方拥有的句柄，并报告一个带标签的 Win32 失败。
 * @param api - 当前活动的绑定表。
 * @param handle - 要关闭的句柄。
 * @param detail - 用于诊断的生命周期标签。
 */
export function closeHandleChecked(api: Win32ProcessBindings, handle: NativePtr, detail: string): void {
  if (api.closeHandle(handle) === 0) throwLastError(api, 'CloseHandle', detail)
}
