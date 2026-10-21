/**
 * `grep` 与 `glob` 的结果时刻搜索卡片展示。两个工具都落在同一个 `card: 'search'`
 * 渲染意图（{@link SearchResultView}）上，并有以 `shape` 区分的两个变体：`grep` 投影出
 * 按文件分组的命中（{@link SearchMatchesResultView}），`glob` 投影出一个扁平的路径列表
 * （{@link SearchPathsResultView}）。本模块负责各工具声明的 value→`presentationMeta`
 * 投影，以及各工具 `presentResult` 在重放时读回的、防御性的 `meta`→view 收窄。
 *
 * 规范值永远不会跨过线路 —— 只有面向模型的渲染文本与这份 JSON `meta` 会 ——
 * 因此一个 UI 渲染所用的结构化形状**必须**搭载在 `meta` 里。每个投影消费的都是
 * 面向模型渲染所消费的**同一份**保留后的命中/路径
 * （{@link module:@deepseek-ai/dsh-tool-fs-search/search-core} 的
 * `retainGrepMatches`/`retainGlobPaths`），因此文本与卡片在"哪些结果跨过了内联上限"上
 * 保持一致，并上报 `total`（搜索到的全部结果）与 `truncated`，
 * 使 UI 永远不会把一个被截断的结果呈现为完整结果。
 *
 * 还有第二个、独立的上限专门约束这份 JSON `meta` 本身：一次宽泛搜索保留下来的命中
 * （几百条长行）仍可能序列化出几百 KB，而 `meta` 会随会话日志持久化并在每次请求时被
 * 重新发送。{@link capMetaBytes} 会丢弃尾部的分组/路径，直到序列化后的 `meta`
 * 装进 `maxMetaBytes`，并把结果标记为 `truncated`；而一个部署的最终输出预算
 * （`dsh-spill-policy`）只会缩减 `content`，永不缩减 `meta`，
 * 因此保持 `meta` 有界是这份投影的职责。
 *
 * @module @deepseek-ai/dsh-tool-fs-search/presentation
 */

import type {
  SearchFileMatches,
  SearchLineMatch,
  SearchResultView,
} from '@deepseek-ai/dsh-tools'
import type { RetainedItems } from '@deepseek-ai/dsh-output-retention'
import type { GrepMatch } from './search-core.ts'

/**
 * meta 投影所读取的保留字段：保留下来的那一页、完整结果是否被截断，
 * 以及施加上限之前的总数。完整的 {@link RetainedItems}（来自 `retainGrepMatches`）
 * 与 `glob` 的采样页都满足这个结构化子集，因此一个投影可以在不伪造
 * `kept`/`omitted` 的情况下消费其中任意一种。
 */
type RetainedPage<T> = Pick<RetainedItems<T>, 'items' | 'truncated' | 'seen'>

/**
 * `grep`/`glob` 工具私有的 `tool/result` `meta` 载荷：被截断的、结构化的搜索结果。
 * 它以不透明形式（作为 `JsonValue`）挂在工具结果上并随会话日志持久化，
 * 这样 `presentResult` 才能在重放时复现搜索卡片。`matches` 形状承载按文件分组的结果，
 * `paths` 形状承载扁平列表。两者都带有施加上限之前的 `total` 与 `truncated` 标志。
 * 产出该结果的工具拥有并收窄这个不透明结构。
 *
 * 成员形状使用的是对象字面量的 `type` 别名，而不是
 * {@link SearchFileMatches}/{@link SearchLineMatch} 接口，因为只有类型别名才能赋值给
 * `presentationMeta` 所返回的 `JsonValue` 索引签名；两者在结构上完全一致，
 * 因此投影出来的值读回来仍然是一个 {@link SearchResultView}。
 */
export type SearchMeta =
  | { shape: 'matches'; files: MetaFileMatches[]; truncated: boolean; total: number }
  | { shape: 'paths'; paths: string[]; truncated: boolean; total: number }

/** {@link SearchMeta} 中的一条命中行（{@link SearchLineMatch} 的可赋值给 JSON 的形式）。 */
type MetaLineMatch = { lineNumber: number; line: string }

/** {@link SearchMeta} 中一个文件的分组命中（{@link SearchFileMatches} 的可赋值给 JSON 的形式）。 */
type MetaFileMatches = { path: string; matches: MetaLineMatch[] }

/**
 * 把扁平的命中按文件（首次出现顺序）分组，形成 UI 会渲染成"每个文件一个可展开分组"的结构化
 * 按文件形状。该分组与面向模型文本的分组一致
 * （{@link module:@deepseek-ai/dsh-tool-fs-search/grep} 的 `formatGrepMatches`），
 * 因此卡片与文本在文件顺序与成员组成上保持一致。
 *
 * @param matches - 待分组的保留命中，按输出顺序排列。
 * @returns 每个文件一个条目，按首次出现顺序排列。
 */
export function groupMatchesByFile(matches: GrepMatch[]): MetaFileMatches[] {
  const byFile = new Map<string, MetaLineMatch[]>()
  for (const match of matches) {
    const entry: MetaLineMatch = { lineNumber: match.lineNumber, line: match.line }
    const group = byFile.get(match.path)
    if (group !== undefined) group.push(entry)
    else byFile.set(match.path, [entry])
  }
  return Array.from(byFile, ([path, fileMatches]) => ({ path, matches: fileMatches }))
}

/** 一份 meta 载荷序列化后的 UTF-8 字节大小（即被持久化并重新发送的大小）。 */
function metaBytes(meta: SearchMeta): number {
  return Buffer.byteLength(JSON.stringify(meta), 'utf8')
}

/**
 * 丢弃尾部的顶层条目（文件分组或路径），直到序列化后的 meta 装进 `maxMetaBytes`；
 * 只要有东西被丢弃就把结果标记为 `truncated`。`total` 保持不变
 * （它统计的是搜索找到了多少，而不是 meta 保留了多少）。
 * 单个大到自身都装不下的条目会被保留：不变式是"凡是能丢的地方就保持载荷有界"，
 * 而不是给出一张掩盖真实结果的空卡片。
 *
 * @param meta - 已投影出来的 meta，已按内联条目数截断。
 * @param maxMetaBytes - 序列化后 meta 的字节预算。
 * @returns 装得下时就返回同一份 meta，否则返回一份按字节设界并标记了 `truncated` 的副本。
 */
function capMetaBytes(meta: SearchMeta, maxMetaBytes: number): SearchMeta {
  if (metaBytes(meta) <= maxMetaBytes) return meta
  if (meta.shape === 'matches') {
    const files = [...meta.files]
    while (files.length > 1 && metaBytes({ ...meta, files, truncated: true }) > maxMetaBytes) files.pop()
    return { ...meta, files, truncated: true }
  }
  const paths = [...meta.paths]
  while (paths.length > 1 && metaBytes({ ...meta, paths, truncated: true }) > maxMetaBytes) paths.pop()
  return { ...meta, paths, truncated: true }
}

/**
 * 把保留下来的 `grep` 命中投影成搜索卡片所用的 {@link SearchMeta}。它消费的是面向模型渲染
 * 所消费的**同一份** {@link RetainedItems}（预览预算与内联命中上限都已施加），
 * 把保留下来的命中按文件分组，上报 `total`（全部已解析命中）与 `truncated`，
 * 然后把序列化后的 meta 限制到 `maxMetaBytes`。
 *
 * @param retained - 针对全部已解析命中的保留结果（已预览、已截断）。
 * @param maxMetaBytes - 序列化后 meta 的字节预算。
 * @returns `matches` 形状的搜索元数据。
 */
export function grepSearchMeta(retained: RetainedPage<GrepMatch>, maxMetaBytes: number): SearchMeta {
  const meta: SearchMeta = {
    shape: 'matches',
    files: groupMatchesByFile(retained.items),
    truncated: retained.truncated,
    total: retained.seen,
  }
  return capMetaBytes(meta, maxMetaBytes)
}

/**
 * 把保留下来的 `glob` 路径投影成搜索卡片所用的 {@link SearchMeta}。它消费的是面向模型渲染
 * 所消费的同一份 {@link RetainedItems}（内联路径上限已施加），上报 `total`
 * （全部发现的路径）与 `truncated`，然后把序列化后的 meta 限制到 `maxMetaBytes`。
 *
 * @param retained - 针对全部发现路径的保留结果（已截断）。
 * @param maxMetaBytes - 序列化后 meta 的字节预算。
 * @returns `paths` 形状的搜索元数据。
 */
export function globSearchMeta(retained: RetainedPage<string>, maxMetaBytes: number): SearchMeta {
  const meta: SearchMeta = {
    shape: 'paths',
    paths: retained.items,
    truncated: retained.truncated,
    total: retained.seen,
  }
  return capMetaBytes(meta, maxMetaBytes)
}

/** `value` 是否为合法的 {@link SearchLineMatch}（从不透明的 `meta` 做防御性收窄）。 */
function isSearchLineMatch(value: unknown): value is SearchLineMatch {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const { lineNumber, line } = value as Record<string, unknown>
  return typeof lineNumber === 'number' && typeof line === 'string'
}

/** `value` 是否为合法的 {@link SearchFileMatches}（从不透明的 `meta` 做防御性收窄）。 */
function isSearchFileMatches(value: unknown): value is SearchFileMatches {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const { path, matches } = value as Record<string, unknown>
  return typeof path === 'string' && Array.isArray(matches) && matches.every(isSearchLineMatch)
}

/**
 * 把不透明的实时或重放结果元数据收窄为一个 {@link SearchResultView}。元数据格式有误时返回
 * `undefined`，使 `presentResult` 可以回退到通用卡片，而不是在重放一段更老的或被手工编辑
 * 过的日志时抛错。该视图不携带任何结果文本：没有搜索卡片的 UI 会回退到原始的
 * `tool/result` 内容。
 *
 * 零结果的 meta（`files: []` / `paths: []`）会收窄成一张合法的空卡片 ——
 * 这与镜像存在的 `diffsFromMeta`（它拒绝空的 diff）不同，因为一次零命中的 grep
 * 是一个合法结果，UI 把它显示为"没有命中"，而不是一个缺失的投影。
 *
 * @param meta - 结果元数据（即该工具投影出的 {@link SearchMeta}）。
 * @returns 搜索视图；元数据缺失或格式有误时为 `undefined`。
 */
export function searchViewFromMeta(meta: unknown): SearchResultView | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const record = meta as Record<string, unknown>
  const { truncated, total } = record
  if (typeof truncated !== 'boolean' || typeof total !== 'number') return undefined
  if (record.shape === 'matches') {
    const { files } = record
    if (!Array.isArray(files) || !files.every(isSearchFileMatches)) return undefined
    return { card: 'search', shape: 'matches', files: files, truncated, total }
  }
  if (record.shape === 'paths') {
    const { paths } = record
    if (!Array.isArray(paths) || !paths.every((path): path is string => typeof path === 'string')) return undefined
    return { card: 'search', shape: 'paths', paths, truncated, total }
  }
  return undefined
}
