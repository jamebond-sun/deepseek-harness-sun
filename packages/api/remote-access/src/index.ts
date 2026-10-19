/**
 * Host 方法级访问控制。Gateway 在分发非 owner 调用或向非
 * owner Peer 转发事件之前先询问 `decide()`；list 方法经
 * `allows()` 过滤条目；每个 Peer 读取自己的访问快照，先从
 * index 读取，再经 `follow()` 读取。业务包为每个非 owner
 * principal 种类注册一个策略。
 * @module @deepseek-ai/dsh-api-remote-access
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  Remote,
  TypertRemoteService,
  principalOf,
  type Principal,
  type PrincipalMap,
  type RemoteAccessResource,
} from '@deepseek-ai/dsh-typert-protocol'
import { REMOTE_ACCESS_SNAPSHOT_KEY } from './snapshot.ts'
import type {
  RemoteAccessAction,
  RemoteAccessDecision,
  RemoteAccessFrame,
  RemoteAccessGrant,
  RemoteAccessPolicy,
  RemoteAccessRequest,
} from './types.ts'

export type * from './types.ts'
export { REMOTE_ACCESS_SNAPSHOT_KEY } from './snapshot.ts'

/** 一个快照代的开场帧。 */
export type RemoteAccessBaseline = Extract<RemoteAccessFrame, { type: 'baseline' }>

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 面向非 owner Peer 的 Host 方法级访问控制。 */
    remoteAccess: RemoteAccessService
  }
}

/** 每个 Peer 都可为自己读取的快照端点。 */
const FOLLOW_ACTION: RemoteAccessAction = 'remoteAccess/follow'
const ALLOW: RemoteAccessDecision = Object.freeze({ kind: 'allow' })
const NO_ALLOW: RemoteAccessDecision = Object.freeze({ kind: 'deny', reason: 'no-allow' })
const POLICY_FAILED: RemoteAccessDecision = Object.freeze({ kind: 'deny', reason: 'policy-failed' })
const OWNER: Principal = Object.freeze({ kind: 'owner' })
const OWNER_BASELINE: RemoteAccessBaseline = Object.freeze({ type: 'baseline', owner: true })

/**
 * 不带资源种类的绑定视图。方法语法使每个种类的
 * condition 都保持可赋值；每个 condition 仅以等于其自身
 * 绑定资源的资源被调用。
 */
interface ErasedBinding {
  readonly role: { readonly actions: readonly RemoteAccessAction[] }
  readonly resource: RemoteAccessResource
  condition?(request: {
    readonly action: RemoteAccessAction
    readonly resource: RemoteAccessResource
    readonly args?: Readonly<Record<string, unknown>>
  }): RemoteAccessDecision
}

/** 一个已注册策略及其服务的 principal 种类。 */
interface PolicyEntry {
  readonly kind: string
  readonly policy: RemoteAccessPolicy<Principal>
}

/** 一个 condition 的拒绝。 */
type Refusal = Extract<RemoteAccessDecision, { kind: 'deny' }>

/** 一个动作在一个资源上的回答，先于任何 `explain()`。 */
type Evaluation =
  | { readonly kind: 'allow' }
  /** 无绑定允许；若有 condition 执行过，`refusal` 是第一个拒绝的 condition 的决策。 */
  | { readonly kind: 'refuse'; readonly refusal: Refusal | undefined }
  | { readonly kind: 'failed' }

const ALLOWED: Evaluation = Object.freeze({ kind: 'allow' })
const FAILED: Evaluation = Object.freeze({ kind: 'failed' })

/** 一个开启的非 owner 快照代；变更合并，直到其读取方被唤醒。 */
class AccessFollower {
  private dirty = false
  private wake: (() => void) | undefined

  /** @param principal - 该代的调用方身份；绝不是 owner。 */
  constructor(readonly principal: Principal) {}

  /** 把该代标记为过期并唤醒其读取方。 */
  touch(): void {
    this.dirty = true
    this.wake?.()
  }

  /**
   * 等待该代过期或被取消。
   * @param signal - 代的取消信号。
   * @returns 过期时为 true；一旦取消则为 false。
   */
  async changed(signal: AbortSignal): Promise<boolean> {
    const abort = (): void => { this.wake?.() }
    signal.addEventListener('abort', abort, { once: true })
    try {
      while (!this.dirty && !signal.aborted) {
        await new Promise<void>((resolve) => { this.wake = resolve })
        this.wake = undefined
      }
    } finally {
      signal.removeEventListener('abort', abort)
    }
    this.dirty = false
    return !signal.aborted
  }
}

/**
 * 访问策略注册表、Gateway 的访问决策、列表
 * 过滤以及按 Peer 的访问快照。每个挂载 Gateway 的组合
 * 也会挂载本服务。
 */
export class RemoteAccessService extends TypertRemoteService {
  private readonly policies = new Map<string, PolicyEntry>()
  /** 自上次 `invalidate()` 以来已记录过失败的策略；其后续失败保持沉默。 */
  private readonly reported = new Set<PolicyEntry>()
  private readonly followers = new Set<AccessFollower>()
  /** 本实例卸载时中止；每个开启的快照代随之结束。 */
  private readonly lifetime = new AbortController()

  /** @param ctx - 持有本服务的 Host 插件上下文。 */
  constructor(ctx: Context) {
    super(ctx, 'remoteAccess')
    ctx.effect(() => () => { this.lifetime.abort() }, 'remoteAccess: snapshot generations')
    // webServer 渲染的每个 index 都属于 owner；snapshotFor 为非 owner 页面供值。
    ctx.inject(['webServer'], (webCtx) => {
      webCtx.on('webserver/index-inject', (table) => {
        table.push({ kind: 'global', name: REMOTE_ACCESS_SNAPSHOT_KEY, value: OWNER_BASELINE })
      })
    })
  }

  /**
   * 在调用方的 fiber 中注册一个非 owner principal 种类的策略；
   * 注册与移除时都会重算开启的快照。
   * @param kind - 该策略服务的 principal 种类；绝不是 `owner`。
   * @param policy - 业务持有的绑定，以及 `kind` 类 principal 的拒绝原因。
   * @returns 移除本策略的释放器。
   * @throws 当 `kind` 已有策略时抛出 Error。
   */
  registerPolicy<K extends Exclude<keyof PrincipalMap, 'owner'>>(kind: K, policy: RemoteAccessPolicy<PrincipalMap[K]>): () => void {
    const policies = this.policies
    if (policies.has(kind)) throw new Error(`remote access: principal kind ${JSON.stringify(kind)} already has a policy`)
    const entry: PolicyEntry = { kind, policy }
    const dispose = this.ctx.effect(() => {
      policies.set(kind, entry)
      this.invalidate()
      return () => {
        policies.delete(kind)
        this.invalidate()
      }
    }, `remoteAccess.registerPolicy(${JSON.stringify(kind)})`)
    return () => { void dispose() }
  }

  /**
   * 报告 `principal` 的绑定或 condition 回答可能已变化。业务包
   * 在每次授予、撤销、模式变更与过期时调用它；开启的快照
   * 会重新推送，且每个策略的下一次失败会再次记录。
   * @param principal - 受影响的 principal；省略时针对每个 principal。
   */
  invalidate(principal?: Principal): void {
    this.reported.clear()
    const key = principal === undefined ? undefined : canonicalJson(principal)
    for (const follower of this.followers) {
      if (key === undefined || canonicalJson(follower.principal) === key) follower.touch()
    }
  }

  /**
   * 仅限 Gateway：为资源已由 Gateway 解析的请求作决策。
   * owner 总被允许，`remoteAccess/follow` 亦然：每个 Peer 读取
   * 自己的快照。否则，只有当 principal 策略的某个绑定在每个
   * 列出资源上都指名该资源、其角色列出该动作、且没有
   * condition，或其 condition 允许时，该动作才被允许。
   * 每次决策调用 `bindings()` 一次。
   * @param request - 调用方或接收方、动作、其触及的
   *   资源，以及调用的参数。
   * @returns `allow`；或 `deny`——principal 种类
   *   没有策略时为 `no-allow`，在第一个无绑定允许的资源上为
   *   第一个拒绝 condition 的原因，否则为 `explain()` 的原因，再否则为 `no-allow`；
   *   `bindings()`、某个 condition 或 `explain()` 抛错时为 `policy-failed`，
   *   每个策略在下次 `invalidate()` 前只记录一次。Gateway
   *   对被拒调用抛出 `remote-access/denied`，并丢弃被拒事件。
   */
  decide(request: RemoteAccessRequest<Principal>): RemoteAccessDecision {
    const { principal, action } = request
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- other packages merge non-owner kinds into PrincipalMap.
    if (principal.kind === 'owner' || action === FOLLOW_ACTION) return ALLOW
    const entry = this.policies.get(principal.kind)
    if (entry === undefined) return NO_ALLOW
    const bindings = this.bindingsOf(entry, principal, action)
    if (bindings === undefined) return POLICY_FAILED
    for (const resource of request.resources) {
      const evaluation = this.evaluate(entry, bindings, action, resource, request.args)
      switch (evaluation.kind) {
        case 'allow':
          continue
        case 'failed':
          return POLICY_FAILED
        case 'refuse':
          return evaluation.refusal ?? this.explain(entry, request)
        /* v8 ignore next -- closed union. */
        default:
          return assertNever(evaluation)
      }
    }
    return ALLOW
  }

  /**
   * 在 Remote 方法内过滤条目。invocation 从访问本服务的
   * Context 读取，因此请在 Remote 方法中以
   * `this.ctx.remoteAccess.allows(resource)` 调用。每次检查都会
   * 重新读取策略的绑定，因此长时间运行的流从下一次检查起
   * 能看到绑定变更。
   * @param resource - 一个结果条目的资源。
   * @returns 对 owner 及 Remote 调用之外为 true；否则为
   *   invocation 的端点动作在无调用参数时是否允许作用于
   *   `resource`，策略缺失或失败时为 false。
   */
  allows(resource: RemoteAccessResource): boolean {
    const invocation = this.ctx.invocation
    const principal = principalOf(invocation)
    if (invocation === undefined || principal === undefined) return true
    const action: RemoteAccessAction = `${invocation.request.namespace}/${invocation.request.method}`
    const entry = this.policies.get(principal.kind)
    if (entry === undefined) return false
    const bindings = this.bindingsOf(entry, principal, action)
    return bindings !== undefined && this.evaluate(entry, bindings, action, resource, undefined).kind === 'allow'
  }

  /**
   * 页面在其快照流连接之前开场所用的 baseline。渲染非 owner
   * 页面的业务包在每个 index 注入行之后把该值赋给
   * {@link REMOTE_ACCESS_SNAPSHOT_KEY}，
   * 以替换 webServer index 携带的 owner baseline。
   * @param principal - 页面的调用方身份。
   * @returns owner 时为 owner baseline；否则为该 principal 当前的授予。
   */
  snapshotFor(principal: Principal): RemoteAccessBaseline {
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- other packages merge non-owner kinds into PrincipalMap.
    if (principal.kind === 'owner') return OWNER_BASELINE
    return { type: 'baseline', owner: false, grants: this.grantsFor(principal) }
  }

  /**
   * 流式传输调用方 Peer 的访问快照：一个 baseline，然后在每次
   * `invalidate()` 以及每次改变授予的策略注册或移除之后发送
   * `upsert` 与 `remove` 帧。owner 只收到
   * `{ owner: true }`。`signal` 中止或本服务卸载时该代结束，
   * 因此重新加载的服务让每个读取方都从全新的
   * baseline 开始。
   * @param signal - 代的取消信号。
   * @returns 一个代的访问帧。
   */
  @Remote({ mode: 'stream' })
  async *follow(signal: AbortSignal): AsyncIterable<RemoteAccessFrame> {
    signal.throwIfAborted()
    const generation = AbortSignal.any([signal, this.lifetime.signal])
    const principal = principalOf(this.ctx.invocation)
    if (principal === undefined) {
      yield this.snapshotFor(OWNER)
      await abortion(generation)
      return
    }
    const follower = new AccessFollower(principal)
    this.followers.add(follower)
    try {
      let sent = this.grantsFor(principal)
      yield { type: 'baseline', owner: false, grants: sent }
      while (await follower.changed(generation)) {
        const next = this.grantsFor(principal)
        const previous = sent
        sent = next
        for (const grant of next) {
          const before = previous.find(other => sameResource(other.resource, grant.resource))
          if (before === undefined || !sameActions(before.actions, grant.actions)) yield { type: 'upsert', grant }
        }
        for (const grant of previous) {
          if (!next.some(other => sameResource(other.resource, grant.resource))) yield { type: 'remove', resource: grant.resource }
        }
      }
    } finally {
      this.followers.delete(follower)
    }
  }

  /** 一次 `bindings()` 调用；记录失败后为 `undefined`。 */
  private bindingsOf(entry: PolicyEntry, principal: Principal, purpose: string): readonly ErasedBinding[] | undefined {
    try {
      return entry.policy.bindings(principal)
    } catch (error) {
      // 策略失败被限制在本次询问内，因此一条有缺陷的规则不会破坏共享的事件流。
      this.report(entry, `list bindings for ${purpose}`, error)
      return undefined
    }
  }

  /** 在 `resource` 上找到角色列出 `action` 且 condition（如有）允许的绑定。 */
  private evaluate(
    entry: PolicyEntry,
    bindings: readonly ErasedBinding[],
    action: RemoteAccessAction,
    resource: RemoteAccessResource,
    args: Readonly<Record<string, unknown>> | undefined,
  ): Evaluation {
    let refusal: Refusal | undefined
    for (const binding of bindings) {
      if (!sameResource(binding.resource, resource) || !binding.role.actions.includes(action)) continue
      if (binding.condition === undefined) return ALLOWED
      let decision: RemoteAccessDecision
      try {
        decision = binding.condition(args === undefined ? { action, resource } : { action, resource, args })
      } catch (error) {
        this.report(entry, `evaluate a condition for ${action}`, error)
        return FAILED
      }
      if (decision.kind === 'allow') return ALLOWED
      refusal ??= decision
    }
    return { kind: 'refuse', refusal }
  }

  /** `explain()` 给出的拒绝原因，否则为 `no-allow`；其抛错时为 `policy-failed`。 */
  private explain(entry: PolicyEntry, request: RemoteAccessRequest<Principal>): RemoteAccessDecision {
    let reason: string | undefined
    try {
      reason = entry.policy.explain?.(request)
    } catch (error) {
      this.report(entry, `explain a refusal of ${request.action}`, error)
      return POLICY_FAILED
    }
    return reason === undefined ? NO_ALLOW : { kind: 'deny', reason }
  }

  /**
   * 每个绑定资源一个授予，按首个绑定的顺序：即该资源
   * 的绑定中 `decide()` 在无调用参数时会允许的端点
   * 动作。没有此类动作的资源不产生授予；
   * event 动作不进入快照。
   */
  private grantsFor(principal: Principal): readonly RemoteAccessGrant[] {
    const entry = this.policies.get(principal.kind)
    if (entry === undefined) return []
    const bindings = this.bindingsOf(entry, principal, 'a snapshot')
    if (bindings === undefined) return []
    const grants: RemoteAccessGrant[] = []
    const seen: RemoteAccessResource[] = []
    for (const { resource } of bindings) {
      if (seen.some(other => sameResource(other, resource))) continue
      seen.push(resource)
      const candidates = new Set<RemoteAccessAction>()
      for (const binding of bindings) {
        if (!sameResource(binding.resource, resource)) continue
        for (const action of binding.role.actions) {
          if (!action.startsWith('event:')) candidates.add(action)
        }
      }
      const actions = [...candidates].filter(action => this.evaluate(entry, bindings, action, resource, undefined).kind === 'allow').sort()
      if (actions.length > 0) grants.push(Object.freeze({ resource, actions: Object.freeze(actions) }))
    }
    return grants
  }

  /** 每个策略记录一次失败，直到下次 `invalidate()`；快照与列表在每次变更时会多次询问。 */
  private report(entry: PolicyEntry, action: string, error: unknown): void {
    if (this.reported.has(entry)) return
    this.reported.add(entry)
    this.ctx.logger.warn(
      `remote access: the ${JSON.stringify(entry.kind)} policy failed to ${action}; its further failures are not logged until access state changes`)
    this.ctx.logger.warn(error)
  }
}

/* v8 ignore next 3 -- closed-union backstop. */
function assertNever(value: never): never {
  throw new Error(`remote access: unreachable value ${JSON.stringify(value)}`)
}

/** 标识一个 principal 的、与键顺序无关的 JSON 文本。 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    // 自有键唯一，因此任意两个条目都不会比较相等。
    const entries = Object.entries(value).sort(([left], [right]) => (left < right ? -1 : 1))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** 种类与 id 都相等时资源相等；`global` 不携带 id。 */
function sameResource(
  left: { readonly kind: string; readonly id?: unknown },
  right: { readonly kind: string; readonly id?: unknown },
): boolean {
  return left.kind === right.kind && left.id === right.id
}

function sameActions(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((action, index) => action === right[index])
}

function abortion(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve()
    else signal.addEventListener('abort', () => { resolve() }, { once: true })
  })
}

export default RemoteAccessService
