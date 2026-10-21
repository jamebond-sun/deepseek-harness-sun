/**
 * LSP 能力接缝（`ctx.lsp`）的服务定义：一个语言服务 provider 注册表，以及对规范化的
 * goToDefinition/findReferences/goToImplementation/hover 查询的逐次、与顺序无关的选择。
 *
 * provider 原子地预留一个品牌化 id 和一组独占的文件扩展名：{@link Lsp.registerProvider}
 * 在改动任何状态之前完成全部校验与冲突检查，因此非法或冲突的注册不会发布任何内容，
 * 其 disposer 也会一并释放全部预留。选择按文件的最后一个扩展名路由查询，
 * 绝不依赖注册顺序。该接缝恰好暴露这四个操作，没有 JSON-RPC 逃逸口。
 * @module @deepseek-ai/dsh-lsp
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { LspProviderId } from './brand.ts'
import type {
  LspProvider,
  LspQueryRequest,
  LspQueryResult,
  LspService,
} from './types.ts'

export { LspProviderId } from './brand.ts'
export type {
  LspHover,
  LspLocation,
  LspOperation,
  LspPosition,
  LspProvider,
  LspProviderQuery,
  LspQueryRequest,
  LspQueryResult,
  LspRange,
  LspService,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    lsp: LspService
  }
}

/**
 * 结构化的 LSP 失败。在 {@link HarnessError} 之上带一个稳定的 `code`
 * （`LSP_INVALID_PROVIDER`、`LSP_CONFLICT`、`LSP_UNAVAILABLE`、`LSP_DISPOSED`、
 * `LSP_UNSUPPORTED_OPERATION`、`LSP_MALFORMED_RESPONSE` 等），调用方据此路由，
 * 而不是去解析 `message`。
 */
export class LspError extends HarnessError {}

/**
 * 提取文件的最后一个扩展名，作为规范化的、小写的、带前导点的键（例如 `Foo.TS` → `.ts`、
 * `foo.d.ts` → `.ts`）。对没有扩展名的文件名或以点开头的 dotfile（`.bashrc`）返回 `''`，
 * 任何路由都不会匹配它。同时按 `/` 与 `\` 切分，使调用方的路径分隔符不影响结果。
 * @param filePath - 要检查的源码路径。
 * @returns 规范化的扩展名，没有时返回 `''`。
 */
export function finalExtension(filePath: string): string {
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  const base = lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath
  const dot = base.lastIndexOf('.')
  // dot <= 0 同时覆盖“没有点”（-1）与以点开头的 dotfile（0）：两者都没有扩展名。
  if (dot <= 0) return ''
  return base.slice(dot).toLowerCase()
}

/** 一个格式良好的规范化扩展名：一个点后跟一个或多个非点、非分隔符的字符。 */
const EXTENSION_PATTERN = /^\.[^./\\]+$/

/** 一条选择路由：要运行的 provider，以及与之同步文档所用的语言 id。 */
interface Route {
  readonly provider: LspProvider
  readonly languageId: string
}

/**
 * `ctx.lsp`。持有 id 预留与“扩展名→路由”表；二者按 provider 一起填充、一起清理，
 * 因此一条路由总是对应一个存活的 provider。
 */
export class Lsp extends Service implements LspService {
  private readonly providerIds = new Set<LspProviderId>()
  private readonly routes = new Map<string, Route>()

  constructor(ctx: Context) {
    super(ctx, 'lsp')
  }

  registerProvider(provider: LspProvider): () => void {
    // 在任何状态改动之前完成全部校验与冲突检查：非法或冲突的注册不得发布任何内容
    // （失败即报，全有或全无）。
    const id = provider.id
    if (id.trim() === '') {
      throw new LspError('an LSP provider id must be a non-empty string', 'LSP_INVALID_PROVIDER')
    }
    if (this.providerIds.has(id)) {
      throw new LspError(`an LSP provider with id "${id}" is already registered`, 'LSP_CONFLICT')
    }

    const entries = Object.entries(provider.extensionToLanguage)
    if (entries.length === 0) {
      throw new LspError(`LSP provider "${id}" registers no file extensions`, 'LSP_INVALID_PROVIDER')
    }

    // 归一化进本 provider 的路由集合，先捕捉 provider 内部的重复项（例如 `.TS` 与 `.ts`），
    // 再检查跨 provider 的冲突。
    const pending = new Map<string, Route>()
    for (const [rawExt, languageId] of entries) {
      const ext = normalizeExtension(rawExt)
      if (!EXTENSION_PATTERN.test(ext)) {
        throw new LspError(`LSP provider "${id}" maps an invalid extension "${rawExt}"`, 'LSP_INVALID_PROVIDER')
      }
      if (languageId.trim() === '') {
        throw new LspError(`LSP provider "${id}" maps extension "${ext}" to an empty language id`, 'LSP_INVALID_PROVIDER')
      }
      if (pending.has(ext)) {
        throw new LspError(`LSP provider "${id}" maps extension "${ext}" more than once`, 'LSP_INVALID_PROVIDER')
      }
      pending.set(ext, { provider, languageId })
    }
    for (const ext of pending.keys()) {
      if (this.routes.has(ext)) {
        throw new LspError(`extension "${ext}" is already handled by another LSP provider`, 'LSP_CONFLICT')
      }
    }

    // 全部检查通过：在一个生命周期控制器中同时预留 id 与每一个扩展名，
    // 以便销毁时一并释放。
    const dispose = this.ctx.effect(function* (this: Lsp) {
      this.providerIds.add(id)
      for (const [ext, route] of pending) this.routes.set(ext, route)
      yield () => {
        this.providerIds.delete(id)
        for (const ext of pending.keys()) this.routes.delete(ext)
      }
    }.bind(this), 'lsp.registerProvider()')
    // ctx.effect 的 disposer 返回 Promise<void>；我们的 disposer API 是同步的
    // 即发即忘——丢弃这个（总是已 resolve 的）promise。
    return () => void dispose()
  }

  async query(request: LspQueryRequest, signal?: AbortSignal): Promise<LspQueryResult> {
    const route = this.routes.get(finalExtension(request.filePath))
    if (route === undefined) {
      throw new LspError(`no LSP provider handles "${request.filePath}"`, 'LSP_UNAVAILABLE')
    }
    return route.provider.query({ ...request, languageId: route.languageId }, signal)
  }
}

/** 小写化扩展名并确保其带前导点；其余格式问题由 `EXTENSION_PATTERN` 拒绝。 */
function normalizeExtension(ext: string): string {
  const lower = ext.toLowerCase()
  return lower.startsWith('.') ? lower : `.${lower}`
}

export default Lsp
