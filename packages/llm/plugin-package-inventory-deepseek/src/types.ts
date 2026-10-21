/** 激活状态的 DeepSeek 插件包清单的线格式类型。 */

/** 一个处于激活状态的插件包，版本可得时附带版本。 */
export interface DeepSeekPluginPackageIdentity {
  readonly name: string
  readonly version?: string
}

/** 每个官方 DeepSeek 请求携带的、带版本号的完整包清单。 */
export interface DeepSeekPluginPackageInventoryExtension {
  readonly version: 1
  readonly packages: readonly DeepSeekPluginPackageIdentity[]
}

declare module '@deepseek-ai/dsh-deepseek-llm-api-extensions/types' {
  interface DeepSeekLlmApiExtensionMap {
    dsh_plugin_packages: DeepSeekPluginPackageInventoryExtension
  }
}
