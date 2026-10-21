/** 进程域内对 Koffi 的 CommonJS 入口的惰性访问。 */

import type koffi from 'koffi'
import { createLazyRequire } from '@deepseek-ai/dsh-lazy-require'

/** Koffi 运行时导出类型。 */
export type Koffi = typeof koffi

/** 在首次 Win32 原生操作时加载 Koffi。 */
export const requireKoffi = createLazyRequire<Koffi>('koffi', import.meta.url)
