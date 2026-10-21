/** 共享 Typert 运行时注册表的浏览器端。 */

import type { Context } from '@deepseek-ai/cordis'
import { TypertRegistry } from '../service.ts'

/** 所需服务：无；这是 Client 反射根。 */
export const inject: string[] = []

/**
 * 安装与 Host 端所用的同一套注册表实现。
 * @param ctx - Client Cordis 根。
 */
export function apply(ctx: Context): void {
  new TypertRegistry(ctx)
}
