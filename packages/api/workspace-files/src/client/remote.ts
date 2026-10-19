/**
 * 本包所调用的 Client Remote 部分：按名称引用生成的
 * `workspaceFiles` 方法，并按结构引用流监督器，使变更流与
 * 提供方能针对脚本化的接口进行测试。
 */
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
// 将生成的 `workspaceFiles` 命名空间合并进 Remote 接口面。
import type {} from '@deepseek-ai/dsh-api-workspace-files/remote'

/** 被监督流的一个条目；`accept` 将正在投递的生成标记为健康。 */
export interface SupervisedStreamItem<Item> {
  /** 解码后的帧。 */
  readonly value: Item
  /** 重置重连退避：该生成正在投递。 */
  accept(): void
}

/** 由 Remote 监督的可重连单消费方流。 */
export interface SupervisedStream<Item> extends AsyncIterable<SupervisedStreamItem<Item>> {
  /**
   * 彻底停止该流。
   * @returns 活动生成与消费方迭代器都关闭后兑现。
   */
  dispose(): Promise<void>
}

/** 一个被监督流需要其属主提供的内容。 */
export interface SupervisedStreamOptions<Item> {
  /** 诊断用属主名称。 */
  readonly name: string
  /** 打开一个物理生成；`signal` 中止它。 */
  readonly open: (signal: AbortSignal) => AsyncIterable<Item>
  /** 一个生成的正常结束所对应的错误；carrier 错误要求重开，其余均为终态。 */
  readonly ended: (accepted: boolean) => Error
}

/** 本包调用的 `workspaceFiles` 命名空间方法，与生成的 Remote 声明一致。 */
export type WorkspaceFilesNamespace = Pick<ClientRemote['workspaceFiles'], 'stat' | 'changes'>

/** 本包眼中的 Client Remote。 */
export interface WorkspaceFilesRemote {
  /**
   * 创建一个可重连流。
   * @param options - 打开器与结束分类。
   * @returns 被监督的流，迭代前不会启动。
   */
  $stream<Item>(options: SupervisedStreamOptions<Item>): SupervisedStream<Item>
  /** `workspaceFiles` 命名空间。 */
  readonly workspaceFiles: WorkspaceFilesNamespace
}
