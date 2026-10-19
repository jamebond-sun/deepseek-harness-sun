/**
 * 固定的首次使用 Workspace 命名，由创建目录的 Host 与为结果行
 * 显示标签的浏览器消费方共享。无导入的纯函数，因此 client 打包器
 * 将其内联，而不是请求本包不发布的模块表行。
 * @module @deepseek-ai/dsh-api-workspace-controller/default-workspace
 */

/**
 * 首次使用 Workspace 在 `<Documents>/deepseek-harness` 下的末级目录名。
 * 语言中立，因此一次安装在语言切换间保持同一磁盘路径。注册表由
 * 同一段名称派生初始标题，该标题正是 {@link workspaceDisplayTitle}
 * 识别为自动的标题。
 */
export const DEFAULT_WORKSPACE_DIRECTORY = 'default-workspace'

/**
 * 一个 Workspace 显示所用的文本。仍携带自动首次使用标题的
 * Workspace 读作调用方语言下的默认名称；其他标题在所有语言中
 * 原样显示。用户恰好输入为 {@link DEFAULT_WORKSPACE_DIRECTORY} 的标题
 * 也按默认显示；没有其他逻辑依赖这一区分。
 * @param title - 存储的 Workspace 标题。
 * @param localizedDefault - 当前语言下的默认 Workspace 名称。
 * @returns 要显示的标题。
 */
export function workspaceDisplayTitle(title: string, localizedDefault: string): string {
  return title === DEFAULT_WORKSPACE_DIRECTORY ? localizedDefault : title
}
