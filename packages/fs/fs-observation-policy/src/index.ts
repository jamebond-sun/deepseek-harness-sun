/**
 * 纯事件的文件系统观测策略；它不注册任何服务。一个弱引用的 owner/target 映射记录每一次
 * 权威的存在/不存在观测，单槽的意图监听器基于该状态派生守卫，而新鲜度/防覆盖的原子校验
 * 由提供者完成。没有这个插件时，工具保留裸提供者的无条件修改行为。组合规则见包内 README。
 * @module @deepseek-ai/dsh-fs-observation-policy
 */

import type { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsObservation, FsTarget, FsVersion, FsWriteIntent } from '@deepseek-ai/dsh-fs'
import type { FsObservationActor } from './types.ts'

export type { FsObservationActor } from './types.ts'

/**
 * 按上下文保存的已观测文件状态，以及建立在其上的三个 `fs/*` 决策。
 * 每次 `apply()` 创建一个实例，以便在销毁时为 HMR 丢弃全部状态。
 */
class ObservedStateGate {
  /**
   * 已观测文件的状态：先按 owner 对象索引（弱引用持有，因此被回收的会话会释放其状态），
   * 再按 {@link FsTarget.targetKey} 索引。条目的存在本身就是先前的观测记录；
   * 其判别字段把"已确认不存在"与"从未见过"区分开来。
   */
  private observed = new WeakMap<object, Map<string, FsObservation>>()

  /**
   * 从不透明的事件 actor 派生已观测状态的 owner —— 通常是当前活跃的 agent 会话。
   * 当无法派生出 owner 时为 `undefined`（例如没有 agent 的直接工具调用）；这类调用可以自由
   * 读取，但无法满足写入/编辑的"先观测"策略。
   */
  private owner(actor: object | undefined): object | undefined {
    // tsgolint 认为 object 可以赋给弱类型 FsObservationActor，而 tsc 为了访问属性仍要求这个结构化断言。
    // 参见 .agents/notes/archived/process/2026-07-29-oxlint-linter.md 中关于分析器分歧的结论。
    // oxlint-disable-next-line typescript/no-unnecessary-type-assertion -- 两个分析器对这个弱类型的判断不一致。
    return (actor as FsObservationActor | undefined)?.agent?.session
  }

  private get(owner: object, targetKey: string): FsObservation | undefined {
    return this.observed.get(owner)?.get(targetKey)
  }

  private set(owner: object, targetKey: string, observation: FsObservation): void {
    let byTarget = this.observed.get(owner)
    if (!byTarget) {
      byTarget = new Map()
      this.observed.set(owner, byTarget)
    }
    byTarget.set(targetKey, observation)
  }

  /** 丢弃所有已记录的状态（HMR 安全 / 销毁）。 */
  clear(): void {
    this.observed = new WeakMap()
  }

  /**
   * 决定写入意图：从未见过或已确认不存在 ⇒ `createIfAbsent`；
   * 已确认存在 ⇒ 以观测到的版本执行 `replaceIfVersion`。
   */
  writeIntent(target: FsTarget, actor: object | undefined): FsWriteIntent {
    const owner = this.owner(actor)
    const prior = owner ? this.get(owner, target.targetKey) : undefined
    return prior?.kind === 'present'
      ? { kind: 'replaceIfVersion', version: prior.version }
      : { kind: 'createIfAbsent' }
  }

  /**
   * 决定编辑的版本守卫：从未见过以 `FS_NOT_OBSERVED` 拒绝，已确认不存在以
   * `FS_NOT_FOUND` 拒绝，存在则提供观测到的版本作为 CAS 基线。
   */
  editIntent(target: FsTarget, actor: object | undefined): { version: FsVersion } {
    const owner = this.owner(actor)
    const prior = owner ? this.get(owner, target.targetKey) : undefined
    if (!owner || prior === undefined) {
      throw new FsError(`edit requires reading "${target.displayPath}" first`, 'FS_NOT_OBSERVED')
    }
    if (prior.kind === 'absent') {
      throw new FsError(`cannot edit "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    }
    return { version: prior.version }
  }

  /** 为该 owner 与目标记录一次权威的存在或不存在观测。 */
  observe(target: FsTarget, observation: FsObservation, actor: object | undefined): void {
    const owner = this.owner(actor)
    if (owner) this.set(owner, target.targetKey, observation)
  }
}

/** 供加载器诊断使用的 Cordis 插件名。 */
export const name = 'fs-observation-policy'

/**
 * 注册三个 `fs/*` 监听器。没有 `inject` —— 该插件不读取任何服务，只操作自己的
 * `WeakMap`。这些 waterfall 是未绑定的（工具在派发时不带 `this`），
 * 因此监听器接收原始的 `(target, actor, next)` 参数。
 */
export function apply(ctx: Context): void {
  const gate = new ObservedStateGate()

  ctx.effect(() => () => {
    // 销毁时丢弃所有已记录的状态，使重载后的插件从一个干净状态开始（HMR 安全）。
    // WeakMap 自身也会被 GC，但替换掉它可以让释放对测试而言可观测且即时。
    gate.clear()
  }, 'fs-observation-policy observed-state teardown')

  // fs/write-intent：占据唯一的决策槽 —— **不要**调用 next()。
  // 通过 Promise.resolve().then 延迟执行，使声明的 Promise 返回类型成立
  // （抛出的错误变成 reject，绝不同步逃逸出 waterfall）。
  ctx.on('fs/write-intent', (target, actor) => Promise.resolve().then(() => gate.writeIntent(target, actor)))

  // fs/edit-intent：占据唯一的决策槽 —— 不要调用 next()。
  ctx.on('fs/edit-intent', (target, actor) => Promise.resolve().then(() => gate.editIntent(target, actor)))

  // fs/observed 必须保持同步且不抛错：emit 不会等待 promise，
  // 而成功的修改已经提交。对存在与不存在两种情况，WeakMap.set 都满足该契约。
  ctx.on('fs/observed', (target, observation, actor) => {
    gate.observe(target, observation, actor)
  })
}
