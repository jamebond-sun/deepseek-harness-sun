/**
 * `LocalSpillStore`：`@deepseek-ai/dsh-spill` 存储接缝的宿主文件系统实现。
 * 把超大文本持久化到一个私有的、会话作用域的文件（防穿越的命名与独占的
 * 仅属主写入见 `./store.ts`），并返回一个路径定位信息加本地读取/grep 的
 * 取回指引。激活之后它会执行一次尽力而为的启动清理，回收
 * 超过 `cleanupPeriodDays` 的溢出文件。
 *
 * @module @deepseek-ai/dsh-spill-local
 */

import { Context } from '@deepseek-ai/cordis'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import z from '@deepseek-ai/schemastery'
import { SpillLocator, SpillStore } from '@deepseek-ai/dsh-spill'
import type { SaveTextSpill, SpillRef } from '@deepseek-ai/dsh-spill'
import { gatherSweepRoots, sweepSpillRoots } from './cleanup.ts'
import type { SweepRoot, WarnFn } from './cleanup.ts'
import { privateRoot, saveTextFile } from './store.ts'

export { discoverDefaultRoots, sweepSpillRoots } from './cleanup.ts'
export type { SweepOptions, SweepRoot, WarnFn } from './cleanup.ts'
export { DEFAULT_ROOT_PREFIX, encodeSegment, isErrno, privateRoot, saveTextFile, sessionDir } from './store.ts'
export type { SavedText, SaveTextOptions } from './store.ts'

/** 一天的毫秒数 —— 用于把 `cleanupPeriodDays` 配置换算成清理截止时间。 */
const MS_PER_DAY = 24 * 60 * 60 * 1000

/** 插件配置（全部可选 —— 默认值由 `static Config` 提供）。 */
export interface Config {
  /**
   * 溢出文件的根目录。省略时使用一个惰性创建的、位于 OS 临时目录下的
   * 私有（0700）每进程目录 —— 这对本地部署是安全的默认选择。
   * 显式设置它可以把溢出文件放到已知位置。
   */
  root?: string
  /**
   * 溢出文件在多少天后可被一次性启动清理回收。默认 `30`；`0` 表示
   * 完全禁用清理。`mtime` 严格早于截止时间的文件会被删除，空目录会被
   * 剪除；新文件、符号链接与无关条目保持不动。在 POSIX 上，清理会跳过
   * 那些可能被其他本地用户修改或替换的根目录与会话目录。
   * 保留是有意为之 —— 恢复或 fork 出来的会话在其过期之前可能仍在
   * 引用一个较旧的定位信息。
   */
  cleanupPeriodDays?: number
}

/** schemastery 应用默认值之后的形状。 */
type ResolvedConfig = Required<Omit<Config, 'root'>> & Pick<Config, 'root'>

/**
 * 本地文件系统溢出后端。文件落在 `<root>/session-<hash>/…` 之下，
 * 名称不可预测，写入是独占且仅属主可见（0600）的，根目录本身私有（0700）——
 * 一个被溢出的工具结果既不能被其他本地用户读取，也不能被预置的符号链接
 * 重定向。
 *
 * 激活之后它启动一次尽力而为的清理（见 {@link cleanupPeriodDays}），回收
 * 过期溢出文件而不延迟服务可用性；该清理归插件 fiber 所有，并在 dispose
 * 时被 await，因此一次 fiber 卸载绝不会在它静默之前返回。
 */
export class LocalSpillStore extends SpillStore {
  static Config: z<Config> = z.object({
    root: z.string(),
    cleanupPeriodDays: z.number().step(1).min(0).default(30),
  })

  /** 已解析的绝对溢出根目录（配置 `root`，否则为私有默认目录），在构造时固定。 */
  readonly root: string

  /** 已校验的配置（构造前 schemastery 已应用 `cleanupPeriodDays` 默认值）。 */
  readonly config: ResolvedConfig

  /**
   * 进行中（或已完成）的启动清理。保留它以便 dispose 时 await；
   * 当清理被禁用（`cleanupPeriodDays === 0`）时为 `undefined`。
   */
  private cleanup: Promise<void> | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx)
    // schemastery（static Config）已经填好 `cleanupPeriodDays`；这里的
    // 类型断言只是为 exactOptionalPropertyTypes 记录这一运行时事实。
    this.config = config as ResolvedConfig
    this.root = config.root !== undefined ? resolve(config.root) : privateRoot()

    // 一次尽力而为的启动清理，归 fiber 所有。生成器体在激活时运行，但并不
    // await 这次清理 —— 它启动清理，然后 yield 一个 await 同一个 promise 的
    // 异步 disposer，因此服务可用性绝不被延迟，同时一次 fiber 卸载又能达到
    // 静默状态（不会有清理 I/O 活过该 fiber）。禁用时（`cleanupPeriodDays === 0`）
    // 则 yield 一个空操作 disposer。
    ctx.effect(function* (this: LocalSpillStore) {
      if (this.config.cleanupPeriodDays > 0) {
        const warn: WarnFn = (message) => { this.ctx.logger.warn(message) }
        this.cleanup = this.runCleanup(warn)
      }
      yield async () => { await this.cleanup }
    }.bind(this), 'spill-local cleanup sweep')
  }

  /**
   * 执行一次性清理：收集待清理的根目录（见 {@link gatherRoots}），
   * 然后按时间截止点清理全部根目录。尽力而为 ——
   * {@link sweepSpillRoots} 会消化所有文件系统故障，因此这里绝不会拒绝，
   * 也不可能让激活或一次并发的溢出写入失败。
   *
   * @param warn - 已消化的文件系统故障的上报出口。
   * @returns 清理完成时 resolve（绝不拒绝）。
   */
  private async runCleanup(warn: WarnFn): Promise<void> {
    const cutoffMs = Date.now() - this.config.cleanupPeriodDays * MS_PER_DAY
    const roots = await this.gatherRoots(warn)
    await sweepSpillRoots({ roots, cutoffMs, warn })
  }

  /**
   * 启动清理覆盖的根目录：每一个被发现的既往默认 `dsh-spill-*` 临时根目录
   * （见 {@link discoverDefaultRoots}），清空后会被剪除；再加上当前/配置的
   * 根目录 —— 只要活着的进程仍可能往里写，它自身绝不会被剪除。
   * 每个根目录下的空会话目录都会被剪除。文件系统身份会在当前根目录
   * 覆盖掉匹配的已发现项、把它标记为不可剪除之前，先对别名去重。
   * 测试会覆写它以注入一组隔离的根目录 —— 并且，作为清理唯一的异步
   * 收集点，还能在 dispose 期间把清理挂起以检查静默性；它是测试接缝，
   * 不是部署开关。
   *
   * @param warn - 已消化的发现故障的上报出口。
   * @returns 待清理的根目录，每个都带有"清空后剪除"标记。
   */
  protected async gatherRoots(warn: WarnFn): Promise<SweepRoot[]> {
    return gatherSweepRoots(this.root, warn, this.defaultRootsBase())
  }

  /**
   * 扫描既往默认 `dsh-spill-*` 根目录的目录 —— 即 OS 临时目录，
   * {@link privateRoot} 在那里创建它们（累积只发生在那里）。
   * 测试会覆写它，把发现指向一个隔离的 fixture 而不是真实的 tmpdir；
   * 它是测试接缝，不是部署开关。
   *
   * @returns 扫描默认溢出根目录的基础目录。
   */
  protected defaultRootsBase(): string {
    return tmpdir()
  }

  async saveText(input: SaveTextSpill): Promise<SpillRef> {
    const saved = await saveTextFile({
      root: this.root,
      sessionId: input.owner.sessionId,
      suggestedName: input.suggestedName,
      content: input.content,
    })
    return {
      locator: SpillLocator(saved.path),
      bytes: saved.bytes,
      retrievalHint: 'Use read with offset/limit, or grep this path to search within it.',
    }
  }
}

export default LocalSpillStore
