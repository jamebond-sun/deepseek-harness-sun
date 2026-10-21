/**
 * 事件名模式与字段匹配器：某事件会选中哪些已注册的钩子。
 * 事件名称沿用 Claude Code 的；挂在一个本桥接永远不会引发的名称上的钩子
 * 会正常注册，但永远不会运行。
 * @module
 */

import type { HookMatcher, MatcherValue } from './types.ts'

/** 引擎自身所引发的事件，与 mods API 调用所引发的 `<namespace>.<method>` 事件相对。 */
export const ENGINE_EVENTS: ReadonlySet<string> = new Set([
  'tool.call', 'tool.check', 'tool.describe',
  'prompt.submit', 'prompt.fill', 'prompt.suggest', 'prompt.edit', 'prompt.compose', 'prompt.section',
  'prompt.context', 'prompt.attachment', 'skill.prompt', 'attribution.text',
  'command.run', 'command.describe', 'config.set', 'config.describe',
  'turn.start', 'turn.step', 'turn.complete',
  'session.start', 'session.end', 'session.compact', 'session.receive', 'session.send', 'session.append',
  'session.attach', 'session.detach', 'session.measure',
  'agent.offer', 'agent.spawn',
  'ui.render', 'ui.resolve', 'ui.press', 'ui.input', 'ui.select', 'ui.focus', 'ui.scroll', 'ui.close', 'ui.message',
  'plugin.register', 'engine.create',
  'telemetry.log', 'telemetry.mark',
])

/**
 * 某个 mod 可能钩住的每一个事件名称，按 Claude Code 的参考顺序排列：
 * 先是引擎事件，再是每一个以 `<namespace>.<method>` 形式出现的 mods API 方法。
 * `on` 会以 Claude Code 自身的措辞拒绝列表之外的名称，因此拼写错误会在
 * 加载时失败，而非注册一个永不运行的钩子。
 */
export const KNOWN_EVENTS: ReadonlySet<string> = new Set([
  ...ENGINE_EVENTS,
  // mods API calls
  'ui.log', 'ui.toast', 'ui.status', 'ui.notice', 'ui.invalidate', 'ui.open', 'ui.panes', 'ui.blit', 'ui.ask', 'ui.copy',
  'command.register', 'command.list',
  'tool.register', 'tool.list',
  'agent.register', 'agent.list',
  'model.complete', 'model.fork', 'model.classify',
  'prompt.read',
  'turn.abort',
  'session.messages', 'session.cwd', 'session.root', 'session.model', 'session.turns', 'session.id', 'session.repo',
  'session.surface', 'session.surfaces', 'session.usage', 'session.version', 'session.authorize',
  'config.list',
  'settings.read',
  'env.get', 'env.set',
  'fs.read', 'fs.write', 'fs.list', 'fs.exists', 'fs.stat', 'fs.ancestors',
  'store.get', 'store.set', 'store.delete', 'store.keys',
  'state.get', 'state.set',
  'clock.now', 'clock.sleep', 'clock.after', 'clock.every',
  'http.fetch',
  'process.run', 'process.spawn',
  'mcp.call', 'mcp.connect',
  'audio.play', 'audio.speak',
])

/**
 * 传给 `on` 的名称是否为精确事件名、`*`，或 `<namespace>.*` 形式的 glob。
 * @param pattern - 名称或 glob。
 * @returns 当 `on` 接受它时为 true。
 */
export function isEventPattern(pattern: string): boolean {
  if (pattern === '*') return true
  if (pattern.endsWith('.*')) {
    const namespace = pattern.slice(0, -2)
    return namespace.length > 0 && [...KNOWN_EVENTS].some(event => event.startsWith(`${namespace}.`))
  }
  return KNOWN_EVENTS.has(pattern)
}

/**
 * 某个已注册的模式是否选中了一个事件。`*` 选中除了遥测事件之外的所有事件，
 * 而遥测事件需由 mod 按名称或 `telemetry.*` 来钩取。
 * @param pattern - 传给 `on` 的名称或 glob。
 * @param event - 正在被引发的事件。
 * @returns 当该模式选中该事件时为 true。
 */
export function eventMatches(pattern: string, event: string): boolean {
  if (pattern === event) return true
  if (pattern === '*') return !event.startsWith('telemetry.')
  return pattern.endsWith('.*') && event.startsWith(pattern.slice(0, -1))
}

function valueMatches(expected: MatcherValue, actual: unknown): boolean {
  if (expected instanceof RegExp) {
    // 全局或 sticky 的正则表达式会记住其上一次测试的停止位置；但每个事件都从头开始。
    expected.lastIndex = 0
    return (typeof actual === 'string' || typeof actual === 'number') && expected.test(String(actual))
  }
  if (Array.isArray(expected)) return expected.some(candidate => candidate === actual)
  return expected === actual
}

/**
 * 匹配器的每一个字段是否都接受事件同名的最顶层字段：标量按相等、
 * 数组按成员资格、RegExp 按测试。
 * @param matcher - 传给 `on` 的匹配器。
 * @param input - 该钩子将收到的事件输入。
 * @returns 当该钩子应当运行时为 true。
 */
export function matcherMatches(matcher: HookMatcher, input: unknown): boolean {
  if (typeof input !== 'object' || input === null) return false
  const record = input as Record<string, unknown>
  return Object.entries(matcher).every(([field, expected]) => valueMatches(expected, record[field]))
}

/**
 * 以 `claude plugin validate` 打印匹配器的方式来渲染它。
 * @param matcher - 匹配器，或为不带匹配器的钩子时的 undefined。
 * @returns `{field=value,...}`，或空字符串。
 */
export function describeMatcher(matcher: HookMatcher | undefined): string {
  if (matcher === undefined) return ''
  const fields = Object.entries(matcher).map(([field, value]) => {
    const rendered = value instanceof RegExp ? String(value) : Array.isArray(value) ? value.join('|') : String(value)
    return `${field}=${rendered}`
  })
  return `{${fields.join(',')}}`
}
