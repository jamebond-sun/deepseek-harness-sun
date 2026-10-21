/** 用于终端就绪、信号与拆除的平台进程表检查。 */

import { closeSync, openSync, readFileSync, readdirSync, readlinkSync, readSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import type { SubprocessTerminalSignal } from '@deepseek-ai/dsh-subprocess'
import { createWindowsProcessInspector } from './windows-inspector.ts'

/** PID 加启动身份，用于防止 PID 复用后的拆除升级。 */
export interface ProcessIdentity {
  pid: number
  started: string
}

interface FileStatus {
  readonly rdev: number
  isCharacterDevice(): boolean
}

/**
 * 对平台进程表的一次观察，由一次就绪轮询或拆除过程所提出的每一个问题共享。
 *
 * 该表最多读取一次，即在第一个需要它的问题时——macOS 上 fork 一个 `/bin/ps`，
 * Linux 上遍历 `/proc`，Windows 上做一次 Toolhelp32 枚举。后续问题绝不会重新读取它，
 * 这正是让一次轮询的代价与运行中命令所生成的子孙数量无关的原因。Windows 的存活性
 * 根本不需要进程表：那里的等待状态是一个逐句柄的问题，因此一个只问存活性的快照
 * 从不枚举。
 *
 * 快照回答的是进程表所显示的内容，这正是批量过滤所需要的，也是信令所不可使用的：
 * {@link ProcessInspector.isAlive} 是信号所跨越的栅栏，因为它读取的是当前状态。
 */
export interface ProcessSnapshot {
  /** 进程表扫描是否没有遗漏任何不可读行；缺省表示未验证。 */
  readonly complete?: boolean
  /**
   * 返回按观察所得的根及其传递性后代，子节点在前。
   * @param rootPid - 要下行遍历的树根。
   * @returns 被观察的根与后代，子节点先于父节点。
   */
  tree(rootPid: number): ProcessIdentity[]
  /**
   * 返回对一个 POSIX 进程会话的被观察成员。
   * @param sessionId - POSIX 会话标识符。
   * @returns 被观察的会话成员；当平台进程表省略会话 id 时为空。
   */
  session(sessionId: number): ProcessIdentity[]
  /**
   * 返回该精确身份是否为一个非静默的进程。
   * @param identity - 需要匹配的 PID 加启动身份。
   * @returns 那一个精确身份——而不只是该 PID——是否在运行。
   */
  alive(identity: ProcessIdentity): boolean
}

/** 一个本地 PTY 会话所使用的、可注入的操作系统进程操作。 */
export interface ProcessInspector {
  foregroundPgid(shellPid: number): number | undefined
  /**
   * 报告前台进程组是否在等待终端 shell 的 stdin。
   *
   * @param pgid 前台进程组标识符。
   * @param shellPid 持久终端 shell 进程标识符。
   * @returns 是否有进程组成员因读取 shell 的终端输入而被阻塞。
   */
  isStdinWaiting(pgid: number, shellPid: number): boolean
  /**
   * 读取一次进程表，并据此回答树、会话与存活性。
   * @returns 一次读取被共享的进程表观察。
   * @throws 当平台进程表无法被枚举时。
   */
  snapshot(): ProcessSnapshot
  /**
   * 返回该精确身份此刻是否为一个非静默的进程。
   *
   * 读取的是平台所提供的、最窄的逐身份来源，而非整张表，因此一轮信令可以重新检查
   * 每个目标而不必付出一次扫描的代价。一次性过滤大量成员的调用方应改用
   * {@link ProcessSnapshot.alive}。
   *
   * @param identity - 需要匹配的 PID 加启动身份。
   * @returns 那一个精确身份——而不只是该 PID——是否在运行。
   */
  isAlive(identity: ProcessIdentity): boolean
  signalGroup(pgid: number, signal: SubprocessTerminalSignal): void
  /**
   * 向一个精确进程身份发信号，并设置针对 PID 复用的栅栏。
   *
   * 栅栏在信号发出之前立即读取当前状态。同一轮中较早取得的观察无法替代它：该观察
   * 保留了原始的 PID 到启动时间的配对，因此一个被回收的 PID 仍会匹配，并接下本应
   * 发给已退出进程的信号。
   *
   * @param identity - 需要发信号的 PID 加启动身份。
   * @param signal - 要投递的终止信号。
   */
  signalProcess(identity: ProcessIdentity, signal: 'SIGTERM' | 'SIGKILL'): void
}

/** 围绕文件系统、进程表与信号系统调用的、可测试化的边界。 */
export interface ProcessInspectorInternals {
  readFile(path: string): string
  readDir(path: string): string[]
  readLink(path: string): string
  stat(path: string): FileStatus
  open(path: string): number
  read(fd: number, buffer: Buffer, length: number, position: number): number
  close(fd: number): void
  exec(file: string, args: string[]): string
  kill(pid: number, signal: NodeJS.Signals): void
}

/* v8 ignore start -- thin OS bindings; injected logic is unit-tested and real platform composition exercises them. */
const DEFAULT_INTERNALS: ProcessInspectorInternals = {
  readFile: path => readFileSync(path, 'utf8'),
  readDir: path => readdirSync(path),
  readLink: path => readlinkSync(path, 'utf8'),
  stat: path => statSync(path),
  open: path => openSync(path, 'r'),
  read: (fd, buffer, length, position) => readSync(fd, buffer, 0, length, position),
  close: closeSync,
  exec: (file, args) => execFileSync(file, args, { encoding: 'utf8' }),
  kill: (pid, signal) => process.kill(pid, signal),
}
/* v8 ignore stop */

interface ProcStat {
  pid: number
  parentPid: number
  pgrp: number
  session: number
  state: string
  ttyDevice: number
  tpgid: number
  started: string
}

/**
 * 解析 Linux `/proc/<pid>/stat` 中使用的字段，包括带括号的 comm 文本。
 * @param text - 完整的 stat 行。
 * @returns 解析出的身份/组字段，或当输入畸形时为 undefined。
 */
export function parseProcStat(text: string): ProcStat | undefined {
  const open = text.indexOf('(')
  const close = text.lastIndexOf(')')
  if (open <= 0 || close <= open) return undefined
  const pid = Number(text.slice(0, open).trim())
  const rest = text.slice(close + 2).trim().split(/\s+/)
  const state = rest[0] || ''
  const parentPid = Number(rest[1])
  const pgrp = Number(rest[2])
  const session = Number(rest[3])
  const ttyDevice = Number(rest[4])
  const tpgid = Number(rest[5])
  const started = rest[19]
  if (![pid, parentPid, pgrp, session, ttyDevice, tpgid].every(Number.isSafeInteger)
    || state.length !== 1 || started === undefined) return undefined
  return { pid, parentPid, pgrp, session, state, ttyDevice, tpgid, started }
}

function readLinuxStat(internals: ProcessInspectorInternals, pid: number): ProcStat | undefined {
  try {
    return parseProcStat(internals.readFile(`/proc/${pid}/stat`))
  } catch (_unreadableProcEntry) {
    return undefined
  }
}

// `/proc/<pid>/stat` 将 tty_nr 以有符号 32 位设备号呈现，而 Node 把同样的 st_rdev
// 位以非负数字暴露。
function linuxDeviceNumber(value: number): number {
  return value >>> 0
}

// `/dev/tty` 通过 stat 报告的是别名设备而非所选 PTY，因此其拥有进程的 tty_nr
// 是唯一可比较的终端身份。
function readLinuxTerminalDevice(
  internals: ProcessInspectorInternals,
  pid: number,
  ttyDevice: number,
  tid?: number,
): number | undefined {
  const terminalDevice = linuxDeviceNumber(ttyDevice)
  if (terminalDevice === 0) return undefined
  const path = tid === undefined ? `/proc/${pid}/fd/0` : `/proc/${pid}/task/${tid}/fd/0`
  try {
    const target = internals.readLink(path)
    if (target === '/dev/tty') return terminalDevice
    const status = internals.stat(path)
    return status.isCharacterDevice() && linuxDeviceNumber(status.rdev) === terminalDevice
      ? terminalDevice
      : undefined
  } catch (_unreadableStdinDevice) {
    return undefined
  }
}

/**
 * 报告一个 Linux 进程组是否有正在执行的成员。`false` 表示该组只包含僵尸/死进程条目；
 * `undefined` 表示进程表无法证明任何一种结果。
 * @param processGroupId - 要检查的 POSIX 进程组 id。
 * @param internals - 可注入的进程表操作。
 * @returns 存活成员的存在情况，或在不可用/缺失时为 `undefined`。
 */
export function linuxProcessGroupHasLiveMembers(
  processGroupId: number,
  internals: ProcessInspectorInternals = DEFAULT_INTERNALS,
): boolean | undefined {
  let entries: string[]
  try {
    entries = internals.readDir('/proc')
  } catch (_unreadableProcDirectory) {
    return undefined
  }
  let matched = false
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    const stat = readLinuxStat(internals, Number(entry))
    if (stat?.pgrp !== processGroupId) continue
    matched = true
    if (!/^[ZXx]$/.test(stat.state)) return true
  }
  return matched ? false : undefined
}

function numericEntries(internals: ProcessInspectorInternals, path: string): number[] | undefined {
  try {
    return internals.readDir(path).filter(entry => /^\d+$/.test(entry)).map(Number)
  } catch (_unreadableProcDirectory) {
    return undefined
  }
}

interface SyscallInfo {
  number: number
  args: number[]
}

function readSyscall(internals: ProcessInspectorInternals, pid: number, tid: number): SyscallInfo | undefined {
  try {
    const text = internals.readFile(`/proc/${pid}/task/${tid}/syscall`).trim()
    if (text === 'running' || text.startsWith('-1 ')) return undefined
    const fields = text.split(/\s+/)
    const number = Number(fields[0])
    const args = fields.slice(1, 7).map(field => Number.parseInt(field, 16))
    if (!Number.isSafeInteger(number) || args.some(value => !Number.isSafeInteger(value))) return undefined
    return { number, args }
  } catch (_unreadableSyscall) {
    return undefined
  }
}

function readMemory(
  internals: ProcessInspectorInternals,
  pid: number,
  address: number,
  length: number,
): Buffer | undefined {
  let fd: number | undefined
  try {
    fd = internals.open(`/proc/${pid}/mem`)
    const buffer = Buffer.alloc(length)
    const count = internals.read(fd, buffer, length, address)
    return buffer.subarray(0, count)
  } catch (_unreadableProcessMemory) {
    return undefined
  } finally {
    if (fd !== undefined) internals.close(fd)
  }
}

function fdSetHasStdin(internals: ProcessInspectorInternals, pid: number, address: number): boolean {
  return address !== 0 && (readMemory(internals, pid, address, 8)?.[0] ?? 0) % 2 === 1
}

function pollHasStdin(
  internals: ProcessInspectorInternals,
  pid: number,
  address: number,
  count: number,
): boolean {
  if (address === 0 || count <= 0) return false
  const memory = readMemory(internals, pid, address, Math.min(count, 1024) * 8)
  if (memory === undefined) return false
  for (let offset = 0; offset + 8 <= memory.length; offset += 8) {
    if (memory.readInt32LE(offset) === 0 && (memory.readInt16LE(offset + 4) & 0x001) !== 0) return true
  }
  return false
}

function epollHasStdin(internals: ProcessInspectorInternals, pid: number, tid: number, epfd: number): boolean {
  try {
    return internals.readFile(`/proc/${pid}/task/${tid}/fdinfo/${epfd}`)
      .split('\n')
      .some(line => /^tfd:\s+0\b/.test(line.trim()))
  } catch (_unreadableFdInfo) {
    return false
  }
}

interface SyscallTable {
  read: number
  select?: number
  pselect: number
  poll?: number
  ppoll: number
  epollWait?: number
  epollPwait: number
}

const SYSCALLS: Partial<Record<NodeJS.Architecture, SyscallTable>> = {
  x64: { read: 0, select: 23, pselect: 270, poll: 7, ppoll: 271, epollWait: 232, epollPwait: 281 },
  arm64: { read: 63, pselect: 72, ppoll: 73, epollPwait: 22 },
}

const SUPPORTED_SYSCALL_TABLES = Object.values(SYSCALLS)

// `/proc/<pid>/task/<tid>/syscall` 使用的是内核 ABI 的编号。因此用户态模拟可能暴露出
// 一个与 process.arch 不同的受支持表。
function linuxSyscallTables(arch: NodeJS.Architecture): readonly SyscallTable[] | undefined {
  const primary = SYSCALLS[arch]
  if (primary === undefined) return undefined
  return [primary, ...SUPPORTED_SYSCALL_TABLES.filter(table => table !== primary)]
}

function syscallWaitsOnStdin(
  internals: ProcessInspectorInternals,
  pid: number,
  tid: number,
  syscall: SyscallInfo,
  tables: readonly SyscallTable[],
): boolean {
  const [a0 = 0, a1 = 0, a2 = 0] = syscall.args
  for (const table of tables) {
    if (syscall.number === table.read) return a0 === 0
    if (syscall.number === table.select || syscall.number === table.pselect) {
      return a0 >= 1 && fdSetHasStdin(internals, pid, a1)
    }
    if (syscall.number === table.poll || syscall.number === table.ppoll) {
      return a1 >= 1 && pollHasStdin(internals, pid, a0, a1)
    }
    if (syscall.number === table.epollWait || syscall.number === table.epollPwait) {
      return a2 >= 1 && epollHasStdin(internals, pid, tid, a0)
    }
  }
  return false
}

abstract class PosixProcessInspector implements ProcessInspector {
  constructor(protected readonly internals: ProcessInspectorInternals) {}

  abstract foregroundPgid(shellPid: number): number | undefined
  abstract isStdinWaiting(pgid: number, shellPid: number): boolean
  abstract snapshot(): ProcessSnapshot
  abstract isAlive(identity: ProcessIdentity): boolean

  signalGroup(pgid: number, signal: SubprocessTerminalSignal): void {
    this.internals.kill(-pgid, signal)
  }

  signalProcess(identity: ProcessIdentity, signal: 'SIGTERM' | 'SIGKILL'): void {
    if (this.isAlive(identity)) this.internals.kill(identity.pid, signal)
  }
}

interface ProcessTreeEntry extends ProcessIdentity {
  parentPid: number
}

/** 进程表中的一行，携带该平台进程表所暴露的字段。 */
interface ProcessRow extends ProcessTreeEntry {
  /** POSIX 会话标识符，或在该表省略时的 undefined。 */
  session: number | undefined
  /** 单字母进程状态，或在该表省略时的 undefined。 */
  state: string | undefined
}

// 僵尸态与死态会被判定为“存在于表中”，却永远不会是“仍在运行”；没有 state 列的表
// 只能报告存在性。
function quiescent(state: string | undefined): boolean {
  return state !== undefined && /^[ZXx]$/.test(state)
}

class PosixProcessSnapshot implements ProcessSnapshot {
  private readonly byPid: Map<number, ProcessRow>

  constructor(private readonly rows: ProcessRow[], readonly complete: boolean) {
    this.byPid = new Map(rows.map(row => [row.pid, row]))
  }

  tree(rootPid: number): ProcessIdentity[] {
    return processTree(this.rows, rootPid)
  }

  session(sessionId: number): ProcessIdentity[] {
    return this.rows.flatMap(row =>
      row.session === sessionId ? [{ pid: row.pid, started: row.started }] : [])
  }

  alive(identity: ProcessIdentity): boolean {
    const row = this.byPid.get(identity.pid)
    return row?.started === identity.started && !quiescent(row.state)
  }
}

function processTree(entries: ProcessTreeEntry[], rootPid: number): ProcessIdentity[] {
  const byPid = new Map(entries.map(entry => [entry.pid, entry]))
  const root = byPid.get(rootPid)
  if (root === undefined) return []
  const byParent = new Map<number, ProcessTreeEntry[]>()
  for (const entry of entries) {
    const children = byParent.get(entry.parentPid) ?? []
    children.push(entry)
    byParent.set(entry.parentPid, children)
  }
  const visited = new Set<number>()
  const result: ProcessIdentity[] = []
  const visit = (entry: ProcessTreeEntry): void => {
    if (visited.has(entry.pid)) return
    visited.add(entry.pid)
    for (const child of byParent.get(entry.pid) ?? []) visit(child)
    result.push({ pid: entry.pid, started: entry.started })
  }
  visit(root)
  return result
}

class LinuxProcessInspector extends PosixProcessInspector {
  constructor(
    private readonly arch: NodeJS.Architecture,
    internals: ProcessInspectorInternals,
  ) {
    super(internals)
  }

  foregroundPgid(shellPid: number): number | undefined {
    const tpgid = readLinuxStat(this.internals, shellPid)?.tpgid
    return tpgid !== undefined && tpgid > 0 ? tpgid : undefined
  }

  isStdinWaiting(pgid: number, shellPid: number): boolean {
    const tables = linuxSyscallTables(this.arch)
    if (tables === undefined) return false
    const shell = readLinuxStat(this.internals, shellPid)
    if (shell === undefined) return false
    const terminalDevice = readLinuxTerminalDevice(this.internals, shellPid, shell.ttyDevice)
    if (terminalDevice === undefined) return false
    for (const pid of numericEntries(this.internals, '/proc') ?? []) {
      const process = readLinuxStat(this.internals, pid)
      if (process?.pgrp !== pgid) continue
      for (const tid of numericEntries(this.internals, `/proc/${pid}/task`) ?? []) {
        const syscall = readSyscall(this.internals, pid, tid)
        if (syscall !== undefined
          && syscallWaitsOnStdin(this.internals, pid, tid, syscall, tables)
          && readLinuxTerminalDevice(this.internals, pid, process.ttyDevice, tid) === terminalDevice) return true
      }
    }
    return false
  }

  isAlive(identity: ProcessIdentity): boolean {
    const stat = readLinuxStat(this.internals, identity.pid)
    return stat?.started === identity.started && !quiescent(stat.state)
  }

  snapshot(): ProcessSnapshot {
    const pids = numericEntries(this.internals, '/proc')
    if (pids === undefined) throw new Error('Cannot inspect processes: /proc directory is unreadable')
    let complete = true
    const rows = pids.flatMap((pid) => {
      const stat = readLinuxStat(this.internals, pid)
      if (stat === undefined) complete = false
      return stat === undefined ? [] : [{
        pid,
        parentPid: stat.parentPid,
        started: stat.started,
        session: stat.session,
        state: stat.state,
      }]
    })
    return new PosixProcessSnapshot(rows, complete)
  }

}

// 此格式的 `ps` 既不暴露会话 id，也不暴露 state 列，因此 macOS 的一行只能回答存在性与
// 父子关系，却无法回答会话归属。
function macProcessTable(internals: ProcessInspectorInternals): { rows: ProcessRow[]; complete: boolean } {
  let complete = true
  const rows = internals.exec('/bin/ps', ['-axo', 'pid=,ppid=,lstart=']).split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
    if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) {
      if (line.trim().length > 0) complete = false
      return []
    }
    return [{
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      started: match[3],
      session: undefined,
      state: undefined,
    }]
  })
  return { rows, complete }
}

class MacProcessInspector extends PosixProcessInspector {
  foregroundPgid(shellPid: number): number | undefined {
    try {
      const value = Number(this.internals.exec('/bin/ps', ['-o', 'tpgid=', '-p', String(shellPid)]).trim())
      return Number.isSafeInteger(value) && value > 0 ? value : undefined
    } catch (_missingProcess) {
      return undefined
    }
  }

  isStdinWaiting(_pgid: number, _shellPid: number): boolean {
    return false
  }

  isAlive(identity: ProcessIdentity): boolean {
    return macProcessTable(this.internals).rows
      .some(entry => entry.pid === identity.pid && entry.started === identity.started)
  }

  snapshot(): ProcessSnapshot {
    const table = macProcessTable(this.internals)
    return new PosixProcessSnapshot(table.rows, table.complete)
  }

}

/**
 * 创建受支持的平台检查器，或在插件加载时失败。
 * @param platform - 目标 Node 平台。
 * @param arch - 用于 Linux 系统调用编号的目标 CPU 架构。
 * @param internals - 文件系统/进程边界，可注入以进行确定性测试。
 * @returns 平台进程检查器。
 */
export function createProcessInspector(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
  internals: ProcessInspectorInternals = DEFAULT_INTERNALS,
): ProcessInspector {
  if (platform === 'linux') return new LinuxProcessInspector(arch, internals)
  if (platform === 'darwin') return new MacProcessInspector(internals)
  if (platform === 'win32') return createWindowsProcessInspector()
  throw new Error(`subprocess-local: terminal inspection is unsupported on platform ${platform}`)
}
