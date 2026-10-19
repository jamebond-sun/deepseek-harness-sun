/**
 * 方法级访问控制契约：动作、角色、绑定、策略、
 * 决策请求与访问快照流。
 * @module @deepseek-ai/dsh-api-remote-access/types
 */

import type {
  Principal,
  RemoteAccessResource,
  RemoteAccessResourceKind,
  RemoteAccessResourceOf,
} from '@deepseek-ai/dsh-typert-protocol'

export type {
  RemoteAccessResource,
  RemoteAccessResourceKind,
  RemoteAccessResourceOf,
  TypertResourceKind,
  TypertResourceMap,
} from '@deepseek-ai/dsh-typert-protocol'

/** 规范的 `<namespace>/<method>` Remote 端点；其分段绝不包含 `:`。 */
export type RemoteAccessEndpoint = `${string}/${string}`

/** 一个 Remote 端点，或针对单个转发事件的 `event:<name>`。 */
export type RemoteAccessAction = RemoteAccessEndpoint | `event:${string}`

/** 一个资源种类上的具名动作集合；由业务包持有的普通值。 */
export interface RemoteAccessRole<K extends RemoteAccessResourceKind> {
  /** 供诊断使用的名称；决策只读取 `resource` 与 `actions`。 */
  readonly name: string
  /** 此角色的每个绑定所指名的资源种类。 */
  readonly resource: K
  /** 角色在其绑定资源上允许的动作。 */
  readonly actions: readonly RemoteAccessAction[]
}

/** `decide()` 与条件的回答。 */
export type RemoteAccessDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly reason: string }

/**
 * 针对其资源上的一个动作细化某个绑定。同步调用，
 * 仅针对资源匹配且角色列出该动作的绑定。
 * @param request - 动作、绑定的资源，以及一次具体调用的具名
 *   参数，已按其 Typert 编译类型校验，并以 lookup 参数作为
 *   wire 身份；对事件、快照与列表过滤而言 `args` 缺省，此时
 *   条件仅就动作本身作答。
 * @returns allow，或 deny 并附被拒调用上报的原因。
 */
export type RemoteAccessCondition<K extends RemoteAccessResourceKind> = (request: {
  readonly action: RemoteAccessAction
  readonly resource: RemoteAccessResourceOf<K>
  readonly args?: Readonly<Record<string, unknown>>
}) => RemoteAccessDecision

/** 角色所属种类的一个资源上的一个角色；资源类型随角色而定。 */
export type RemoteAccessBinding = {
  [K in RemoteAccessResourceKind]: {
    readonly role: RemoteAccessRole<K>
    readonly resource: RemoteAccessResourceOf<K>
    /** 无条件时，绑定允许其角色列出的每个动作。 */
    readonly condition?: RemoteAccessCondition<K>
  }
}[RemoteAccessResourceKind]

/** 一个访问问题：`principal` 可否在 `resources` 上执行 `action`。 */
export interface RemoteAccessRequest<P extends Principal> {
  readonly principal: P
  readonly action: RemoteAccessAction
  /**
   * 该动作触及的每个资源，未指名时仅为 global 资源；
   * 只有该动作在每个列出的资源上都被允许时才放行。
   */
  readonly resources: readonly RemoteAccessResource[]
  /**
   * 一次具体调用的具名参数，已按其 Typert 编译类型校验，
   * 并以 lookup 参数作为 wire 身份；对事件、快照与列表过滤缺省。
   */
  readonly args?: Readonly<Record<string, unknown>>
}

/**
 * 一个非 owner principal 种类的业务规则。每个成员都
 * 同步地依据业务包在内存中持有的状态作答。
 */
export interface RemoteAccessPolicy<P extends Principal> {
  /**
   * 列出该 principal 的绑定。每次 `decide()`、每次
   * `allows()` 与每次快照计算各调用一次；绝不缓存。
   * @param principal - 本策略种类、非 owner 的调用方。
   * @returns 该 principal 当前持有的每个绑定。
   */
  bindings(principal: P): readonly RemoteAccessBinding[]
  /**
   * 给出无任何绑定允许的请求的原因；仅在决策已为
   * deny 之后调用，因此绝不改变决策。
   * @param request - 被拒绝的请求。
   * @returns 被拒调用上报的原因；`no-allow` 时为 `undefined`。
   */
  explain?(request: RemoteAccessRequest<P>): string | undefined
}

/** 非 owner 被拒调用的详情。 */
export interface RemoteAccessDeniedDetails {
  /** 被拒调用的规范 `<namespace>/<method>` 端点。 */
  readonly action: string
  /**
   * 条件或 `explain()` 给出的原因、`no-allow` 或 `policy-failed`；
   * 资源无效的调用会在询问 `decide()` 之前被 Gateway 以
   * `resource-invalid` 拒绝。
   */
  readonly reason: string
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'remote-access/denied': RemoteAccessDeniedDetails
  }
}

/** 一个 principal 可在一个资源上调用的端点动作。 */
export interface RemoteAccessGrant {
  readonly resource: RemoteAccessResource
  /**
   * 在本资源上无需调用参数即被允许的端点动作，已排序；
   * 为普通字符串是因为 Typert 不为模板字面量类型生成编解码器。
   */
  readonly actions: readonly string[]
}

/**
 * `remoteAccess/follow` 的一帧。一代以一个 baseline 开启；
 * owner baseline 是其所在代的唯一一帧。
 */
export type RemoteAccessFrame =
  | { readonly type: 'baseline'; readonly owner: true }
  | { readonly type: 'baseline'; readonly owner: false; readonly grants: readonly RemoteAccessGrant[] }
  | { readonly type: 'upsert'; readonly grant: RemoteAccessGrant }
  | { readonly type: 'remove'; readonly resource: RemoteAccessResource }
