/**
 * shell 工具（`dsh-tool-bash`、`dsh-tool-pwsh`）共享的渲染辅助：这里定义
 * 的是工具渲染器所输出的退出状态标记契约，Host 的 `presentResult`
 * 实现在此解析它，Web 的终端卡片模型则在不导入 Host 代码的前提下镜像它。
 * @module @deepseek-ai/dsh-shell/render
 */

/**
 * 从渲染结果中还原出的退出状态，以及该状态被剥离之前所属的输出主体。
 */
export type ParsedExitStatus =
  & { body: string }
  & ({ exitCode: number } | { signal: string })

/**
 * 把渲染后的 shell 工具结果字符串拆分为输出主体与结构化退出状态——这是
 * shell 工具渲染器附加的 `[exit code: N]`／`[killed by signal: X]` 标记的
 * 逆操作。被杀死的标记得到 `signal`；否则非零标记得到 `exitCode`；两者
 * 都缺失表示干净的退出 0。
 *
 * 被消费的标记会从 `body` 中移除，因为终端呈现会把退出状态显示为独立的
 * 徽标：把标记留在输出里会让退出状态渲染两次。其他标记（超时、沙箱拒绝）
 * 承载的是没有徽标展示的事实，因此保留在 body 中。
 *
 * 回放只保留渲染后的内容文本而非原始 `ShellRunResult`，因此终端呈现必须
 * 在此还原退出徽标。要求前导换行且位于字符串末尾，可以避免普通输出仅因
 * 以类似标记的文本结尾就被匹配——除非最后一行与真实标记无法区分。
 * @param text - 面向模型的、已渲染的 shell 工具结果。
 * @returns 去掉标记的主体，以及还原出的终止退出码或信号。
 */
export function parseExitStatus(text: string): ParsedExitStatus {
  const signal = /\n\[killed by signal: ([^\]\n]+)\]$/.exec(text)
  if (signal?.[1] !== undefined) return { body: text.slice(0, signal.index), signal: signal[1] }
  const exit = /\n\[exit code: (\d+)\]$/.exec(text)
  if (exit?.[1] !== undefined) return { body: text.slice(0, exit.index), exitCode: Number(exit[1]) }
  return { body: text, exitCode: 0 }
}
