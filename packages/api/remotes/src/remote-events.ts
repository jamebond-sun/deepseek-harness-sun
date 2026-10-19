/**
 * 本应用转发 Host 事件允许列表的唯一归属地。两个
 * 编译面都列出本文件，因此 Host 转发循环与消费方
 * `ctx.remote.$on` 键面读取同一份声明，而不是两份可能
 * 漂移的副本；`./types.ts` 从中推导类型投影并保持
 * type-only。
 */

import type {} from '@deepseek-ai/dsh-api-session-controller/remote-events'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-deepseek-account/types'
import type {} from '@deepseek-ai/dsh-permission-presets/types'
import type {} from '@deepseek-ai/dsh-plugin-manager/types'
import type {} from '@deepseek-ai/dsh-plugin-market/types'
import type {} from '@deepseek-ai/dsh-schedule/client'
import type { TypertForwardableEventEntry } from '@deepseek-ai/dsh-typert-protocol'

/**
 * 本应用不加重命名即转发的 Host 事件。显式 mode 既是
 * Host 的分发策略，也是 `ctx.remote.$on` 的合法键集合。
 * `emit` 条目声明其载荷所携资源的读取方，或不声明以
 * 触及内建的 `global` 资源；仅当访问控制允许时它才到达
 * 非 owner Peer。每条通知指名一个资源身份或不指名，
 * 集合变更改经 follow 流传输。
 */
export const API_REMOTE_FORWARDED_EVENTS = [
  { event: 'agent-preset/selected', mode: 'emit' },
  { event: 'approval/request', mode: 'waterfall' },
  { event: 'api-session/activity', mode: 'emit', resources: { session: (sessionId): SessionId => sessionId } },
  { event: 'api-session/added', mode: 'emit', resources: { session: (summary): SessionId => summary.sessionId } },
  { event: 'api-session/error', mode: 'emit', resources: { session: (sessionId): SessionId => sessionId } },
  { event: 'api-session/removed', mode: 'emit', resources: { session: (sessionId): SessionId => sessionId } },
  { event: 'api-session/status', mode: 'emit', resources: { session: (sessionId): SessionId => sessionId } },
  { event: 'commands/change', mode: 'emit' },
  { event: 'deepseek-account/session-expired', mode: 'emit' },
  { event: 'deepseek-account/model-sign-in-required', mode: 'emit' },
  { event: 'credentials/record-updated', mode: 'emit' },
  { event: 'credentials/reference-updated', mode: 'emit' },
  { event: 'goal/activation-changed', mode: 'emit' },
  { event: 'cordis/request-run', mode: 'emit' },
  { event: 'cordis/request-run-resolved', mode: 'emit' },
  { event: 'cordis/dynamic-package', mode: 'emit' },
  { event: 'cordis/dynamic-retract', mode: 'emit' },
  { event: 'cordis/inspect-query', mode: 'emit' },
  { event: 'cordis/inspect-query-resolved', mode: 'emit' },
  { event: 'llm/adapters-updated', mode: 'emit' },
  { event: 'permission-presets/catalog-changed', mode: 'emit' },
  { event: 'plugin-manager/changed', mode: 'emit' },
  { event: 'plugin-manager/install-log', mode: 'emit' },
  { event: 'plugin-manager/install-state', mode: 'emit' },
  { event: 'plugin-market/changed', mode: 'emit' },
  { event: 'settings/document-updated', mode: 'emit' },
  { event: 'schedule/changed', mode: 'emit' },
  { event: 'user-questions/request', mode: 'waterfall' },
] as const satisfies readonly TypertForwardableEventEntry[]
