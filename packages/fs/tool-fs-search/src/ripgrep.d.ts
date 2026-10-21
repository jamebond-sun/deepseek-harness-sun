/**
 * `@vscode/ripgrep` 包的最小类型面：一个 ESM 模块，解析出平台对应的 ripgrep 二进制
 * （`@vscode/ripgrep-<platform>-<arch>` 可选依赖），并把其绝对路径作为具名导出
 * `rgPath` 导出（该包没有随包的类型声明）。
 * @module @deepseek-ai/dsh-tool-fs-search/ripgrep-types
 */

declare module '@vscode/ripgrep' {
  /** 当前平台下打包的 ripgrep 可执行文件的绝对路径。 */
  export const rgPath: string
}
