import type { TurnBoundaryProjection } from './types.ts'
import type {} from '@deepseek-ai/dsh-session-projection'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** agent session 的打开/最新 turn 与 step 边界事实（整值）。 */
    turnBoundary: TurnBoundaryProjection
  }
}

export {}
