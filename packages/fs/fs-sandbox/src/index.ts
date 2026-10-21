/**
 * `SandboxedFileSystem`：`@deepseek-ai/dsh-fs` 服务定义中强制实施沙箱的实现。它继承
 * `LocalFileSystem`，因此所有文本存储机制 —— resolve、stat、读取/流式读取、列举、原子写入
 * 以及"读-匹配-写"的编辑临界区 —— 都逐字沿用本地实现；本包只在这两处修改操作上额外加上
 * 按次调用的**策略**围栏。读取原样穿透：所有模式都允许读取。
 *
 * 这道围栏是**受信任代码**对**模型可控路径**做的策略检查，**不是**内核边界 —— 这些操作本身
 * 属于该接缝自己的（open、rename），只有目标路径不可信，因此"先规范化再判定包含"就是这一面
 * 的完整答案。这是包含性约束，而非安全边界；对不可信**代码**做内核级隔离仍然是 `ctx.shell`
 * 的职责（`@deepseek-ai/dsh-bash-sandbox`）。残存的 TOCTOU（祖先符号链接在包含性复检与系统
 * 调用之间被替换）通过在委托之前立刻重新规范化来收窄，并在该威胁模型下被接受。
 *
 * 按次调用的策略：`read-only` 拒绝一切修改；`workspace-write` 仅当目标规范化后位于策略的
 * 工作区根目录或共享 `writableRoots` 策略给出的平台临时目录之下时才允许修改；
 * `danger-full-access` 不加围栏地委托。被拒绝时抛出结构化的 `FS_SANDBOX_DENIED`。
 *
 * @module @deepseek-ai/dsh-fs-sandbox
 */

import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import type { Config as LocalConfig } from '@deepseek-ai/dsh-fs-local'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsEditOutcome, FsEditRequest, FsTarget, FsVersion, FsWriteIntent, FsWriteOutcome } from '@deepseek-ai/dsh-fs'
import { writableRoots } from '@deepseek-ai/dsh-sandbox'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { isPathUnder } from './containment.ts'

/**
 * 插件配置：逐字沿用本地后端的旋钮（`cwd` 解析默认值与 `diffBasisMaxBytes`
 * 覆盖展示上限）。沙箱默认值（模式 + `workspace-write` 回退根目录）**不在**这里 ——
 * `ctx.sandboxPolicy` 会为每个强制实施该能力的调用会话解析出策略。
 */
export type Config = LocalConfig

/**
 * 强制实施沙箱的文件系统后端。注册为 `ctx.fs`（加载它而非 `dsh-fs-local`，并配合一个
 * `ctx.sandboxPolicy`，就是全部切换动作 —— 面向模型的工具无需改动）。其已配置的默认模式
 * 就是 {@link sandboxMode} 暴露的能力事实；`dsh-tool-fs` 为每次修改把各会话的模式与 cwd
 * 解析成策略，而一次获批的提级则可能为单次调用打上一个严格更宽的模式。
 */
export class SandboxedFileSystem extends LocalFileSystem {
  static inject = ['sandboxPolicy']

  private readonly defaultMode: SandboxMode
  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    this.defaultMode = ctx.sandboxPolicy.defaultMode
  }

  /** 部署的默认模式 —— 工具层读取它来宣示提级能力。 */
  override get sandboxMode(): SandboxMode {
    return this.defaultMode
  }

  /**
   * 先按按次调用的策略围栏本次写入，再委托给继承来的原子写入。另见 {@link checkedTarget}。
   * @param target - 待写入的已解析目标。
   * @param content - 文件的全新完整内容。
   * @param expected - 守卫本次写入的写入意图；省略表示无条件写入。
   * @param signal - 在原子发布生效之前中断本次写入。
   * @param sandboxPolicy - 按次调用的模式与工作区根目录；省略则使用部署回退值。
   * @returns 继承自后端的写入结果。
   */
  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    return super.writeText(await this.checkedTarget(target, sandboxPolicy), content, expected, signal)
  }

  /**
   * 先按按次调用的策略围栏本次编辑，再委托给继承来的原子编辑。另见 {@link checkedTarget}。
   * @param target - 待编辑的已解析目标。
   * @param edit - 字面量的查找/替换请求。
   * @param expected - 版本守卫；省略表示无条件编辑。
   * @param signal - 在原子发布生效之前中断本次编辑。
   * @param sandboxPolicy - 按次调用的模式与工作区根目录；省略则使用部署回退值。
   * @returns 继承自后端的编辑结果。
   */
  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    return super.editText(await this.checkedTarget(target, sandboxPolicy), edit, expected, signal)
  }

  /**
   * 对 `target` 强制执行按次调用的策略，并返回本次修改必须使用的**那个**精确目标，
   * 使被检查的同一性正是被修改的同一性（不存在"在此检查、在彼写入"的 TOCTOU）。
   * `read-only` 直接拒绝；`workspace-write` **此刻**重新规范化（`resolve` 会对最深的已存在
   * 祖先做 realpath，反映并发替换掉的符号链接），要求其被包含在某个可写根之下，并返回
   * **那个**新鲜的目标；`danger-full-access` 原样返回调用方的目标，不加围栏。
   * 拒绝时抛出结构化的 `FS_SANDBOX_DENIED` —— 工具层把它映射为面向模型的 `[sandbox: …]`
   * 标记与提级提示。
   */
  private async checkedTarget(target: FsTarget, sandboxPolicy?: SandboxExecutionPolicy): Promise<FsTarget> {
    const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()
    const { mode } = policy
    if (mode === 'danger-full-access') return target
    if (mode === 'read-only') {
      throw new FsError(`cannot write "${target.displayPath}": file access denied under read-only mode`, 'FS_SANDBOX_DENIED')
    }
    // workspace-write：在**新鲜**的规范路径上做包含性判定（可以捕捉到工具解析该目标之后
    // 被替换掉的符号链接祖先），并且修改以**这个**新鲜目标委托下去 —— 绝不使用过期的那个。
    const fresh = await this.resolve(target.displayPath)
    let contained = false
    for (const root of writableRoots(policy)) {
      if (await isPathUnder(fresh.targetKey, root)) {
        contained = true
        break
      }
    }
    if (!contained) {
      throw new FsError(`cannot write "${target.displayPath}": file access denied under workspace-write mode`, 'FS_SANDBOX_DENIED')
    }
    return fresh
  }
}

export default SandboxedFileSystem
