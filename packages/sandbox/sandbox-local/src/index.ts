/**
 * 本地沙箱后端。它选择平台对应的运行器链（Linux 上是 bwrap 再到 Landlock；
 * macOS 上是 Seatbelt；Windows 上是 ACL 受限令牌运行器），对相互竞争的候选
 * 者做一次功能性探测，并上报每次包装的强制完整度与 stderr 分类事实。缺失
 * 或不可用的限制一律失败即关闭，而不是原样返回调用方的 argv。
 *
 * windows-acl 这一环节还额外持有写入授予：写入 SID 是由规范化工作区路径
 * 派生出的按工作区划分的身份（`workspaceWriteSid`），而每个活跃会话都会获得
 * 一个随机的私有临时目录及其派生能力（`tempWriteSid`）。工作区根目录的 ACE
 * 在服务器生命周期内按工作区只物化一次并保持常驻（跨会话复用缓存——精确
 * ACE 跳过使得此后每次供应都是 O(1)，而不必按会话重新向整棵树传播）；私有
 * 临时目录的 ACE 则在 dispose 时撤销。运行器接收这两个 SID（它们的出现即
 * 标记了由本接缝托管的契约），并不再自行管理 DACL。该环节上报部分强制，
 * 因为 NTFS 硬链接会把同一个文件对象别名到多个路径上、读取始终不受限，
 * 且另一 AppContainer 工具以包 SID 施加过 ACL 的目录树对 Low 完整性子进程
 * 不可读。
 * @module @deepseek-ai/dsh-sandbox-local
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  LAUNCHER_BIN,
  LAUNCHER_FAILURE_EXIT,
  launcherPath as landlockLauncherPath,
  probe as defaultProbeLandlock,
} from '@deepseek-ai/node-addon-system/landlock-run'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SandboxProvider, SandboxUnavailableError, canonicalPath } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, ConfinedSandboxMode, RunnerFailureRule, SandboxEnforcement, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { AclWriteGrant, assertTempRootOutsideWorkspace, registerAclDiagnosisSkill, tempWriteSid, workspaceWriteSid } from '@deepseek-ai/dsh-sandbox-windows-acl'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { bwrapProfileArgs, landlockProfileArgs, seatbeltProfileArgs } from './profiles.ts'

/** 插件配置。全部可选——`static Config` 提供默认值。 */
export interface Config {
  /**
   * 覆盖运行器 argv；bwrap 兼容的配置参数会被追加在其后。非空覆盖即断言
   * 完整强制，并跳过内建的选型与探测。一个能够启动但拒绝其配置的运行器，
   * 必须能被 {@link runnerFailureSignatures} 识别。消费者只有在确认工作目录
   * 可用之后，才对一次 spawn 拒绝做分类。当 `error.path` 等于 argv[0] 且
   * `error.syscall` 为 `spawn` 或 `spawn <runner>` 时，或当 `error.path`
   * 缺失且 `error.syscall` 恰为 `spawn <runner>` 时，`ENOENT` 或 `EACCES`
   * 即标识出该运行器。
   */
  runnerCommand?: string[]
  /**
   * 已配置的 {@link runnerCommand} 在执行被包装命令之前拒绝其配置时，所输出
   * 的大小写不敏感 stderr 子串。与 `runnerCommand` 同时出现时必填且非空；
   * 缺少它则被拒绝。每一条目都是一个非空、单行、大小写不敏感的子串，覆盖
   * 该可执行运行器自身的失败方言。
   */
  runnerFailureSignatures?: string[]
  /** 每次功能性探测的正超时；对 Node 而言 0 意味着无限制。 */
  probeTimeoutMs?: number
}

/** 探测 `bwrap` 能否创建该配置；提供者会缓存这一有界结果。 */
function defaultProbeBwrap(timeoutMs: number): boolean {
  const probe = spawnSync('bwrap', [...bwrapProfileArgs({ mode: 'read-only', workspaceRoot: '/' }), '--', 'true'], {
    timeout: timeoutMs,
    stdio: 'ignore',
  })
  return probe.status === 0
}

/**
 * Seatbelt 功能性探测：通过 `sandbox-exec -p` 应用真实的 `read-only` 配置，
 * 并在其下运行 `true`——退出码 0 表示内核接受并强制了该配置（当
 * `sandbox_init` 拒绝配置时，`sandbox-exec` 会以非零码退出）。缺少
 * `sandbox-exec`（所有非 macOS 宿主机）会让 spawn 失败并探测为 `unusable`，
 * 与其他环节上二进制缺失的情形完全一致。Apple 将该 CLI 标记为已弃用，但在
 * 每个 macOS 上仍然随系统分发；若它有朝一日消失，正是这个探测会失败即关闭。
 */
function defaultProbeSeatbelt(seatbeltExec: string, timeoutMs: number): boolean {
  const probe = spawnSync(seatbeltExec, [...seatbeltProfileArgs({ mode: 'read-only', workspaceRoot: '/' }), '--', 'true'], {
    timeout: timeoutMs,
    stdio: 'ignore',
  })
  return probe.status === 0
}

/**
 * windows-acl 功能性探测：以只读模式（零授予、不改 ACL）把运行器套在
 * `cmd /c exit 0` 之外运行——退出码 0 表示运行器创建了受限令牌并在其下
 * 派生了子进程。win32 链是单一候选者，因此产品从不探测；该探测是为覆盖
 * 链而存在，并与其他环节保持同样的形状。
 */
function defaultProbeWindowsAcl(runnerInvocation: string[], timeoutMs: number): boolean {
  const program = runnerInvocation[0]
  if (program === undefined) return false
  const probe = spawnSync(program, [
    ...runnerInvocation.slice(1),
    '--workspace', tmpdir(), '--temp', tmpdir(), '--mode', 'read-only',
    '--', 'cmd', '/c', 'exit', '0',
  ], {
    timeout: timeoutMs,
    stdio: 'ignore',
  })
  return probe.status === 0
}

/** 测试钩子：注入探测结论 / 伪启动器 / 一个没有真实运行器的平台。 */
export interface SandboxInternals {
  /** 替换用于选链的 `process.platform`（可从任意宿主机演练任意平台的链）。 */
  platform?: string
  /** 整体替换该平台的链（行走机制——例如探测产品链上只有未探测才会到达的某个环节）。 */
  chain?: readonly SelectedRunner['runner'][]
  /** 替换 `bwrap` 功能性探测（Linux 链的第一环节）。 */
  probeBwrap?: () => boolean
  /** 替换 Landlock 启动器功能性探测（Linux 链的第二环节）。 */
  probeLandlock?: (launcher: string) => SandboxEnforcement | 'unusable'
  /** 替换 Seatbelt 功能性探测（darwin 链的唯一环节——仅在该链日后变长时才会被用到）。 */
  probeSeatbelt?: (seatbeltExec: string) => boolean
  /** 替换解析出的 `landlock-run` 启动器路径（一个伪启动器脚本）。 */
  landlockLauncher?: string
  /** 替换探测与包装所调用的 `sandbox-exec` 可执行文件（一个伪脚本）。 */
  seatbeltExec?: string
  /** 替换解析出的 windows-acl 运行器 argv 前缀（一个伪运行器）。 */
  windowsAclRunnerArgs?: string[]
  /** 替换解析出的 windows-acl 运行器构建产物入口路径（一个伪 lib/runner.js 位置）。 */
  windowsAclRunnerEntry?: string
  /** 替换 windows-acl 功能性探测（win32 链的唯一环节——仅在该链日后变长时才会被用到）。 */
  probeWindowsAcl?: () => boolean
  /** 替换提供者 dispose 时的私有临时目录删除（一个会抛错的替身用以演练清理失败路径）。 */
  rmTempDir?: (path: string) => void
}

/** 链的结论：由哪个运行器施加限制，以及它强制得有多完整。 */
type SelectedRunner = { runner: 'bwrap' | 'landlock' | 'seatbelt' | 'windows-acl'; enforcement: SandboxEnforcement }

/** 一个活跃会话/工作区对的私有临时目录及其能力。 */
interface AclTempCapability {
  dir: string
  writeSid: string
  grant: AclWriteGrant
}

/**
 * 各平台的运行器链——选型首先是按平台，其次才是探测：只有当某平台的链
 * 有超过一个候选者时，才按优先顺序探测（探测用于裁决，而不是去复核一个
 * 别无选择的结论）。没有任何链的平台在 `confine()` 处失败即关闭。Linux
 * 优先选择 `bwrap`（其挂载配置最贴近模式词汇）而非 Landlock 启动器；
 * darwin 恰好只有一个候选者，不经任何探测即被选中。
 */
const PLATFORM_CHAINS: Record<string, readonly SelectedRunner['runner'][]> = {
  linux: ['bwrap', 'landlock'],
  darwin: ['seatbelt'],
  // Windows 受限令牌运行器（@deepseek-ai/dsh-sandbox-windows-acl）：
  // 单一候选者，不经探测即被选中——它在执行期的拒绝会通过其 stderr
  // 特征串（windows-acl-run:）与退出码 127 失败即关闭。
  win32: ['windows-acl'],
}

/**
 * 某一环节在未经探测而被选中时（链长为 1）所声称的强制完整度。`bwrap`
 * 与 Seatbelt 在构造上就管辖了所有已承诺的文件效应，因此这一声称是一个
 * 配置事实；列出 `landlock` 只是为了表的完整性，它在没有探测时不可达
 * （Linux 链有两个环节，因此它只会经由探测被选中，而正是探测的报告区分
 * 了完整与按 ABI 而言的部分——并且该启动器还会在每次受限运行时的 stderr
 * 上自行上报部分强制）。
 */
const STATIC_ENFORCEMENT: Record<SelectedRunner['runner'], SandboxEnforcement> = {
  bwrap: 'full',
  landlock: 'full',
  seatbelt: 'full',
  // 进程初始化期间 Everyone 仍留在两个限制列表中，但 Low 标签剥夺了它
  // 曾经赋予的写权限。NTFS 硬链接依旧能把一个已授予的工作区文件别名到
  // 工作区之外的路径上，读取仍然不受限，而施加过 AppContainer ACL 的目录
  // 树对子进程不可读：该后端强制的是剩余可由 ACL 触达的那部分表面，
  // 因此不得宣称绝对的承诺。
  'windows-acl': 'partial',
}

/**
 * 探测的时限必须是一个正的有限数：Node 把 `spawnSync({ timeout: 0 })`
 * 当作没有超时，因此一个未经校验的 0 会静默地意味着"无限制"——
 * 与该字段所承诺的正好相反。
 */
function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`sandbox-local: ${name} must be a positive finite number`)
  }
}

/**
 * 每个运行器所用内核所说的拒绝"方言"——在其之下被拒绝的文件效应会产生哪些
 * 大小写不敏感的 stderr 子串，每次包装都会携带（即本接缝的
 * `ConfinedArgv.denialSignatures`）。
 */
const DENIAL_SIGNATURES = {
  bwrap: ['read-only file system'],
  landlock: ['permission denied'],
  seatbelt: ['operation not permitted'],
  // pwsh/.NET："Access to the path '...' is denied."；cmd："Access is denied."；
  // Node EACCES："permission denied"；EPERM："operation not permitted"。
  'windows-acl': ['access is denied', 'access to the path', 'permission denied', 'operation not permitted'],
  runnerCommand: ['read-only file system', 'permission denied'],
} as const satisfies Record<SelectedRunner['runner'] | 'runnerCommand', readonly string[]>

/** windows-acl 运行器文档化的失败退出码（它自己的 RUNNER_FAILURE_EXIT 契约，区别于 Landlock 的 125）。 */
const WINDOWS_ACL_RUNNER_FAILURE_EXIT = 127

/**
 * 由运行器持有的致命诊断。Landlock 有一份带版本号的 exit-125 加致命行
 * 的启动器失败契约。Bubblewrap 当前的致命路径以 1 退出，但其公开契约并
 * 未保留该状态，而 sandbox-exec 根本没有发布启动器失败状态；这些后端因此
 * 仅按特征串识别。windows-acl 运行器在每次运行器侧失败时打印
 * `windows-acl-run: <detail>` 并以 127 退出——该规则以这一退出状态为门槛，
 * 因此一个仅仅打印出该特征串的受限命令（或是在子进程非零退出时上报的运行器
 * 清理失败）永远不会被误判为"命令没有运行"。请让 Landlock 的元组与
 * `packages/test-support/session-snapshot/tests/fixtures/partial-landlock-sandbox.ts`
 * 中已装配的快照夹具保持一致。
 */
const RUNNER_FAILURE_RULES = {
  bwrap: [{ fatalSignatures: ['bwrap: '] }],
  landlock: [{
    allowedExitCodes: [LAUNCHER_FAILURE_EXIT],
    fatalSignatures: [`${LAUNCHER_BIN}: `],
    informationalLines: [`${LAUNCHER_BIN}: partial enforcement (older Landlock ABI)`],
  }],
  seatbelt: [{ fatalSignatures: ['sandbox-exec: '] }],
  'windows-acl': [{ allowedExitCodes: [WINDOWS_ACL_RUNNER_FAILURE_EXIT], fatalSignatures: ['windows-acl-run: '] }],
} as const satisfies Record<SelectedRunner['runner'], readonly RunnerFailureRule[]>

/**
 * 本地进程沙箱提供者。注册为 `ctx.sandbox`。缓存链的结论，并在 windows-acl
 * 环节上缓存写入授予（{@link AclWriteGrant}：按工作区划分的常驻工作区根
 * 授予，以及按活跃会话/工作区对划分、可撤销的私有临时目录授予，后者在
 * 提供者 dispose 时撤销）；一次性的探测之外不再派生任何进程。
 */
export class LocalSandboxProvider extends SandboxProvider {
  // 内联 schema 调用：配置目录会静态地遍历 `static Config`。
  static Config: z<Config> = z.object({
    runnerCommand: z.array(z.string()).default([]),
    runnerFailureSignatures: z.array(z.string()).default([]),
    probeTimeoutMs: z.natural().default(5_000),
  })

  /** 测试钩子（对应 bash 执行器的 `internals`）。 */
  internals: SandboxInternals = {}

  private readonly runnerCommand: string[] | undefined
  private readonly configuredRunnerFailureSignatures: string[]
  private readonly probeTimeoutMs: number
  /** 缓存的链结论；在首次受限包装需要它之前保持 undefined。 */
  private selectedRunner: SelectedRunner | 'unavailable' | undefined
  /**
   * 服务器生命周期内的写入授予（windows-acl 环节）：按工作区划分的常驻
   * 工作区根授予（其 ACE 就是跨会话复用缓存，比提供者活得更久——从不撤销），
   * 以及按活跃会话/工作区对划分、可撤销的私有临时目录授予（在提供者
   * dispose 时撤销）。
   */
  private readonly workspaceGrants = new Map<string, AclWriteGrant>()
  private readonly tempCapabilities = new Map<string, AclTempCapability>()

  constructor(ctx: Context, config: Config) {
    super(ctx)
    // schema（static Config）为每个字段都提供了默认值——这些断言记录的
    // 正是那些运行期事实。runnerCommand 为空表示"未配置"：改用平台链。
    const runner = config.runnerCommand as string[]
    const runnerFailureSignatures = config.runnerFailureSignatures as string[]
    if (runner.length === 0 && runnerFailureSignatures.length > 0) {
      throw new Error('sandbox-local: runnerFailureSignatures requires runnerCommand')
    }
    if (runner.length > 0 && runnerFailureSignatures.length === 0) {
      throw new Error('sandbox-local: runnerCommand requires at least one runnerFailureSignatures entry')
    }
    if (runnerFailureSignatures.some(signature => signature.trim().length === 0 || /[\r\n]/u.test(signature))) {
      throw new Error('sandbox-local: runnerFailureSignatures entries must be non-empty single-line strings')
    }
    this.runnerCommand = runner.length > 0 ? runner : undefined
    this.configuredRunnerFailureSignatures = runnerFailureSignatures
    this.probeTimeoutMs = config.probeTimeoutMs as number
    assertPositiveFinite('probeTimeoutMs', this.probeTimeoutMs)
    // 运维人员提供的运行器不使用 ACL 后端。注册表仍是可选的，可以在本
    // 提供者之后挂载。
    /* v8 ignore next 3 -- 仅 Windows 的注册；Linux 覆盖通道无法走到这一分支 */
    if (process.platform === 'win32' && this.runnerCommand === undefined) {
      ctx.inject(['skills'], (skillsCtx) => { registerAclDiagnosisSkill(skillsCtx) })
    }
    // 临时授予随提供者一并撤销：一次干净的服务器关闭不会留下任何临时
    // ACE（工作区 ACE 按设计保持常驻——即复用缓存；非正常关闭则把它们
    // 留给下一次供应去做精确 ACE 跳过）。
    ctx.effect(() => () => {
      this.revokeAclGrants()
    })
  }

  /**
   * 按 `policy` 把 `argv` 包装进所选运行器的调用中——若已配置
   * `runnerCommand` 则用它（运维人员的断言，不做探测），否则使用平台链上
   * 那个以自身配置方言表达的运行器。
   *
   * @param argv - 调用方即将 spawn 的精确 argv。
   * @param policy - 本次执行所运行的文件效应策略。
   * @param signal - 在策略解析或授予创建之前的取消信号。
   * @returns 包装后的 argv，以及所选后端的强制完整度、拒绝特征串与运行器
   *   失败结构化规则；当平台上没有可用运行器时，抛出失败即关闭的
   *   `SANDBOX_UNAVAILABLE` 错误。
   */
  async confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv> {
    signal?.throwIfAborted()
    policy = { ...policy, workspaceRoot: canonicalPath(policy.workspaceRoot) }
    if (this.runnerCommand !== undefined) {
      return Promise.resolve<ConfinedArgv>({
        argv: [...this.runnerCommand, ...bwrapProfileArgs(policy), '--', ...argv],
        enforcement: 'full',
        denialSignatures: DENIAL_SIGNATURES.runnerCommand,
        runnerFailureRules: [{ fatalSignatures: this.configuredRunnerFailureSignatures }],
      })
    }
    const selected = this.selectRunner(policy.mode)
    const runnerArgv = this.runnerArgv(selected.runner, policy)
    return Promise.resolve<ConfinedArgv>({
      argv: [...runnerArgv, '--', ...argv],
      enforcement: selected.enforcement,
      denialSignatures: DENIAL_SIGNATURES[selected.runner],
      runnerFailureRules: RUNNER_FAILURE_RULES[selected.runner],
    })
  }

  /** 所选环节针对一份策略的运行器调用（程序 + 配置参数）。 */
  private runnerArgv(runner: SelectedRunner['runner'], policy: SandboxPolicy): string[] {
    switch (runner) {
      case 'bwrap': return ['bwrap', ...bwrapProfileArgs(policy)]
      case 'landlock': return [this.landlockLauncher(), ...landlockProfileArgs(policy)]
      case 'seatbelt': return [this.seatbeltExec(), ...seatbeltProfileArgs(policy)]
      case 'windows-acl': return this.windowsAclRunnerArgv(policy)
      default: return assertNever(runner)
    }
  }

  /**
   * 一份策略对应的 windows-acl 运行器 argv。在 workspace-write 下，若存在
   * 调用会话（即策略的 `sessionId`），授予在提供者生命周期内只物化一次——
   * 按工作区划分的常驻工作区根授予，以及按活跃会话/工作区对划分、可撤销且
   * 随机的私有临时目录能力。运行器接收 `--write-sid` 与 `--temp-write-sid`，
   * 自身不做任何授予。无 agent 的 workspace-write 调用传入环境临时根且不带
   * 任何 SID 标志：运行器会为这一次调用创建并删除一个随机的私有子目录。
   * @param policy - 已解析的按调用策略。
   * @returns 运行器调用。
   */
  private windowsAclRunnerArgv(policy: SandboxPolicy): string[] {
    const sessionId = policy.sessionId
    if (sessionId === undefined || policy.mode === 'read-only') {
      return [
        ...this.windowsAclRunnerInvocation(),
        '--workspace', policy.workspaceRoot,
        '--temp', tmpdir(),
        '--mode', policy.mode,
      ]
    }
    const temp = this.materializeAclGrant(sessionId, policy.workspaceRoot)
    return [
      ...this.windowsAclRunnerInvocation(),
      '--workspace', policy.workspaceRoot,
      '--temp', temp.dir,
      '--mode', policy.mode,
      '--write-sid', workspaceWriteSid(policy.workspaceRoot),
      '--temp-write-sid', temp.writeSid,
    ]
  }

  /**
   * 在提供者生命周期内，为一份 workspace-write 策略只物化一次其 ACE。工作区
   * SID 与常驻根授予由该工作区共享。临时目录是随机的，并带有一个不同的
   * SID，因此同一工作区上的另一个会话无法借助共享的工作区 SID 进入它。
   * 一个全新的提供者总会选择新的路径，因此崩溃残留既不会与之碰撞，也不会
   * 为一个恢复的会话提供授权。失败即关闭：只物化一半的临时授予会被撤销，
   * 其目录也会在错误向外传播之前被删除。
   * @param sessionId - 策略中的调用会话身份。
   * @param workspaceRoot - 已解析的策略根。
   * @returns 该会话/工作区对的私有临时目录与写入能力。
   */
  private materializeAclGrant(sessionId: SessionId, workspaceRoot: string): AclTempCapability {
    assertTempRootOutsideWorkspace(workspaceRoot, tmpdir())
    const writeSid = workspaceWriteSid(workspaceRoot)
    if (!this.workspaceGrants.has(workspaceRoot)) {
      const grant = AclWriteGrant.create(writeSid)
      try {
        grant.add(workspaceRoot, true)
      } catch (error) {
        // 释放该 SID；一个常驻 ACE（若应用成功后才在后续步骤抛错）正是
        // 预期的终态，而非错误残留——没有东西需要撤销。
        try {
          grant.dispose()
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'sandbox-local windows-acl workspace grant failed and its cleanup also failed')
        }
        throw error
      }
      this.workspaceGrants.set(workspaceRoot, grant)
    }
    const key = JSON.stringify([String(sessionId), workspaceRoot])
    const existing = this.tempCapabilities.get(key)
    if (existing !== undefined) return existing
    const tempDir = mkdtempSync(join(tmpdir(), 'dsh-'))
    const tempSid = tempWriteSid(tempDir)
    let grant: AclWriteGrant | undefined
    try {
      grant = AclWriteGrant.create(tempSid)
      grant.add(tempDir)
    } catch (error) {
      const cleanupFailures: unknown[] = []
      if (grant !== undefined) {
        try {
          grant.dispose()
        } catch (cleanupError) {
          cleanupFailures.push(cleanupError)
        }
      }
      try {
        this.removeTempDir(tempDir)
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError)
      }
      if (cleanupFailures.length > 0) {
        throw new AggregateError([error, ...cleanupFailures], 'sandbox-local windows-acl temp grant materialization failed and its cleanup also failed')
      }
      throw error
    }
    const capability = { dir: tempDir, writeSid: tempSid, grant }
    this.tempCapabilities.set(key, capability)
    return capability
  }

  /**
   * 释放每一个写入授予（提供者 dispose）：可撤销的临时 ACE 被撤销，本提供者
   * 创建的私有临时目录被删除，每一次 SID 分配都被释放；常驻的工作区 ACE 保留
   * （复用缓存）。清理失败只上报、不抛出：cordis 的拆卸不应被授予清理中断。
   * 崩溃会跳过这一切，但新的提供者绝不会复用残留的那个随机路径或 SID；
   * 操作系统的临时区清理机制（或人工删除）最终会回收它。
   */
  private revokeAclGrants(): void {
    if (this.workspaceGrants.size === 0 && this.tempCapabilities.size === 0) return
    const failures: unknown[] = []
    for (const grant of [...this.workspaceGrants.values(), ...[...this.tempCapabilities.values()].map(capability => capability.grant)]) {
      try {
        grant.dispose()
      } catch (error) {
        failures.push(error)
      }
    }
    for (const { dir } of this.tempCapabilities.values()) {
      try {
        this.removeTempDir(dir)
      } catch (error) {
        failures.push(error)
      }
    }
    this.workspaceGrants.clear()
    this.tempCapabilities.clear()
    if (failures.length > 0) {
      this.ctx.logger.warn(`sandbox-local: windows-acl grant cleanup completed with ${failures.length} failure(s)`)
      for (const error of failures) this.ctx.logger.warn(error)
    }
  }

  /** 删除一个由提供者拥有的私有临时目录（可注入，供清理测试使用）。 */
  private removeTempDir(dir: string): void {
    const remove = this.internals.rmTempDir ?? ((path: string) => { rmSync(path, { recursive: true, force: true }) })
    remove(dir)
  }

  /**
   * 在提供者的生命周期内只解析一次"由哪个运行器施加限制"：取本平台的链
   * （{@link PLATFORM_CHAINS}），若只有一个候选者则直接选中，若有多个候选者
   * 则按链顺序由功能性探测裁决。当平台没有链、或没有候选者通过时失败即
   * 关闭——命令根本不会运行。
   */
  private selectRunner(mode: ConfinedSandboxMode): SelectedRunner {
    this.selectedRunner ??= this.chainVerdict()
    if (this.selectedRunner === 'unavailable') throw new SandboxUnavailableError(mode)
    return this.selectedRunner
  }

  /** 走一遍本平台的链：唯一候选者不探测，多个按顺序探测，无一可用 → unavailable。 */
  private chainVerdict(): SelectedRunner | 'unavailable' {
    const chain = this.internals.chain ?? PLATFORM_CHAINS[this.internals.platform ?? process.platform] ?? []
    const [first, ...rest] = chain
    if (first === undefined) return 'unavailable'
    // 唯一候选者无需裁决；它在执行期的拒绝仍然失败即关闭。
    if (rest.length === 0) return { runner: first, enforcement: STATIC_ENFORCEMENT[first] }
    for (const runner of chain) {
      const enforcement = this.probeRunner(runner)
      if (enforcement !== 'unusable') return { runner, enforcement }
    }
    return 'unavailable'
  }

  /** 某一环节的功能性探测（经由走链，每个最多执行一次）。 */
  private probeRunner(runner: SelectedRunner['runner']): SandboxEnforcement | 'unusable' {
    // bwrap 的挂载配置与 Seatbelt 的 deny-file-write* 配置在构造上就管辖
    // 了所有已承诺的文件效应，因此它们探测通过时一律是完整强制；Landlock
    // 启动器的探测报告区分完整与按 ABI 而言的部分，而 windows-acl 因其
    // 已记录的硬链接、读取不受限与 AppContainer ACL 边界始终为部分强制。
    switch (runner) {
      case 'bwrap': {
        const probe = this.internals.probeBwrap ?? (() => defaultProbeBwrap(this.probeTimeoutMs))
        return probe() ? 'full' : 'unusable'
      }
      case 'landlock': {
        const probe = this.internals.probeLandlock ?? (launcher => defaultProbeLandlock(launcher, { timeoutMs: this.probeTimeoutMs }))
        return probe(this.landlockLauncher())
      }
      case 'seatbelt': {
        const probe = this.internals.probeSeatbelt ?? (exec => defaultProbeSeatbelt(exec, this.probeTimeoutMs))
        return probe(this.seatbeltExec()) ? 'full' : 'unusable'
      }
      case 'windows-acl': {
        const probe = this.internals.probeWindowsAcl
          ?? (() => defaultProbeWindowsAcl(this.windowsAclRunnerInvocation(), this.probeTimeoutMs))
        return probe() ? 'partial' : 'unusable'
      }
      default: return assertNever(runner)
    }
  }

  /** 用于探测与执行的 Landlock 启动器（在已解析结果之上的测试钩子）。 */
  private landlockLauncher(): string {
    return this.internals.landlockLauncher ?? landlockLauncherPath()
  }

  /** 用于探测与执行的 `sandbox-exec` 可执行文件（在系统版本之上的测试钩子）。 */
  private seatbeltExec(): string {
    return this.internals.seatbeltExec ?? 'sandbox-exec'
  }

  /**
   * windows-acl 运行器的 argv 前缀：存在构建产物时使用 lib/runner.js 入口
   * （生产），否则通过 tsx 使用包内源码（开发）。把源码加载器与 TypeScript
   * 路径固定到本安装上，不受目标 cwd 或环境变量覆盖的影响。
   * 该前缀保持为 `[node, runner, ...]`——未来的原生 exe 运行器沿用同一
   * argv 契约，只替换这些条目。
   */
  private windowsAclRunnerInvocation(): string[] {
    const override = this.internals.windowsAclRunnerArgs
    if (override !== undefined) return override
    const builtEntry = this.internals.windowsAclRunnerEntry ?? fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-sandbox-windows-acl/runner'))
    if (existsSync(builtEntry)) return [process.execPath, builtEntry]
    const sourceEntry = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-sandbox-windows-acl/src/runner.ts'))
    const sourceConfig = fileURLToPath(new URL('../../../../tsconfig.base.json', import.meta.url))
    const registration = `import { register } from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))}; register({ tsconfig: ${JSON.stringify(sourceConfig)} });`
    return [process.execPath, '--import', `data:text/javascript,${encodeURIComponent(registration)}`, sourceEntry]
  }
}

export default LocalSandboxProvider
