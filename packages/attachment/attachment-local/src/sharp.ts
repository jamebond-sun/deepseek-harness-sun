/** 进程域中对 Sharp 的 CommonJS 兼容入口的懒加载访问。 */

import type sharp from 'sharp'
import { createLazyRequire } from '@deepseek-ai/dsh-lazy-require'

/** 在首次栅格操作时加载 Sharp 并保留其可调用导出。 */
export const requireSharp = createLazyRequire<typeof sharp>('sharp', import.meta.url)
