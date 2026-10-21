/**
 * 客户端安全的任务词汇：一个任务的只读投影，以及它的输出环形缓冲区交出的块。这个叶子
 * 模块不触达任何 Host 包，因此浏览器程序与 Remote 传输类型可以导入它，而不会牵出注册表
 * 的 Host 声明合并。
 * @module @deepseek-ai/dsh-jobs/view
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
// 仅类型：Workspace 注册表的归档准入族映射，本 seam 把 `job` 合并进去。
import type {} from '@deepseek-ai/dsh-workspace/types'
import type { JobId } from './brand.ts'

/**
 * 任务生命周期：`running`、可选的 `stopping`，然后恰好一个终态。生产者特有的事实
 * 放在 {@link JobView.progress} 与 {@link JobView.detail} 里。
 */
export type JobStatus = 'running' | 'stopping' | 'completed' | 'killed' | 'failed'

declare module '@deepseek-ai/dsh-workspace/types' {
  interface SessionActivityKindMap {
    /** 本会话拥有的一个后台任务正在运行或 stopping。 */
    job: true
  }
}

/**
 * 生产者定义的任务类型。插件通过声明合并扩展这个映射；注册表把每个值都当作
 * 不透明的 id 命名空间。
 */
export interface JobKindMap {
  bash: 'bash'
}

/** 已注册生产者类型名的、可合并扩展的联合类型。 */
export type JobKind = JobKindMap[keyof JobKindMap]

/**
 * 一个输出块的流标签。`stdout` 与 `stderr` 会进入模型的消费型读取；`log` 标记只有观察者
 * 才看得到的生产者叙述（一个 workflow 的阶段行）。消费者把无法识别的标签当作没有标签。
 */
export type JobChannel = 'stdout' | 'stderr' | 'log'

/** 一个任务输出环形缓冲区中的一块：绝对偏移、文本、通道与丢失标记。 */
export interface JobChunk {
  /** 该块第一个字节的绝对偏移；偏移一旦分配就不再移动。 */
  readonly at: number
  /** 与追加时完全一致的块文本（可能因保留策略被裁掉尾部）。 */
  readonly text: string
  /** 生产者提供时的流标签。 */
  readonly channel?: JobChannel
  /** 紧邻该块之前的字节已丢失，或在生产者侧丢失，或被保留策略丢弃。 */
  readonly gapBefore?: true
}

/**
 * 一个任务的只读投影——每次调用都产生一个新对象，绝不是注册表的活状态。模型工具、
 * 浏览器侧的名册以及观察流都消费这一种形状。
 */
export interface JobView {
  /** 注册表签发的 id（`<kind>-<short-uuid>`）。 */
  readonly id: JobId
  /**
   * 任务注册时所用的生产者类型：一个 Host 注册过的 `JobKind`，以开放字符串的形式承载，
   * 因为浏览器包或 Remote 编解码器只能看到它自己程序编译进来的那些 `JobKindMap` 合并。
   */
  readonly kind: string
  /** 生产者提供的一行标签。 */
  readonly label: string
  /** 所属会话；无主任务没有，而每个调用方都能看到无主任务。 */
  readonly owner?: SessionId
  /** 生产者自有的、对完整面向模型通知与读取的上限，单位 UTF-8 字节。 */
  readonly outputLimitBytes?: number
  /** 当前生命周期状态。 */
  readonly status: JobStatus
  /** 生产者的实时进度行（`3/10`、当前阶段）；结算时清空。 */
  readonly progress?: string
  /** 终态原因（`exit code: 3`）；已记录的 kill 原因会并入。 */
  readonly detail?: string
  /** 任务注册时的纪元毫秒。 */
  readonly startedAt: number
  /** 任务结算时的纪元毫秒；在世时没有。 */
  readonly finishedAt?: number
  /**
   * 输出环形缓冲区的绝对坐标，以及其背后的完整流文件。`total` 是下一个块起始的偏移
   * （什么都没写入时为 0）；`earliest` 是最老的保留字节，恰好在保留策略丢掉头部时大于 0。
   * `spillPaths` 按源顺序列出该任务的拉取源当前保存的溢出文件并去重，在没有任何源保存
   * 文件时不存在：它比任何块都活得久，因此游标低于 `earliest` 的读取者仍能说出字节去了哪里。
   */
  readonly output: { readonly total: number; readonly earliest: number; readonly spillPaths?: readonly string[] }
}
