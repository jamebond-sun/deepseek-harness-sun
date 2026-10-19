/** 与客户端共享的公开插件管理记录。 */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { PluginLocalizedMeta } from '@deepseek-ai/dsh-package-manifest'
import type { PluginInventoryEntry } from '@deepseek-ai/dsh-host-plugin-inventory/types'
export type { PluginEntryId } from '@deepseek-ai/dsh-host-plugin-inventory/types'
import type { PluginEntryId } from '@deepseek-ai/dsh-host-plugin-inventory/types'

/** 一个 profile 控制无法修改其目标的原因。 */
export type ReadOnlyReason = 'management-required' | 'unaddressable'

/** 一个包，其声明的 DSH 要求拒绝运行中的 DSH 版本，且不存在针对该确切组合的豁免。 */
export interface IncompatiblePlugin {
  name: string
  version: string
  runtimeVersion: string
  /** 仅包含运行中的版本无法满足的要求，以 `engines.dsh` 或 DSH peer 包名为键。 */
  requirements: Record<string, string>
}

/** 可本地化的管理失败，以及可选的外部诊断。 */
export interface ManagementError {
  code: ReadOnlyReason | 'unknown-plugin' | 'invalid-spec' | 'already-installed' | 'ambiguous-install' | 'not-bundle' | 'not-removable' | 'stop-profile' | 'bundle-in-use' | 'stale-approval' | 'incompatible-version' | 'operation-error'
  diagnostic?: string
  /** 与 `incompatible-version` 一同出现：运行中的 DSH 版本所拒绝的包。 */
  incompatible?: IncompatiblePlugin[]
}

/**
 * 一个变更要等待下一次启动的原因：`no-hmr` 的 profile 只在启动时应用变更；`package-moved`
 * 的变更把某个已安装的包映射到另一个目录（而未先移除它），或变更/本地覆盖 DSH 安装所提供的
 * 某个包；`host-module` 的变更触及运行中的进程自身所导入的模块；`unmanaged-plugin` 的变更
 * 触及运行在 Loader 入口之外的某个插件；`module-comparison` 表示已加载的模块无法与磁盘比较。
 */
export type RestartReason = 'no-hmr' | 'package-moved' | 'host-module' | 'unmanaged-plugin' | 'module-comparison'

/** 一个运行中的 profile 条目，以及其持久化控制的可用性。 */
export type PluginInfo = PluginInventoryEntry & (
  | { patchId: string; readOnlyReason?: never }
  | { patchId?: never; readOnlyReason: ReadOnlyReason }
)

/** 一个 bundle 的补丁所声明的一行，以及在该 bundle 贡献它时其对应的活动条目。 */
export interface BundleRowInfo {
  /** 补丁所声明的行 id。 */
  rowId: string
  /** 该行所命名的模块。 */
  moduleName: string
  /** 本地包的展示元数据，包括其 bundle 已被禁用的行。 */
  meta?: PluginLocalizedMeta
  /** 承载本行的 Loader 条目，当恰好有一个活动条目拥有该 id 时。 */
  entryId?: PluginEntryId
}

/** 一个已发布、由 profile 安装，或可发现的按需 bundle。 */
export interface BundleInfo {
  name: string
  /** 项目维护的已发布可选 bundle 或按需目录条目，独立于安装与选择。 */
  official: boolean
  /** 可读的包位置；按需目录条目排除未声明的传递副本，且声明的文件可能缺失。 */
  availability: 'installation' | 'profile' | 'missing'
  /** 为按需目录条目所提供的精确已发布 Host 版本或同一检出中的开发链接。 */
  installTarget?: { spec: string; version: string }
  version?: string
  /** 本地展示文本，带有可用翻译或字面回退，或一条元数据诊断。 */
  meta?: PluginLocalizedMeta
  /** 本 bundle 包清单的、未经翻译的 `description`。 */
  description?: string
  /** 在 profile 清单中被选中；加载错误意味着其层被跳过。 */
  enabled: boolean
  /** profile 是否声明了该依赖；availability 另报其文件是否可读。 */
  installed: boolean
  /**
   * 仅当某项 profile 依赖并非安装同时提供时出现：即 `pnpm add` 所接受的 spec，其中本地路径被
   * 转为绝对路径，且 http(s) URL 的用户信息被去除。
   */
  source?: string
  /**
   * 安装是否随附该 bundle 供用户开启：由启动器的 `OPTIONAL_BUNDLES` 命名、被安装的依赖持有、
   * 没有任何已发布的模板选中它，且永不可移除。
   */
  optional: boolean
  removable: boolean
  readOnlyReason?: ReadOnlyReason
  error?: ManagementError
  /** 该 bundle 补丁所插入的行，按声明顺序排列；当补丁无法读取时为空。 */
  rows: BundleRowInfo[]
  /** 该 bundle 补丁在未声明它们的情况下所改动的行 id：它配置或禁用的内置行。 */
  overrides: string[]
}

/** 要从中安装的注册表：一个 http(s) URL，或代表 pnpm 自身配置所命名者的 null。 */
export type Registry = string | null

/** 管理器所询问的注册表：已配置的第一个、其顺序排在其后的回退项，以及 pnpm 自身配置所命名者。 */
export interface PluginRegistries {
  readonly registry: Registry
  readonly fallbackRegistries: readonly string[]
  /** pnpm 自身配置在 profile 中所命名的 URL，从 pnpm 读取；无法读取时为 null。 */
  readonly resolved: string | null
}

/** 一个包操作如何失败，由它如何结束以及它打印了什么来读取。 */
export type PluginInstallFailureKind =
  | 'pnpm-missing'
  | 'timeout'
  | 'not-found'
  | 'no-matching-version'
  | 'network'
  | 'disk-full'
  | 'permission'
  | 'build-blocked'
  | 'integrity'
  | 'unknown'

/** 包操作的完成，包括 Git 检查，以及获取未删节诊断的路径。 */
export interface PackageResult {
  exitCode: number
  output: string
  truncated: boolean
  logPath: string
  /** 当运行失败时存在：其退出码与输出所描述的失败种类。 */
  kind?: PluginInstallFailureKind
  /** 管理器在运行打印了超过其静默上限的内容之后终止了它；`exitCode` 仍报告它如何结束。 */
  timedOut?: boolean
  /** 当兼容性检查拒绝该运行时存在：运行中的 DSH 版本所拒绝的包。 */
  incompatible?: IncompatiblePlugin[]
}

/** 持久化的变更，以及独立观测到的应用结果。 */
export interface ChangeResult {
  changed: boolean
  /** `cancelled` 是调用方停止的安装，其文件已恢复。 */
  application: 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled'
  /** 与 `restart-required` 一同出现：变更为何只在下一次启动时才生效。 */
  restartReason?: RestartReason
  /** 最后尝试的步骤；成功的安装可继续进入启用阶段。 */
  stage: 'install' | 'enable' | 'remove'
  target: string
  enabled?: boolean
  error?: ManagementError
  /** 操作原样保留的、先前已存在的非活动条目。 */
  warnings?: string[]
  packageResult?: PackageResult
  /** 一旦 pnpm 与 bundle 检查接受了安装，该安装所添加的 bundle。 */
  bundle?: string
  /** 已安装 bundle 的清单版本，在声明时；pnpm 的 `minimumReleaseAge` 可能使它比最新发布更旧。 */
  version?: string
  /** 在一次失败运行之后读取、在 profile 的 pnpm 设置中等待显式脚本批准的精确包名。 */
  pendingBuilds?: string[]
  /** 在本次安装尝试之前保存的包脚本权限。 */
  approvedBuilds?: string[]
  /** 该安装所询问的注册表，按顺序排列；`packageResult` 是最后一个的运衎。 */
  registries?: Registry[]
  /**
   * 最后一次失败的运行无法抵达或无法从中得到答案的对象：它询问的注册表，或某个 git 或
   * tarball spec 所拉取自的主机（没有任何注册表可以替代它）；当失败两者都无法解释时缺失。
   */
  failedAt?: 'registry' | 'spec-host'
}

/** 标识一次安装，从它开始直到它结算，包括其日志分块与取消。 */
export type PluginInstallRequestId = Branded<'PluginInstallRequestId'>

/** bundle 安装默认激活；提供取消能力的调用方给出其 request id。 */
export interface InstallBundleOptions {
  enabled?: boolean
  /** 保存解析后的依赖版本而非一个范围；适用于任何 bundle 安装。 */
  saveExact?: boolean
  requestId?: PluginInstallRequestId
  /** 针对该 profile 显式允许这些待决包的脚本，然后安装；一个不再待决的名称会拒绝该调用。 */
  approvedBuilds?: string[]
  /** 首先询问的注册表；缺失时为已配置的那个。在一个注册表不可达或过期时，已配置的回退项紧随其后。 */
  registry?: Registry
}

/** 一次检视所询问的位置。 */
export interface InspectOptions {
  /** 首先询问的注册表；缺失时为已配置的那个。 */
  readonly registry?: Registry
}

/** 一个安装 spec 所采取的形式，用 pnpm 的术语来说。 */
export type InstallSpecKind = 'registry' | 'path' | 'git' | 'tarball'

/** 在安装了任何东西之前、一个 spec 被拒绝的原因。 */
export type PluginInspectProblem =
  | 'invalid-spec'
  | 'already-installed'
  | 'not-found'
  | 'not-a-package'
  | 'not-a-bundle'
  | 'network'
  | 'unknown'

/**
 * 一次安装之前读取一个 spec 所命名的对象：针对名称时注册表的回答、针对路径时某个目录的
 * 清单，而针对 git 或 tarball spec 则只有其形式——其包要等 pnpm 拉取之后才知道。
 */
export type PluginSpecInspection =
  | {
    readonly status: 'accepted'
    readonly kind: InstallSpecKind
    readonly name?: string
    readonly version?: string
    /** 包清单的 `description`。 */
    readonly description?: string
    /** 包是否声明了一个 bundle 补丁；当 spec 的形式未说明时为 null。 */
    readonly bundle: boolean | null
    /** 为名称作答的注册表，以及为其它形式作答的安装该 spec 时首先询问的那个。 */
    readonly registry: Registry
    /** 某个 git spec 或一个 tarball URL 所拉取自的主机，没有任何注册表可以替代它。 */
    readonly host?: string
  }
  | {
    readonly status: 'refused'
    readonly problem: PluginInspectProblem
    /** pnpm、注册表或文件系统所说的话。 */
    readonly reason: string
    /** 当拒绝来自对它们的询问时，所询问的注册表（按顺序排列）；`reason` 是最后一个的。 */
    readonly registries?: Registry[]
  }

/** 一次安装的 Host 阶段，在其 install 调用结算之前；`installing` 每询问一个注册表即宣告一次。 */
export interface PluginInstallProgress {
  readonly requestId: PluginInstallRequestId
  readonly phase: 'installing' | 'cancelling' | 'applying'
  /** 与 `installing` 一同：本次尝试所询问的注册表、其从 1 开始的序号，以及该安装可能询问的数量。 */
  readonly attempt?: { readonly registry: Registry; readonly index: number; readonly total: number }
}

/** 取消只有在进程退出且文件恢复之后才被确认。 */
export interface PluginInstallCancellation {
  readonly status: 'cancelled' | 'too-late' | 'not-running'
}

/** pnpm 运行输出的一块分块，随运行的产生而提供。 */
export interface PluginInstallLogChunk {
  /** 该运行所属的安装，在调用方给出了 request id 时。 */
  readonly requestId?: PluginInstallRequestId
  /** 该分块所属的运行。 */
  readonly jobId: string
  /** 运行所执行的命令行：pnpm 的命令名，然后是它的参数。 */
  readonly argv: readonly string[]
  /** 运行在其中执行的目录：profile 目录。 */
  readonly cwd: string
  readonly stream: 'stdout' | 'stderr'
  readonly text: string
  /** 在该运行的最后一块上出现：pnpm 的退出码，当它在没有退出码的情况下结束时为 null。 */
  readonly exitCode?: number | null
}

/** profile 中改变了什么，供展示它的消费方使用。 */
export interface PluginChange {
  /** 改变它的操作。 */
  readonly reason: 'plugin' | 'bundle' | 'install' | 'remove'
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * profile 的插件、bundle，或组合发生了变化：一次管理器操作已完成。在管理器之外应用
     * 的补丁生成（由 HMR 的监听器在 CLI 或手动编辑之后触发）在此处不宣告任何内容。
     * @mode emit
     * @param change - 改变了什么。
     */
    'plugin-manager/changed'(change: PluginChange): void
    /**
     * pnpm 运行输出的一块分块，随运行的产生而流式提供。
     * @mode emit
     * @param chunk - 该分块以及它所属的运行。
     */
    'plugin-manager/install-log'(chunk: PluginInstallLogChunk): void
    /**
     * 一次安装在它的 Host 阶段之间移动。`installing` 每询问一个注册表即宣告一次，附带
     * 该尝试的注册表与序号；`cancelling` 与 `applying` 各宣告一次。
     * @mode emit
     * @param progress - 该安装的 request id 与阶段，以及在 installing 时的尝试。
     */
    'plugin-manager/install-state'(progress: PluginInstallProgress): void
  }
}
