/** 每个顶层回合的工作区变更摘要、宣布它们的 Session 事件，以及随附比较结果为其提供服务的 Host 服务。 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** 一个回合内被更改的文件，附带来自 git 或来自其文件工具编辑周围的整文件捕获的行数。 */
export interface WorkspaceChangedFile {
  /** 相对于 Session 工作目录的路径，或位于其之外的绝对 Host 路径。 */
  path: string
  /**
   * 排序键与标签：工作目录内的相对路径、位于其之上的仓库文件的
   * `../` 路径、home 目录之下的 `~` 路径，否则为绝对路径。始终以斜杠分隔。
   */
  display: string
  /** 新增的行数；二进制或超大文件为 0。 */
  added: number
  /** 删除的行数；二进制或超大文件为 0。 */
  deleted: number
  /** 当 git 将文件报告为二进制，或当某一捕获侧持有 NUL 字节时存在。 */
  binary?: true
  /** 当某一捕获侧超过插件的 `maxFileBytes` 时存在；该文件被列出但无行数或比较。 */
  oversized?: true
}

/** 一个顶层回合内被更改的文件，保存在 Host 上直到其 Session 被释放。 */
export interface WorkspaceChangesSummary {
  /** 本摘要所描述的、发生文件变更的回合。 */
  turn: number
  /** `path` 值所相对的那份 Session 工作目录。 */
  cwd: string
  /** 按 `display` 顺序排列的被更改文件，以插件的 `maxFiles` 为上限。 */
  files: WorkspaceChangedFile[]
  /** 完整的被更改文件计数，包含被上限省略的文件。 */
  total: number
  /** 所有被更改文件新增的行数，包含被上限省略的文件。 */
  added: number
  /** 所有被更改文件删除的行数，包含被上限省略的文件。 */
  deleted: number
  /** 回合开始与回合结束快照的 git 树 id；未拍摄快照时缺失。 */
  snapshot?: { before: string; after: string }
}

/** 一个带三条上下文行的统一差异块；每行保留其 `+`、`-` 或空格前缀。 */
export interface WorkspaceDiffHunk {
  /** 差异块在回合开始内容中的起始行（从 1 计）；无行的那一侧从 1 开始且行数为 0。 */
  oldStart: number
  /** 取自回合开始内容的、该差异块的行数。 */
  oldLines: number
  /** 差异块在回合结束内容中的起始行（从 1 计）；无行的那一侧从 1 开始且行数为 0。 */
  newStart: number
  /** 取自回合结束内容的、该差异块的行数。 */
  newLines: number
  /** 按顺序排列的差异块主体，每行以 `+`、`-` 或空格为前缀。 */
  lines: string[]
}

/** 一个被列出文件的、回合开始与回合结束内容的比较，在需要时才计算。 */
export type WorkspaceFileDiff =
  | {
    kind: 'text'
    /** 被列出文件的 `path`。 */
    path: string
    /** 被列出文件的 `display`。 */
    display: string
    /** 文件在回合开始时是否存在。 */
    before: boolean
    /** 文件在回合结束时是否存在。 */
    after: boolean
    /** 按文件顺序排列的差异块；两侧内容相同时为空。 */
    hunks: WorkspaceDiffHunk[]
    /** 当行比较超过插件的 `diffTimeoutMs`、且每行都显示为被替换时为真。 */
    coarse: boolean
  }
  /** git 报告为二进制、或持有 NUL 字节的一侧；不提供任何行。 */
  | { kind: 'binary'; path: string; display: string }
  /** 大于插件 `maxFileBytes` 的一侧；不提供任何行。 */
  | { kind: 'oversized'; path: string; display: string }

/** 为存活的 Session 提供记录器所保留的摘要与文件比较。 */
export interface WorkspaceChanges {
  /**
   * 一次 `workspace/changes` 事件所宣布的摘要。
   * @param sessionId - 追加了该事件的 Session。
   * @param seq - 该事件的序列号。
   * @returns 摘要；一旦其 Session 被释放，或本 Host 从未记录过它，则为 undefined。
   */
  summary(sessionId: SessionId, seq: number): WorkspaceChangesSummary | undefined
  /**
   * 比较一个被列出文件在回合开始与回合结束时的内容。
   * @param sessionId - 追加了该事件的 Session。
   * @param seq - 该事件的序列号。
   * @param index - 该文件在摘要 `files` 中的索引。
   * @param signal - 取消读取的信号。
   * @returns 比较结果；一旦其 Session 被释放、本 Host 从未记录过它，或没有任何文件拥有该索引，则为 undefined。
   * @throws 当为存活的 Session 读取快照失败时抛出。
   */
  diff(sessionId: SessionId, seq: number, index: number, signal: AbortSignal): Promise<WorkspaceFileDiff | undefined>
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * 一个已完成的顶层回合的被更改文件已汇总；摘要本身保留在
     * Host 上，并在 Session 存活期间由 `workspaceChanges.summary` 按事件的序列号提供服务。
     * 同一回合的最新事件会取代较早的事件。
     */
    'workspace/changes': { turn: number }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 存活 Session 的每个回合变更文件摘要与比较。 */
    workspaceChanges: WorkspaceChanges
  }
}
