/**
 * 沙箱策略的唯一归属地（`ctx.sandboxPolicy`）：独自持有本次部署的沙箱
 * 回退值以及按会话的解析逻辑——文件效应 {@link SandboxMode}、workspace-write
 * 的根，以及覆盖工具箱（`sandbox/mode` 事件、它的折叠与写入路径；折叠即在此
 * 注册的 `sandboxMode` 会话投影单元，而事件与写入路径来自 `./session-mode.ts`）。
 * 在每次 agent 请求之前，所有者还会把已解析的策略贡献给可安全缓存的运行期
 * 上下文快照。agent 循环把该快照作为模型历史记录，因此重放能重建出与各强制
 * 消费者所解析的完全相同的模式与根，而无需改写稳定的系统提示。
 *
 * 强制性的文件系统、一次性 bash 与终端后端都从这里读取同一份已解析策略。
 * 上下文只描述这份策略，不去清点能力；而每个后端保留各自的强制方言，每个
 * 工具拥有各自操作特有的拒绝与升级指引。该服务在每个操作边界只读取一次
 * 会话状态；执行器与提供者保持与会话无关。
 *
 * @module @deepseek-ai/dsh-sandbox-policy
 */

import { isAbsolute } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { z as zod } from 'zod'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-system-prompt'

export { SANDBOX_MODES, setSandboxMode } from './session-mode.ts'

/** 保持执行世界的拼写；强制提供者在各自宿主机上解析文件系统身份。 */
function resolveWorkspaceRoot(path: string): string {
  if (!isAbsolute(path)) throw new Error('sandbox-policy: workspace root must be an absolute execution-world path')
  return path
}

/** 渲染该策略，但不声称挂载了哪些能力。 */
function renderPolicyContext(policy: SandboxExecutionPolicy): string {
  switch (policy.mode) {
    case 'read-only':
      return 'Current DSH file policy: read-only. Any available operation enforced by the DSH file sandbox cannot modify files in the standing mode. Do not refuse a required modification from this policy alone: try an available tool normally and follow any denial and escalation guidance it returns.'
    case 'workspace-write':
      return `Current DSH file policy: workspace-write. Any available operation enforced by the DSH file sandbox may modify files under the session workspace: ${JSON.stringify(policy.workspaceRoot)}. Some platform temporary areas may also be writable.`
    case 'danger-full-access':
      return 'Current DSH file policy: danger-full-access. The DSH file sandbox does not restrict file modifications by available operations.'
    /* v8 ignore next 4 -- SandboxMode 是同进程内带类型的封闭联合；该分支只是静态穷尽性守卫。 */
    default: {
      const mode: never = policy.mode
      throw new Error(`unreachable sandbox mode: ${String(mode)}`)
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sandboxPolicy: SandboxPolicyService
  }
}

/**
 * 插件配置：本次部署的沙箱默认值。全部可选——`Config` 提供默认值
 * （`mode: 'read-only'` 是故障安全的默认值；希望 agent 可写工作区的部署需要
 * 显式选择加入）。运行器选型不在这里（它属于 `ctx.sandbox` 提供者的配置），
 * 也没有任何按工具族的旋钮：这里是唯一的共享策略归属地。
 */
export interface Config {
  /** 一个会话起始时的文件沙箱模式（默认：`read-only`）。 */
  mode?: SandboxMode
  /**
   * 无 agent 调用与没有 cwd 的会话所用的绝对回退根（默认：`process.cwd()`）。
   * 普通的 agent 调用则改用其会话 cwd。
   */
  workspaceRoot?: string
}

/** 为一次能力调用选定沙箱策略的输入。 */
export interface SandboxPolicyRequest {
  /** 调用会话；其不可变 cwd 成为工作区边界。 */
  session?: Session
  /** 显式获批的模式覆盖，其优先级高于会话策略。 */
  mode?: SandboxMode
}

/** 沙箱模式投影的状态 schema（状态即公开形状）。 */
const sandboxModeStateSchema = zod.union([
  zod.literal('read-only'),
  zod.literal('workspace-write'),
  zod.literal('danger-full-access'),
]).nullable()

type SandboxModeState = zod.infer<typeof sandboxModeStateSchema>
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** 最近一次记录的沙箱模式覆盖；尚未有过覆盖时为 null（解析时套用部署默认值）。 */
    sandboxMode: SandboxModeState
  }
}

/**
 * 沙箱策略服务（`ctx.sandboxPolicy`）。持有部署的默认模式、回退工作区根，
 * 以及当前的请求期策略段落。工具层为每次执行调用 {@link resolve}，使一个
 * 会话的模式日志与其不可变 cwd 一并抵达每一个强制能力。
 */
export class SandboxPolicyService extends Service {
  // 内联 schema 调用：配置目录会静态地遍历 `static Config`。
  static Config: z<Config> = z.object({
    mode: z.union(['read-only', 'workspace-write', 'danger-full-access'] as const).default('read-only'),
    // 不设 schema 默认值：process.cwd() 在构造函数中解析，因此无论以何种
    // 方式提供，存下来的根始终是绝对路径。
    workspaceRoot: z.string(),
  })

  static inject = ['sessionProjections']

  /** 部署的默认模式——位于会话覆盖之下的回退值。 */
  readonly defaultMode: SandboxMode
  /** 没有会话 cwd 的调用所用的绝对 `workspace-write` 回退根。 */
  readonly workspaceRoot: string
  constructor(ctx: Context, config: Config) {
    super(ctx, 'sandboxPolicy')
    // schemastery（static Config）已经填好了 `mode`；该断言记录的正是这一
    // 运行期事实。`workspaceRoot` 没有 schema 默认值，因此它回退到进程 cwd
    // 是真实的分支，两种情形下都会被解析为绝对路径。
    this.defaultMode = config.mode as SandboxMode
    this.workspaceRoot = resolveWorkspaceRoot(config.workspaceRoot ?? process.cwd())

    ctx.sessionProjections.register({
      key: 'sandboxMode',
      stateVersion: 1,
      stateSchema: sandboxModeStateSchema,
      init: () => null,
      apply: (state, event) => (event.type === 'sandbox/mode' ? event.data.mode : state),
    })

    ctx.inject(['systemPrompt'], (scope: Context) => {
      scope.systemPrompt.context({
        name: 'sandbox:policy',
        order: scope.systemPrompt.getContextOrder('SANDBOX_POLICY'),
        text: (context) => {
          const session = context.agent?.session
          return session === undefined
            ? ''
            : renderPolicyContext(this.resolve({ session }))
        },
      })
    })
  }

  /**
   * 解析一次能力调用的完整策略。已获批的显式模式优先于会话最后一条
   * `sandbox/mode` 事件，后者又优先于部署默认值。会话 cwd 即它的
   * workspace-write 边界；配置中的根则是无 agent 调用与没有 cwd 的会话的
   * 回退值。
   * @param request - 可选的会话与已获批的模式覆盖。
   * @returns 完全解析后的按调用模式与绝对工作区根。
   */
  resolve(request: SandboxPolicyRequest = {}): SandboxExecutionPolicy {
    const { session } = request
    return {
      mode: request.mode ?? (session === undefined ? undefined : this.overrideOf(session)) ?? this.defaultMode,
      workspaceRoot: resolveWorkspaceRoot(session?.header.cwd ?? this.workspaceRoot),
      ...session === undefined ? {} : { sessionId: session.id },
    }
  }

  /**
   * 读取会话覆盖，但不套用部署默认值。
   * @param session - 其日志提供该覆盖的会话。
   * @returns 最近一次记录的模式；没有时返回 `undefined`。
   */
  overrideOf(session: Session): SandboxMode | undefined {
    return this.ctx.sessionProjections.stateOf(session, 'sandboxMode') ?? undefined
  }
}

export default SandboxPolicyService
