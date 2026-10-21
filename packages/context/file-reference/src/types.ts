/**
 * 公开的文件引用发现记录。本模块仅包含类型，以便生成的 Remote 客户端
 * 无需 Host 运行时代码即可消费它。
 * @module @deepseek-ai/dsh-file-reference/types
 */

/** 目标会话 cwd 内、仅含路径的一个补全候选。 */
export interface FileReferenceCandidate {
  /** 被普通提示与文件系统工具所接受的、面向用户的路径。 */
  path: string
  /** 目录保持补全打开；文件则结束该提及。 */
  kind: 'file' | 'directory'
}
