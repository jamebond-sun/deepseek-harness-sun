/**
 * `credentials` Remote 命名空间的 Host 拥有者：浏览器配置页所读写的
 * `ctx.credentials` 引用那一半。
 *
 * @module @deepseek-ai/dsh-api-settings-controller/src/credentials.ts
 */

import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { CredentialInfo } from '@deepseek-ai/dsh-credentials/types'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'

/**
 * 单个远程 `describe` 批次的扇出上限。设置页只询问它自己的行所提到的
 * 引用，因此该上限远高于任何真实页面，同时仍能防止单个已认证请求
 * 启动无界的提供方工作。
 */
const MAX_DESCRIBE_REFS = 64

const credentialRefSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
const describeRequestSchema = z.object({
  refs: z.array(credentialRefSchema).max(MAX_DESCRIBE_REFS),
})
const setRequestSchema = z.object({ ref: credentialRefSchema, value: z.string().min(1) })
const unsetRequestSchema = z.object({ ref: credentialRefSchema })

/** 解析比生成的 TypeScript 编解码器更具体的域约束。 */
function parseRequest<T>(method: string, schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new RemoteError('gateway/bad-request', `invalid payload for ${method}`, { issues: parsed.error.issues })
  }
  return parsed.data
}

/**
 * 恰好复制 {@link CredentialInfo} 声明的字段。Gateway 返回业务结果时
 * 不做解码，因此若提供方的 `describe` 携带额外的可枚举属性，它们就会
 * 被序列化给调用方。
 * @param info - 提供方对一个引用的回答。
 * @returns 相同的事实，不附加任何其他内容。
 */
function projectCredentialInfo(info: CredentialInfo): CredentialInfo {
  return {
    configured: info.configured,
    ...info.source === undefined ? {} : { source: info.source },
    writable: info.writable,
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** `credentials` Remote 命名空间的 Host 拥有者。 */
    credentialsController: CredentialsController
  }
}

/**
 * 支撑生成的 `ctx.remote.credentials` 命名空间的 Host 服务。它承担凭据接缝
 * 本身不承担的每项 wire 义务：批次扇出上限、逐字段的视图投影、引用
 * 文法守卫，以及拒绝映射。秘密值只单向穿越——此处的任何方法都不
 * 返回它。
 */
export class CredentialsController extends TypertRemoteService {
  /** @param ctx - 可挂载凭据提供方的 Host 上下文。 */
  constructor(ctx: Context) {
    super(ctx, 'credentialsController', { namespace: 'credentials' })
  }

  /**
   * 为一个配置界面描述多个引用。之所以批量，是因为设置页一次性描述
   * 它的各行提到的所有引用，一次往返能让这些行不会各自分别落定。
   * @param refs - 引用名称，至多 {@link MAX_DESCRIBE_REFS} 个；文法之外的名称
   *   会以 `gateway/bad-request` 拒绝整个调用。
   * @returns 每个请求的名称一个视图，以该名称为键。
   * @throws RemoteError 请求无效或未挂载凭据提供方时抛出。
   */
  @Remote
  async describe(refs: string[]): Promise<Record<string, CredentialInfo>> {
    const request = parseRequest('credentials.describe', describeRequestSchema, { refs })
    const branded = request.refs.map(ref => [ref, credentialRef(ref)] as const)
    const credentials = this.provider()
    const entries = await Promise.all(branded.map(async ([ref, key]) =>
      [ref, projectCredentialInfo(await credentials.describe(key))] as const))
    return Object.fromEntries(entries)
  }

  /**
   * 从配置界面存储一个值。该值只沿此方向穿越 wire：没有任何读取
   * 路径会返回它。
   * @param ref - 要存储到的引用名称。
   * @param value - 非空的秘密值。
   * @throws RemoteError 请求无效、未挂载提供方或提供方拒绝写入时抛出。
   */
  @Remote
  async set(ref: string, value: string): Promise<void> {
    const request = parseRequest('credentials.set', setRequestSchema, { ref, value })
    const branded = credentialRef(request.ref)
    const credentials = this.provider()
    await this.write(request.ref, () => credentials.set(branded, request.value))
  }

  /**
   * 从配置界面移除一个引用。
   * @param ref - 要移除的引用名称。
   * @throws RemoteError 请求无效、未挂载提供方或提供方拒绝写入时抛出。
   */
  @Remote
  async unset(ref: string): Promise<void> {
    const request = parseRequest('credentials.unset', unsetRequestSchema, { ref })
    const branded = credentialRef(request.ref)
    const credentials = this.provider()
    await this.write(request.ref, () => credentials.unset(branded))
  }

  /** 解析可选的提供方，或报告如何提供它。 */
  private provider(): CredentialProvider {
    const credentials = this.ctx.get('credentials')
    if (credentials === undefined) {
      throw new RemoteError(
        'gateway/internal',
        'credentials service is absent: this deployment does not mount a credential provider (e.g. @deepseek-ai/dsh-credentials-local) in its composition',
        {},
      )
    }
    return credentials
  }

  /**
   * 执行一次远程写入，并把每种拒绝都报告为携带接缝自身消息的
   * `credential/rejected`：提供方拒绝（例如已存储的文档不再能解析）
   * 正是设置页必须逐字展示的内容。调用方在进入之前先对引用做
   * 品牌化处理，因此文法之外的名称永远不会到达此路径，且以与读取侧
   * 相同的方式失败。details 只给出引用，因此任何失败路径都无法把
   * 值带出去。
   */
  private async write(ref: string, write: () => Promise<void>): Promise<void> {
    try {
      await write()
    } catch (error: unknown) {
      throw new RemoteError(
        'credential/rejected',
        error instanceof Error ? error.message : String(error),
        { ref },
        { cause: error },
      )
    }
  }
}

export default CredentialsController
