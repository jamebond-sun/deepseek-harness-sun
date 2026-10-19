/**
 * `workspaceFiles` Remote 命名空间的 wire 类型。仅含类型：生成的
 * Remote client 消费本模块时不需要 Host 运行时代码。
 *
 * 两种路径词汇从这里输出，每个方法恰好只用其中一种：
 *
 * - `read`、`readBytes`、`stat` 与 `changes` 用文件在文件系统执行世界中的
 *   绝对路径命名文件，因为它们的消费方是 Client 资源系统，其
 *   `dsh-resource://file/session/<id>/<path>` 地址携带的就是同一路径。
 * - `list` 使用 workspace 路径——与其 `path` 参数接受的语法相同——
 *   因为它的消费方是一棵以 workspace 根为根的树。
 *
 * @module @deepseek-ai/dsh-api-workspace-files/types
 */

// 导入 protocol 模块，使本文件末尾的声明扩充其错误映射，
// 而不是定义一个无关的 ambient 模块。
import type {} from '@deepseek-ai/dsh-typert-protocol'

/** 一个 workspace 文件的身份与新鲜度，不含其内容。 */
export interface WorkspaceFileStat {
  /**
   * 文件在文件系统执行世界中的绝对路径，符号链接已解析：POSIX 上以
   * `/` 分隔，Windows 上为盘符根加平台分隔符。这是
   * `dsh-resource://file/absolute/…` 地址携带的内容，也是
   * `dsh-resource://file/session/<sessionId>/…` 地址中的
   * workspace 相对路径相对该 Session 根所解析出的目标。
   */
  readonly absolutePath: string
  /** stat 时不透明的新鲜度令牌；从不解析。 */
  readonly version: string
  /** 完整文件的字节大小，仅当后端报告时存在。 */
  readonly bytes?: number
}

/**
 * 一次 `read` 返回的行窗口。行号从 1 开始并以 `\n` 结尾；末尾的
 * `\n` 终止最后一行，而不是开启一个新的空行。
 */
export interface WorkspaceFileRange {
  /** 页的第一行。默认为 1。 */
  readonly offset?: number
  /** 页的最大行数。默认为配置的 `maxLines`，且不得超过它。 */
  readonly limit?: number
}

/** Client 读到的一页 workspace 文本文件。 */
export interface WorkspaceFileText extends WorkspaceFileStat {
  /** 页的第一行，与请求一致。 */
  readonly offset: number
  /**
   * 页内的行以 `\n` 连接，最后一行之后没有终止符。
   * 超过文件最后一行的页与只含一个空行的页均为空串；
   * 由 `lines` 区分二者。
   */
  readonly text: string
  /** 页含多少行；当 `offset` 越过文件最后一行时为 `0`。 */
  readonly lines: number
  /** 页是否包含文件的最后一行。 */
  readonly eof: boolean
}

/** 一次 `readBytes` 返回的字节窗口。偏移从 0 开始。 */
export interface WorkspaceByteRange {
  /** 窗口的首字节。默认为 0。 */
  readonly offset?: number
  /** 窗口的最大字节数。默认为配置的 `maxBytes`，且不得超过它。 */
  readonly length?: number
}

/** 一次二进制文件读取的目标解析与可选字节范围。 */
export interface WorkspaceByteReadOptions {
  /** 字节窗口；省略则在配置的 `maxFileBytes` 上限内读取完整文件。 */
  readonly range?: WorkspaceByteRange
  /** 基准文件，绝对或 workspace 相对路径；相对目标从其所在目录解析。 */
  readonly baseFile?: string
}

/**
 * Client 读到的 workspace 文件的一个字节窗口：原始字节，不做文本
 * 解码，也不拒绝二进制内容。`bytes` 是完整文件的大小。
 */
export interface WorkspaceFileBytes<Data extends Uint8Array = Uint8Array> extends WorkspaceFileStat {
  /** 窗口的首字节，与请求一致。 */
  readonly offset: number
  /** 文件的原生字节；到达或越过 EOF 时为空。 */
  readonly data: Data
  /** 窗口是否包含文件的最后一个字节。 */
  readonly eof: boolean
}

/** 所列 workspace 目录的一个直接子项。 */
export interface WorkspaceDirectoryEntry {
  /** 在所列目录内的基名。 */
  readonly name: string
  /**
   * 子项解析的结果。符号链接报告其目标自身的类型，`other` 涵盖
   * 既非常规文件也非目录的一切；`read` 仍会拒绝符号链接，因此这里的
   * `file` 是列目录时的事实，而非内容可读的承诺。
   */
  readonly type: 'file' | 'directory' | 'other'
  /** 字节大小，仅对后端报告大小的常规文件存在。 */
  readonly size?: number
}

/** 一个 workspace 目录的直接子项。 */
export interface WorkspaceDirectoryListing {
  /**
   * 所列目录的 workspace 路径，相对 workspace 根，根本身为空串。
   * 子项路径是本值与 {@link WorkspaceDirectoryEntry.name} 以 `/` 连接的结果。
   */
  readonly path: string
  /**
   * 直接子项，按后端稳定的名称顺序，截断到配置的条目上限。
   * 展示顺序由调用方决定。
   */
  readonly entries: readonly WorkspaceDirectoryEntry[]
  /** 条目上限是否从 {@link entries} 中丢弃了子项。 */
  readonly truncated: boolean
}

/**
 * 文件系统失效后目标的当前元数据。文件消费方可忽略已知的版本；
 * 目录消费方在每一帧上都重新列目录，因为子项的元数据可能变化
 * 而目录版本不变。
 */
export type WorkspaceFileChange =
  | {
    /** 目标的绝对路径，与 {@link WorkspaceFileStat.absolutePath} 形式相同。 */
    readonly absolutePath: string
    /** 来自当前 stat 的不透明新鲜度令牌；从不解析。 */
    readonly version: string
  }
  | {
    /** 目标的绝对路径，与 {@link WorkspaceFileStat.absolutePath} 形式相同。 */
    readonly absolutePath: string
    /** 观察到目标已不存在。 */
    readonly absent: true
  }

/**
 * workspace 文件 watch 生成的一帧。`ready` 确认 Host 已初始化目标
 * watcher；随后排队的与实时的失效以携带当前目标元数据的 `change`
 * 帧送达。
 */
export type WorkspaceFileWatchFrame =
  | { readonly kind: 'ready' }
  | { readonly kind: 'change'; readonly change: WorkspaceFileChange }

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** 文件系统提供方无法为该目标初始化 watch。 */
    'workspace-file/watch-unsupported': { readonly path: string }
    /** workspace 内该路径上不存在条目。 */
    'workspace-file/not-found': { readonly path: string }
    /** 列目录或 watch 路径解析到 Session 的 workspace 根之外。 */
    'workspace-file/outside-workspace': { readonly path: string }
    /** 请求的页超出配置的字节上限；不返回任何内容。 */
    'workspace-file/too-large': { readonly path: string; readonly limit: number }
    /** 已读取的内容不是可解码的 UTF-8 文本，或页中含 NUL 字节。 */
    'workspace-file/not-text': { readonly path: string }
    /** 路径不是常规文件，因此没有可读的文本。 */
    'workspace-file/not-regular-file': {
      readonly path: string
      readonly kind: 'directory' | 'symlink' | 'other'
    }
    /** 路径不是目录，因此没有可列出的子项。 */
    'workspace-file/not-directory': {
      readonly path: string
      readonly kind: 'file' | 'symlink' | 'other'
    }
  }
}
