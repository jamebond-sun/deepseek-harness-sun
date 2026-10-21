/**
 * DeepSeek Harness 沙箱接缝的 Windows ACL 写入限制后端。它复刻了
 * github.com/huoyaoyuan/windows-acl-restrict-poc @ 10e4dfb（已修复的修订版）
 * 的机制：一个 WRITE_RESTRICTED 令牌，其限制 SID 中包含互不相同的写入 SID
 * 与临时写入 SID，而本沙箱会把这两个 SID 加到各自所属目录的 DACL 上——于是
 * 交集检查恰好在任一能力持有 Write ACE 的地方允许写入，而在这些 SID 所涉的
 * 其他任何地方都不允许（该检查还会继承其他限制 SID 的环境写入 ACE——即保活
 * 组登录 SID + Everyone；Authenticated Users、INTERACTIVE 与 LOCAL 在两份
 * 列表中都不出现——完整边界见 `packages/sandbox/sandbox-local` 中该接缝的
 * 双列表契约，以及包内 README 的 Modes 一节）。该交集只覆盖对象自身的访问
 * 检查，因此令牌还会被降到 Low 完整性，且每个被授予的目录都带有 Low 禁止
 * 向上写入标签以及 `acl` 模块所记录的环境删除拒绝。写入 SID 是按工作区划分
 * 的身份（{@link workspaceWriteSid}）：由规范化工作区路径确定性派生，因此
 * 工作区根目录的 ACE 按机器、按工作区只物化一次，此后每次供应都命中精确
 * ACE 跳过——这正是"按会话随机 SID"要为每个会话付出一次整树传播代价的授予
 * 复用故事。每一个私有临时目录则各自获得自己的 SID，因此共享同一工作区的
 * 兄弟会话无法进入彼此的临时目录树。与 POC 不同，每一个 API 失败都会连同
 * API 名称与精确的 Win32 错误码抛出；子进程绝不会被不受限地派生。
 *
 * 已知边界（属于受限令牌的固有性质，而非本次移植的产物）：
 *  - 写入受限制；读取、网络与进程可见性不受限制（WRITE_RESTRICTED 只对
 *    写入访问求交集）；
 *  - 控制台隔离不可用——子进程与宿主机共用同一个控制台（在该限制之下，
 *    CREATE_NO_WINDOW / CREATE_NEW_CONSOLE 的子进程会以
 *    STATUS_DLL_INIT_FAILED 死亡）；
 *  - 私有临时目录与每一个可写目录都必须由调用方拥有（所有者隐式的
 *    WRITE_DAC）；
 *  - 授予都是对真实目录的常驻 ACE 修改。工作区授予被刻意从不撤销——该 ACE
 *    就是跨会话复用缓存（撤销会迫使下一个会话重新传播整棵树）。临时授予是
 *    可撤销的：dispose() 会移除它们，使一个常驻的可继承 ACE 永远不会比它
 *    所属会话的临时目录活得更久。环境临时根从不被隐式授予。当
 *    `manageDacls: false` 时，由调用方持有这些 DACL（即沙箱接缝的授予
 *    复用）：init()/dispose() 完全跳过授予/撤销，且调用方不得在存活的
 *    子进程之下做撤销。
 * @module @deepseek-ai/dsh-sandbox-windows-acl
 */

import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { Win32Error } from '@deepseek-ai/dsh-win32-process'

import { grantWrite, revokeWrite } from './acl.ts'
import { allocPtrSlot, decodePtr, isNullPtr, throwLastError, win32 } from './ffi.ts'
import type { NativePtr, Win32Bindings } from './ffi.ts'
import { assertPrivateTempDisjoint } from './path-boundary.ts'
import { drainPipe, spawnSandboxed, spawnSandboxedInherited, waitForExit } from './spawn.ts'
import { createRestrictedToken, findLogonSid, makeWellKnownSid, openCurrentProcessToken, restrictTokenIntegrity, setTokenDefaultDaclGrant } from './token.ts'
import * as abi from './win32-abi.ts'

export { AclWriteGrant } from './grant.ts'
export { assertTempRootOutsideWorkspace } from './path-boundary.ts'
export { tempWriteSid, workspaceWriteSid } from './workspace-sid.ts'
export { ACL_DIAGNOSIS_SKILL, registerAclDiagnosisSkill } from './acl-skill.ts'
/** 构造选项：工作区/临时允许列表及其各自不同的 SID 身份。 */
export interface AclSandboxOptions {
  /** 受限子进程允许写入的目录（必须存在且由调用方拥有）。 */
  writableDirs: readonly string[]
  /**
   * 待授予的既有私有临时目录。workspace-write 的调用方必须显式传入它，
   * 或传入 null 以禁用临时写入；环境临时根从不是一次隐式授予。read-only
   * 只接受 null/undefined。
   */
  tempDir?: string | null
  /**
   * 构成 workspace-write 允许列表的那个写入 SID：在 workspace-write 下必填，
   * 在 read-only 下被忽略（且必须不出现）。调用方通过
   * {@link workspaceWriteSid} 从工作区派生它——该身份是按工作区划分的，
   * 而非按沙箱实例划分，因此工作区根的 ACE 比每一个实例活得更久，后续供应
   * 都会命中精确 ACE 跳过。
   */
  writeSid?: string
  /**
   * 该私有临时目录的写入 SID。只要 workspace-write 授予了一个临时目录就
   * 必填，其余情形不出现。它必须与 {@link writeSid} 不同，因此共享同一
   * 工作区的兄弟会话无法借助常驻的工作区能力进入彼此的临时目录树。
   */
  tempWriteSid?: string
  /**
   * 本实例所限制的文件效应模式——它选定受限令牌的限制 SID 列表（read-only
   * 为 I，workspace-write 为 J），且必须与授予形状匹配：read-only 配零授予。
   * 运行器在其边界校验经 argv 传入的模式字符串；本带类型接缝信任该联合。
   */
  mode: 'read-only' | 'workspace-write'
  /**
   * 本实例是否持有自己的 DACL 授予（默认 true）。为 false 表示调用方已经
   * 物化了这些 ACE（沙箱接缝的工作区/临时能力生命周期）：init()/dispose()
   * 完全跳过授予/撤销——调用方按其自身生命周期持有这些授予并自行撤销。
   */
  manageDacls?: boolean
}

/** 每次派生的选项：程序、其 argv/cwd，以及 stdio 形态。 */
export interface AclSandboxSpawnOptions {
  /** 要运行的程序（非限定名时按 CreateProcess 的方式经 PATH 搜索解析）。 */
  command: string
  /** 参数，按 CommandLineToArgvW 的规则加引号。 */
  args?: readonly string[]
  /** 工作目录；默认为调用方的 cwd。 */
  cwd?: string
  /**
   * 'pipe'（默认）：通过匿名管道捕获 stdout/stderr。
   * 'inherit'：子进程直接继承调用方的 stdio（运行器用法——字节直通），且总是
   * 被包进一个"关闭即终止"的 Job，使子进程随调用方一同死亡；结果中的
   * stdout/stderr 为空。
   */
  stdio?: 'pipe' | 'inherit'
  /** 在继承 stdio 模式下转发到同一载荷描述符的控制管道。 */
  controlFileDescriptor?: 7
}

/** 一个已落定的受限子进程：捕获到的 stdio 与退出码。 */
export interface AclSandboxChildResult {
  stdout: Buffer
  stderr: Buffer
  exitCode: number
}

/** 一个正在运行的受限子进程：其 pid 与一个落定 promise。 */
export interface AclSandboxChild {
  /** 子进程 id。 */
  pid: number
  /** 在子进程退出后解析出 stdout/stderr 与退出码。 */
  wait(): Promise<AclSandboxChildResult>
}

/** 释放一个可选 SID，同时为尽最大努力的兄弟清理保留失败信息。 */
function freeSidBestEffort(
  api: Win32Bindings,
  sidPtr: NativePtr | undefined,
  label: string,
  failures: unknown[],
): void {
  if (sidPtr === undefined) return
  try {
    const freed = api.localFree(sidPtr)
    if (!isNullPtr(freed)) throwLastError(api, 'LocalFree', label)
  } catch (error) {
    failures.push(error)
  }
}

/**
 * 一个写入受限的沙箱实例：令牌 + 写入 SID 授予 + 派生。`init()` 是失败即
 * 关闭的——任何 Win32 失败都会撤销那些可撤销的（临时）授予并抛出；
 * `dispose()` 撤销临时授予、保留常驻的工作区 ACE 不动（跨实例复用缓存）、
 * 释放每一次分配，并上报每一次清理失败。当 `manageDacls: false` 时由调用方
 * 持有这些授予（沙箱接缝的授予复用）：init() 不应用任何授予，dispose()
 * 也不撤销任何授予。
 */
export class AclSandbox {
  /** 绝对的可写目录（在构造函数中校验）。 */
  readonly writableDirs: string[]
  /** 其 ACE 构成工作区允许列表的工作区 SID 字符串。 */
  readonly writeSid: string | undefined
  /** 该私有临时目录的写入 SID（仅在带临时的 workspace-write 下存在）。 */
  readonly tempWriteSid: string | undefined
  /** 文件效应模式——选定受限令牌的限制 SID 列表。 */
  readonly mode: 'read-only' | 'workspace-write'
  private readonly tempDirOption: string | null | undefined
  private readonly manageDacls: boolean
  private tempDirResolved: string | null | undefined
  private api: Win32Bindings | undefined
  private token: NativePtr | undefined
  private writeSidPtr: NativePtr | undefined
  private tempWriteSidPtr: NativePtr | undefined
  /** init() 所分配的已知 SID/登录 SID；由 dispose() 与写入 SID 一并释放。 */
  private sidAllocations: NativePtr[] = []
  private grantedPaths: Array<{ path: string; sidPtr: NativePtr }> = []

  constructor(options: AclSandboxOptions) {
    this.mode = options.mode
    this.manageDacls = options.manageDacls ?? true
    this.writableDirs = options.writableDirs.map((directory) => {
      const absolute = resolve(directory)
      if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
        throw new Error(`AclSandbox writable dir does not exist or is not a directory: ${absolute}`)
      }
      return absolute
    })
    this.tempDirOption = options.tempDir
    this.writeSid = options.writeSid
    this.tempWriteSid = options.tempWriteSid
    if (this.mode === 'workspace-write' && this.writeSid === undefined) {
      throw new Error('AclSandbox workspace-write requires a write SID — derive it from the workspace via workspaceWriteSid()')
    }
    if (this.mode === 'workspace-write' && this.tempDirOption === undefined) {
      throw new Error('AclSandbox workspace-write requires an explicit private temp directory or null')
    }
    if (this.mode === 'read-only' && this.tempDirOption !== undefined && this.tempDirOption !== null) {
      throw new Error('AclSandbox read-only does not accept a temp directory')
    }
    if (this.mode === 'read-only' && (this.writeSid !== undefined || this.tempWriteSid !== undefined)) {
      throw new Error('AclSandbox read-only does not accept write SIDs')
    }
    if (this.mode === 'workspace-write' && this.tempDirOption !== null && this.tempWriteSid === undefined) {
      throw new Error('AclSandbox workspace-write with temp requires a temp write SID — derive it via tempWriteSid()')
    }
    if (this.tempDirOption === null && this.tempWriteSid !== undefined) {
      throw new Error('AclSandbox temp write SID requires a temp directory')
    }
    if (this.writeSid !== undefined && this.tempWriteSid === this.writeSid) {
      throw new Error('AclSandbox workspace and temp write SIDs must be distinct')
    }
  }

  /** 已解析的临时目录（init 之后可用；临时授予被禁用时为 null）。 */
  get tempDir(): string | null | undefined {
    return this.tempDirResolved
  }

  /** 创建受限令牌并应用能力 SID 授予。非幂等：每个实例只能调用一次。 */
  async init(): Promise<void> {
    if (this.api !== undefined) throw new Error('AclSandbox is already initialized')
    const api = await win32()
    const currentToken = openCurrentProcessToken(api)
    let currentTokenOpen = true
    let restrictedToken: NativePtr | undefined
    try {
      const parseSid = (sid: string): NativePtr => {
        const sidSlot = allocPtrSlot()
        if (api.convertStringSidToSidW(sid, sidSlot) === 0) {
          throwLastError(api, 'ConvertStringSidToSidW', sid)
        }
        const parsedSid = decodePtr(sidSlot)
        if (parsedSid === null) throw new Win32Error('ConvertStringSidToSidW', api.getLastError(), sid)
        return parsedSid
      }
      this.writeSidPtr = this.writeSid === undefined ? undefined : parseSid(this.writeSid)
      this.tempWriteSidPtr = this.tempWriteSid === undefined ? undefined : parseSid(this.tempWriteSid)

      const tempDir = this.mode === 'read-only' || this.tempDirOption === null ? null : this.tempDirOption
      /* v8 ignore next -- 构造函数校验要求 workspace-write 提供显式的临时目录或 null；
         其他分支都会归一化为 null。 */
      if (tempDir === undefined) throw new Error('AclSandbox workspace-write temp directory was not resolved')
      if (tempDir !== null) {
        if (!existsSync(tempDir) || !statSync(tempDir).isDirectory()) {
          throw new Error(`AclSandbox temp dir does not exist or is not a directory: ${tempDir}`)
        }
        assertPrivateTempDisjoint(this.writableDirs, tempDir)
      }
      this.tempDirResolved = tempDir

      // manageDacls: false——调用方（沙箱接缝的授予）已经物化了这些 ACE；
      // 本实例既不得添加也不得移除任何 ACE。当本实例持有这些 DACL 时，
      // writableDir 的 ACE 是常驻的（按工作区划分的复用缓存——dispose()
      // 从不撤销它们，否则下一次供应就得重新传播整棵树），而临时 ACE 是
      // 可撤销的（dispose() 在私有目录被删除之前移除它；环境临时根从不
      // 被授予）。
      // 这些授予用于拒绝与打标签的 Low 标签 SID 与 world SID。
      const lowLabelSid = makeWellKnownSid(api, abi.WinLowLabelSid)
      const worldSid = makeWellKnownSid(api, abi.WinWorldSid)
      this.sidAllocations.push(lowLabelSid, worldSid)

      if (this.manageDacls) {
        if (this.writeSidPtr !== undefined) {
          for (const path of this.writableDirs) {
            grantWrite(api, path, this.writeSidPtr, lowLabelSid, worldSid)
          }
          if (tempDir !== null && this.tempWriteSidPtr !== undefined) {
            // 在授予之前记录：grantWrite 可能在一次成功应用之后抛错
            // （一次 LocalFree 失败），而失败即关闭的 catch 必须仍然撤销
            // 该路径（撤销一个从未授予过的路径是一次空操作式的合并）。
            this.grantedPaths.push({ path: tempDir, sidPtr: this.tempWriteSidPtr })
            grantWrite(api, tempDir, this.tempWriteSidPtr, lowLabelSid, worldSid)
          }
        }
      }
      const logonSid = findLogonSid(api, currentToken)
      this.sidAllocations.push(logonSid)
      const writeSids = [this.writeSidPtr, this.tempWriteSidPtr].filter((sid): sid is NativePtr => sid !== undefined)
      restrictedToken = createRestrictedToken(
        api, currentToken, logonSid, writeSids,
        { world: worldSid },
        this.mode,
      )
      restrictTokenIntegrity(api, restrictedToken, lowLabelSid)
      this.token = restrictedToken
      // 受限令牌的默认 DACL 仍旧只点名用户那些环境 SID——没有一个是限制
      // SID。受限进程所创建的每一个新对象（匿名 stdio 管道、同步对象）都从
      // 该默认值取得其 DACL，因此写入的第二趟检查会拒绝创建管道
      // （ERROR_ACCESS_DENIED；Node 表现为 EPERM），从而破坏每一次管道式
      // stdio 的孙进程派生。合并进一条针对某个限制 SID 的完全访问 ACE
      // （存在时取私有的临时 SID，否则取工作区 SID，read-only 下取
      // Everyone）：新对象的创建仍受父对象 DACL 把关，而新对象自身的 DACL
      // 则能通过第二趟检查。选择临时 SID 可以防止某个会话临时目录树中那些
      // 默认 DACL 对象获得共享的工作区能力。
      setTokenDefaultDaclGrant(api, restrictedToken, this.tempWriteSidPtr ?? this.writeSidPtr ?? worldSid)
      if (api.closeHandle(currentToken) === 0) throwLastError(api, 'CloseHandle', 'current process token')
      currentTokenOpen = false
      this.api = api
    } catch (error) {
      // 失败即关闭的清理：绝不在一次失败的 init 之后留下可撤销的（临时）
      // 授予或 SID 分配。常驻的工作区 ACE 不被撤销——它们是预期的终态
      // （复用缓存），而非错误残留。
      const cleanupFailures: unknown[] = []
      if (currentTokenOpen && api.closeHandle(currentToken) === 0) {
        cleanupFailures.push(new Win32Error('CloseHandle', api.getLastError(), 'current process token after init failure'))
      }
      if (restrictedToken !== undefined && api.closeHandle(restrictedToken) === 0) {
        cleanupFailures.push(new Win32Error('CloseHandle', api.getLastError(), 'restricted token after init failure'))
      }
      for (const grant of this.grantedPaths) {
        try {
          revokeWrite(api, grant.path, grant.sidPtr)
        } catch (cleanupError) {
          cleanupFailures.push(cleanupError)
        }
      }
      for (const [label, sidPtr] of [['workspace write SID', this.writeSidPtr], ['temp write SID', this.tempWriteSidPtr]] as const) {
        freeSidBestEffort(api, sidPtr, label, cleanupFailures)
      }
      for (const sidPtr of this.sidAllocations.splice(0)) {
        freeSidBestEffort(api, sidPtr, 'init SID allocation', cleanupFailures)
      }
      this.token = undefined
      this.writeSidPtr = undefined
      this.tempWriteSidPtr = undefined
      this.tempDirResolved = undefined
      this.grantedPaths = []
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [error, ...cleanupFailures],
          `AclSandbox init failed and ${cleanupFailures.length} cleanup operation(s) also failed`,
        )
      }
      throw error
    }
  }

  /**
   * 在受限令牌之下派生一个进程。失败即关闭：任何 Win32 失败都抛出；子进程
   * 绝不会以不受限的方式被创建。当 `stdio: 'inherit'` 时，子进程直接共用
   * 调用方的 stdio，并被放进一个"关闭即终止"的 Job（随调用方一同死亡）。
   * 只能在所有子进程都已退出之后调用 dispose()——在一个存活的子进程之下
   * 撤销授予会移除它剩余的写入额度。
   * @param options - 程序、argv/cwd 以及 stdio 形态。
   * @returns 正在运行的子进程。
   */
  spawn(options: AclSandboxSpawnOptions): AclSandboxChild {
    const api = this.api
    const token = this.token
    if (api === undefined || token === undefined) throw new Error('AclSandbox is not initialized: call init() first')
    if (options.controlFileDescriptor !== undefined && options.stdio !== 'inherit') {
      throw new Error('control pipe requires inherited stdio')
    }
    const args = options.args ?? []
    const cwd = options.cwd ?? process.cwd()

    if (options.stdio === 'inherit') {
      const native = spawnSandboxedInherited(api, token, {
        command: options.command, args, cwd,
        ...options.controlFileDescriptor === undefined ? {} : { controlFileDescriptor: options.controlFileDescriptor },
      })
      let exitCodePromise: Promise<number> | undefined
      return {
        pid: native.pid,
        wait: async () => {
          exitCodePromise ??= Promise.resolve(waitForExit(api, native.process))
          const exitCode = await exitCodePromise
          if (api.closeHandle(native.job) === 0) throwLastError(api, 'CloseHandle', 'kill-on-close job')
          return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode }
        },
      }
    }

    const native = spawnSandboxed(api, token, { command: options.command, args, cwd })
    const stdout = drainPipe(api, native.stdoutRead)
    const stderr = drainPipe(api, native.stderrRead)
    // 这里刻意不启动 waitForExit：WaitForSingleObject 会阻塞线程，从而在
    // 子进程仍在运行时饿死那些排空操作（管道缓冲区死锁）。排空操作只有在
    // 子进程关闭其管道端之后才会解析——那时等待会立即返回。
    let exitCodePromise: Promise<number> | undefined
    return {
      pid: native.pid,
      wait: async () => {
        const stdoutBuffer = await stdout
        const stderrBuffer = await stderr
        exitCodePromise ??= Promise.resolve(waitForExit(api, native.process))
        return { stdout: stdoutBuffer, stderr: stderrBuffer, exitCode: await exitCodePromise }
      },
    }
  }

  /**
   * 撤销那些可撤销的（临时）授予、释放 SID、关闭令牌；常驻的工作区 ACE
   * 保留（复用缓存）。上报每一次清理失败。
   */
  dispose(): void {
    const api = this.api
    if (api === undefined) return
    const failures: unknown[] = []
    if (this.manageDacls) {
      for (const grant of this.grantedPaths) {
        try {
          revokeWrite(api, grant.path, grant.sidPtr)
        } catch (error) {
          failures.push(error)
        }
      }
    }
    for (const [label, sidPtr] of [['workspace write SID', this.writeSidPtr], ['temp write SID', this.tempWriteSidPtr]] as const) {
      freeSidBestEffort(api, sidPtr, label, failures)
    }
    const token = this.token
    /* v8 ignore next -- init 只在 this.token 之后才赋值 this.api，因此一个已初始化的实例
       总是持有其令牌；该守卫与写入 SID 的守卫对称。 */
    if (token !== undefined) {
      try {
        if (api.closeHandle(token) === 0) throwLastError(api, 'CloseHandle', 'restricted token')
      } catch (error) {
        failures.push(error)
      }
    }
    for (const sidPtr of this.sidAllocations.splice(0)) {
      freeSidBestEffort(api, sidPtr, 'init SID allocation', failures)
    }
    this.api = undefined
    this.token = undefined
    this.writeSidPtr = undefined
    this.tempWriteSidPtr = undefined
    this.grantedPaths = []
    if (failures.length > 0) {
      throw new AggregateError(failures, `AclSandbox dispose completed with ${failures.length} cleanup failure(s)`)
    }
  }
}
