/** dsh plugin 命令与运行中的管理器共享的 profile 包操作。 */
import { once } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, open, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { execa } from 'execa'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import {
  DEFAULT_PROFILE_BUNDLES, bundlePatchPaths, initProfile, PROFILE_TEMPLATES, readProfileManifest,
  resolveBundleDir, resolveProfileDir, loadOverlayPatches, composeEntries, readProfileVersionExemptions,
  evaluatePluginCompatibility, pluginCompatibilityWarning, type ProfileManifest,
} from '@deepseek-ai/dsh-app-boot'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { parseInstallSpec } from './install-spec.ts'
import { awaitTreeGone, leadsOwnGroup, treeAlive, type RunTree } from './run-tree.ts'
import { incompatiblePlugin } from './failure.ts'
import type { IncompatiblePlugin, PackageResult, Registry } from './types.ts'
export { setProfileVersionExemption, readProfileVersionExemptions } from '@deepseek-ai/dsh-app-boot'

/** 由启动器提供的 profile 与调用位置。 */
export interface PackageOperationContext {
  profile: string
  /** 一个应用所拥有的 profile 的显式目录；具名的 CLI profile 在 home 之下解析。 */
  dir?: string
  installAnchor: string
  cwd: string
  home?: string
}

/** 一次 pnpm 操作的输出与取消策略。 */
export interface PackageOperationOptions {
  /** pnpm 可执行文件的名称或路径；像 `dsh plugin` 命令一样通过 `PATH` 解析。默认为 `pnpm`。 */
  command?: string
  /** 一个应用所拥有可执行文件的前缀参数。 */
  args?: readonly string[]
  /** 应用运行时环境，仅应用于本次包操作。 */
  env?: Readonly<Record<string, string>>
  /** CLI 继承鉴权与终端描述符；service 清除密钥并捕获输出。 */
  execution: 'cli' | 'service'
  signal?: AbortSignal
  outputBytes: number
  onOutput?: (text: string, stream: 'stdout' | 'stderr') => void
  activateNewBundles?: boolean
  lockWaitMs?: number
  /**
   * 一旦被捕获的输出在此毫秒数内保持静默，就终止该运行。以这种方式停止的运行会报告
   * `timedOut`；没有上限时，一个停止推进却未退出的子进程会永远占据其调用方。继承了
   * 描述符的运行不捕获任何输出，也永远不会被设限。
   */
  idleTimeoutMs?: number
  /** 安装前注册表查找的上限（毫秒）；没有时采用一个固定的上限。 */
  lookupTimeoutMs?: number
}

/** 相对于调用方的目录解析包 spec。
 * @param argument 一个 pnpm 参数。
 * @param cwd 调用目录，绝不会是 profile 目录。
 * @returns 锚定后的参数。
 */
export function anchorPathSpec(argument: string, cwd: string): string {
  const match = /^(?<prefix>(?:file|link):)?(?<path>\.{1,2}(?:[/\\].*)?)$/.exec(argument)
  if (match?.groups?.path === undefined) return argument
  return `${match.groups.prefix ?? ''}${resolve(cwd, match.groups.path)}`
}

/** 在不加载其 JavaScript 的前提下读取 bundle 元数据。
 * @param name 已安装的依赖或安装所拥有的包名。
 * @param dir Profile 目录。
 * @param anchor 安装清单。
 * @returns 解析后的元数据；对于没有 bundle 元数据的包为 undefined。
 */
export function bundleManifest(name: string, dir: string, anchor: string): ProfileManifest | undefined {
  const packageDir = resolveBundleDir('dsh', name, anchor, dir)
  const manifest = readProfileManifest('dsh', packageDir)
  return manifest.dsh?.bundle?.patch === undefined ? undefined : manifest
}

/** 在保留无关字段的前提下，原子地保存 profile 清单。
 * @param dir Profile 目录。
 * @param manifest 更新后的文档。
 */
export async function saveManifest(dir: string, manifest: ProfileManifest): Promise<void> {
  await writeFileAtomic(join(dir, 'package.json'), JSON.stringify(manifest, undefined, 2) + '\n', { mode: 0o600 })
}

/** 在不重新启用被保留依赖的前提下，协调包的移除与新安装的 bundle。 */
async function reconcile(before: ProfileManifest, dir: string, anchor: string, options: PackageOperationOptions): Promise<void> {
  const after = readProfileManifest('dsh', dir)
  const dependencies = Object.keys(after.dependencies ?? {})
  const beforeDeps = new Set(Object.keys(before.dependencies ?? {}))
  const previous = after.dsh?.profile?.bundles ?? []
  const bundles = previous.filter((name) => {
    if (!beforeDeps.has(name) && !dependencies.includes(name)) return true
    return dependencies.includes(name) && bundleManifest(name, dir, anchor) !== undefined
  })
  for (const name of dependencies) {
    if (beforeDeps.has(name)) continue
    const metadata = bundleManifest(name, dir, anchor)
    if (metadata?.dsh?.bundle === undefined) {
      options.onOutput?.(`dsh: warning: ${name} declares no dsh.bundle — installed as a plain dependency, not a profile layer\n`, 'stderr')
      continue
    }
    for (const file of bundlePatchPaths(resolveBundleDir('dsh', name, anchor, dir), metadata.dsh.bundle)) loadOverlayPatches('dsh', file)
    if (!bundles.includes(name)) {
      bundles.push(name)
    }
  }
  if (JSON.stringify(previous) === JSON.stringify(bundles)) return
  after.dsh = { ...after.dsh, profile: { ...after.dsh?.profile, bundles } }
  await saveManifest(dir, after)
}

/**
 * 管道在其进程退出之后继续排空的时长，作为完成一次运行的一个固定环节，而非一个部署
 * 旋钮：一个继承了它们的后代进程会让它们保持打开，而失败分类所读取的尾部到那时已经写完。
 */
const DRAIN_AFTER_EXIT_MS = 2_000

/** 每一个收集器是否在 `ms` 之内完成。
 * @param collectors 与上限竞速的管道读取器。
 * @param ms 最长等待时间，以毫秒计。
 * @returns 当所有收集器都及时结算时为 true。
 */
async function drainWithin(collectors: readonly Promise<void>[], ms: number): Promise<boolean> {
  if (collectors.length === 0) return true
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      Promise.allSettled(collectors).then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => { resolve(false) }, ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** 将待安装包作为位置参数的安装命令。 */
const INSTALL_COMMANDS = new Set(['add', 'install', 'i'])

/** 调用方未指定时的、安装前注册表查找的上限。 */
const LOOKUP_TIMEOUT_MS = 20_000

/** 一个安装命令显式点名的包 spec，按顺序排列。 */
function namedSpecs(args: readonly string[]): string[] {
  const index = args.findIndex(argument => !argument.startsWith('-'))
  const command = index < 0 ? undefined : args[index]
  if (command === undefined || !INSTALL_COMMANDS.has(command)) return []
  return args.slice(index + 1).filter(argument => !argument.startsWith('-'))
}

/** 一个具名 spec 将要安装的清单，在不安装它的情况下读取。
 * 路径 spec 从磁盘读取。注册表 spec 向 pnpm 自身的配置询问该范围所选中的版本及其
 * dsh 要求（`engines` 与 peerDependencies）。git 或 tarball spec 需要拉取本身，因此
 * 安装之后的检查才是判定它的依据。
 * @param dir 查找所运行的 profile 目录。
 * @param spec 锚定后的安装 spec。
 * @param options pnpm 可执行文件、前缀参数、调用方的上限与信号。
 * @param environment 调用方 pnpm 调用的环境。
 * @param flags 运行自身的标志，使查找去询问该运行将使用的注册表。
 * @returns 包清单；当读取它本就需要安装本身时，为 undefined。
 */
async function namedSpecManifest(
  dir: string, spec: string, options: PackageOperationOptions, environment: Readonly<Record<string, string | undefined>>,
  flags: readonly string[],
): Promise<object | undefined> {
  const parsed = parseInstallSpec(spec)
  if (parsed.kind === 'path') {
    const filename = join(parsed.path, 'package.json')
    return existsSync(filename) ? JSON.parse(readFileSync(filename, 'utf8')) as object : undefined
  }
  if (parsed.kind !== 'registry') return undefined
  const viewed = await execa(options.command ?? 'pnpm', [
    ...options.args ?? [], 'view', parsed.spec, 'name', 'version', 'engines', 'peerDependencies', '--json',
    ...flags, '--config.fetch-retries=0',
  ], {
    cwd: dir, env: environment, extendEnv: false, reject: false, stdin: 'ignore',
    ...options.signal === undefined ? {} : { cancelSignal: options.signal },
    timeout: options.lookupTimeoutMs ?? LOOKUP_TIMEOUT_MS,
  })
  if (viewed.exitCode !== 0) return undefined
  const value: unknown = JSON.parse(viewed.stdout)
  return (Array.isArray(value) ? value.at(-1) : value) as object
}

/** 缺失的已安装包是可修复的；它们的缺失属于安装前后对比的一部分。 */
function optionalFile(path: string): string | undefined {
  try { return readFileSync(path, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** 一次操作记录其所启动 pnpm 运行的位置，供在该操作自身进程先结束时接手它的后续操作使用。 */
function runRecordPath(dir: string): string {
  return join(dir, '.plugin-manager', 'run.json')
}

/** 记录一次已启动的运行；从已退出进程接手 profile 锁的后续操作会等待它。 */
async function recordRun(dir: string, tree: RunTree): Promise<void> {
  if (tree.pid === undefined) return
  await writeFileAtomic(runRecordPath(dir), `${JSON.stringify(tree)}\n`, { mode: 0o600, dirMode: 0o700 })
}

/**
 * 本操作为何不得运行：一条由某个在运行中途退出的操作留下的记录，点名了一个仍在写入
 * profile 的运行。profile 锁在其持有者退出之后被接手，但它的 pnpm 进程树可能比它活得更久。
 * 一条在受控等待内已停止的、被记录的运行，其记录会被移除。
 * @param dir Profile 目录。
 * @returns 诊断信息；当没有活动记录时，为 undefined。
 */
async function activeRecordedRun(dir: string): Promise<string | undefined> {
  const path = runRecordPath(dir)
  const text = optionalFile(path)
  if (text === undefined) return undefined
  let tree: RunTree | undefined
  try {
    const value: unknown = JSON.parse(text)
    const { pid, grouped } = (typeof value === 'object' && value !== null ? value : {}) as { pid?: unknown; grouped?: unknown }
    if (Number.isSafeInteger(pid) && (pid as number) > 0 && typeof grouped === 'boolean') tree = { pid: pid as number, grouped }
  } catch (error) {
    // 记录是被原子替换的，因此一条无法解析的记录是由其它东西写入的，并在下文被报告。
    void error
  }
  if (tree === undefined) {
    return `dsh: ${path} does not name a package run; delete it once no earlier package operation is still running in this profile\n`
  }
  await awaitTreeGone(tree)
  if (treeAlive(tree)) {
    return `dsh: process ${String(tree.pid)}, started by an earlier package operation whose own process ended, is still running in this profile; `
      + `wait for it or stop it, then retry. If process ${String(tree.pid)} is not that package run, delete ${path}.\n`
  }
  await rm(path, { force: true })
  return undefined
}

/** pnpm 可以通过任意直接依赖字段安装插件。 */
function directDependencies(manifest: ProfileManifest): Record<string, string> {
  const extra = manifest as ProfileManifest & { devDependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }
  return { ...extra.devDependencies, ...manifest.dependencies, ...extra.optionalDependencies }
}

/** 仅检视由被变更 bundle 贡献的插件行，而非其依赖闭包。 */
function bundleComponentManifests(manifest: ProfileManifest, dir: string, anchor: string): ProfileManifest[] {
  const bundle = manifest.dsh?.bundle
  if (bundle === undefined) return []
  const patches = bundlePatchPaths(dir, bundle).flatMap(file => loadOverlayPatches('dsh', file))
  const names = new Set<string>()
  const visit = (rows: EntryOptions[]) => {
    for (const row of rows) {
      if (row.group && Array.isArray(row.config)) visit(row.config as EntryOptions[])
      if (typeof row.name !== 'string' || row.name.startsWith('.') || row.name.startsWith('/') || row.name.includes(':')) continue
      const parts = row.name.split('/')
      names.add(parts.slice(0, row.name.startsWith('@') ? 2 : 1).join('/'))
    }
  }
  visit(composeEntries([patches.filter(patch => patch.insert !== undefined)]))
  return [...names].flatMap((name) => {
    let packageDir: string
    try { packageDir = resolveBundleDir('dsh', name, anchor, dir) } catch (error) {
      // Resolution errors for uninstalled or dynamic rows remain subject to the startup loader's checks.
      void error
      return []
    }
    return [readProfileManifest('dsh', packageDir)]
  })
}

/** 在一个其调用方已持有 profile 写入锁的 profile 内执行 pnpm。
 * 新安装或更新的直接依赖即使禁用激活也会被检查；一个未被触及的依赖永远不会阻碍无关
 * 的操作，并在启动时仍被拒绝。兼容性拒绝会恢复 profile 清单与 lockfile，但会把已下载的
 * 模块留在磁盘上。
 * @param context 启动器拥有的 profile 与解析位置。
 * @param args pnpm 参数，处于相对路径锚定之前。
 * @param options 输出、激活与取消策略。
 * @returns 退出状态、静默上限是否终止了运行，以及诊断文件路径。
 * 兼容性拒绝返回退出码 1。service 输出受上限约束；CLI 输出使用继承来的描述符。
 * 诊断文件在返回或拒绝时关闭，包括准备与 spawn 失败的情况。
 */
export async function runProfilePnpm(
  context: PackageOperationContext, args: readonly string[], options: PackageOperationOptions,
): Promise<PackageResult> {
  const dir = context.dir ?? resolveProfileDir(context.profile, context.home)
  // 在读取任何 profile 文件之前：一条仍处于活动状态的已记录运行可能正在重写它们。
  const active = await activeRecordedRun(dir)
  const logRoot = join(dir, '.plugin-manager', 'logs')
  await mkdir(logRoot, { recursive: true, mode: 0o700 })
  const logDir = await mkdtemp(join(logRoot, 'operation-'))
  const logPath = join(logDir, 'pnpm.log')
  await using log = await open(logPath, 'wx', 0o600)
  if (active !== undefined) {
    await log.write(active)
    await log.close()
    options.onOutput?.(active, 'stderr')
    const bytes = Buffer.from(active)
    return { exitCode: 1, output: bytes.subarray(Math.max(0, bytes.length - options.outputBytes)).toString('utf8'), truncated: bytes.length > options.outputBytes, logPath }
  }
  const before = readProfileManifest('dsh', dir)
  const savedFiles = ['package.json', 'pnpm-lock.yaml'].map(name => ({ path: join(dir, name), text: optionalFile(join(dir, name)) }))
  const beforeDependencies = directDependencies(before)
  const installedBefore = new Map(Object.keys(beforeDependencies).map(name => [name, optionalFile(join(dir, 'node_modules', name, 'package.json'))]))
  let output = Buffer.alloc(0)
  let truncated = false
  const append = (bytes: Buffer): void => {
    output = Buffer.concat([output, bytes])
    if (output.length > options.outputBytes) {
      truncated = true
      output = output.subarray(output.length - options.outputBytes)
    }
  }
  const environment = { ...(options.execution === 'cli' ? process.env : scrubbedParentEnv()), ...options.env }
  const restore = async (): Promise<void> => {
    for (const file of savedFiles) {
      if (file.text === undefined) await rm(file.path, { force: true })
      else await writeFileAtomic(file.path, file.text, { mode: 0o600 })
    }
  }
  /** 兼容性检查所拒绝的包；调用方在自己的界面上渲染它们。 */
  const incompatible: IncompatiblePlugin[] = []
  const rejected = async (warnings: readonly string[], restoration: string): Promise<PackageResult> => {
    const diagnostic = `\ndsh: installation rejected: ${warnings.join('\n')}\ndsh: ${restoration}.\n`
    await log.write(diagnostic)
    options.onOutput?.(diagnostic, 'stderr')
    append(Buffer.from(diagnostic))
    await log.close()
    return { exitCode: 1, output: output.toString('utf8'), truncated, logPath, incompatible }
  }
  // 安装命令点名它所添加的包，因此在 pnpm 运行之前读取并检查它们的清单：不兼容的版本
  // 永远不会被安装，而正在使用的那个仍可继续工作。
  const preflight: string[] = []
  const exemptions = readProfileVersionExemptions(dir)
  // 运行自身的注册表标志，使查找去询问该安装将要使用的注册表。
  const registryFlags = args.filter(argument => argument.startsWith('--registry='))
  for (const raw of namedSpecs(args)) {
    // 清单无法被读取或校验的 spec 留给运行自身，以及安装之后的检查——后者会报告
    // 它无法校验的内容。
    try {
      const manifest = await namedSpecManifest(dir, anchorPathSpec(raw, context.cwd), options, environment, registryFlags)
      if (manifest === undefined) continue
      const issue = evaluatePluginCompatibility(manifest, exemptions)
      if (issue !== undefined && !issue.exempted) {
        preflight.push(pluginCompatibilityWarning(issue))
        incompatible.push(incompatiblePlugin(issue))
      }
    } catch (error) { void error; continue }
  }
  if (preflight.length > 0) return await rejected(preflight, 'nothing was installed')
  const cancellation = new AbortController()
  // 服务运行会捕获输出，因此当运行被 kill 时 execa 会终止它所带领的整棵进程树：一个
  // 生命周期脚本会比启动它的 pnpm 进程活得更久。CLI 保留调用方的进程组，因此中断仍能抵达它。
  const grouped = leadsOwnGroup(options.execution)
  const child = execa(options.command ?? 'pnpm', [...options.args ?? [], ...args.map(arg => anchorPathSpec(arg, context.cwd))], {
    cwd: dir, env: environment, extendEnv: false, reject: false,
    stdout: options.execution === 'cli' ? 'inherit' : 'pipe',
    stderr: options.execution === 'cli' ? 'inherit' : 'pipe',
    killDescendants: options.execution === 'service',
    buffer: false, stdin: options.execution === 'cli' ? 'inherit' : 'ignore', cancelSignal: options.signal === undefined
      ? cancellation.signal : AbortSignal.any([cancellation.signal, options.signal]),
  })
  // 在写入记录之前就开始监听，以免漏掉写入期间发生的退出。
  const exited = once(child.nodeChildProcess, 'exit').catch(() => undefined)
  let writes = Promise.resolve()
  /** `settled` 记录进程结果已知；`stalled` 记录静默上限终止了运行。 */
  const control = { settled: false, stalled: false }
  /** 一旦本次调用自行提前结束读取，便置位，使其引发的关闭不会被读作运行失败。 */
  let cut = false
  /** 在那次提前结束之前、某次读取所遇到的第一个失败，运行仍会报告它。 */
  let failure: Error | undefined
  let idleTimer: NodeJS.Timeout | undefined
  /** 静默上限：一个停止打印却未退出的被捕获运行会被终止，而绝不会被等待。 */
  const armIdle = (): void => {
    if (control.settled || options.idleTimeoutMs === undefined) return
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      control.stalled = true
      // execa 的 kill 会抵达服务运行的整棵进程树，并自行升级。
      child.kill()
    }, options.idleTimeoutMs)
  }
  const collect = async (stream: AsyncIterable<Buffer | string>, kind: 'stdout' | 'stderr') => {
    try {
      for await (const chunk of stream) {
        armIdle()
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        writes = writes.then(async () => { await log.write(bytes) })
        await writes
        options.onOutput?.(bytes.toString('utf8'), kind)
        append(bytes)
      }
    } catch (error) {
      // 本次调用提前结束的读取并非运行所遇到的失败，且运行已经退出，因此取消已无
      // 可停止的内容。
      if (!cut) {
        failure ??= error instanceof Error ? error : new Error(String(error))
        cancellation.abort()
      }
      throw error
    }
  }
  const collectors = [
    ...child.stdout === null ? [] : [collect(child.stdout, 'stdout')],
    ...child.stderr === null ? [] : [collect(child.stderr, 'stderr')],
  ]
  // 排空阶段决定一个失败是否会浮现，因此每路读取现在就要被认领：否则在管道排空
  // 期间，一个未被认领的拒绝会被当作未处理而报告。
  for (const collector of collectors) void collector.catch(() => { /* reported through `failure` and the settled readings */ })
  // 继承来的描述符把终端交给了 pnpm，因此没有可供静默上限观测的捕获输出：它会在
  // 一次健康的运行上误触发。
  if (collectors.length > 0) armIdle()
  let exitCode: number
  try {
    await recordRun(dir, { pid: child.pid, grouped })
    // execa 只有在管道化的 stdio 结束之后才会兑现其 promise，因此进程自身的退出——
    // 即运行的完成——要从原始子进程读取。一次 spawn 失败在没有退出码的情况下结算。
    const settled = Promise.allSettled([child])
    await Promise.race([exited, settled])
    control.settled = true
    clearTimeout(idleTimer)
    // 一个停滞的运行会先停止它的整棵进程树，因此调用方的回滚与锁释放只在该运行所
    // 启动的脚本停止写入之后才发生。
    if (control.stalled) await awaitTreeGone({ pid: child.pid, grouped })
    // 一个继承了管道的后代进程可能让管道在进程结束之后仍保持打开；尾部在受控的
    // 上限下排空，而非被无限期等待。
    const drained = await drainWithin(collectors, DRAIN_AFTER_EXIT_MS)
    if (drained) {
      for (const stream of await Promise.allSettled(collectors)) if (stream.status === 'rejected') throw stream.reason
    } else {
      // 将尾部截断是本次调用自身的结束，而非运行所遇到的失败；截断之前的失败仍会浮现，
      // 且截断会在日志中留下一条说明，因为分类可能读到一个不完整的尾部。
      cut = true
      child.stdout?.destroy()
      child.stderr?.destroy()
      const notice = 'dsh: pnpm output was cut short after its process exited\n'
      await log.write(notice)
      // 截断之前的失败是运行自身的，它会取代调用方原本会读到的那条说明；而截断自身
      // 所引发的拒绝则是它的结束。
      if (failure !== undefined) throw failure
      options.onOutput?.(notice, 'stderr')
      append(Buffer.from(notice))
    }
    const [completion] = await settled
    if (completion.status === 'rejected') throw completion.reason
    const result = completion.value
    exitCode = result.exitCode ?? (result.code === 'ENOENT' ? 127 : 1)
    if (control.stalled) {
      const notice = `dsh: pnpm printed nothing for ${String(options.idleTimeoutMs)}ms and was terminated\n`
      await log.write(notice)
      options.onOutput?.(notice, 'stderr')
      append(Buffer.from(notice))
    }
    if (result.failed && output.length === 0) {
      const diagnostic = result.shortMessage ?? 'pnpm failed'
      await log.write(diagnostic)
      truncated = Buffer.byteLength(diagnostic) > options.outputBytes
      output = Buffer.from(diagnostic).subarray(0, options.outputBytes)
    }
    // 一个被终止运行的退出状态不说明它写入了什么，因此它永远不会协调选择。
    if (exitCode === 0 && !control.stalled) {
      const after = readProfileManifest('dsh', dir)
      const warnings: string[] = []
      for (const [name, spec] of Object.entries(directDependencies(after))) {
        const packageDir = join(dir, 'node_modules', name)
        const installed = optionalFile(join(packageDir, 'package.json'))
        if (installed === undefined) continue
        // 本次运行未触及的依赖绝不会阻碍一个无关的操作；profile 启动会拒绝它。
        const untouched = beforeDependencies[name] === spec && installedBefore.get(name) === installed
        const found: string[] = []
        const issues: IncompatiblePlugin[] = []
        try {
          const manifest = readProfileManifest('dsh', packageDir)
          for (const candidate of [manifest, ...bundleComponentManifests(manifest, packageDir, context.installAnchor)]) {
            const issue = evaluatePluginCompatibility(candidate, readProfileVersionExemptions(dir))
            if (issue !== undefined && !issue.exempted) {
              found.push(pluginCompatibilityWarning(issue))
              issues.push(incompatiblePlugin(issue))
            }
          }
        } catch (error) {
          found.push(`Cannot validate installed package ${name}: ${String(error)}`)
        }
        if (found.length === 0) continue
        if (!untouched) {
          warnings.push(...found)
          incompatible.push(...issues)
        }
        else {
          const notice = `\ndsh: warning: ${found.join('\n')}\ndsh: it stays installed but profile startup denies it until you grant an exemption for those exact versions.\n`
          await log.write(notice)
          options.onOutput?.(notice, 'stderr')
        }
      }
      if (warnings.length > 0) {
        // bundle 组件的要求需要已安装的内容，因此这一拒绝发生在 pnpm 替换了整棵树之后：
        // 恢复文件，然后用恢复后的 lockfile 重新安装，使本次运行之前能工作的版本继续加载。
        // 一个原本没有 lockfile 的 profile 会从恢复后的清单重新安装而不创建 lockfile，
        // 从而移除本次运行所添加的内容。
        await restore()
        const hadLockfile = savedFiles.some(file => file.path.endsWith('pnpm-lock.yaml') && file.text !== undefined)
        const repair = ['install', hadLockfile ? '--frozen-lockfile' : '--config.lockfile=false']
        const repairing = execa(options.command ?? 'pnpm', [...options.args ?? [], ...repair], {
          cwd: dir, env: environment, extendEnv: false, reject: false, stdin: 'ignore',
          ...options.idleTimeoutMs === undefined ? {} : { timeout: options.idleTimeoutMs },
        })
        await recordRun(dir, { pid: repairing.pid, grouped: false })
        const repaired = await repairing
        exitCode = 1
        const restoration = repaired.exitCode === 0
          ? 'restored package.json, pnpm-lock.yaml, and node_modules'
          : "restored package.json and pnpm-lock.yaml, but node_modules could not be reinstalled; run 'dsh plugin install'"
        const diagnostic = `\ndsh: installation rejected: ${warnings.join('\n')}\ndsh: ${restoration}.\n`
        await log.write(diagnostic)
        options.onOutput?.(diagnostic, 'stderr')
        append(Buffer.from(diagnostic))
      } else if (options.activateNewBundles !== false) {
        await reconcile(before, dir, context.installAnchor, options)
      }
    }
  } finally {
    control.settled = true
    clearTimeout(idleTimer)
    // 本进程已经看到运行结束，因此没有后续操作需要等待它。
    await rm(runRecordPath(dir), { force: true })
    await log.close()
  }
  return {
    exitCode, output: output.toString('utf8'), truncated, logPath,
    ...control.stalled ? { timedOut: true } : {}, ...incompatible.length > 0 ? { incompatible } : {},
  }
}

/** Initialize and run the dsh plugin command with the same write lock as the service.
 * @param context Launcher-owned locations.
 * @param args Pnpm arguments.
 * @param options Output and cancellation policy.
 * @returns Completed package-manager result.
 */
export async function runPluginCommand(
  context: PackageOperationContext, args: readonly string[], options: PackageOperationOptions,
): Promise<PackageResult> {
  const dir = context.dir ?? resolveProfileDir(context.profile, context.home)
  await mkdir(dir, { recursive: true })
  return withFileLock(join(dir, 'package.json'), async () => {
    if (!existsSync(join(dir, 'package.json'))) {
      const template = PROFILE_TEMPLATES[context.profile]
      initProfile(dir, template?.bundles ?? DEFAULT_PROFILE_BUNDLES)
      options.onOutput?.(`dsh: initialized profile ${context.profile} at ${dir}\n`, 'stderr')
    }
    return runProfilePnpm(context, args, options)
  }, options.lockWaitMs === undefined ? undefined : { waitMs: options.lockWaitMs })
}

/** What one registry lookup answered. */
export interface PackageViewResult {
  /** pnpm's exit code, null when it ended without one or never started. */
  exitCode: number | null
  stdout: string
  stderr: string
  /** The lookup ran past its bound and was killed. */
  timedOut: boolean
  /** The failure of starting pnpm at all, when that is what happened. */
  cause?: unknown
}

/** Bounds of one registry lookup. */
export interface PackageViewOptions {
  /** The pnpm executable name or path. Defaults to `pnpm`. */
  command?: string
  /** Prefix arguments for an application-owned executable. */
  args?: readonly string[]
  /** Application runtime environment, applied only to this package operation. */
  env?: Readonly<Record<string, string>>
  /** Ends the lookup early; the caller's signal, when it has one. */
  signal?: AbortSignal
  /** Bound on the lookup, in milliseconds. */
  timeoutMs: number
  /** The registry asked; null asks the one pnpm's own configuration names. */
  registry?: Registry
}

/**
 * Read the registry pnpm's own configuration names in the profile: its `.npmrc` chain and workspace settings,
 * as `pnpm config get registry` resolves them.
 * @param dir Profile directory.
 * @param options The pnpm executable and the time bound.
 * @returns The registry URL as pnpm printed it, or null when pnpm did not answer with one.
 */
export async function readProfileRegistry(
  dir: string, options: { command?: string; args?: readonly string[]; env?: Readonly<Record<string, string>>; timeoutMs: number },
): Promise<string | null> {
  const result = await execa(options.command ?? 'pnpm', [...options.args ?? [], 'config', 'get', 'registry'], {
    cwd: dir, env: { ...scrubbedParentEnv(), ...options.env }, extendEnv: false, reject: false, stdin: 'ignore', timeout: options.timeoutMs,
  })
  // The registry is the last line: pnpm may print a notice before it.
  const answer = result.exitCode === 0 ? result.stdout.trim().replace(/^[\s\S]*\n/, '').trim() : ''
  return /^https?:\/\/\S+$/.test(answer) ? answer : null
}

/**
 * The argument that sends one pnpm command to a registry.
 * @param registry - the registry, or null for the one pnpm's own configuration names.
 * @returns `--registry=<url>` for a URL; nothing for null.
 */
export function registryArguments(registry: Registry): string[] {
  return registry === null ? [] : [`--registry=${registry}`]
}

/**
 * Ask the registry what a spec names through `pnpm view`, run in the profile
 * directory so the registry, proxy, and authentication settings of an install
 * apply. The lookup makes one request without pnpm's own retries: a registry
 * that does not answer is reported within `timeoutMs`, and the registries
 * configured after it are the retry.
 * @param dir Profile directory.
 * @param spec One registry spec: a package name with an optional range.
 * @param options The registry, cancellation, and the time bound.
 * @returns pnpm's exit, output, and how the lookup ended.
 */
export async function viewProfilePackage(dir: string, spec: string, options: PackageViewOptions): Promise<PackageViewResult> {
  const result = await execa(options.command ?? 'pnpm', [
    ...options.args ?? [], 'view', spec, 'name', 'version', 'description', 'dsh', '--json',
    ...registryArguments(options.registry ?? null), '--config.fetch-retries=0',
  ], {
    cwd: dir, env: { ...scrubbedParentEnv(), ...options.env }, extendEnv: false, reject: false, stdin: 'ignore',
    timeout: options.timeoutMs, ...options.signal === undefined ? {} : { cancelSignal: options.signal },
  })
  const cause = result.exitCode === undefined && !result.timedOut && !result.isCanceled
    ? Object.assign(new Error(result.shortMessage), { code: result.code })
    : undefined
  return {
    exitCode: result.exitCode ?? null, stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut,
    ...cause === undefined ? {} : { cause },
  }
}
