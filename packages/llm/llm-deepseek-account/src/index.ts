/** DeepSeek 账号路由的账号令牌认证、账号模型清单，以及版本门禁。 */
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { Context } from '@deepseek-ai/cordis'
import { ACCOUNT_QUOTA_EXCEEDED_CODE, APP_IDENTITY, LlmError, QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-deepseek-account'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { catalogModelInfo, registerDeepSeekProvider, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import type { DeepSeekRequestAuth, ResolvedDeepSeekOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { AccountModelCatalog } from './catalog.ts'
import type { CatalogView } from './catalog.ts'
import { Config, plainAccountOptions, resolveAccountOptions } from './config.ts'
import { requestModelListing } from './listing.ts'
import type { ModelListing } from './listing.ts'
import { resolveAccountCatalog } from './resolve-catalog.ts'
import type { AccountCatalog, CatalogRefusal } from './resolve-catalog.ts'

export { Config } from './config.ts'
export const name = 'llm-deepseek-account'
export const inject = ['llm']

const PROVIDER = 'deepseek-account'
/** 在 Messages、Files 与模型清单请求上携带账号令牌的请求头。 */
const TOKEN_HEADER = 'x-dsh-auth-token'
/** 清单诊断的控制台标签；产品 profile 不会为 `ctx.logger` 挂载控制台 exporter。 */
const LOG_TAG = '[llm-deepseek-account]'

/** 一次账号操作的连接事实：协议设置，以及随之解析出的目录。 */
interface AccountConnection extends ResolvedDeepSeekOptions {
  readonly catalog: AccountCatalog
}

function refuse(model: string, refusal: CatalogRefusal | undefined): void {
  if (refusal === undefined) return
  switch (refusal.kind) {
    case 'upgrade-required':
      throw new LlmError(
        `DeepSeek model "${model}" requires DeepSeek Harness ${refusal.requiredVersion} or later; current version is ${APP_IDENTITY.version}`,
        'CLIENT_UPGRADE_REQUIRED',
      )
    case 'unsupported':
      throw new LlmError(`DeepSeek model "${model}" is not supported by DeepSeek Harness; current version is ${APP_IDENTITY.version}`, 'MODEL_UNSUPPORTED')
    /* v8 ignore next 2 -- 目录解析只会产生这个封闭的拒绝联合 */
    default:
      assertNever(refusal, 'account catalog refusal')
  }
}

export function apply(ctx: Context, config: Config): void {
  const environment = launchEnvironmentOf(ctx)
  const settings = () => resolveAccountOptions(plainAccountOptions(config), environment)
  settings()
  const supported = resolveAdapterOptions({}).models
  const account = () => ctx.get('deepseekAccount')
  const resolveAuth = async (connection: ResolvedDeepSeekOptions): Promise<DeepSeekRequestAuth> => {
    const token = await account()?.resolveToken(connection.baseURL)
    if (token === undefined) throw new LlmError('Sign in to DeepSeek to use the account provider. The request destination must allow account authentication.', 'ACCOUNT_SIGN_IN_REQUIRED')
    return {
      headers: { [TOKEN_HEADER]: token },
      onRequestError: async (error) => {
        if (!(error instanceof LlmError)) return error
        if (error.code === QUOTA_EXCEEDED_CODE) {
          return new LlmError(error.message, ACCOUNT_QUOTA_EXCEEDED_CODE, { ...error.failure, cause: error })
        }
        if (error.failure.status !== 401) return error
        const rejected = new LlmError(error.message, 'ACCOUNT_TOKEN_INVALID', { ...error.failure, cause: error })
        try { await account()?.rejectToken(token) }
        catch (_credentialRemovalFailed) { /* 存储失败无法取代推理失败。 */ }
        return rejected
      },
    }
  }
  const catalog = new AccountModelCatalog({
    settings: () => settings().catalog,
    token: async url => account()?.resolveToken(url),
    load: (url, token, signal) => requestModelListing(url, { [TOKEN_HEADER]: token }, signal),
    now: () => Date.now(),
    info: (message) => { console.info(LOG_TAG, message) },
    warn: (message) => { console.warn(LOG_TAG, message) },
  })
  let loggedListing: ModelListing | undefined
  /** 为一个视图解析目录，并把该清单的隐藏条目按清单记录一次。 */
  const connectionOf = (view: CatalogView): AccountConnection => {
    const resolved = settings()
    const result = resolveAccountCatalog({
      listing: view.listing?.entries,
      supported,
      overrides: resolved.modelOverrides,
      routeMaxTokens: resolved.protocol.maxTokens,
      clientVersion: APP_IDENTITY.version,
    })
    if (view.listing !== loggedListing) {
      loggedListing = view.listing
      for (const problem of result.problems) console.warn(LOG_TAG, problem)
    }
    return { ...resolved.protocol, models: result.resolution, catalog: result }
  }
  const entry = { provider: PROVIDER, displayName: 'DeepSeek Account', settingsNs: ctx.fiber.entry?.options.id ?? name, settingsPath: [] }
  const directory = ctx.llm.registerConfigurableProviders([entry])
  let reportedError: string | undefined
  /** 在提供方目录上发布覆盖项的诊断信息。 */
  const discovered = (view: CatalogView): AccountConnection => {
    const connection = connectionOf(view)
    const error = connection.catalog.overrideErrors.length === 0 ? undefined : connection.catalog.overrideErrors.join('; ')
    if (error !== reportedError) {
      reportedError = error
      directory.replace([error === undefined ? entry : { ...entry, error }])
    }
    return connection
  }
  registerDeepSeekProvider<AccountConnection>(ctx, PROVIDER, {
    providerName: 'DeepSeek Account',
    options: () => connectionOf(catalog.current()),
    connect: async signal => connectionOf(await catalog.view(signal)),
    resolveAuth,
    admit: (connection, model) => { refuse(model, connection.catalog.refusals.get(model)) },
    discoverModels: async (provider) => {
      const view = await catalog.view()
      return view.signedIn ? discovered(view).catalog.offered.map(model => catalogModelInfo(provider, model)) : []
    },
  })
  ctx.effect(() => () => { catalog.dispose() }, 'llm-deepseek-account: model catalog')
}
