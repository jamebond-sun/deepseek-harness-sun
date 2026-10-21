/**
 * Claude Code 内建工具名（mod 的匹配器与 `e.tool` 使用）与注册表所知的
 * 宿主工具名之间的别名映射。
 * @module
 */

/** Claude Code 工具名 → 宿主工具名，对应两个产品都内置提供的工具。 */
export const DEFAULT_TOOL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  Bash: 'bash',
  Read: 'read',
  Edit: 'edit',
  Write: 'write',
  Glob: 'glob',
  Grep: 'grep',
  WebFetch: 'web_fetch',
  WebSearch: 'web_search',
  Task: 'subagent',
  TodoWrite: 'todo_write',
  AskUserQuestion: 'ask_user_question',
  ExitPlanMode: 'exit_plan_mode',
  Skill: 'skill',
})

/** 双向的工具名翻译。 */
export interface ToolNameAliases {
  /** 某个 mod 所看到的、宿主工具的名称：其 Claude Code 别名，或宿主名本身。 */
  toMod(harnessName: string): string
  /** 某个 mod 所指名的宿主工具：别名目标，或名称本身。 */
  toHarness(modName: string): string
}

/**
 * 由内建表加上部署覆盖项构建翻译。
 * @param overrides - 用于扩展或替换默认值的、Claude Code 名 → 宿主名的条目。
 * @returns 双向翻译。
 */
export function createToolNameAliases(overrides: Readonly<Record<string, string>> = {}): ToolNameAliases {
  const forward = new Map(Object.entries({ ...DEFAULT_TOOL_ALIASES, ...overrides }))
  const reverse = new Map<string, string>()
  for (const [modName, harnessName] of forward) reverse.set(harnessName, modName)
  return {
    toMod: harnessName => reverse.get(harnessName) ?? harnessName,
    toHarness: modName => forward.get(modName) ?? modName,
  }
}
