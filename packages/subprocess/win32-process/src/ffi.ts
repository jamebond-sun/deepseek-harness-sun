/** 针对通用 Win32 进程、stdio 与 Job 操作的惰性 Koffi 绑定。 */

import * as abi from './abi.ts'
import { Win32Error } from './errors.ts'
import { requireKoffi, type Koffi } from './koffi.ts'

declare const nativePtr: unique symbol
/** 经品牌化标记、以防被意外当作数值使用的 Koffi 原生指针。 */
export type NativePtr = bigint & { readonly [nativePtr]: true }

type Ptr = ReturnType<Koffi['pointer']>

/** 已加载的 Win32 库，以及由进程扩展示例使用的共享 stdcall 绑定器。 */
export interface Win32BindingContext {
  /** 内核进程、句柄、管道与 Job API。 */
  readonly kernel32: ReturnType<Koffi['load']>
  /** 令牌与安全 API。 */
  readonly advapi32: ReturnType<Koffi['load']>
  /** 从已加载的 Win32 库中绑定一个 stdcall 函数。 */
  readonly bind: (
    library: ReturnType<Koffi['load']>,
    name: string,
    result: Ptr | string,
    args: Array<Ptr | string>,
  ) => unknown
}

/**
 * 返回一个 Koffi 指针是否表示 NULL。
 * @param value - 由 Koffi 或某个 Win32 调用返回的指针值。
 * @returns 对于 null、undefined 或地址零为 true。
 */
export function isNullPtr(value: NativePtr | null | undefined): value is null | undefined {
  return value === null || value === undefined || (value as bigint) === 0n
}

/** 由被继承或管道化 stdio 启动所使用的 STARTUPINFOW 字段。 */
export interface StartupInfoInput {
  cb: number
  dwFlags: number
  wShowWindow: number
  hStdInput: NativePtr
  hStdOutput: NativePtr
  hStdError: NativePtr
  cbReserved2?: number
  lpReserved2?: NativePtr
}

/** 已解码的 PROCESS_INFORMATION 结果。 */
export interface ProcessInfoOutput {
  hProcess: NativePtr | null
  hThread: NativePtr | null
  dwProcessId: number
  dwThreadId: number
}

/** 受限制令牌沙箱进程操作所使用的通用 Win32 调用。 */
export interface Win32ProcessBindings {
  closeHandle(handle: NativePtr): number
  getLastError(): number
  getFileType(handle: NativePtr): number
  uvGetOsfhandle(fileDescriptor: number): NativePtr | null
  formatMessageW(
    flags: number,
    source: null,
    messageId: number,
    languageId: number,
    buffer: Buffer,
    size: number,
    args: null,
  ): number
  createPipe(readHandle: NativePtr, writeHandle: NativePtr, attributes: null, size: number): number
  setHandleInformation(handle: NativePtr, mask: number, flags: number): number
  createProcessAsUserW(
    token: NativePtr,
    applicationName: string | null,
    commandLine: string,
    processAttributes: null,
    threadAttributes: null,
    inheritHandles: number,
    creationFlags: number,
    environment: null,
    currentDirectory: string | null,
    startupInfo: NativePtr,
    processInfo: NativePtr,
  ): number
  createProcessW(
    applicationName: string | null,
    commandLine: string,
    processAttributes: null,
    threadAttributes: null,
    inheritHandles: number,
    creationFlags: number,
    environment: Buffer | null,
    currentDirectory: string | null,
    startupInfo: NativePtr,
    processInfo: NativePtr,
  ): number
  readFile(file: NativePtr, buffer: Buffer, count: number, bytesRead: NativePtr, overlapped: null): number
  peekNamedPipe(
    pipe: NativePtr,
    buffer: null,
    size: number,
    bytesRead: NativePtr | null,
    totalAvail: NativePtr,
    leftThisMessage: NativePtr | null,
  ): number
  waitForSingleObject(handle: NativePtr, milliseconds: number): number
  getExitCodeProcess(process: NativePtr, exitCode: NativePtr): number
  createJobObjectW(attributes: null, name: null): NativePtr
  setInformationJobObject(job: NativePtr, cls: number, information: Buffer, length: number): number
  queryInformationJobObject(
    job: NativePtr,
    cls: number,
    information: Buffer,
    length: number,
    returnLength: null,
  ): number
  assignProcessToJobObject(job: NativePtr, process: NativePtr): number
  resumeThread(thread: NativePtr): number
  terminateProcess(process: NativePtr, exitCode: number): number
  terminateJobObject(job: NativePtr, exitCode: number): number
  getStdHandle(stdHandle: number): NativePtr
}

/** 通用 Win32 调用，外加 Node 的 libuv 描述符到句柄的桥接。 */
export interface CurrentTokenProcessBindings extends Win32ProcessBindings {
  uvGetOsfhandle(fileDescriptor: number): NativePtr | null
}

interface Win32Types {
  PVOID: Ptr
  PPVOID: Ptr
  STARTUPINFOW: ReturnType<Koffi['struct']>
  PROCESS_INFORMATION: ReturnType<Koffi['struct']>
}

let cachedTypes: Win32Types | undefined

/** 在首次原生操作时解析 Koffi 指针与进程布局。 */
function win32Types(): Win32Types {
  if (cachedTypes !== undefined) return cachedTypes
  const koffi = requireKoffi()
  const PVOID = koffi.pointer('void')
  const PPVOID = koffi.pointer(PVOID)
  const STARTUPINFOW = koffi.struct('DSH_STARTUPINFOW', {
    cb: 'uint32', lpReserved: 'str16', lpDesktop: 'str16', lpTitle: 'str16',
    dwX: 'uint32', dwY: 'uint32', dwXSize: 'uint32', dwYSize: 'uint32',
    dwXCountChars: 'uint32', dwYCountChars: 'uint32', dwFillAttribute: 'uint32',
    dwFlags: 'uint32', wShowWindow: 'uint16', cbReserved2: 'uint16',
    lpReserved2: koffi.pointer('uint8'), hStdInput: PVOID, hStdOutput: PVOID, hStdError: PVOID,
  })
  const PROCESS_INFORMATION = koffi.struct('DSH_PROCESS_INFORMATION', {
    hProcess: PVOID, hThread: PVOID, dwProcessId: 'uint32', dwThreadId: 'uint32',
  })
  /* v8 ignore start -- ABI guards are pinned by native header probes. */
  if (STARTUPINFOW.size !== abi.STARTUPINFOW_SIZE) {
    throw new Error(`STARTUPINFOW layout mismatch: koffi computed ${STARTUPINFOW.size}, expected ${abi.STARTUPINFOW_SIZE}`)
  }
  if (PROCESS_INFORMATION.size !== abi.PROCESS_INFORMATION_SIZE) {
    throw new Error(`PROCESS_INFORMATION layout mismatch: koffi computed ${PROCESS_INFORMATION.size}, expected ${abi.PROCESS_INFORMATION_SIZE}`)
  }
  /* v8 ignore stop */
  return cachedTypes = { PVOID, PPVOID, STARTUPINFOW, PROCESS_INFORMATION }
}

/**
 * Materialize the Koffi STARTUPINFOW layout on first native use.
 * @returns the cached native struct type.
 */
export function startupInfoType(): ReturnType<Koffi['struct']> {
  return win32Types().STARTUPINFOW
}

/**
 * Materialize the Koffi PROCESS_INFORMATION layout on first native use.
 * @returns the cached native struct type.
 */
export function processInformationType(): ReturnType<Koffi['struct']> {
  return win32Types().PROCESS_INFORMATION
}

/**
 * Allocate a pointer-sized out-parameter slot.
 * @returns allocated native slot.
 */
export function allocPtrSlot(): NativePtr {
  const { PVOID } = win32Types()
  return requireKoffi().alloc(PVOID, 1) as NativePtr
}

/**
 * Allocate a uint32 out-parameter slot.
 * @returns allocated native slot.
 */
export function allocUint32(): NativePtr {
  return requireKoffi().alloc('uint32', 1) as NativePtr
}

/**
 * Decode a pointer out-parameter.
 * @param slot - pointer-sized slot filled by Win32.
 * @returns decoded pointer, or null for address zero.
 */
export function decodePtr(slot: NativePtr): NativePtr | null {
  const value = requireKoffi().decode(slot, win32Types().PVOID) as NativePtr | null
  return isNullPtr(value) ? null : value
}

/**
 * 解码一个 uint32 出参。
 * @param slot - 由 Win32 填充的 uint32 槽位。
 * @returns 解码后的无符号值。
 */
export function decodeUint32(slot: NativePtr): number {
  return requireKoffi().decode(slot, 'uint32') as number
}

/**
 * 分配一个清零的 STARTUPINFOW。
 * @returns 已分配的结构体指针。
 */
export function allocStartupInfo(): NativePtr {
  return requireKoffi().alloc(win32Types().STARTUPINFOW, 1) as NativePtr
}

/**
 * 编码承载 stdio 的 STARTUPINFOW 字段。
 * @param startupInfo - 已分配的 STARTUPINFOW 指针。
 * @param fields - 被继承 stdio 所需的字段。
 */
export function encodeStartupInfo(startupInfo: NativePtr, fields: StartupInfoInput): void {
  requireKoffi().encode(startupInfo, win32Types().STARTUPINFOW, fields)
}

/**
 * 分配一个清零的 PROCESS_INFORMATION。
 * @returns 已分配的结构体指针。
 */
export function allocProcessInfo(): NativePtr {
  return requireKoffi().alloc(win32Types().PROCESS_INFORMATION, 1) as NativePtr
}

/**
 * 解码 PROCESS_INFORMATION。
 * @param processInfo - 由 CreateProcess 填充的结构体指针。
 * @returns 进程/线程句柄与 id。
 */
export function decodeProcessInfo(processInfo: NativePtr): ProcessInfoOutput {
  return requireKoffi().decode(processInfo, win32Types().PROCESS_INFORMATION) as ProcessInfoOutput
}

let cachedContext: Win32BindingContext | undefined
let cached: CurrentTokenProcessBindings | undefined

/* v8 ignore start -- 由原生 Windows ABI 与沙箱 Job 演练。 */
function bindingContext(): Win32BindingContext {
  if (cachedContext !== undefined) return cachedContext
  const koffi = requireKoffi()
  const kernel32 = koffi.load('kernel32.dll')
  const advapi32 = koffi.load('advapi32.dll')
  const bind = (
    lib: ReturnType<typeof koffi.load>,
    name: string,
    result: Ptr | string,
    args: Array<Ptr | string>,
  ): unknown => lib.func('__stdcall', name, result, args)
  cachedContext = { kernel32, advapi32, bind }
  return cachedContext
}

function bindings(): CurrentTokenProcessBindings {
  if (cached !== undefined) return cached
  const koffi = requireKoffi()
  const { PVOID, PPVOID, STARTUPINFOW, PROCESS_INFORMATION } = win32Types()
  const { kernel32, advapi32, bind } = bindingContext()
  const node = koffi.load(null)
  cached = {
    closeHandle: bind(kernel32, 'CloseHandle', 'int', [PVOID]),
    getLastError: bind(kernel32, 'GetLastError', 'uint32', []),
    getFileType: bind(kernel32, 'GetFileType', 'uint32', [PVOID]),
    formatMessageW: bind(kernel32, 'FormatMessageW', 'uint32', [
      'uint32', PVOID, 'uint32', 'uint32', PVOID, 'uint32', PVOID,
    ]),
    createPipe: bind(kernel32, 'CreatePipe', 'int', [PPVOID, PPVOID, PVOID, 'uint32']),
    setHandleInformation: bind(kernel32, 'SetHandleInformation', 'int', [PVOID, 'uint32', 'uint32']),
    createProcessAsUserW: bind(advapi32, 'CreateProcessAsUserW', 'int', [
      PVOID, 'str16', 'str16', PVOID, PVOID, 'int', 'uint32', PVOID, 'str16',
      koffi.pointer(STARTUPINFOW), koffi.pointer(PROCESS_INFORMATION),
    ]),
    createProcessW: bind(kernel32, 'CreateProcessW', 'int', [
      'str16', 'str16', PVOID, PVOID, 'int', 'uint32', PVOID, 'str16',
      koffi.pointer(STARTUPINFOW), koffi.pointer(PROCESS_INFORMATION),
    ]),
    readFile: bind(kernel32, 'ReadFile', 'int', [PVOID, PVOID, 'uint32', koffi.pointer('uint32'), PVOID]),
    peekNamedPipe: bind(kernel32, 'PeekNamedPipe', 'int', [
      PVOID, PVOID, 'uint32', koffi.pointer('uint32'), koffi.pointer('uint32'), koffi.pointer('uint32'),
    ]),
    waitForSingleObject: bind(kernel32, 'WaitForSingleObject', 'uint32', [PVOID, 'uint32']),
    getExitCodeProcess: bind(kernel32, 'GetExitCodeProcess', 'int', [PVOID, koffi.pointer('uint32')]),
    createJobObjectW: bind(kernel32, 'CreateJobObjectW', PVOID, [PVOID, 'str16']),
    setInformationJobObject: bind(kernel32, 'SetInformationJobObject', 'int', [PVOID, 'int', PVOID, 'uint32']),
    queryInformationJobObject: bind(kernel32, 'QueryInformationJobObject', 'int', [
      PVOID, 'int', PVOID, 'uint32', PVOID,
    ]),
    assignProcessToJobObject: bind(kernel32, 'AssignProcessToJobObject', 'int', [PVOID, PVOID]),
    resumeThread: bind(kernel32, 'ResumeThread', 'uint32', [PVOID]),
    terminateProcess: bind(kernel32, 'TerminateProcess', 'int', [PVOID, 'uint32']),
    terminateJobObject: bind(kernel32, 'TerminateJobObject', 'int', [PVOID, 'uint32']),
    getStdHandle: bind(kernel32, 'GetStdHandle', PVOID, ['int']),
    uvGetOsfhandle: node.func('uv_get_osfhandle', PVOID, ['int']),
  } as unknown as CurrentTokenProcessBindings
  return cached
}

/**
 * 用调用方拥有的 Win32 API 族扩展共享进程表。
 * @param create - 只从共享库中绑定调用方特定的操作。
 * @returns 通用进程绑定与调用方特定操作的合并结果。
 */
export function extendWin32ProcessBindings<Extension extends object>(
  create: (context: Win32BindingContext) => Extension,
): CurrentTokenProcessBindings & Extension {
  return { ...bindings(), ...create(bindingContext()) }
}

/**
 * 加载不带策略特定扩展的通用进程绑定表。
 * @returns 共享的 Win32 进程、stdio 与 Job 操作。
 */
export function loadWin32ProcessBindings(): CurrentTokenProcessBindings {
  return bindings()
}
/* v8 ignore stop */

/**
 * 通过 FormatMessageW 格式化一个 Win32 错误码。
 * @param api - 当前活动的绑定表。
 * @param win32Code - 捕获到的 GetLastError 值。
 * @returns 修剪后的系统消息；不可用时为空字符串。
 */
export function errorText(api: Win32ProcessBindings, win32Code: number): string {
  const buffer = Buffer.alloc(1024)
  const length = api.formatMessageW(
    abi.FORMAT_MESSAGE_FROM_SYSTEM | abi.FORMAT_MESSAGE_IGNORE_INSERTS,
    null,
    win32Code,
    0,
    buffer,
    buffer.length / 2,
    null,
  )
  return length === 0 ? '' : buffer.subarray(0, length * 2).toString('utf16le').trim()
}

/**
 * 抛出当前的 GetLastError 值。
 * @param api - 当前活动的绑定表。
 * @param name - 失败的 Win32 操作。
 * @param detail - 可选的操作上下文。
 * @returns never；始终抛出 Win32Error。
 */
export function throwLastError(api: Win32ProcessBindings, name: string, detail?: string): never {
  const win32Code = api.getLastError()
  throw new Win32Error(name, win32Code, detail ?? errorText(api, win32Code))
}

/**
 * 抛出一个被显式捕获的 Win32 错误码。
 * @param api - 当前活动的绑定表。
 * @param name - 失败的 Win32 操作。
 * @param win32Code - 在清理之前捕获的错误。
 * @param detail - 可选的操作上下文。
 * @returns never；始终抛出 Win32Error。
 */
export function throwWin32(
  api: Win32ProcessBindings,
  name: string,
  win32Code: number,
  detail?: string,
): never {
  throw new Win32Error(name, win32Code, detail ?? errorText(api, win32Code))
}
