/**
 * 建立在相互独立的 sandbox-mode 与 approval-policy 两个开关之上、面向用户的权限
 * 预设。一次切换会记录被选中的预设，然后通过各自的权威 setter 写入发生变化的开关。
 * 执行、prompt 叙述与重放继续读取各自的开关折叠结果。当两个预设共用同一组取值时，
 * 预设事件得以保留用户的意图。Auto 评审集成可以发布一个固定的、仅限当前 Session
 * 的预设，并附带一个同步的准入检查；设置项的默认值仍限定在已配置的表内。读侧暴露
 * 进程级目录与只包含当前值的 `permissions` Session 投影；写侧以 `/permission`
 * 命令提供。
 *
 * @module dsh-permission-presets
 */
import type {} from '@deepseek-ai/dsh-settings'

import type { Volatile } from '@deepseek-ai/cordis'

import { Context } from '@deepseek-ai/cordis'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { SANDBOX_MODES, setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
// 副作用式类型导入：通过声明合并提供 `ctx.shell`（本服务读取的能力事实
// `sandboxMode`），同时不对接缝产生值依赖。
import type {} from '@deepseek-ai/dsh-shell'
import type { ApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { APPROVAL_POLICIES, setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
// 仅类型：解析必需的投影服务，以及可选的 settings/command 子项。
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-commands'
import type { PermissionCatalog, PermissionSelection, PresetOption } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    permissionPresets: PermissionPresetService
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** 最近记录到的权限覆盖情况与构造函数播种状态。 */
    permissions: PermissionProjectionState
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * 把被选中的预设记录为已持久的用户意图。开关事件紧随其后写入同一个 turn
     * 并控制执行；本事件不进入模型 transcript，并让权限投影单元在多个预设共用
     * 同一组取值时保留用户的选择。
     */
    'permission/preset': { preset: string }
  }
}

/** 一个预设的 sandbox/approval 取值组合，以及可选的 Client 呈现信息。 */
export interface PresetSpec {
  /** 该预设经 `sandbox/mode` 写入的值。 */
  sandbox: SandboxMode
  /** 该预设经 `approval/policy` 写入的值。 */
  approval: ApprovalPolicy
  /** Client 为该预设展示的名称；缺省时为原始的表键。 */
  name?: string
  /** 一句面向用户的话，说明该预设的含义；未配置时缺省。 */
  description?: string
}

/**
 * 当生效的开关取值与任何可用预设都不匹配时返回。客户端可以把它当作当前值展示，
 * 但它永远不是切换目标，也不会成为事件载荷。
 */
export const CUSTOM_PRESET = 'custom'

/** 实验性的逐次评审预设的权威身份。 */
export const AUTO_PRESET = 'auto'

/**
 * 生效中的 Auto 集成的固定执行组合。`ask` 把评审方的拒绝路由给用户；一个被保存
 * 下来的 Auto 身份同样匹配 `never`，被委派的子 agent 用它固定取值，从而让评审方的
 * 拒绝保持终局性。
 */
const AUTO_PRESET_SPEC: PresetSpec = {
  sandbox: 'danger-full-access',
  approval: 'ask',
}

/**
 * 投影单元的开关状态：每个开关事件最后一次出现的值；在出现覆盖之前为 null
 * （组合默认值在生成视图时才生效）。
 */
export interface KnobState {
  /** 最后一次 `permission/preset` 的载荷，或 null。 */
  preset: string | null
  /** 最后一次 `sandbox/mode` 的载荷，或 null。 */
  sandbox: SandboxMode | null
  /** 最后一次 `approval/policy` 的载荷，或 null。 */
  approval: ApprovalPolicy | null
}

/** 权限覆盖与构造函数播种状态的投影内部 state。 */
interface PermissionProjectionState extends KnobState {
  /** 日志中是否存在构造函数播种边界。 */
  seeded: boolean
}

const permissionStateSchema: zod.ZodType<PermissionProjectionState> = zod.object({
  preset: zod.string().nullable(),
  sandbox: zod.union([
    zod.literal('read-only'),
    zod.literal('workspace-write'),
    zod.literal('danger-full-access'),
  ]).nullable(),
  approval: zod.union([zod.literal('ask'), zod.literal('never')]).nullable(),
  seeded: zod.boolean(),
}).strict()

/** 空日志的 state：每个开关都处在组合默认值上。 */
const EMPTY_KNOBS: KnobState = { preset: null, sandbox: null, approval: null }

/**
 * 单事件的权限状态转移（投影单元的 `apply`）。无关事件返回同一个引用 ——
 * 这是注册表的变更闸门。
 * @param state - `event` 之前已折叠的开关状态。
 * @param event - 一条已提交的 Session 事件。
 * @returns 下一个状态；事件无关时返回同一个引用。
 */
function applyPermissionEvent(
  state: PermissionProjectionState,
  event: SessionEvent,
): PermissionProjectionState {
  switch (event.type) {
    case 'permission/preset':
      return { ...state, preset: event.data.preset }
    case 'sandbox/mode':
      return { ...state, sandbox: event.data.mode }
    case 'approval/policy':
      return { ...state, approval: event.data.policy }
    case 'session/end-seed':
      return { ...state, seeded: true }
    default:
      return state
  }
}

/** 新 Session 接收初始权限时读取的用户设置。 */
export interface PermissionSettings {
  /** 钉入新建 Session 的预设。 */
  defaultPreset: string
}

/** {@link PermissionPresetService} 的配置：预设表与组合默认值。 */
export interface Config {
  /**
   * 预设表：名称 → 开关组合。默认为 `workspace-write`
   * （workspace-write + ask）与 `danger-full-access`
   * （danger-full-access + never）。其中 `custom` 与 `auto` 两个名称被保留，
   * 分别用于推导状态与 Auto 评审集成。
   */
  presets: Record<string, PresetSpec>
  /**
   * 新 Session 的默认值。缺省时使用与组合后的 sandbox 和 approval 默认值相匹配的
   * 那个预设。
   */
  defaultPreset: Volatile<string | undefined>
}

/**
 * 持有部署所配置的权限预设、固定的 Auto 集成钩子，以及它们的写入路径。要求一个能够
 * 实施约束的 `ctx.shell` 执行器与 `ctx.approval`；无法匹配任何取值的开关会被报告为
 * {@link CUSTOM_PRESET}，而不是一个错误。
 */
export class PermissionPresetService extends TypertRemoteService {
  // 内联 schema 调用：配置目录静态地遍历 `static Config`。
  static Config = z.object({
    presets: z.dict(z.object({
      sandbox: z.union(SANDBOX_MODES as SandboxMode[]).required(),
      approval: z.union(APPROVAL_POLICIES as ApprovalPolicy[]).required(),
      name: z.string(),
      description: z.string(),
    })).default({
      'workspace-write': {
        sandbox: 'workspace-write', approval: 'ask',
        name: 'workspace-write', description: 'Write inside the workspace and permitted temporary directories; wider retries require approval.',
      },
      'danger-full-access': {
        sandbox: 'danger-full-access', approval: 'never',
        name: 'danger-full-access', description: 'Full file access without approval prompts.',
      },
    }),
    defaultPreset: z.string().volatile(),
  })

  static inject = ['shell', 'approval', 'sessions', 'sessionProjections']

  private readonly presets: Record<string, PresetSpec>
  private autoAdmit: (() => void) | undefined
  private defaultSettings: () => PermissionSettings

  constructor(ctx: Context, config: Config) {
    super(ctx, 'permissionPresets')

    ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
    // schema 已为这张表填好默认值 —— 该断言只是把这个运行期事实记录下来。
    this.presets = config.presets
    if (CUSTOM_PRESET in this.presets) {
      throw new Error(`permission: "${CUSTOM_PRESET}" is reserved for the derived not-a-preset state and cannot name a table entry`)
    }
    if (AUTO_PRESET in this.presets) {
      throw new Error(`permission: "${AUTO_PRESET}" is reserved and cannot name a configured preset`)
    }
    if (ctx.shell.sandboxMode === undefined) {
      throw new Error('permission: the mounted bash executor does not confine (no sandboxMode) — presets bundle a sandbox mode, so composing this plugin over an unconfined executor is a misconfiguration')
    }
    const inferredDefault = this.derive(EMPTY_KNOBS)
    const defaultPreset = config.defaultPreset.get() ?? inferredDefault
    if (defaultPreset === CUSTOM_PRESET) {
      throw new Error('permission: composed sandbox and approval defaults match no preset; configure defaultPreset explicitly')
    }
    this.resolve(defaultPreset)
    this.defaultSettings = () => {
      const defaultPreset = config.defaultPreset.get() ?? inferredDefault
      if (!Object.hasOwn(this.presets, defaultPreset)) throw new Error(`permission: unknown default preset "${defaultPreset}"`)
      return { defaultPreset }
    }

    const selectionSchema = zod.object({
      currentValue: zod.string().min(1),
    }) as zod.ZodType<PermissionSelection>
    ctx.sessionProjections.register({
      key: 'permissions',
      stateVersion: 2,
      stateSchema: permissionStateSchema,
      init: () => ({ ...EMPTY_KNOBS, seeded: false }),
      apply: applyPermissionEvent,
      wire: { viewSchema: selectionSchema, view: state => ({ currentValue: this.derive(state) }) },
    })
    ctx.on('session/created', (session) => {
      this.pinInitialPermission(session)
    })
    for (const session of ctx.sessions.list()) {
      this.pinInitialPermission(session)
    }

    // /permission 命令：web 客户端使用的唯一写入路径（弹窗贡献把选中的预设作为
    // 这一行提交）。该子 context 只在组合了命令注册表时才激活。
    ctx.inject(['commands'], (commandCtx) => {
      commandCtx.commands.register({
        definitionId: CommandDefinitionId('@deepseek-ai/dsh-permission-presets'),
        name: 'permission',
        description: 'Switch the permission preset (sandbox mode + approval policy)',
        input: { hint: '<preset>' },
        // 结果文案不会再用本命令自身的名字标注取值：任何把 `名称 · 文本` 渲染出来的
        // 界面（例如 web 的命令行）否则会显示成
        // `permission · Permission preset: workspace-write.`
        handler: ({ agent, rawInput }) => {
          const name = rawInput.trim()
          if (name === '') {
            return { kind: 'success', text: `current preset ${this.current(agent.session)} (available: ${this.names.join(', ')})` }
          }
          if (!this.names.includes(name)) {
            return { kind: 'error', text: `unknown preset "${name}" (available: ${this.names.join(', ')})` }
          }
          this.apply(agent.session, name, (policy) => { this.ctx.approval.setPolicy(agent, policy) })
          return { kind: 'success', text: `preset ${name}` }
        },
      })
    })
  }

  /**
   * 对外公布的预设名称：按声明顺序排列的已配置项，其后是生效期间的 Auto。
   * @returns 全部可切换的预设名称。
   */
  get names(): readonly string[] {
    return [...Object.keys(this.presets), ...(this.autoAdmit === undefined ? [] : [AUTO_PRESET])]
  }

  /**
   * 读取暴露给当前 Session UI 的完整进程级目录。
   * @returns 当前全部可选预设，按贡献顺序排列。
   */
  @Remote('catalog')
  catalog(): PermissionCatalog {
    return {
      options: this.names.map(name => this.optionOf(name)),
      defaultOptions: Object.keys(this.presets).map(name => this.optionOf(name)),
      defaultPreset: this.defaultSettings().defaultPreset,
    }
  }

  /**
   * 在调用方集成的 effect 生命周期内发布固定的、当前 Session 级的 Auto 预设。
   * @param admit - 在选择或恢复生效中的 Auto 之前运行的同步闸门。
   * @returns 移除 Auto 的异步 effect 回收函数。
   */
  registerAuto(admit: () => void): () => Promise<void> {
    return this.ctx.effect(() => {
      if (this.autoAdmit !== undefined) throw new Error('permission: preset "auto" is already registered')
      this.autoAdmit = admit
      this.emitCatalogChanged()
      return () => {
        this.autoAdmit = undefined
        this.emitCatalogChanged()
      }
    }, 'permissionPresets.registerAuto()')
  }

  /**
   * 当前被选为未来 Session 默认值的预设。
   * @returns 解析出的设置值；没有挂载设置提供者时为组合默认值。
   */
  get defaultPreset(): string {
    return this.defaultSettings().defaultPreset
  }

  private permissionState(session: Session): PermissionProjectionState {
    const state = this.ctx.sessionProjections.stateOf(session, 'permissions')
    if (state === undefined) throw new Error('permission: permissions session projection is not registered')
    return state
  }

  /**
   * 解析出与生效开关取值相匹配的预设。当仍然匹配的上一次选择与他人共用同一组取值时，
   * 由它胜出；仍处于选中状态的 Auto 还能匹配 `never` 审批策略；否则由第一个配置
   * 匹配项胜出。没有任何可用预设匹配时返回
   * {@link CUSTOM_PRESET}。
   * @param session - 读取其开关状态的 Session。
   * @returns 生效的预设名称；都不匹配时为 `custom`。
   */
  current(session: Session): string {
    return this.derive(this.permissionState(session))
  }

  /** 为一份已折叠的开关状态解析预设（`current` 与投影单元共用的同一套算法）。 */
  private derive(state: KnobState): string {
    const sandbox = state.sandbox ?? this.ctx.shell.sandboxMode
    const approval = state.approval ?? this.ctx.approval.config.policy ?? 'ask'
    const matches = (spec: PresetSpec): boolean => spec.sandbox === sandbox && spec.approval === approval
    if (state.preset !== null) {
      const spec = this.specOf(state.preset)
      if (spec !== undefined && matches(spec)) return state.preset
      if (state.preset === AUTO_PRESET && spec?.sandbox === sandbox && approval === 'never') return AUTO_PRESET
    }
    for (const [name, spec] of Object.entries(this.presets)) {
      if (matches(spec)) return name
    }
    return CUSTOM_PRESET
  }

  /**
   * 解析某个可用预设的开关组合。
   * @param name - 要解析的预设名称。
   * @returns 对应的已配置组合。
   * @throws 当 `name` 既不是已配置预设，也不是当前生效中的 Auto 预设时抛出。
   */
  resolve(name: string): PresetSpec {
    const spec = this.specOf(name)
    if (spec === undefined) {
      throw new Error(`permission: unknown preset "${name}" (known: ${this.names.join(', ')})`)
    }
    return spec
  }

  /**
   * 为一个可用预设或 {@link CUSTOM_PRESET} 构造 Client 选项。
   * 缺失的展示名称回退到预设键本身。
   * @param name - 某个已配置的预设键、生效中的 `auto`，或 `custom`。
   * @returns 供 Client 渲染的选项。
   * @throws 当 `name` 既不是已配置预设、生效中的 `auto`，也不是 `custom` 时抛出。
   */
  optionOf(name: string): PresetOption {
    if (name === CUSTOM_PRESET) {
      return { value: CUSTOM_PRESET, name: 'Custom', description: 'Current sandbox and approval settings do not match a preset.' }
    }
    const spec = this.resolve(name)
    return { value: name, name: spec.name ?? name, ...spec.description !== undefined ? { description: spec.description } : {} }
  }

  /**
   * 记录一次预设变更，然后通过各自的 setter 更新每一个发生变化的开关。再次选择当前
   * 已经生效的预设不会追加任何事件。
   * @param session - 本次切换所属的 Session。
   * @param name - 要切换到的预设；名称未知时抛出。
   */
  set(session: Session, name: string): void {
    this.apply(session, name, (policy) => { setApprovalPolicy(session, policy) })
  }

  /** 通过已持久的身份与权威 setter 应用一个预设。 */
  private apply(session: Session, name: string, setApproval: (policy: ApprovalPolicy) => void): void {
    const spec = this.resolve(name)
    if (name === AUTO_PRESET) this.autoAdmit?.()
    const current = this.current(session)
    const knobs = this.permissionState(session)
    const updateKnobs = (): void => {
      if (spec.sandbox !== (knobs.sandbox ?? this.ctx.shell.sandboxMode)) {
        setSandboxMode(session, spec.sandbox)
      }
      if (spec.approval !== (knobs.approval ?? this.ctx.approval.config.policy ?? 'ask')) {
        setApproval(spec.approval)
      }
    }
    if (current !== name) session.append('permission/preset', { preset: name })
    updateKnobs()
  }

  /**
   * 在 Session 发布之前补齐每一个缺失的权限事实。真正全新的 Session 使用当前的用户
   * 默认值；已播种或部分初始化的 Session 保留其生效的开关取值，只补齐缺失的已持久
   * 事实。一个被保存下来的 Auto 身份要求集成处于生效状态，并通过其准入检查之后
   * 才会被发布。
   */
  private pinInitialPermission(session: Session): void {
    const state = this.permissionState(session)
    const { preset, sandbox, approval, seeded } = state
    if (preset === AUTO_PRESET) {
      if (this.autoAdmit === undefined) {
        throw new Error('permission: cannot restore preset "auto" without its active integration')
      }
      this.autoAdmit()
    }
    if (preset === null && sandbox === null && approval === null && !seeded) {
      const name = this.defaultPreset
      const spec = this.resolve(name)
      session.append('permission/preset', { preset: name })
      setSandboxMode(session, spec.sandbox)
      setApprovalPolicy(session, spec.approval)
      return
    }

    const effective = this.derive(state)
    if (preset === null && effective !== CUSTOM_PRESET) {
      session.append('permission/preset', { preset: effective })
    }
    if (sandbox === null) {
      setSandboxMode(session, this.ctx.shell.sandboxMode as SandboxMode)
    }
    if (approval === null) {
      setApprovalPolicy(session, this.ctx.approval.config.policy ?? 'ask')
    }
  }

  /** 发布一条不具否决权的、无载荷的目录失效通知。 */
  private emitCatalogChanged(): void {
    for (const listener of this.ctx.events.dispatch('emit', ['permission-presets/catalog-changed']) as Array<() => unknown>) {
      try {
        const returned = listener()
        if (returned != null && typeof (returned as PromiseLike<unknown>).then === 'function') {
          void Promise.resolve(returned as PromiseLike<unknown>).catch((error: unknown) => {
            this.ctx.logger.warn(`permission: catalog-changed listener failed: ${error instanceof Error ? error.message : String(error)}`)
          })
        }
      } catch (error: unknown) {
        this.ctx.logger.warn(`permission: catalog-changed listener failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /** 解析某个已配置的、或当前生效中的固定预设，且不抛出。 */
  private specOf(name: string): PresetSpec | undefined {
    return this.presets[name]
      ?? (name === AUTO_PRESET && this.autoAdmit !== undefined ? AUTO_PRESET_SPEC : undefined)
  }
}

export default PermissionPresetService
