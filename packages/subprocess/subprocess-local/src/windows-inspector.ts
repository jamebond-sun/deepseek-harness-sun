/**
 * 用于终端就绪、信令与拆除的 Windows 进程表操作：借助 GetProcessTimes 创建时间
 * 身份的 Toolhelp32 快照枚举与进程句柄等待状态存活判断；把 shell pid 当作伪
 * 进程组（Windows 没有 POSIX 组）；以及 taskkill 树信令。koffi 绑定按需惰性加载，
 * 因此非 Windows 进程永远不会触及 Win32 库；所有决策逻辑都接受一个可注入的
 * internals 边界，以便测试套件能在任意主机上固定其行为。
 * @module dsh-subprocess-local/windows-inspector
 */

import { spawnSync } from 'node:child_process'
import type { SubprocessTerminalSignal } from '@deepseek-ai/dsh-subprocess'
import { createLazyRequire } from '@deepseek-ai/dsh-lazy-require'
import type { ProcessIdentity, ProcessInspector, ProcessSnapshot } from './process-inspector.ts'

type Koffi = typeof import('koffi')['default']
type KoffiType = ReturnType<Koffi['pointer']>

const requireKoffi = createLazyRequire<Koffi>('koffi', import.meta.url)

/** 一行 Toolhelp32 进程表记录。 */
export interface ProcessEntry {
  pid: number
  parentPid: number
}

/** Creation identity plus the process object's current wait state. */
export interface WindowsProcessState {
  /** 用于栅栏 PID 复用的 GetProcessTimes 创建身份。 */
  started: string
  /** 零时长进程句柄等待是否报告进程仍在运行。 */
  active: boolean
}

/** Injectable Windows process operations used by one local PTY session. */
export interface WindowsProcessInspectorInternals {
  /** 枚举当前进程表（pid/父 pid 对）。 */
  snapshot(): ProcessEntry[]
  /** 返回某个进程的创建身份与等待状态；不可读时为 undefined。 */
  processState(pid: number): WindowsProcessState | undefined
  /** 终止一棵进程树；`force` 映射到 taskkill 的 `/F`。 */
  taskkill(pid: number, force: boolean): void
}

/**
 * 以子节点优先的顺序，从某个根开始遍历进程表，仅保留起始身份可读的成员
 *（不可读的成员属于检测器漏检，与 Linux 上不可读的 `/proc` 条目完全相同）。
 * @param entries - 进程表快照。
 * @param rootPid - 要向下遍历的树根。
 * @param started - 针对单个成员的创建时间身份解析器。
 * @returns 该根及其当前的传递性后代，子节点在前。
 */
/* jscpd:ignore-start -- Windows 检查器刻意镜像 process-inspector.ts：
   其决策逻辑（树遍历、身份栅栏、组信令）是建立在 Win32 原语之上、相同的契约，
   依据 persistent-pty 笔记 2026-08-11-pwsh-persistent-pty。 */
export function windowsProcessTree(
  entries: ProcessEntry[],
  rootPid: number,
  started: (pid: number) => string | undefined,
): ProcessIdentity[] {
  const byPid = new Map(entries.map(entry => [entry.pid, entry]))
  const root = byPid.get(rootPid)
  if (root === undefined) return []
  const byParent = new Map<number, ProcessEntry[]>()
  for (const entry of entries) {
    const children = byParent.get(entry.parentPid) ?? []
    children.push(entry)
    byParent.set(entry.parentPid, children)
  }
  const visited = new Set<number>()
  const result: ProcessIdentity[] = []
  const visit = (entry: ProcessEntry): void => {
    if (visited.has(entry.pid)) return
    visited.add(entry.pid)
    for (const child of byParent.get(entry.pid) ?? []) visit(child)
    const identity = started(entry.pid)
    if (identity !== undefined) result.push({ pid: entry.pid, started: identity })
  }
  visit(root)
  return result
}

/**
 * Windows 的 {@link ProcessInspector}。shell pid 充当前台进程组的替身：它是一个
 * 稳定的伪组，让提示符标记的就绪路径得以比较前台身份；而每一次真实的信号都通过
 * taskkill 指向整控制台范围的树（SIGINT 由终端句柄以一次 `\x03` 输入写入投递，
 * 永远不会到达这一层）。
 */
export class WindowsProcessInspector implements ProcessInspector {
  constructor(
    private readonly internals: WindowsProcessInspectorInternals = defaultWindowsProcessInternals(),
  ) {}

  foregroundPgid(shellPid: number): number {
    return shellPid
  }

  isStdinWaiting(_pgid: number, _shellPid: number): boolean {
    return false
  }

  isAlive(identity: ProcessIdentity): boolean {
    const state = this.internals.processState(identity.pid)
    return state?.active === true && state.started === identity.started
  }

  snapshot(): ProcessSnapshot {
    // 在首次读取该表的问题上才枚举。存活判断从不枚举——等待状态在这里是逐句柄的
    // 问题——因此只询问存活的 Windows 拆除轮询，无需付出 Toolhelp32 遍历的代价。
    let entries: ProcessEntry[] | undefined
    return {
      tree: rootPid => windowsProcessTree(
        entries ??= this.internals.snapshot(),
        rootPid,
        pid => this.internals.processState(pid)?.started,
      ),
      // Windows 没有 POSIX 会话；shell pid 作为伪组充当替身。
      session: () => [],
      alive: identity => this.isAlive(identity),
    }
  }

  signalGroup(pgid: number, signal: SubprocessTerminalSignal): void {
    this.internals.taskkill(pgid, signal === 'SIGKILL')
  }

  signalProcess(identity: ProcessIdentity, signal: 'SIGTERM' | 'SIGKILL'): void {
    if (this.isAlive(identity)) this.internals.taskkill(identity.pid, signal === 'SIGKILL')
  }
}
/* jscpd:ignore-end */

/**
 * 创建 Windows 进程检查器。
 * @param internals - 可注入的进程操作；默认使用 koffi 支撑的表。
 * @returns Windows 检查器。
 */
export function createWindowsProcessInspector(
  internals: WindowsProcessInspectorInternals = defaultWindowsProcessInternals(),
): WindowsProcessInspector {
  return new WindowsProcessInspector(internals)
}

/** 用 taskkill 终止一棵 Windows 进程树，其遏制方式类似于 POSIX 组信令。 */
function taskkillTree(pid: number, force: boolean): void {
  if (pid <= 0) return
  // 结果刻意不检查：一个已经不存在的树、退出竞争，以及缺失的 taskkill 二进制，
  // 在这里与 POSIX 遇到 ESRCH 时一样可被容忍。
  spawnSync('taskkill', ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])], {
    stdio: 'ignore',
    windowsHide: true,
  })
}

declare const nativePtr: unique symbol
/** Koffi 3 原生指针（一个 BigInt 地址），做了品牌化标记，从而无法悄无声息地进入数值上下文。 */
export type NativePtr = bigint & { readonly [nativePtr]: true }

/**
 * 对来自 Win32 句柄 API 的 NULL 与 INVALID_HANDLE_VALUE 返回值为真。
 * @param value - koffi 可能交还的句柄（指针、null 或 0n）。
 * @returns 该值是否表示一个无效句柄。
 */
export function isInvalidHandle(value: NativePtr | null | undefined): boolean {
  if (value === null || value === undefined) return true
  const asBigInt = value as bigint
  return asBigInt === 0n || asBigInt === 0xFFFFFFFFFFFFFFFFn || asBigInt === -1n
}

/** 惰性 koffi 绑定表：Windows 检查器使用的每一个 Win32 调用。 */
interface Win32Bindings {
  createToolhelp32Snapshot(flags: number, processId: number): NativePtr
  process32FirstW(snapshot: NativePtr, entry: NativePtr): number
  process32NextW(snapshot: NativePtr, entry: NativePtr): number
  openProcess(desiredAccess: number, inheritHandle: number, pid: number): NativePtr
  getProcessTimes(
    process: NativePtr,
    creation: NativePtr,
    exit: NativePtr,
    kernel: NativePtr,
    user: NativePtr,
  ): number
  waitForSingleObject(handle: NativePtr, milliseconds: number): number
  closeHandle(handle: NativePtr): number
}

/**
 * 一次性解析 koffi 的 Win32 结构体类型。注册是惰性且带缓存的，因为 koffi 的类型
 * 注册表在单个进程内是全局的：重新求值本模块的测试运行器（被提升的 `vi.mock`
 * 会重新导入整个依赖图）不得重新注册这些名字。
 */
function win32Structs(): { PVOID: KoffiType; PROCESSENTRY32W: ReturnType<Koffi['struct']>; FILETIME: ReturnType<Koffi['struct']> } {
  if (cachedStructs !== undefined) return cachedStructs
  const koffi = requireKoffi()
  const PVOID = koffi.pointer('void')
  // koffi 的 PROCESSENTRY32W 布局（tlhelp32.h）；该尺寸断言锁定 x64 布局。
  const PROCESSENTRY32W = koffi.struct('PROCESSENTRY32W', {
    dwSize: 'uint32',
    cntUsage: 'uint32',
    th32ProcessID: 'uint32',
    th32DefaultHeapID: PVOID,
    th32ModuleID: 'uint32',
    cCntThreads: 'uint32',
    th32ParentProcessID: 'uint32',
    pcPriClassBase: 'int32',
    dwFlags: 'uint32',
    szExeFile: koffi.array('char16', 260),
  })
  // koffi 的 FILETIME 布局（minwinbase.h）：64 位时间戳的两个 32 位半部。
  const FILETIME = koffi.struct('FILETIME', {
    dwLowDateTime: 'uint32',
    dwHighDateTime: 'uint32',
  })
  /* v8 ignore start -- 布局不匹配守卫只在 ABI 被破坏时触发；windows-native 测试套件会实际演练真实结构体。 */
  if (PROCESSENTRY32W.size !== 568) {
    throw new Error(`PROCESSENTRY32W layout mismatch: koffi computed ${PROCESSENTRY32W.size}, Windows headers say 568`)
  }
  /* v8 ignore stop */
  cachedStructs = { PVOID, PROCESSENTRY32W, FILETIME }
  return cachedStructs
}

let cachedStructs: ReturnType<typeof win32Structs> | undefined

const TH32CS_SNAPPROCESS = 0x2
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const SYNCHRONIZE = 0x00100000
const WAIT_OBJECT_0 = 0
const WAIT_TIMEOUT = 0x102

let cachedBindings: Win32Bindings | undefined

/**
 * 解析惰性 Win32 绑定（抛出首个绑定失败，以失败封闭）。
 * @returns 已缓存的绑定表。
 */
function win32Bindings(): Win32Bindings {
  if (cachedBindings !== undefined) return cachedBindings
  const koffi = requireKoffi()
  const { PVOID, PROCESSENTRY32W, FILETIME } = win32Structs()
  const kernel32 = koffi.load('kernel32.dll')
  const bind = (
    name: string,
    result: ReturnType<typeof koffi.pointer> | string,
    args: Array<ReturnType<typeof koffi.pointer> | string>,
  ): unknown => kernel32.func('__stdcall', name, result, args)
  cachedBindings = {
    createToolhelp32Snapshot: bind('CreateToolhelp32Snapshot', PVOID, ['uint32', 'uint32']),
    process32FirstW: bind('Process32FirstW', 'int', [PVOID, koffi.pointer(PROCESSENTRY32W)]),
    process32NextW: bind('Process32NextW', 'int', [PVOID, koffi.pointer(PROCESSENTRY32W)]),
    openProcess: bind('OpenProcess', PVOID, ['uint32', 'int', 'uint32']),
    getProcessTimes: bind('GetProcessTimes', 'int', [
      PVOID,
      koffi.pointer(FILETIME),
      koffi.pointer(FILETIME),
      koffi.pointer(FILETIME),
      koffi.pointer(FILETIME),
    ]),
    waitForSingleObject: bind('WaitForSingleObject', 'uint32', [PVOID, 'uint32']),
    closeHandle: bind('CloseHandle', 'int', [PVOID]),
  } as Win32Bindings
  return cachedBindings
}

/**
 * 以品牌化的 {@link NativePtr} 分配 koffi 内存；koffi 的 TS 类型为 `any`，因此
 * 该转换经由 `unknown` 进行，以把这里的不安全面收敛在一处。
 * @param type - 要分配的类型。
 * @param count - 元素数量。
 * @returns 品牌化的分配指针。
 */
function allocNative(type: Parameters<Koffi['alloc']>[0], count: number): NativePtr {
  const koffi = requireKoffi()
  const value: unknown = koffi.alloc(type, count)
  return value as NativePtr
}

/** 通过 Toolhelp32 枚举当前进程表。 */
function snapshotWindowsProcesses(bindings: Win32Bindings): ProcessEntry[] {
  const koffi = requireKoffi()
  const { PROCESSENTRY32W } = win32Structs()
  const snapshot = bindings.createToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
  /* v8 ignore next -- 针对进程标志的无效快照无法通过公开 API 产生；
     该守卫镜像 POSIX 对不可读 /proc 的容忍，且 isInvalidHandle 已有单元测试。 */
  if (isInvalidHandle(snapshot)) return []
  const entries: ProcessEntry[] = []
  try {
    const entry = allocNative(PROCESSENTRY32W, 1)
    koffi.encode(entry, 'uint32', PROCESSENTRY32W.size)
    let ok = bindings.process32FirstW(snapshot, entry)
    while (ok !== 0) {
      const record = koffi.decode(entry, PROCESSENTRY32W) as {
        th32ProcessID: number
        th32ParentProcessID: number
      }
      entries.push({ pid: record.th32ProcessID, parentPid: record.th32ParentProcessID })
      ok = bindings.process32NextW(snapshot, entry)
    }
  } finally {
    bindings.closeHandle(snapshot)
  }
  return entries
}

/** 读取某个进程的创建身份与当前等待状态。 */
function windowsProcessState(bindings: Win32Bindings, pid: number): WindowsProcessState | undefined {
  const koffi = requireKoffi()
  const { FILETIME } = win32Structs()
  const handle = bindings.openProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, 0, pid)
  if (isInvalidHandle(handle)) return undefined
  try {
    const creation = allocNative(FILETIME, 1)
    const exit = allocNative(FILETIME, 1)
    const kernel = allocNative(FILETIME, 1)
    const user = allocNative(FILETIME, 1)
    /* v8 ignore next -- 成功打开后发生的 GetProcessTimes 失败与进程退出竞争、
       无法确定性地构造；缺失进程的路径已被覆盖，且调用方把 undefined 视为检测器漏检。 */
    if (bindings.getProcessTimes(handle, creation, exit, kernel, user) === 0) return undefined
    const record = koffi.decode(creation, FILETIME) as { dwLowDateTime: number; dwHighDateTime: number }
    const wait = bindings.waitForSingleObject(handle, 0)
    /* v8 ignore next -- 一个已打开的进程句柄恰好处于这两种零时长等待状态之一；
       意外的 Win32 失败即表示一个不可读进程。 */
    if (wait !== WAIT_OBJECT_0 && wait !== WAIT_TIMEOUT) return undefined
    return {
      started: `${record.dwHighDateTime}:${record.dwLowDateTime}`,
      active: wait === WAIT_TIMEOUT,
    }
  } finally {
    bindings.closeHandle(handle)
  }
}

/** 由 koffi 支撑的默认 internals；绑定在首次使用时惰性解析。 */
function defaultWindowsProcessInternals(): WindowsProcessInspectorInternals {
  return {
    snapshot: () => snapshotWindowsProcesses(win32Bindings()),
    processState: pid => windowsProcessState(win32Bindings(), pid),
    taskkill: taskkillTree,
  }
}
