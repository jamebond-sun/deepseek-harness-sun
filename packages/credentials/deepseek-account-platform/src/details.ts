/** 为账户 UI 消费者所投影的、Platform 的 Web 档案与钱包查询。 */
import { z } from 'zod'
import type { AccountBonusNotification, AccountBonusOrderId, AccountDetails, AccountProfile, AccountUserId } from '@deepseek-ai/dsh-deepseek-account/types'
import { AccountUnauthorizedError, PlatformAuthError, requestAccount, requestBonusNotified, requestUnnotifiedBonuses } from './protocol.ts'

const user = z.object({
  id: z.string().nullish(),
  email: z.string(), mobile: z.string().optional(), mobile_number: z.string().optional(),
  id_profile: z.object({ name: z.string().nullable(), picture: z.string().nullish() }).nullish(),
})
// balance 与 amount 以字符串形式到达，Platform 的 Web 客户端会将其传给 big.js，而 big.js 的十进制
// 文法也接受一个被省略的整数或小数部分，以及一个十进制指数（0E-16、1e+3）。
const decimal = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i
const wallet = z.object({
  currency: z.enum(['CNY', 'USD']), balance: z.string().regex(decimal),
})
const summary = z.object({ normal_wallets: z.array(wallet), bonus_wallets: z.array(wallet) })
// 协议响应经过 JSON 解码；元数据保留任意 JSON 值，而不做字段校验。
const bonusMetadata = z.custom<Exclude<AccountBonusNotification['campaign'], undefined>>().optional()
const bonus = z.object({
  campaign: bonusMetadata, amount: bonusMetadata, currency: bonusMetadata, granted_at: bonusMetadata,
  order_id: z.string(), title: z.string().nullish().transform(value => value ?? undefined), expires_at: z.string().nullish().transform(value => value ?? ''), msg: z.string(),
})
// 共享的响应读取器已经解包了 biz_data，因此载荷本身就是赠金列表。
const unnotified = z.array(bonus)

/** 投影 Platform 用户数据，而不保留凭证或多余字段。
 * @param value - 当前或交换的用户响应。
 * @returns UI 账户档案。
 */
export function profile(value: unknown): AccountProfile {
  const parsed = user.safeParse(value)
  if (!parsed.success) throw new PlatformAuthError('protocol')
  return projectProfile(parsed.data)
}

function projectProfile(value: z.infer<typeof user>): AccountProfile {
  const { email, mobile, mobile_number: mobileNumber, id_profile: identity } = value
  return {
    id: value.id == null ? null : value.id as AccountUserId,
    avatarUrl: identity?.picture || null,
    name: identity?.name || null, contact: mobile || mobileNumber || email || null,
  }
}

function accountPayload<T>(schema: z.ZodType<T>, value: unknown, field: 'profile' | 'balance' | 'bonus'): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    console.error(`[deepseek-account] ${field} schema rejected`, {
      issues: parsed.error.issues.map(issue => ({ path: issue.path, code: issue.code })),
    })
    throw new PlatformAuthError('protocol')
  }
  return parsed.data
}

const queries: { [K in keyof AccountDetails]: {
  path: '/auth-api/v0/users/current' | '/api/v0/users/get_user_summary'
  parse: (value: unknown) => AccountDetails[K]
} } = {
  profile: { path: '/auth-api/v0/users/current', parse: value => ({
    status: 'ready', value: projectProfile(accountPayload(user, value, 'profile')),
  }) },
  balance: { path: '/api/v0/users/get_user_summary', parse: (value) => {
    const parsed = accountPayload(summary, value, 'balance')
    return { status: 'ready', value: parsed.normal_wallets, bonusWallets: parsed.bonus_wallets }
  } },
}

/**
 * 读取一个 Platform 账户字段，而无需等待另一个查询。
 * @param field - 档案，或充值与赠金钱包余额。
 * @param origin - 与已存储授权签发者相匹配的、已配置的来源。
 * @param token - 已存储的授权令牌；响应令牌会被丢弃。
 * @param signal - 请求与凭证的生命周期。
 * @param headers - 针对已配置来源的、已验证的部署请求头。
 * @returns 经过净化的查询结果；失败绝不会变成零余额。
 * @throws 当 Platform 以 HTTP 401 或响应码 40003 拒绝该已存储令牌时，抛出 AccountUnauthorizedError。
 */
export async function readAccountDetail<K extends keyof AccountDetails>(field: K, origin: string, token: string,
  signal: AbortSignal, headers: Record<string, string>): Promise<AccountDetails[K]> {
  const query = queries[field]
  try { return query.parse(await requestAccount(origin, query.path, token, signal, headers)) }
  catch (error) {
    if (error instanceof AccountUnauthorizedError) throw error
    return { status: 'failed' }
  }
}

/**
 * 为一份已捕获的凭证读取尚未通知的赠金列表。
 * @param origin - 与已存储授权签发者相匹配的、已配置的来源。
 * @param token - 已捕获的账户授权；调用方已经将其绑定到该账户。
 * @param signal - 凭证生命周期与请求超时。
 * @param headers - 针对已配置来源的、部署与客户端身份请求头。
 * @returns 按 Platform 顺序的、已通知内容；畸形的载荷即一次协议失败。
 */
export async function readUnnotifiedBonuses(origin: string, token: string,
  signal: AbortSignal, headers: Record<string, string>): Promise<readonly AccountBonusNotification[]> {
  const parsed = accountPayload(unnotified, await requestUnnotifiedBonuses(origin, token, signal, headers), 'bonus')
  return parsed.map(row => ({
    ...(row.campaign === undefined ? {} : { campaign: row.campaign }),
    ...(row.amount === undefined ? {} : { amount: row.amount }),
    ...(row.currency === undefined ? {} : { currency: row.currency }),
    ...(row.granted_at === undefined ? {} : { grantedAt: row.granted_at }),
    orderId: row.order_id as AccountBonusOrderId, expiresAt: row.expires_at, message: row.msg,
    ...(row.title === undefined ? {} : { title: row.title }),
  }))
}

/**
 * 将一条已展示的赠金记录为已通知，针对它读取时所依据的凭证。
 * @param origin - 与已存储授权签发者相匹配的、已配置的来源。
 * @param token - 已捕获的账户授权；调用方已经将其绑定到该账户。
 * @param orderId - 用户所看到的、已授予赠金的订单。
 * @param signal - 凭证生命周期与请求超时。
 * @param headers - 针对已配置来源的、部署与客户端身份请求头。
 * @returns 在 Platform 记录下该确认之后；HTTP 与业务失败会抛出。
 */
export async function sendBonusNotified(origin: string, token: string, orderId: AccountBonusOrderId,
  signal: AbortSignal, headers: Record<string, string>): Promise<void> {
  await requestBonusNotified(origin, token, orderId, signal, headers)
}
