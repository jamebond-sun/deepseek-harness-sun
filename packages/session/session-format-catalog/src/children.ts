/** 将特定父会话的子会话证据绑定到静态的一方可迁移清单中。 */

import { createSessionFormatCatalog } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatCatalog, SessionFormatJsonValue } from '@deepseek-ai/dsh-session-format'
import { createSessionFormatV3ToV4, sessionFormatV3ToV4 } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { sessionFormatCatalogOptions } from './generated.ts'

/**
 * 组装一个目录，使其 V3→V4 边知晓某个父会话的历史子会话。
 * @param children - 完整的子会话证据，在目录整个生命周期内保持不变；空数组表示声明没有子会话。
 * @returns 一个目录，每个制品拥有独立的恢复状态，且当前格式读取行为不变。
 */
export function createSessionFormatCatalogWithChildren(children: readonly SessionFormatJsonValue[]): SessionFormatCatalog {
  const migration = createSessionFormatV3ToV4(children)
  return createSessionFormatCatalog({
    ...sessionFormatCatalogOptions,
    migrations: sessionFormatCatalogOptions.migrations.map(edge => edge === sessionFormatV3ToV4 ? migration : edge),
  })
}
