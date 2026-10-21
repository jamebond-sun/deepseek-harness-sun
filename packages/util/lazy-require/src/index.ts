/** 面向 CommonJS 兼容 Host 依赖、相对调用方的惰性加载。 */

import { createRequire } from 'node:module'

/**
 * 围绕 Node 相对调用方的 `require` 创建一个成功结果缓存。
 * 失败的加载不会被缓存，因此修正后的安装可被重试。
 * @param specifier - 由调用方包声明的字面依赖说明符。
 * @param parentURL - 调用方的 `import.meta.url`，包解析由其负责。
 * @returns 首次使用时解析该依赖的零参加载器。
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- 保留调用方提供的模块类型
export function createLazyRequire<T>(specifier: string, parentURL: string | URL): () => T {
  const require = createRequire(parentURL)
  let loaded = false
  let value: T
  return () => {
    if (!loaded) {
      value = require(specifier) as T
      loaded = true
    }
    return value
  }
}
