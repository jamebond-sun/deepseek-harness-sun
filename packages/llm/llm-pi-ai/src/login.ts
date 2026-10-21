/**
 * 为那些自带登录能力的 pi-ai 提供方提供的授权流程。这就是 harness 中立的
 * 通知/提示词汇与 pi-ai 的 `AuthInteraction` 之间的全部翻译；
 * 它之上的任何东西都不知道是哪个库在跑这场对话。
 *
 * @module dsh-llm-pi-ai/login
 */

import type { AuthEvent, AuthPrompt, AuthType, Provider } from '@earendil-works/pi-ai'
import type { Context } from '@deepseek-ai/cordis'
import type { AuthorizationMethod, AuthorizationPrompt, AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import { isCredentialKeySegment } from '@deepseek-ai/dsh-credentials'
import { catalogProvider, catalogProviderIds } from './catalog.ts'
import { recordKeyFor } from './auth.ts'
import type { PiAiAuthInjection } from './adapter.ts'
import { createModels } from './models.ts'

/**
 * 本适配器不提供其 OAuth 登录的那些目录提供方。pi-ai 的
 * Sign in with ChatGPT（`openai`）用一个稳定的 UUID 向 OpenAI 标识本次
 * 安装，而该 UUID 是由应用通过 `LoginOptions.getDeviceId` 提供的，
 * 并且缺少它时它会拒绝启动。harness 不保留任何用于第三方账号登录的
 * 安装 ID，因此该路由用 API 密钥登录。
 */
const UNSERVED_OAUTH: ReadonlySet<string> = new Set(['openai'])

/**
 * 一个目录提供方所提供的登录方式。
 *
 * 某种方式只会在 pi-ai 真的能运行它时出现：除了 {@link UNSERVED_OAUTH}
 * 中的那些提供方之外，`oauth` 携带一个无需应用提供登录选项就能运行的
 * `login`；而一个 api-key 方式只有在该提供方交互式地收集它的密钥时
 * 才有——当前每一个已安装的提供方都是如此，因此密钥是被键入 pi-ai
 * 自己的提示，而不是被键入设置表单。
 * @param provider - 已安装的目录提供方，当 pi-ai 自带一个时。
 * @returns 它的各种方式，最被偏好的在前；当它不提供任何登录时为空。
 */
function loginMethods(provider: Provider | undefined): AuthorizationMethod[] {
  const methods: AuthorizationMethod[] = []
  const oauth = provider === undefined || UNSERVED_OAUTH.has(provider.id) ? undefined : provider.auth.oauth
  if (oauth !== undefined) methods.push({ id: 'oauth', label: oauth.loginLabel ?? oauth.name })
  const apiKey = provider?.auth.apiKey
  if (apiKey?.login !== undefined) methods.push({ id: 'api-key', label: apiKey.name })
  return methods
}

/**
 * 用该接缝的词汇复述一个 pi-ai 登录事件。
 *
 * 一次设备码授权是唯一同时携带人类所需的两件事的事件——要去哪里，
 * 以及在那里输入什么——这正是那个中立的通知在它的 `url` 旁边有一个
 * `code`，而不是把该码折进消息里的原因。
 * @param event - pi-ai 报告了什么。
 * @param session - 要向哪一次尝试报告它。
 */
function relay(event: AuthEvent, session: AuthorizationSession): void {
  switch (event.type) {
    case 'info': {
      const link = event.links?.[0]
      session.notify({ message: event.message, ...link === undefined ? {} : { url: link.url } })
      return
    }
    case 'auth_url':
      session.notify({
        message: event.instructions ?? 'Open this page to continue signing in.',
        url: event.url,
      })
      return
    case 'device_code':
      session.notify({
        message: 'Enter this code on the verification page to finish signing in.',
        url: event.verificationUri,
        code: event.userCode,
      })
      return
    case 'progress':
      session.notify({ message: event.message })
      return
    default:
      // pi-ai 的事件联合对新的成员保持开放：一个遇到了它不认识的
      // 成员的构建仍然会让人类看到正在发生什么，而不是在登录中途沉默。
      session.notify({ message: 'Signing in…' })
  }
}

/**
 * 用该接缝的词汇复述一个 pi-ai 提示。
 *
 * `manual_code` 变成一个普通的文本问题，因为 pi-ai 所划出的那个区别——
 * 一个人类从浏览器复制来的码，与一个他们已知的值——对任何界面渲染出来的
 * 东西都没有改变。它自己的 `signal` 被一路带过来，而那才是要紧的部分：
 * 正是一个让一个键入的码与一个浏览器回调竞速的流程，撤回落败的那个
 * 问题的方式。
 * @param prompt - pi-ai 问了什么。
 * @returns 要交给人类的、中立的提示。
 */
function restate(prompt: AuthPrompt): AuthorizationPrompt {
  const signal = prompt.signal === undefined ? {} : { signal: prompt.signal }
  switch (prompt.type) {
    case 'select':
      return { ...signal, kind: 'select', message: prompt.message, options: prompt.options }
    case 'secret':
      return {
        ...signal,
        kind: 'secret',
        message: prompt.message,
        ...prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder },
      }
    default:
      return {
        ...signal,
        kind: 'text',
        message: prompt.message,
        ...prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder },
      }
  }
}

/**
 * 为每个自带登录能力的已安装提供方注册一个授权流程。
 *
 * 注册不取决于配置：一个提供方必须先被登录，为它添加一条路由才有意义，
 * 因此该流程从插件挂载的那一刻起就存在，而不是在某个 profile 出现之后
 * 才出现。
 * @param ctx - 携带 `ctx.authorization` 的插件上下文。
 * @param auth - 此处每个集合构建时所用的那些注入项。
 */
export function registerPiAiFlows(ctx: Context, auth: PiAiAuthInjection): void {
  for (const providerId of catalogProviderIds()) {
    const provider = catalogProvider(providerId)
    const [first, ...rest] = loginMethods(provider)
    /* v8 ignore next 3 -- 这里的每个 id 都指名一个已安装的提供方，而每个已安装的
       提供方都自带登录，因此没有任何条目被跳过；这个守卫是为了在其中任一
       条件不再成立时，防止它变成一次崩溃。 */
    if (provider === undefined || first === undefined) continue
    /* v8 ignore next 7 -- 每个已安装的目录 id 都是一个小写连字符标识符；
       这个守卫防止上游将来某个处于记录语法之外的 id（点分的或含大写的，
       正如别处厂商 id 已经出现的那样）在 `recordKeyFor` 中抛错，
       从而导致整个挂载失败。 */
    if (!isCredentialKeySegment(providerId)) {
      ctx.logger.warn(
        'llm-pi-ai: catalog provider "%s" cannot address a credential record; its sign-in is not offered',
        providerId)
      continue
    }
    ctx.authorization.registerFlow({
      key: recordKeyFor(providerId),
      label: provider.name,
      methods: [first, ...rest],
      async run(session) {
        // 它自己的一个集合，只持有正在被登录的那个提供方：
        // 登录不是在服务请求，而它所产生的凭据无论如何都会落到那个共享存储中。
        const models = createModels(auth)
        models.setProvider(provider)
        // 即上面声明的那两个 id 之和，而该接缝只会交回某个流程声明过的其中一个。
        const type: AuthType = session.method === 'oauth' ? 'oauth' : 'api_key'
        // pi-ai 通过同一个存储持久化登录所返回的东西，
        // 而正是这一点让它成为本记录的唯一写入者。
        await models.login(providerId, type, {
          signal: session.signal,
          notify: (event) => { relay(event, session) },
          prompt: prompt => session.prompt(restate(prompt)),
        })
      },
    })
  }
}
