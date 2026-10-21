/**
 * 文件系统服务定义（`ctx.fs`）的词汇表：不透明的目标/版本标识、`stat` 返回的元数据、
 * 写入意图与结果形状、字面量编辑的请求/结果，以及类型化的错误分类。
 * @module @deepseek-ai/dsh-fs/types
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { Branded } from '@deepseek-ai/dsh-brand'

/**
 * 用于过期守卫与目标查找的不透明键。本地后端使用形如 realpath 的字符串；远端后端可能
 * 使用工作区 URI 或文件 id。消费方**不得**解析它，也不得假定它是本地绝对路径。
 */
export type FsTargetKey = Branded<'FsTargetKey'>

/**
 * 把一个字符串标记为 {@link FsTargetKey}。仅供后端使用 —— 消费方从不自行生成键，
 * 而是从 `resolve()` 获取。
 * @param key - 后端的原始键字符串（本地后端传入 realpath）。
 * @returns 同一个字符串，带上标记；不做任何校验。
 */
export function FsTargetKey(key: string): FsTargetKey {
  return key as FsTargetKey
}

/**
 * 不透明的文件版本令牌 —— 写入/编辑所守卫的新鲜度令牌。本地后端从高分辨率的 stat 同一性
 * 与新鲜度字段派生它；远端后端可能使用修订 id。策略层记录它用于过期检查；消费方可以展示
 * 相关元数据，但**不得**解释这个令牌。
 */
export type FsVersion = Branded<'FsVersion'>

/**
 * 把一个字符串标记为 {@link FsVersion}。仅供后端使用 —— 消费方从不自行生成版本，
 * 而是从 `stat`/写入/编辑的结果获取。
 * @param v - 后端的原始版本字符串。
 * @returns 同一个字符串，带上标记；不做任何校验。
 */
export function FsVersion(v: string): FsVersion {
  return v as FsVersion
}

/**
 * 对某个目标的一次权威观测。存在的观测携带受守卫替换所用的版本；不存在的观测只授权
 * 受守卫的创建，绝不授权编辑。
 */
export type FsObservation =
  | { readonly kind: 'present'; readonly version: FsVersion }
  | { readonly kind: 'absent' }

/**
 * 由后端解析为稳定标识的路径。`resolve()` 产出它；其余所有操作都以它为入参。
 */
export interface FsTarget {
  /** 用于过期守卫与目标查找的不透明键。 */
  targetKey: FsTargetKey
  /**
   * 面向模型/UI 输出的路径。依后端不同，可以是本地绝对路径、工作区相对路径或远端 URI。
   */
  displayPath: string
}

/**
 * 目标的元数据 —— 即 {@link FileSystem.stat} 的返回值。让策略层在读取之前就能先拒绝目录
 * 与特殊文件，并依据 `size` 选择 `readText` 还是 `streamText`，而不必靠失败来试探。
 * `version` 是新鲜度令牌。`stat` 返回 `undefined` 表示目标不存在。
 */
export interface FsInfo {
  /** 目标此刻的不透明新鲜度令牌。 */
  version: FsVersion
  /** 目标是常规文件、目录还是其他类型。 */
  type: 'file' | 'directory' | 'other'
  /** 常规文件的字节大小，在后端能够上报时给出。 */
  size?: number
}

/**
 * 当最后一个路径分量是符号链接时，不跟随该分量的路径元数据。与 {@link FsInfo} 不同，
 * 这个路径级探测可以报出 `symlink`，使带有信任边界规则的消费方能在解析出目标之前就
 * 拒绝仓库自有的链接。
 */
export interface FsPathInfo {
  /** 路径条目此刻的不透明新鲜度令牌。 */
  version: FsVersion
  /** 路径条目是常规文件、目录、符号链接还是其他类型。 */
  type: 'file' | 'directory' | 'symlink' | 'other'
  /** 路径条目的字节大小，在后端能够上报时给出。 */
  size?: number
}

/**
 * {@link FileSystem.listDir} 返回的一个直接子项。列举只返回元数据与已解析的目标，
 * 且不得读取文件内容。
 */
export interface FsDirEntry {
  /** 子项在被列举目录内的基名。 */
  name: string
  /** 子项是常规文件、目录还是其他类型。 */
  type: 'file' | 'directory' | 'other'
  /** 供后续操作使用的已解析子目标。 */
  target: FsTarget
  /** 当后端能廉价地给出元数据时的不透明新鲜度令牌。 */
  version?: FsVersion
  /** 常规文件的字节大小，在后端能够上报时给出。 */
  size?: number
}

/**
 * 受守卫的写入意图。`createIfAbsent` 遇到已存在的目标以 `FS_NOT_OBSERVED` 拒绝；
 * `replaceIfVersion` 遇到不存在或版本不匹配以 `FS_STALE_VERSION` 拒绝。在 `writeText`
 * 中省略意图表示无条件的创建或覆盖，而不是联合类型的第三个分支。
 */
export type FsWriteIntent =
  | { kind: 'createIfAbsent' }
  | { kind: 'replaceIfVersion'; version: FsVersion }

/** 整文件写入的结果。 */
export interface FsWriteOutcome {
  /** 本次写入是新建文件还是替换已有文件。 */
  operation: 'create' | 'update'
  /** 写入后文件的不透明版本。 */
  version: FsVersion
  /**
   * 写入**之前**的文件内容；当文件原本不存在（即创建）或后端拒绝给出上下文基线时为
   * `null`（例如此前的二进制/非 UTF-8 文件，或待比较的两侧任一侧达到其排他上限）。
   * 这是 LF 规范化的存储文本（即 diff 基线），绝不是 diff —— 当 `before` 存在时，
   * 消费方依据 `before`/`after` 计算结果时刻的上下文 diff，否则退化为整文件 diff。
   */
  before: string | null
  /** 写入**之后**的文件内容，已做 LF 规范化，以便与 `before` 共享同一 diff 基线。 */
  after: string
}

/** 一次字面量替换的编辑请求。 */
export interface FsEditRequest {
  /** 待替换的非空字面量文本。必须精确匹配（在行尾规范化之后）。 */
  oldString: string
  /** 字面的替换文本。为空字符串表示删除命中的文本。 */
  newString: string
  /** 替换所有命中项，而不是要求恰好命中一处。 */
  replaceAll: boolean
}

/** 字面量编辑的结果。 */
export interface FsEditOutcome {
  /** 编辑后文件的不透明版本。 */
  version: FsVersion
  /**
   * 编辑**之前**的文件内容。这是原始存储文本（由后端做 LF 规范化），绝不是 diff ——
   * 消费方依据 `before`/`after` 计算结果时刻的上下文 diff（带上下文的已应用补丁块）。
   */
  before: string
  /** 编辑**之后**的文件内容。 */
  after: string
}

/**
 * 稳定、可被机器路由的文件系统失败码。由 {@link FsError} 携带；工具注册表在 `isError`
 * 结果上暴露 `{ name, code }`，使重试/权限/UI 层无需解析消息文本即可分支处理。
 */
export type FsErrorCode =
  | 'FS_NOT_FOUND'
  | 'FS_NOT_DIRECTORY'
  | 'FS_NOT_TEXT'
  | 'FS_NOT_REGULAR_FILE'
  | 'FS_TOO_LARGE'
  | 'FS_PERMISSION_DENIED'
  | 'FS_SANDBOX_DENIED'
  | 'FS_IO_ERROR'
  | 'FS_STALE_VERSION'
  | 'FS_NOT_OBSERVED'
  | 'FS_AMBIGUOUS_EDIT'
  | 'FS_EDIT_NOT_FOUND'
  | 'FS_ABORTED'

/**
 * 类型化的文件系统错误。继承 {@link HarnessError}，因此带有稳定的 {@link FsErrorCode}
 * 并串联 `cause`。这套词汇由 `dsh-fs` 持有，使后端与策略层抛出相同的错误码，
 * 而不是各自编造消息字符串。
 */
export class FsError extends HarnessError {
  override readonly code: FsErrorCode

  constructor(message: string, code: FsErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.code = code
  }
}
