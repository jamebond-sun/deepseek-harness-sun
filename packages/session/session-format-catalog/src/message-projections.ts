/** 用于已分离的当前格式回放（含浏览器读取器）的纯一方消息解释器。 */

import { imageOffloadProjection } from '@deepseek-ai/dsh-compaction-image-offload/projection'
import type { SessionMessageProjection } from '@deepseek-ai/dsh-session/surface'

/** 已安装的解释定义；恢复监听器由其所属插件单独挂载。 */
export const currentSessionMessageProjections: readonly SessionMessageProjection[] = [imageOffloadProjection]
