/**
 * 位于 pi-ai 的认证模型与 harness 凭据平面之间的三个适配器。
 * 每个 pi-ai 特有的概念都留在它们的这一侧：它们所消费的 harness 接缝——
 * `ctx.credentials` 的记录与 `ctx.authorization` 的流程——不指名来自
 * 本库的任何东西，因此另一个适配器家族可以以一种不同的认证模型到来，
 * 并共享同样的两个接缝。
 *
 * @module dsh-llm-pi-ai/auth
 */

import { homedir } from 'node:os'
import { access } from 'node:fs/promises'
import { resolve as resolvePath } from 'node:path'
import type { AuthContext, Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai'
import type { Context } from '@deepseek-ai/cordis'
import {
  credentialKey, credentialKeyId, credentialKeyScope, credentialRef, isCredentialKeySegment, isCredentialRefName,
} from '@deepseek-ai/dsh-credentials'
import type { CredentialKey, CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { LlmError } from '@deepseek-ai/dsh-llm'

/**
 * 本适配器家族所存储的每条凭据都写在它之下的那个记录作用域。
 * 它就是该插件的注册名，而正是这一点告诉后来的读取者——一个配置 UI，
 * 或服务于同一个提供方名称的第二个适配器家族——本插件持有该记录内部的格式。
 */
export const RECORD_SCOPE = 'llm-pi-ai'

/**
 * 某个 pi-ai 提供方 id 的记录地址。
 * @param providerId - pi-ai 自己的提供方 id，它同时也是 harness 的路由键。
 * @returns 本适配器家族读取与写入的、带作用域的凭据键。
 */
export function recordKeyFor(providerId: string): CredentialKey {
  return credentialKey(RECORD_SCOPE, providerId)
}

/**
 * 一个授权载荷的 JSON 映像：普通对象会丢掉它们那些显式为 undefined 的
 * 成员，而 JSON 无法容纳的数组条目会变成 null，与 `JSON.stringify`
 * 所渲染的完全一致。pi-ai 的凭据习惯上会把可选成员携带为显式的
 * `undefined`（一个 github.com Copilot 授权持有 `enterpriseUrl: undefined`），
 * 而凭据存储的严格校验器会把这当作不可表示而拒绝。其他一切——
 * 包括非有限的数字与外来的原型——都原样通过，因此一个真正无法存储的值
 * 仍然会在存储处响亮地失败。
 * @param value - 要渲染的值。
 * @returns 该值的 JSON 映像。
 */
function jsonImage(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(entry => entry === undefined ? null : jsonImage(entry))
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    const image: Record<string, unknown> = {}
    for (const [key, member] of Object.entries(value)) {
      if (member !== undefined) image[key] = jsonImage(member)
    }
    return image
  }
  return value
}

/**
 * 把一条已存储的记录翻译为 pi-ai 所期望的那条凭据。
 *
 * 一条 `api-key` 记录在两侧都是结构化的，因此它被逐字段重建。
 * 一个 `grant` 载荷是 pi-ai 自己的 OAuth 凭据，被逐字存储：
 * 该接缝把它当作不透明的 JSON，正是为了让一个持有某种令牌格式的库
 * 继续持有它——连同刷新字段在内。
 * @param record - 已存储的记录；当没有任何东西被存储时为该值缺失。
 * @returns 那条 pi-ai 凭据；对于缺失的记录为 undefined。
 */
function toPiCredential(record: CredentialRecord | undefined): Credential | undefined {
  if (record === undefined) return undefined
  if (record.kind === 'api-key') {
    return {
      type: 'api_key',
      ...record.key === undefined ? {} : { key: record.key },
      ...record.env === undefined ? {} : { env: { ...record.env } },
    }
  }
  return record.payload as Credential
}

/**
 * 把一条 pi-ai 凭据翻译为要存储的那条记录。
 * @param credential - 一次登录或刷新所产出的凭据。
 * @returns 要提交的那条记录，采用凭据接缝所存储的联合类型。
 */
function toRecord(credential: Credential): CredentialRecord {
  if (credential.type === 'api_key') {
    return {
      kind: 'api-key',
      ...credential.key === undefined ? {} : { key: credential.key },
      ...credential.env === undefined ? {} : { env: { ...credential.env } },
    }
  }
  return { kind: 'grant', payload: jsonImage(credential) }
}

/**
 * 那个凭据服务，或指名缺失之物的失败。读取在没有服务时回答
 * “没有存储任何东西”，因为一个没有凭据平面的组合确实不持有任何凭据；
 * 写入则会拒绝，因为一次其授权静默消失的登录会报告成功，
 * 然后让之后的每个请求都失败。
 * @param ctx - 插件上下文。
 * @returns 那个存活的服务。
 * @throws {LlmError} 当没有挂载任何服务时，错误码为 `NO_CREDENTIAL_STORE`。
 */
function writableStore(ctx: Context): CredentialProvider {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) {
    throw new LlmError(
      'llm-pi-ai: this composition mounts no credentials service, so there is nowhere to store the'
      + ' credential a sign-in produces; mount one (dsh-credentials-local) to sign in',
      'NO_CREDENTIAL_STORE',
    )
  }
  return credentials
}

/**
 * 一个架在 harness 凭据记录之上的 pi-ai `CredentialStore`。
 *
 * pi-ai 在 `modify()` *内部*运行 OAuth 刷新，因此本存储的排他范围
 * 必须覆盖一次网络往返，而不是一次文件重命名——这正是记录写入路径
 * 需要一个自己的等待上限、而不是本地写入所需的那个短上限的原因。
 *
 * pi-ai 会就集合中的每一个提供方询问本存储，手工声明的路由也包括在内，
 * 而一个路由键是任意的设置字典键，一个记录 id 却不是。处于记录语法之外的
 * id 永远不可能存储过一条记录，因此读取回答“没有存储任何东西”，
 * 而一次删除没有任何东西可移除；只有 `modify` 会拒绝它，因为一次无法
 * 落地的写入绝不能报告它已经落地。
 * @param ctx - 携带可选 `ctx.credentials` 的插件上下文。
 * @returns 要交给 `createModels()` 的那个存储。
 */
export function credentialStoreFrom(ctx: Context): CredentialStore {
  return {
    async read(providerId) {
      const credentials = ctx.get('credentials')
      if (credentials === undefined) return undefined
      if (!isCredentialKeySegment(providerId)) return undefined
      return toPiCredential(await credentials.readRecord(recordKeyFor(providerId)))
    },
    async list(): Promise<readonly CredentialInfo[]> {
      const stored = await ctx.get('credentials')?.listRecords() ?? []
      const mine: CredentialInfo[] = []
      for (const entry of stored) {
        // 由另一个插件持有的记录不是本集合应当报告的内容：
        // 它们的载荷写在一个 pi-ai 从未认可过的格式里。
        if (credentialKeyScope(entry.key) !== RECORD_SCOPE) continue
        mine.push({
          providerId: credentialKeyId(entry.key),
          type: entry.kind === 'api-key' ? 'api_key' : 'oauth',
        })
      }
      return mine
    },
    async modify(providerId, mutate) {
      if (!isCredentialKeySegment(providerId)) {
        throw new LlmError(
          `llm-pi-ai: provider id "${providerId}" cannot address a stored credential record (a record id is a`
          + ' lowercase hyphenated identifier); authenticate this route through apiKeyEnv instead of a stored'
          + ' credential',
          'UNSTORABLE_PROVIDER_ID',
        )
      }
      const stored = await writableStore(ctx).modifyRecord(recordKeyFor(providerId), async (current) => {
        const next = await mutate(toPiCredential(current))
        return next === undefined ? undefined : toRecord(next)
      })
      return toPiCredential(stored)
    },
    // 之所以是 `async`，是为了让一个缺失的服务以一次拒绝到达调用方：
    // pi-ai 的存储契约是返回 promise 的，而一次同步抛出会逃出
    // 每一次其他存储失败都会得到的那个 `ModelsError` 包装。
    async delete(providerId) {
      if (!isCredentialKeySegment(providerId)) return
      await writableStore(ctx).deleteRecord(recordKeyFor(providerId))
    },
  }
}

/**
 * 一个架在 harness 凭据平面与宿主文件系统之上的 pi-ai `AuthContext`。
 *
 * `env()` 首先从凭据接缝作答，因此一个由部署通过 harness 存储的值
 * 会被某个提供方自己的环境发现找到——没有这一点，那次发现只会读取
 * 进程环境，而一个已存储的 `AWS_ACCESS_KEY_ID` 对它就是不可见的。
 * `fileExists()` 回答的是宿主进程自己的文件系统，而不是工作区的
 * `ctx.fs` 接缝，因为它被问到的那些路径（`~/.aws/credentials`、
 * 应用默认凭据）是关于本进程在哪里运行的事实，而不是关于正在被编辑的
 * 那个项目的事实。
 * @param ctx - 携带可选 `ctx.credentials` 的插件上下文。
 * @returns 要交给 `createModels()` 的那个认证上下文。
 */
export function authContextFrom(ctx: Context): AuthContext {
  return {
    async env(name) {
      // pi-ai 会询问任意由提供方声明的名字；一个不是 POSIX 标识符的
      // 名字永远不可能作为一个引用被存储，而去询问该接缝会抛错，
      // 而不是回答“未设置”。
      if (isCredentialRefName(name)) {
        const credentials = ctx.get('credentials')
        const hit = await credentials?.resolve(credentialRef(name))
        if (hit !== undefined) return hit.value
      }
      return launchEnvironmentOf(ctx).get(name)?.value
    },
    async fileExists(path) {
      const expanded = path.startsWith('~/') || path === '~'
        ? resolvePath(homedir(), path.slice(1).replace(/^\//, ''))
        : path
      try {
        await access(expanded)
        return true
      } catch {
        // 不存在、不可读，或一个损坏的符号链接——其中任何一种都意味着
        // 这个环境凭据来源无法被使用，而这也正是调用方所做的唯一区分。
        return false
      }
    },
  }
}
