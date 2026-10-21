/**
 * 溢出（spill）存储能力接缝（`ctx.spillStore`）的服务定义（Service Definition）：一个抽象服务，定义溢出后端
 * 做什么 —— 持久化超大文本并返回面向模型的定位信息加取回指引 —— 而不规定怎么做。
 * 实现类继承 {@link SpillStore} 并注册为 `spillStore` 服务；
 * `@deepseek-ai/dsh-spill-local`（宿主文件系统）是第一个实现。
 *
 * 该服务定义刻意保持最小：只有 `saveText`，别无其他。它不拥有
 * 保留策略（那是 `@deepseek-ai/dsh-output-retention`）、不拥有工具结果
 * 替换（那是 `@deepseek-ai/dsh-spill-policy`）、也没有取回或
 * 搜索 API。后端自行提供适配其存储介质的定位信息与取回提示。
 *
 * @module @deepseek-ai/dsh-spill
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { SaveTextSpill, SpillRef } from './types.ts'

export { SpillLocator } from './types.ts'
export type { SaveTextSpill, SpillOwner, SpillRef, SpillSource } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    spillStore: SpillStore
  }
}

/**
 * 抽象溢出存储服务。继承它、实现 {@link saveText}，并把子类作为插件加载 ——
 * 它会注册为 `ctx.spillStore`（每个上下文只有一个实现；加载第二个会抛错，
 * 这是 cordis 标准的重复服务行为）。
 *
 * 每个实现都必须遵守的语义：
 * - {@link saveText} 逐字持久化完整的 `content`，并返回一个不透明的
 *   定位信息、精确的字节长度，以及面向模型的取回指引。
 * - 存储按请求的 {@link SaveTextSpill.owner} 会话划分命名空间；后端选择一个
 *   私有（非全局可读）位置，以及一个由调用方 `suggestedName` 派生、
 *   但绝不与之相同的无冲突名称。
 * - `saveText` 在发生真实存储故障（权限、ENOSPC、后端不可用）时拒绝；
 *   如何降级由调用方决定（溢出策略把拒绝当作尽力而为，并保留内联结果）。
 */
export abstract class SpillStore extends Service {
  constructor(ctx: Context) {
    super(ctx, 'spillStore')
  }

  /**
   * 把 `input.content` 持久化到会话作用域内的溢出产物。
   * @param input - 归属、调用方提供的来源字段、建议名称，以及要保存的完整文本。
   * @returns 已保存产物的 {@link SpillRef}；存储故障时拒绝。
   */
  abstract saveText(input: SaveTextSpill): Promise<SpillRef>
}

export default SpillStore
