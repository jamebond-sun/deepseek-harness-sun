/** 在 DSH 发行版中提供、而无需安装其 provider 运行时的 Official bundle。 */

import type { PluginLocalizedMeta } from '@deepseek-ai/dsh-package-manifest'

export { ON_DEMAND_BUNDLES } from './official-bundle-packages.ts'

/** 离线发现元数据；安装状态与所请求的版本属于运行中的 host。 */
export interface OfficialBundleCatalogEntry {
  /** 现有的 bundle 安装器所接受的精确 npm 包名。 */
  readonly packageName: string
  /** 包自有的本地化文本与自包含图标，无需 provider 代码即可嵌入。 */
  readonly meta: Required<Pick<PluginLocalizedMeta, 'title' | 'description' | 'icon'>>
}

export { OFFICIAL_ON_DEMAND_CATALOG } from './official-bundles.generated.ts'
