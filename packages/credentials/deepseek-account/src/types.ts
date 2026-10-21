/** 客户端提供的请求身份，以及客户端安全的账户状态；凭证从不跨越此投影。 */
import type {} from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** 一次账户操作所请求的 UI 身份；宿主由此推导出 Platform 请求头。 */
export interface AccountClientMetadata {
  readonly version: string
  /** 活动 UI 语言；仅其主子标签会选择 Platform 线路的 locale。 */
  readonly locale: string
  /** 相对 UTC 的偏移，以秒计，格林尼治以东为正。 */
  readonly timezoneOffsetSeconds: number
}

/** 一次本地登录尝试的身份，与平台请求 ID 无关。 */
export type SignInAttemptId = Branded<'SignInAttemptId'>
/**
 * 通过调用方本地化字典渲染的安全失败码。
 * `no-response`：fetch 未返回 Response；`network`：HTTP 或账户详情获取失败。
 * `protocol`：响应或授权数据无效；`expired`：授权已过期；
 * `storage`：本地凭证访问或提交失败。
 */
export type SignInErrorCode = 'no-response' | 'network' | 'protocol' | 'expired' | 'storage'
/** 最近一次登录尝试，含终态结果，直至下一次尝试为止。 */
export interface SignInAttemptView {
  readonly id: SignInAttemptId
  readonly phase: 'initializing' | 'waiting-browser' | 'exchanging' | 'committing' | 'succeeded' | 'cancelled' | 'expired' | 'failed'
  readonly authorizeUrl?: string
  readonly expiresAt?: number
  readonly errorCode?: SignInErrorCode
}
/** 由宿主的平台配置推导出的浏览器目的地；绝不携带令牌。 */
export interface AccountLinks {
  readonly usageUrl: string
  readonly topUpUrl: string
}
/** 已存储账户的存在，并不等于服务端已验证其令牌的声明。 */
export interface AccountView {
  readonly status: 'signed-out' | 'credential-stored'
  readonly links: AccountLinks
  readonly attempt: SignInAttemptView | null
}

/** 由 current-user 接口所提供的、平台的账户标识符。 */
export type AccountUserId = Branded<'AccountUserId'>
/** 展示身份；联系方式保留 Platform 的掩码。 */
export interface AccountProfile {
  readonly id: AccountUserId | null
  readonly name: string | null
  readonly contact: string | null
  /** Platform 提供的头像 URL，未配置图片时缺省。 */
  readonly avatarUrl?: string | null
}
/** 平台的充值或赠金钱包余额；十进制字符串保留服务端精度。 */
export interface AccountWallet {
  readonly currency: 'CNY' | 'USD'
  readonly balance: string
}
/** 相互独立的查询结果，使得档案与余额的失败可以分别渲染。 */
export interface AccountDetails {
  readonly profile: { readonly status: 'ready'; readonly value: AccountProfile } | { readonly status: 'failed' }
  readonly balance: { readonly status: 'ready'; readonly value: readonly AccountWallet[]; readonly bonusWallets: readonly AccountWallet[] } | { readonly status: 'failed' }
}

/** 一份已授予赠金订单的身份，跨设备与跨登录保持稳定。 */
export type AccountBonusOrderId = Branded<'AccountBonusOrderId'>
/** 一份 Platform 尚未记录为已展示的、已授予的赠金；文案由服务端撰写。 */
export interface AccountBonusNotification {
  /** 服务端本地化的纯文本标题；缺省响应使用本地化的赠金标题。 */
  readonly title?: string
  readonly orderId: AccountBonusOrderId
  /** 可选的 Platform 元数据，不经校验地转发。 */
  readonly campaign?: JsonValue
  readonly amount?: JsonValue
  readonly currency?: JsonValue
  readonly grantedAt?: JsonValue
  /** Platform 过期时间戳；空字符串表示该通知永不过期。 */
  readonly expiresAt: string
  /** 服务端本地化、可直接展示的纯文本。 */
  readonly message: string
}
/** 尚未通知的赠金，及其所属账户，按 Platform 顺序。 */
export interface AccountBonusBatch {
  readonly accountId: AccountUserId
  readonly bonuses: readonly AccountBonusNotification[]
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** 服务端拒绝移除了当前账户凭证；此通知不会被重放。
     * @mode emit
     */
    'deepseek-account/session-expired'(): void
    /** 一次账户模型请求要求用户登录。
     * @mode emit
     */
    'deepseek-account/model-sign-in-required'(): void
  }
}
