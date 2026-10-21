/** 供配置界面使用的、已安装提供方的默认值。 */

import type { Provider } from '@earendil-works/pi-ai'
import type { LlmConfigurableProvider } from '@deepseek-ai/dsh-llm'
import { PROVIDER_DATA } from './provider-data.generated.ts'

/**
 * 返回已生成的展示元数据，而不执行任何认证。
 * @param provider - 已安装的目录提供方，可能来自一个较新的消费者依赖。
 * @returns 已知的元数据；对于一个未被记录的提供方，则只有一个固定的公共端点。
 */
export function providerDefaultsOf(provider: Provider): Pick<LlmConfigurableProvider, 'nativeAuth' | 'defaultBaseURL' | 'baseURLEnv'> {
  const data = PROVIDER_DATA[provider.id]
  // 消费者可以在依赖区间内安装一个较新的 pi-ai。一个未被记录的提供方
  // 仍然可以被配置，只是没有猜测出来的认证元数据。
  if (data === undefined) return provider.baseUrl && !provider.baseUrl.includes('{') ? { defaultBaseURL: provider.baseUrl } : {}
  const { env, ...endpoint } = data
  return { ...endpoint, nativeAuth: { env, oauth: provider.auth.oauth !== undefined } }
}
