/**
 * 启动提供者所读取的进程事实，放在 `./startup` 入口之外，以便测试替换它们时不会
 * 增加任何公开包 API。
 * @module @deepseek-ai/dsh-headless/startup-internals
 */

/** 提供者所读取的进程事实；测试会替换它们。 */
export const internals: {
  stdinIsTty: () => boolean
  stdout: { write(chunk: string): unknown }
} = {
  stdinIsTty: () => process.stdin.isTTY,
  stdout: process.stdout,
}
