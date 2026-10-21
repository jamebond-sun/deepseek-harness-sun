/**
 * 目录选择接缝的客户端安全类型面：一层浏览目录在调用方眼中是什么样子。仅含类型——没有
 * 运行时代码，且此处不触及任何仅宿主可见的符号，因此 Client 编译面读到的签名与宿主
 * 发出的完全一致。
 *
 * @module @deepseek-ai/dsh-host-directory-picker/types
 */

/** 一条目录记录：一层列表中的子项，或一个面包屑祖先。 */
export interface DirectoryEntry {
  /** 浏览器行中显示的基本名称（根目录面包屑携带其完整路径）。 */
  name: string
  /** 宿主的绝对路径——客户端绝不自行拼接路径段。 */
  path: string
  /** 按宿主平台约定为隐藏（POSIX 上以点开头）；是否显示由客户端决定。 */
  hidden: boolean
}

/** 一层目录及其祖先链，即浏览后端所报告的形式。 */
export interface DirectoryListing {
  /** 被列出目录的绝对路径。 */
  path: string
  /** 宿主账户的主目录（面包屑“主目录”的根）。 */
  home: string
  /**
   * 从文件系统根到被列出目录（含）的祖先链；每个面包屑都是可跳转的目标（面包屑的
   * `hidden` 恒为 false）。
   */
  crumbs: DirectoryEntry[]
  /** 直接子目录，按名称排序；指向目录的符号链接也包含在内。 */
  entries: DirectoryEntry[]
  /**
   * 当后端因完整结果上限而截断 `entries` 时为 true：该层实际的子目录比已返回的多，
   * 缺失的记录是按名称排序的尾部（隐藏记录也计入上限）。
   */
  truncated: boolean
}
