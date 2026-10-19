/** 面向账户 UI 消费方的已认证 Remote 操作。 */
import { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { isRunningAccountTask } from '@deepseek-ai/dsh-deepseek-account'
import type {} from '@deepseek-ai/dsh-agent'
import type { AccountBonusBatch, AccountBonusOrderId, AccountClientMetadata, AccountDetails, AccountUserId } from '@deepseek-ai/dsh-deepseek-account/types'
import type { AccountView, SignInAttemptId } from './types.ts'

/** 账户命令与可安全重连的状态流。 */
export class AccountController extends TypertRemoteService {
  static inject = ['deepseekAccount', 'agents']
  /** @param ctx - 已挂载账户提供方的 Host。 */
  constructor(ctx: Context) { super(ctx, 'accountController', { namespace: 'account' }) }
  /**
   * 读取安全的账户投影。
   * @returns 当前账户与尝试状态。
   */
  @Remote
  getState(): Promise<AccountView> { return this.ctx.deepseekAccount.getState() }
  /**
   * 查询展示安全的 Platform 资料数据。
   * @param client - 发起请求的 UI 的身份；Host 由此推导 Platform 请求头。
   * @returns 资料结果；账户授权缺失或已变更时为 null。
   */
  @Remote
  getProfile(client: AccountClientMetadata): Promise<AccountDetails['profile'] | null> {
    return this.ctx.deepseekAccount.getProfile(client)
  }
  /**
   * 查询 Platform 充值钱包余额。
   * @param client - 发起请求的 UI 的身份；Host 由此推导 Platform 请求头。
   * @returns 余额结果；账户授权缺失或已变更时为 null。
   */
  @Remote
  getBalance(client: AccountClientMetadata): Promise<AccountDetails['balance'] | null> {
    return this.ctx.deepseekAccount.getBalance(client)
  }
  /**
   * 查询 Platform 尚未记录为已展示的已发放奖励。
   * @param client - 发起请求的 UI 的身份；其语言选择服务端撰写的消息。
   * @returns 奖励及其所属账户；账户授权缺失或已变更时为 null。
   */
  @Remote
  getUnnotifiedBonuses(client: AccountClientMetadata): Promise<AccountBonusBatch | null> {
    return this.ctx.deepseekAccount.getUnnotifiedBonuses(client)
  }
  /**
   * 将一个已展示的奖励记录为已通知其所属账户。
   * @param accountId - 读取该通知所针对的账户。
   * @param orderId - 用户看到的已发放奖励订单。
   * @param client - 发起请求的 UI 的身份；Host 由此推导 Platform 请求头。
   * @returns Platform 记录该确认后为 true；账户缺失或已变更时为 false。
   */
  @Remote
  ackBonusNotified(accountId: AccountUserId, orderId: AccountBonusOrderId, client: AccountClientMetadata): Promise<boolean> {
    return this.ctx.deepseekAccount.ackBonusNotified(accountId, orderId, client)
  }
  /**
   * 开始浏览器登录。
   * @param client - 发起请求的 UI 的身份，由新尝试捕获。
   * @param callbackOrigin - 浏览器可访问的回环 HTTP origin。
   * @param loginSource - 发起 UI，用于从失败的交换中返回。
   * @returns 新的或已处于活动状态的登录尝试。
   */
  @Remote
  startSignIn(client: AccountClientMetadata, callbackOrigin: string, loginSource: 'web' | 'desktop'): Promise<AccountView> {
    return this.ctx.deepseekAccount.startSignIn(client, callbackOrigin, loginSource)
  }
  /**
   * 取消指定的本地尝试。
   * @param attemptId - 要取消的尝试。
   * @returns 已落定的取消或提交状态。
   */
  @Remote
  cancelSignIn(attemptId: SignInAttemptId): Promise<AccountView> { return this.ctx.deepseekAccount.cancelSignIn(attemptId) }
  /**
   * 检查运行中任务最近记录的请求提供方，包括工具与重试。
   * @returns 运行中的工作在账户路由上是否有最近的请求上下文。
   */
  @Remote
  hasRunningAccountTasks(): boolean {
    return this.ctx.agents.list().some(isRunningAccountTask)
  }
  /**
   * 移除本地账户授权并在后台通过 Platform 吊销它，不删除 API 密钥。
   * @param client - 发起请求的 UI 的身份，为后台吊销重试而捕获。
   * @returns 移除本地账户授权之后的状态。
   */
  @Remote
  signOut(client: AccountClientMetadata): Promise<AccountView> { return this.ctx.deepseekAccount.signOut(client) }
  /**
   * 订阅凭据过期，而不重放先前的通知。
   * @param signal - 流的生命周期。
   * @returns 订阅期间发出的通知。
   */
  @Remote({ mode: 'stream' })
  async *watchExpiry(signal: AbortSignal): AsyncIterable<'session-expired'> {
    let pending = 0
    let wake: (() => void) | undefined
    const stop = this.ctx.on('deepseek-account/session-expired', () => { pending++; wake?.() })
    const abort = (): void => { wake?.() }
    signal.addEventListener('abort', abort, { once: true })
    try {
      while (!signal.aborted) {
        if (pending > 0) { pending--; yield 'session-expired'; continue }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      stop()
      signal.removeEventListener('abort', abort)
    }
  }
  /**
   * 以流输出安全的账户投影。
   * @param signal - 流的生命周期。
   * @returns 初始快照与后续变更。
   */
  @Remote({ mode: 'stream' })
  watch(signal: AbortSignal): AsyncIterable<AccountView> { return this.ctx.deepseekAccount.watch(signal) }
}
export default AccountController
