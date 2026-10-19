/** Remote Event 组装可用的 Session Controller 事件。 */
type SessionControllerRemoteEvent =
  | 'api-session/activity'
  | 'api-session/added'
  | 'api-session/error'
  | 'api-session/removed'
  | 'api-session/status'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteEventSelection extends
    Record<SessionControllerRemoteEvent, true> {}
}

export {}
