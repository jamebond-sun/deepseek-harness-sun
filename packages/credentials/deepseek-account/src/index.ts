/** 由平台、API 与模型消费者共享的账户 Service Definition。 */
import { Context, Service } from '@deepseek-ai/cordis'
import type { AccountBonusBatch, AccountBonusOrderId, AccountClientMetadata, AccountDetails, AccountUserId, AccountView, SignInAttemptId } from './types.ts'
export type { AccountBonusBatch, AccountBonusNotification, AccountBonusOrderId, AccountClientMetadata, AccountDetails, AccountProfile, AccountUserId, AccountWallet, AccountLinks, AccountView, SignInAttemptId, SignInAttemptView, SignInErrorCode } from './types.ts'
export { isRunningAccountTask, installAccountTaskCancellation } from './account-tasks.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** 本地授权的移除已完成。
     * @mode emit
     */
    'deepseek-account/signed-out'(): void
  }
  interface Context {
    deepseekAccount: DeepSeekAccount
  }
}

/** 内嵌 Platform 文档的、仅宿主持有的凭证；绝不通过账户 RPC 暴露。 */
export interface PlatformSession {
  readonly origin: string
  readonly token: string
  /** 来自上一次成功档案读取的稳定签发者账户 ID；为 null 时需要使用一次性浏览器存储。 */
  readonly userId: AccountUserId | null
  /** 选择内嵌前端部署的可选 dist 查询值。 */
  readonly embeddedPageDist?: string
  /** 仅宿主持有的部署请求头；消费方客户端会加上它自身动态的 identity，二者都不会抵达渲染器引导阶段。 */
  readonly requestHeaders?: Readonly<Record<string, string>>
}

/** 账户操作；只有宿主消费者才能取得请求凭证。 */
export abstract class DeepSeekAccount extends Service {
  /** @param ctx - 拥有此账户实现的上下文。 */
  constructor(ctx: Context) { super(ctx, 'deepseekAccount') }
  /**
   * 读取已存储账户的存在情况，以及最近一次登录尝试。
   * @returns 一份不含凭证或 PKCE 秘密的快照。
   */
  abstract getState(): Promise<AccountView>
  /**
   * 独立于钱包余额地查询 Platform 档案。
   * 一个稳定的档案 ID 首次可用或发生变化的就绪结果，会通知启用身份的 watch 消费者，
   * 使其重新读取 getPlatformSession；重复的 ID 则保持静默。
   * @param client - 本次调用所请求的 UI 身份。
   * @returns 档案结果，或当已登出或查询期间授权发生变化时为 null。
   */
  abstract getProfile(client: AccountClientMetadata): Promise<AccountDetails['profile'] | null>
  /**
   * 独立于档案数据地查询 Platform 充值与赠金钱包余额。
   * @param client - 本次调用所请求的 UI 身份。
   * @returns 余额结果，或当已登出或查询期间授权发生变化时为 null。
   */
  abstract getBalance(client: AccountClientMetadata): Promise<AccountDetails['balance'] | null>
  /**
   * 查询 Platform 尚未记录为已展示的、已授予的赠金。
   * @param client - 本次调用所请求的 UI 身份；其语言会选择服务端撰写的消息。
   * @returns 赠金及其所属账户，或当已登出或查询期间授权发生变化时为 null。
   */
  abstract getUnnotifiedBonuses(client: AccountClientMetadata): Promise<AccountBonusBatch | null>
  /**
   * 将一条已展示的赠金记录为已通知，针对其所属的账户。
   * @param accountId - 该通知被读取所针对的账户；一个不同的当前账户绝不会被确认。
   * @param orderId - 用户所看到的、已授予赠金的订单。
   * @param client - 本次调用所请求的 UI 身份。
   * @returns 一旦 Platform 记录下该确认即为 true；若已登出或账户变化则为 false。
   */
  abstract ackBonusNotified(accountId: AccountUserId, orderId: AccountBonusOrderId, client: AccountClientMetadata): Promise<boolean>
  /**
   * 加入一个活跃尝试，或启动浏览器授权。
   * @param client - 请求方 UI 的身份；一个新的尝试会捕获它，而加入则保留原尝试的身份。
   * @param callbackOrigin - 浏览器可访问的环回 HTTP 源，含任何 SSH 本地端口。
   * @param loginSource - 发起的 UI，用于在失败交换后返回。
   * @returns 初始快照，无需等待浏览器批准。
   */
  abstract startSignIn(client: AccountClientMetadata, callbackOrigin: string, loginSource: 'web' | 'desktop'): Promise<AccountView>
  /**
   * 仅取消具名的那个尝试；正在提交的尝试会在返回前先结算。
   * @param id - 来自此宿主的尝试身份。
   * @returns 取消之后，或已经在提交的提交之后的状态。
   */
  abstract cancelSignIn(id: SignInAttemptId): Promise<AccountView>
  /**
   * 移除本地授权，但保留 API 密钥；提供方在后台撤销它。
   * @param client - 请求方 UI 的身份，为后台撤销重试所捕获。
   * @returns 本地移除之后的已登出状态；远端失败绝不会恢复该授权。
   */
  abstract signOut(client: AccountClientMetadata): Promise<AccountView>
  /**
   * 订阅快照，包含一份完整的初始状态。
   * @param signal - 订阅的生命周期；结束它绝不会取消登录。
   * @param includeIdentityChanges - 也在缓存的 Platform 身份变化时通知；默认为 false。
   * @returns 随着账户状态变化的完整快照。
   */
  abstract watch(signal: AbortSignal, includeIdentityChanges?: boolean): AsyncIterable<AccountView>
  /**
   * 仅为提供方所允许的推理源解析一个凭证。
   * @param url - 实际请求目的地或 API 基址。
   * @returns 已存储的令牌，或当为其他源或已登出账户时为 undefined。
   */
  abstract resolveToken(url: string): Promise<string | undefined>
  /**
   * 仅在推理所拒绝的令牌仍与已存储登录匹配时，才移除它。
   * @param token - 被拒绝的推理请求所捕获的令牌。
   * @returns 在移除匹配的凭证并发送过期通知之后。
   */
  abstract rejectToken(token: string): Promise<void>
  /**
   * 读取为已配置 Platform 源准备的凭证，绑定其签发环境，并将其与上一次成功档案读取
   * 所得的账户 ID 配对；不发起任何档案请求。
   * @returns 一份仅宿主可见的快照，或当已登出或读取期间凭证发生变化时为 null。
   */
  abstract getPlatformSession(): Promise<PlatformSession | null>
  /**
   * 读取既有的登录身份，而不创建设备或返回凭证。
   * @returns 可选的设备/账户标识符，以及提供方的 OS 版本字符串。
   */
  abstract getDeviceIdentity(): Promise<{ deviceId?: string; userId?: AccountUserId; osVersion: string }>
}
export default DeepSeekAccount


/** 按大小写敏感的名称合并 Cookie 头中的键值对，保留无关的 cookie。
 * @param base - 既有的请求 cookie。
 * @param override - 部署 cookie，其值优先。
 * @returns 一个 Cookie 头，每个名称至多一对。
 */
export function mergePlatformCookies(base: string, override: string): string {
  const cookies = new Map<string, string>()
  for (const header of [base, override]) {
    for (const pair of header.split(';')) {
      const separator = pair.indexOf('=')
      if (separator < 1) continue
      cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim())
    }
  }
  return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ')
}

/**
 * 识别原生的桌面 API 请求；为 null 时非桌面请求保持不变。
 * @param platform - 桌面组合所提供的操作系统。
 * @returns 由账户与更新策略客户端共享的 Platform 请求头。
 */
export function desktopClientHeaders(platform: 'darwin' | 'win32' | null): Record<string, string> {
  if (platform === null) return {}
  return { 'x-client-platform': platform === 'win32' ? 'desktop-win' : 'desktop-mac' }
}

/**
 * 为一次调用构建 Platform 客户端身份请求头。
 * @param platform - 桌面组合所提供的操作系统；为 null 时将客户端标识为 web。
 * @param client - 本次调用所请求的 UI 身份。
 * @returns 五个客户端请求头；bundle ID 故意留空。
 */
export function platformClientHeaders(platform: 'darwin' | 'win32' | null, client: AccountClientMetadata): Record<string, string> {
  return {
    'x-client-bundle-id': '',
    'x-client-platform': 'web',
    ...desktopClientHeaders(platform),
    'x-client-version': client.version,
    'x-client-locale': platformWireLocale(client.locale),
    'x-client-timezone-offset': String(client.timezoneOffsetSeconds),
  }
}

/**
 * 将调用方的 UI 语言归约为带区域的 Platform locale。
 * 与请求头以及请求体 locale 字段共享同一套归一化。
 * @param locale - 活动 UI 语言，如 `zh-CN`、`zh_TW` 或 `en-US`。
 * @returns 该语言所对应的、带区域的 Platform locale，`zh_CN` 或 `en_US`。
 */
export function platformWireLocale(locale: string): 'zh_CN' | 'en_US' {
  return locale.toLowerCase().split(/[-_]/)[0] === 'zh' ? 'zh_CN' : 'en_US'
}
