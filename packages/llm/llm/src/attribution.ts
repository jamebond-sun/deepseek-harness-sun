/**
 * 把每个提供方请求作为 `User-Agent` 发送的非机密产品身份集中起来，
 * 以免各个适配器发生漂移。参见
 * `docs/subsystems/llm-streaming.md#appidentity--app-attribution`。
 *
 * 供提供方请求使用的应用归因词汇。
 * @module @deepseek-ai/dsh-llm/attribution
 */

import { createRequire } from 'node:module'

// 包自身的清单是版本的唯一来源，因此 User-Agent 不会与实际发布的版本
// 发生漂移（`./package.json` 是本包的一个导出；该相对路径在 `src/`
// 与打包后的 `lib/` 中都能解析）。
const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

/**
 * 发送给 LLM 提供方的静态公开应用身份。
 *
 * 每个字段都是一项公开的产品事实，在任何请求上都是安全的：
 * 这里不包含任何机密、本地路径、会话 id、提示文本或按用户标识，
 * 并且任何按请求的内容都不得影响这些值。
 */
export interface AppIdentity {
  /** `User-Agent` 的产品令牌（小写、连字符分隔）。 */
  product: string
  /** 产品版本；来自包元数据，绝不手工复制。 */
  version: string
  /** 应用的仓库主页 URL，用作 `User-Agent` 的注释。 */
  url: string
}

/**
 * harness 自身的身份：每个适配器默认发送的身份。需要白标身份的部署
 * 把自己的 {@link AppIdentity} 传给 {@link attributionHeaders}——
 * 省略时回退到这个默认值；任何东西都不能完全抑制归因。
 */
export const APP_IDENTITY: AppIdentity = {
  product: 'deepseek-harness',
  version,
  url: 'https://github.com/deepseek-ai/deepseek-harness',
}

/**
 * 标准的 `User-Agent` 值：`product/version (+url)`。带括号的 `+url`
 * 注释是约定俗成的自我标识形式（RFC 9110 §10.1.5 的 product + comment 语法）。
 * @param identity - 要渲染的身份；默认为 {@link APP_IDENTITY}。
 * @returns 可直接发送的请求头值。
 */
export function userAgent(identity: AppIdentity = APP_IDENTITY): string {
  return `${identity.product}/${identity.version} (+${identity.url})`
}

/**
 * 构建适配器必须在每个提供方请求上发送的归因头。
 * 请求头名称为小写（HTTP 字段名在线路上不区分大小写）。
 * @param identity - 要发送的身份；默认为 {@link APP_IDENTITY}——省略不能抑制归因。
 * @returns 要合并进提供方请求的请求头（目前只有 `user-agent`）。
 */
export function attributionHeaders(
  identity: AppIdentity = APP_IDENTITY,
): Record<string, string> {
  return { 'user-agent': userAgent(identity) }
}
