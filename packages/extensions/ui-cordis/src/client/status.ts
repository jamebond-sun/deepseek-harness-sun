/** 基于 Host 清单与本页面 Client 活动集的共享状态推导。 */

import type { DynamicCordisLivePackage } from '@deepseek-ai/dsh-cordis-client-runner/client'
import type {
  CordisDynamicPackageId, DynamicCordisInventoryRow,
} from './events.ts'

/** 三个产品可见的生命周期读值。 */
export type CordisVisibleStatus = 'idle' | 'client-pending' | 'running'

/**
 * 在一个 Plugin 行内定位一个不可变的 Package。
 * @param row - 所属的 Plugin 清单行。
 * @param packageId - 待定位的不可变 Package 身份。
 * @returns 匹配的 Package 元数据；不存在时为 `undefined`。
 */
export function packageOf(
  row: DynamicCordisInventoryRow,
  packageId: CordisDynamicPackageId,
): DynamicCordisInventoryRow['packages'][number] | undefined {
  return row.packages.find(pkg => pkg.packageId === packageId)
}

/**
 * 推导一个 Package 的可见状态。
 * @param row - 所属的 Plugin 清单行。
 * @param packageId - 被描述的 Package。
 * @param loaded - 本页面已加载的 Client 激活。
 * @returns idle、Host 运行/Client 待定，或完全运行。
 */
export function cordisVisibleStatus(
  row: DynamicCordisInventoryRow,
  packageId: CordisDynamicPackageId,
  loaded: readonly DynamicCordisLivePackage[],
): CordisVisibleStatus {
  const run = row.activeRun
  if (run === undefined || run.packageId !== packageId) return 'idle'
  const pkg = packageOf(row, packageId)
  if (pkg?.hasClientHalf !== true) return 'running'
  return loaded.some(live => live.pluginId === row.pluginId
    && live.packageId === packageId
    && live.pluginRunId === run.pluginRunId)
    ? 'running'
    : 'client-pending'
}
