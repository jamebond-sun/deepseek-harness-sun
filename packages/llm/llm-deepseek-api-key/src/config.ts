/** 与一次 Messages 端点配置一同解析的 API 密钥配置。 */
import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { deepSeekConfigFields, type Config as ProtocolConfig, plainOptions as protocolOptions, resolveAdapterOptions as resolveProtocolOptions } from '@deepseek-ai/dsh-llm-deepseek'
import type { Options as ProtocolOptions, DeepSeekConnectionOptions } from '@deepseek-ai/dsh-llm-deepseek'

/** 带有按请求解析的 API 密钥引用的 Messages 配置。 */
export interface Config extends ProtocolConfig {
  /** 按请求解析的凭据引用；默认为 DEEPSEEK_API_KEY。 */
  apiKeyEnv: Volatile<string>
}
export const Config = z.object({
  ...deepSeekConfigFields,
  apiKeyEnv: z.string().role('credential-ref').default('DEEPSEEK_API_KEY').volatile(),
})
/** API 密钥提供方的纯部署输入。 */
export type Options = ProtocolOptions & { apiKeyEnv?: string }
/** 从同一次配置快照中捕获的端点与凭据引用。 */
export interface ResolvedDeepSeekOptions extends DeepSeekConnectionOptions {
  /** 仅用于本次连接快照的凭据引用。 */
  apiKeyEnv: CredentialRef
}
/** 读取一份已校验的提供方配置。
 * @param config - 实时的插件配置。
 * @returns 已分离的解析器输入。
 */
export function plainOptions(config: Config): Options {
  return { ...protocolOptions(config), apiKeyEnv: config.apiKeyEnv.get() }
}
/** 同时解析 API 密钥与协议设置。
 * @param config - 原始的部署设置。
 * @param environment - 应用启动环境。
 * @returns 已校验的端点事实，以及与之匹配的凭据引用。
 */
export function resolveAdapterOptions(config: Options, environment?: LaunchEnvironmentSnapshot): ResolvedDeepSeekOptions {
  return { ...resolveProtocolOptions(config, environment), apiKeyEnv: credentialRef(config.apiKeyEnv ?? 'DEEPSEEK_API_KEY') }
}
