/** 账号目录：版本门禁、本构建的模型知识，以及部署覆盖项。 */
import semver from 'semver'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import type { DeepSeekCatalogModel } from '@deepseek-ai/dsh-llm-deepseek'
import type { ModelOverride } from './config.ts'
import type { ListedFacts, ListingEntry } from './listing.ts'

/** 本构建在网络 I/O 之前拒绝某个已列出模型的原因。 */
export type CatalogRefusal =
  | { readonly kind: 'upgrade-required'; readonly requiredVersion: string }
  | { readonly kind: 'unsupported' }

/** 一次目录解析的输入。 */
export interface AccountCatalogInput {
  /** 最近一次成功清单的条目；在成功之前为 `undefined`。 */
  readonly listing: readonly ListingEntry[] | undefined
  /** 本构建支持的、已校验的模型，携带其客户端侧知识。 */
  readonly supported: readonly DeepSeekCatalogModel[]
  /** 按模型 id 组织的覆盖项，只保存各自声明的字段。 */
  readonly overrides: Readonly<Record<string, ModelOverride>>
  /** 路由输出上限，已列出的输出能力会受其约束。 */
  readonly routeMaxTokens: number
  /** 本构建的语义化版本。 */
  readonly clientVersion: string
}

/** 一个已解析的账号目录。 */
export interface AccountCatalog {
  /** 按清单顺序排列的可选模型；当没有清单成功时，为本构建自带的模型。 */
  readonly offered: readonly DeepSeekCatalogModel[]
  /** 请求解析所查阅的条目：可提供的模型，以及清单未提供但本构建支持的模型。 */
  readonly resolution: readonly DeepSeekCatalogModel[]
  /** 在网络 I/O 之前被拒绝的已列出模型，按 id 组织。 */
  readonly refusals: ReadonlyMap<string, CatalogRefusal>
  /** 因其声明不可读或不可用而被隐藏的清单条目。 */
  readonly problems: readonly string[]
  /** `modelOverrides` 的配置诊断信息。 */
  readonly overrideErrors: readonly string[]
}

/** 替换一个条目的字段；纯文本的结果会丢掉它所继承的图像限制。 */
function layered(model: DeepSeekCatalogModel, layer: ModelOverride): DeepSeekCatalogModel {
  const merged: DeepSeekCatalogModel = { ...model, ...layer }
  if (merged.inputModalities?.includes('image') !== true) {
    if (layer.imagePixelBudget === undefined) delete merged.imagePixelBudget
    if (layer.imageMaxBytes === undefined) delete merged.imageMaxBytes
  }
  return merged
}

/** 把一条可用的清单条目叠加到本构建中同 id 的条目之上。 */
function listed(base: DeepSeekCatalogModel, entry: ListingEntry, facts: ListedFacts, routeMaxTokens: number): DeepSeekCatalogModel {
  const { systemPromptUpdate: _replaced, ...leadingOnly } = base
  return layered(facts.systemPromptUpdate === 'leading-only' ? leadingOnly : base, {
    ...entry.name === undefined ? {} : { name: entry.name },
    ...facts.contextWindow === undefined ? {} : { contextWindow: facts.contextWindow },
    ...facts.maxOutputTokens === undefined ? {} : { maxTokens: Math.min(routeMaxTokens, facts.maxOutputTokens) },
    ...facts.systemPromptUpdate === 'in-history' ? { systemPromptUpdate: 'in-history' as const } : {},
    inputModalities: [...facts.inputModalities],
  })
}

function gateOf(entry: ListingEntry, known: boolean, clientVersion: string, problems: string[]): CatalogRefusal | undefined {
  const requirement = entry.requirement
  switch (requirement.kind) {
    case 'none':
      return known ? undefined : { kind: 'unsupported' }
    case 'min-version':
      if (semver.valid(requirement.version) === null) break
      return semver.gte(clientVersion, requirement.version)
        ? undefined
        : { kind: 'upgrade-required', requiredVersion: requirement.version }
    case 'invalid':
      break
    /* v8 ignore next 2 -- 清单解码只会产生这个封闭的要求联合 */
    default:
      return assertNever(requirement, 'model listing client requirement')
  }
  problems.push(`model "${entry.id}" declares an unreadable client requirement`)
  return { kind: 'unsupported' }
}

/**
 * 解析账号目录。已声明的最低客户端版本决定某个已列出模型是否可用；
 * 没有该声明时，只有本构建支持的模型会被提供，其余已列出的模型保持隐藏。
 * @param input - 清单、受支持的模型、覆盖项、路由上限，以及本构建的版本。
 * @returns 可提供的模型、请求解析条目、拒绝原因与诊断信息。
 */
export function resolveAccountCatalog(input: AccountCatalogInput): AccountCatalog {
  const supported = new Map(input.supported.map(model => [model.id, model]))
  const problems: string[] = []
  const overrideErrors: string[] = []
  const withOverride = (model: DeepSeekCatalogModel): DeepSeekCatalogModel => {
    const override = input.overrides[model.id]
    if (override === undefined) return model
    const candidate = layered(model, override)
    try {
      resolveAdapterOptions({ models: [candidate] })
    } catch (error) {
      overrideErrors.push(`modelOverrides.${model.id} does not apply (${String(error)})`)
      return model
    }
    return candidate
  }
  if (input.listing === undefined) {
    const resolution = resolveAdapterOptions({ models: input.supported.map(withOverride) }).models
    return { offered: resolution, resolution, refusals: new Map(), problems, overrideErrors }
  }
  const offered: DeepSeekCatalogModel[] = []
  const refusals = new Map<string, CatalogRefusal>()
  for (const entry of input.listing) {
    const refusal = gateOf(entry, supported.has(entry.id), input.clientVersion, problems)
    if (refusal !== undefined) {
      refusals.set(entry.id, refusal)
      continue
    }
    if (!entry.capabilities.usable) {
      problems.push(`model "${entry.id}" ${entry.capabilities.reason}`)
      refusals.set(entry.id, { kind: 'unsupported' })
      continue
    }
    offered.push(withOverride(listed(supported.get(entry.id) ?? { id: entry.id }, entry, entry.capabilities.facts, input.routeMaxTokens)))
  }
  const offeredIds = new Set(offered.map(model => model.id))
  const listedIds = new Set(input.listing.map(entry => entry.id))
  for (const id of Object.keys(input.overrides)) {
    if (!listedIds.has(id) && !supported.has(id)) {
      overrideErrors.push(`modelOverrides names "${id}", which neither the account listing nor the built-in catalog describes`)
    }
  }
  const resolution = resolveAdapterOptions({
    models: [...offered, ...input.supported.filter(model => !offeredIds.has(model.id)).map(withOverride)],
  }).models
  return { offered: resolution.slice(0, offered.length), resolution, refusals, problems, overrideErrors }
}
