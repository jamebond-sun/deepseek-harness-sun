/**
 * 不依赖 React 的 Client 访问状态：最新的 `remoteAccess/follow` 快照，
 * 以及按资源与动作划分的身份稳定布尔源。
 * @module @deepseek-ai/dsh-api-remote-access/src/client/state
 */

import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteAccessFrame, RemoteAccessGrant, RemoteAccessResource } from '../types.ts'

/** 一个已声明资源种类下、按资源身份划分的允许动作。 */
type KindGrants = ReadonlyMap<string, ReadonlySet<string>>

type AccessSnapshot =
  /** 无 baseline，或非 owner 快照流已失败：每个回答均为 false。 */
  | { readonly kind: 'closed' }
  | { readonly kind: 'owner' }
  | {
    readonly kind: 'granted'
    readonly global: ReadonlySet<string>
    readonly resources: ReadonlyMap<string, KindGrants>
  }

type GrantedSnapshot = Extract<AccessSnapshot, { kind: 'granted' }>

const CLOSED: AccessSnapshot = Object.freeze({ kind: 'closed' })
const OWNER_SNAPSHOT: AccessSnapshot = Object.freeze({ kind: 'owner' })
const GLOBAL_KEY = '\u0000global'

/** 一个快照代的开场帧。 */
export type Baseline = Extract<RemoteAccessFrame, { type: 'baseline' }>

/**
 * 校验 index 注入行赋给页面的开场 baseline。
 * @param value - 注入的全局值；页面未携带时为 `undefined`。
 * @returns baseline，未注入任何值时为 `undefined`。
 * @throws 注入值不是 baseline 帧时抛出 TypeError。
 */
export function parseInjectedBaseline(value: unknown): Baseline | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value) || value['type'] !== 'baseline') throw new TypeError('remote access: the injected access snapshot is not a baseline frame')
  if (value['owner'] === true) return { type: 'baseline', owner: true }
  const grants = value['grants']
  if (value['owner'] !== false || !Array.isArray(grants) || !grants.every(isGrant)) {
    throw new TypeError('remote access: the injected access snapshot carries malformed grants')
  }
  return { type: 'baseline', owner: false, grants }
}

function isGrant(value: unknown): value is RemoteAccessGrant {
  if (!isRecord(value) || !isResource(value['resource'])) return false
  const actions = value['actions']
  return Array.isArray(actions) && actions.every(action => typeof action === 'string')
}

function isResource(value: unknown): value is RemoteAccessResource {
  if (!isRecord(value) || typeof value['kind'] !== 'string') return false
  return value['kind'] === 'global' || typeof value['id'] === 'string'
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 一个 Client 代的快照持有者。源按 `(kind, id, action)` 缓存，
 * 使 Hook 绑定保持其身份；每个源都从当前快照计算其布尔值。
 */
export class ClientAccessState {
  private snapshot: AccessSnapshot = CLOSED

  /** @param initial - 页面注入的开场 baseline；没有它时每个回答均为 false，直到 baseline 到达。 */
  constructor(initial?: Baseline) {
    if (initial !== undefined) this.replace(initial)
  }
  private readonly listeners = new Set<() => void>()
  private readonly sources = new Map<string, HostObservable<boolean>>()

  /**
   * global 资源上一个动作的回答。
   * @param action - 调用方可发起的端点动作。
   * @returns 身份稳定的布尔源。
   */
  global(action: string): HostObservable<boolean> {
    return this.cached(GLOBAL_KEY, '', action)
  }

  /**
   * 一个已声明种类的资源上一个动作的回答。
   * @param kind - 已声明的资源种类。
   * @param id - 资源身份。
   * @param action - 调用方可发起的端点动作。
   * @returns 身份稳定的布尔源。
   */
  resource(kind: string, id: string, action: string): HostObservable<boolean> {
    return this.cached(kind, id, action)
  }

  /**
   * 以一代的开场帧替换快照。
   * @param frame - owner 或非 owner 的 baseline。
   */
  replace(frame: Baseline): void {
    if (frame.owner) {
      this.publish(OWNER_SNAPSHOT)
      return
    }
    let global: ReadonlySet<string> = new Set()
    const resources = new Map<string, Map<string, ReadonlySet<string>>>()
    // baseline 尚未发布，因此其映射就地填充。
    for (const { resource, actions } of frame.grants) {
      if (resource.kind === 'global') {
        global = new Set(actions)
        continue
      }
      let grants = resources.get(resource.kind)
      if (grants === undefined) {
        grants = new Map()
        resources.set(resource.kind, grants)
      }
      grants.set(resource.id, new Set(actions))
    }
    this.publish({ kind: 'granted', global, resources })
  }

  /**
   * 应用当前代的一个增量。
   * @param frame - `upsert` 或 `remove`。
   */
  update(frame: Exclude<RemoteAccessFrame, { type: 'baseline' }>): void {
    const current = this.snapshot
    if (current.kind !== 'granted') return
    switch (frame.type) {
      case 'upsert':
        this.publish(withGrant(current, frame.grant))
        return
      case 'remove':
        this.publish(withGrant(current, { resource: frame.resource, actions: [] }, true))
        return
      /* v8 ignore next -- the generated Remote codec validates this closed union. */
      default:
        return assertNever(frame)
    }
  }

  /** 当前快照是否为 owner 的快照，其回答从不依赖流。 */
  get owner(): boolean {
    return this.snapshot.kind === 'owner'
  }

  /** 流已终态失败：owner 保留每个回答；非 owner 的回答变为 false。 */
  unavailable(): void {
    if (this.snapshot.kind !== 'owner') this.publish(CLOSED)
  }

  private cached(kind: string, id: string, action: string): HostObservable<boolean> {
    const key = `${kind}\u0000${id}\u0000${action}`
    let source = this.sources.get(key)
    if (source === undefined) {
      source = {
        getSnapshot: () => answer(this.snapshot, kind, id, action),
        subscribe: (listener) => {
          this.listeners.add(listener)
          return () => { this.listeners.delete(listener) }
        },
      }
      this.sources.set(key, source)
    }
    return source
  }

  private publish(next: AccessSnapshot): void {
    this.snapshot = next
    for (const listener of [...this.listeners]) listener()
  }
}

function answer(snapshot: AccessSnapshot, kind: string, id: string, action: string): boolean {
  switch (snapshot.kind) {
    case 'closed':
      return false
    case 'owner':
      return true
    case 'granted': {
      const allowed = kind === GLOBAL_KEY ? snapshot.global : snapshot.resources.get(kind)?.get(id)
      return allowed?.has(action) ?? false
    }
    /* v8 ignore next -- closed union. */
    default:
      return assertNever(snapshot)
  }
}

function withGrant(snapshot: GrantedSnapshot, grant: RemoteAccessGrant, remove = false): GrantedSnapshot {
  const resource = grant.resource
  if (resource.kind === 'global') return { ...snapshot, global: new Set(grant.actions) }
  const resources = new Map(snapshot.resources)
  const grants = new Map(resources.get(resource.kind))
  if (remove) grants.delete(resource.id)
  else grants.set(resource.id, new Set(grant.actions))
  resources.set(resource.kind, grants)
  return { ...snapshot, resources }
}

/* v8 ignore next 3 -- closed-union backstop. */
function assertNever(value: never): never {
  throw new Error(`unreachable access frame: ${JSON.stringify(value)}`)
}
