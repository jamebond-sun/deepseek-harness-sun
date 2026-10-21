/** 注入的 faces 与 Package 自有的 `tool.view.cordis` 槽位声明。 */

import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  CordisRunActivity, CordisRunFailure, CordisUserRunRequest, DynamicCordisLivePackage,
  DynamicCordisRenderFailure,
} from '@deepseek-ai/dsh-cordis-client-runner/client'
import type { CordisActionResult } from './dynamic-port.ts'
import type { CordisInventory } from './inventory.ts'
import type { CordisRunCardPointer, CordisRunCardStore } from './run-card-index.ts'
import type {
  ApprovalRequestId, CordisDynamicPackageId, CordisDynamicPluginId, CordisDynamicPluginRunId,
} from './events.ts'

/** 交付给动态 Package 业务视图的拥有者信息。 */
export interface CordisToolViewOwnerProps {
  readonly pluginId: CordisDynamicPluginId
  readonly packageId: CordisDynamicPackageId
  readonly pluginRunId: CordisDynamicPluginRunId
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * 在对话流中最新合格 `cordis_run` 卡片内渲染的、Package 自有的
     * 交互区域。用它放置控件以及用户可交互的其它
     * UI。动态 Client 代码以
     * `key: 'self'` 注册；Guard 将该键绑定到当前的 Plugin 与 Package。
     */
    'tool.view.cordis': {
      kind: 'keyed'
      scope: 'session'
      owner: CordisToolViewOwnerProps
    }
  }
}

/** 只读 Define 卡片所使用的活动事实。 */
export interface CordisCardFace {
  hooks: {
    inventory: CordisInventory
    loaded: HostObservable<readonly DynamicCordisLivePackage[]>
  }
}

/** Run 卡片及其业务视图归属索引所使用的活动事实。 */
export interface CordisRunCardFace extends CordisCardFace {
  hooks: CordisCardFace['hooks'] & {
    runCards: CordisRunCardStore
    activeRuns: HostObservable<ReadonlyMap<CordisDynamicPluginId, CordisRunActivity>>
  }
  /** 将本成功结果发布进会话的最新卡片索引。 */
  onObserveRunCard(pointer: CordisRunCardPointer): void
}

/** 全框架面板状态与生命周期动词。 */
export interface CordisPanelFace {
  hooks: {
    inventory: CordisInventory
    activeRuns: HostObservable<ReadonlyMap<CordisDynamicPluginId, CordisRunActivity>>
    runErrors: HostObservable<ReadonlyMap<CordisDynamicPluginId, CordisRunFailure>>
    renderFailures: HostObservable<ReadonlyMap<CordisDynamicPluginId, DynamicCordisRenderFailure>>
    loaded: HostObservable<readonly DynamicCordisLivePackage[]>
  }
  onApprove(requestId: ApprovalRequestId, approveFutureVersions: boolean): Promise<void>
  onDecline(requestId: ApprovalRequestId): Promise<void>
  onRun(request: CordisUserRunRequest): Promise<void>
  onStop(sessionId: SessionId, pluginId: CordisDynamicPluginId): Promise<CordisActionResult>
  onRemove(sessionId: SessionId, pluginId: CordisDynamicPluginId): Promise<CordisActionResult>
  onRefresh(): void
}
