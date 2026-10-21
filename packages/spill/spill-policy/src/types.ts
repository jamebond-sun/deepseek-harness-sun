/**
 * 溢出策略插件的词汇：策略为推导一个溢出产物的归属会话所需要的、
 * 对工具执行的最小结构化视图。
 *
 * `@deepseek-ai/dsh-tools` 的 `ToolExecution` 满足该形状，因此策略可以
 * 直接读取 `exec`，无需导入 `dsh-tools` 或 `dsh-agent`。
 * 只读取会话 HEADER 的 id —— 与所有其他子系统所依据的同一个身份
 * （参见 `dsh-tool-bash` 的归属推导）。
 *
 * @module @deepseek-ai/dsh-spill-policy/types
 */

import type { SessionId } from '@deepseek-ai/dsh-session'

/** 工具执行的最小结构化视图：存在时其归属会话的 header id。 */
export interface SpillPolicyExec {
  /** 代表其发起该调用的 agent，当存在时。 */
  agent?: {
    session: {
      header: {
        /** 规范的会话身份 —— 溢出归属者。 */
        id: SessionId
      }
    }
  }
}
