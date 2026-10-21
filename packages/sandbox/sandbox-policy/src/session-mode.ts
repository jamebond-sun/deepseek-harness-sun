/**
 * 按会话划分的沙箱模式覆盖：以会话日志作为存储。一次运行期切换（UI 策略
 * 控件或测试场景）被记录为它所作用的那个会话上的一条 `sandbox/mode` 事件；
 * `有效模式 = 投影状态 ?? 部署默认值`，因此一次覆盖可以靠重放跨重启存活，
 * 两个会话永远看不到彼此的状态，且不需要任何外部配置存储。该事件是纯日志
 * 事件（沿用 `approval/*` 的先例）：策略所有者把这个折叠结果投影进每次模型
 * 请求，而各强制工具上报各自操作特有的边界标记。执行侧通过
 * `ctx.sandboxPolicy.resolve()` 遵循同一个折叠结果——它把模式连同调用会话
 * 的工作区根一起盖到每次能力调用上，其优先级最低，低于一次升级授予。
 *
 * 该覆盖是每一个强制族（bash 与文件系统皆然）共享的策略状态，因此它落在
 * 策略包里，而不是落在某一个能力的接缝里。
 *
 * @module dsh-sandbox-policy/session-mode
 */

import type { Session } from '@deepseek-ai/dsh-session'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * 该会话的沙箱模式被切换——纯日志事件（类似 `approval/*`；不是界面事件，
     * 不携带 `surfaceOp`）：可持久、可重放，从不进入模型转录。最后一条此类
     * 事件即为该会话的覆盖值（由 sandboxMode 投影单元折叠）。
     * `source: 'delegation'` 标记一次被播种进子会话的覆盖；缺少 source
     * 则表示一次运行期切换。
     */
    'sandbox/mode': {
      mode: SandboxMode
      /** Marks an override seeded into a child at delegation. */
      source?: 'delegation'
    }
  }
}

/** 全部 {@link SandboxMode}，用于选项宣告以及对不可信模式字符串的运行期校验。 */
export const SANDBOX_MODES: readonly SandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access']

/**
 * 一个会话的沙箱模式覆盖的唯一写入路径：只追加一条 `sandbox/mode` 事件——
 * 这次切换本身即是它的事件；没有任何东西会在带外修改模式状态。它在该会话
 * 下一次受限调用（bash 或 fs）时生效——消费者读取共享的投影状态。
 * @param session - 该覆盖所属的会话。
 * @param mode - 本会话此后每一次受限调用所运行的模式（直到下一次切换）。
 */
export function setSandboxMode(session: Session, mode: SandboxMode): void {
  session.append('sandbox/mode', { mode })
}
