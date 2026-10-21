/**
 * 为 `@joplin/turndown-plugin-gfm` 提供的环境模块声明；该包本身不提供类型，
 * 也没有 DefinitelyTyped 包。此处仅声明组合插件 `gfm`；该包各自的子插件
 *（`tables`、`strikethrough` 等）暂不声明，直到有代码导入它们为止。
 */
declare module '@joplin/turndown-plugin-gfm' {
  import type TurndownService from 'turndown'

  /** 组合型的 GitHub 风格 Markdown 插件（表格、删除线、任务列表、高亮代码块）。 */
  export const gfm: TurndownService.Plugin
}
