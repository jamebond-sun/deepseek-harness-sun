/** 基于共享沙箱诊断的 shell 结果投影。 */
import type { ShellRunResult } from '@deepseek-ai/dsh-shell'
import { matchesSignature } from '@deepseek-ai/dsh-sandbox'
export { isRunnerSpawnFailure, classifyRunnerFailure, matchesSignature } from '@deepseek-ai/dsh-sandbox'

/**
 * 按所选后端的拒绝方言对一次失败的运行进行分类。
 * @param result - 已落定的前台运行。
 * @param signatures - 来自当前包装的、大小写不敏感的拒绝特征子串。
 * @returns 该失败运行是否匹配这一拒绝方言。
 */
export function classifyDenial(result: ShellRunResult, signatures: readonly string[]): boolean {
  return matchesSignature(result.exitCode, result.stderr.text, signatures)
}
