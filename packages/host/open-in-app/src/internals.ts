/** 宿主事实与进程适配器的测试接缝；生产环境保持空的默认值。 */

import type { OpenInAppInternals } from './resolver.ts'

/** 源码级测试在插件激活之前注入的目录事实。 */
export const internals: { catalog: OpenInAppInternals } = { catalog: {} }
