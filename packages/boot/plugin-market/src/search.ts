/** 对一份已校验索引中插件的过滤、模糊文本匹配与排序。 */
import MiniSearch from 'minisearch'
import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'
import type { MarketDeclaration, MarketIndex, MarketPlugin } from '@deepseek-ai/dsh-plugin-market-index'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { MarketQuery } from './types.ts'

/**
 * CJK 文字所使用的字母、标记与数字；CJK 文字词与词之间没有空格。脚本扩展包含
 * ー（长音符号）与 々（叠字符号）这类共享字符。
 */
const CJK = String.raw`[[\p{scx=Han}\p{scx=Hira}\p{scx=Kana}\p{scx=Hang}]&&[\p{L}\p{M}\p{N}]]`
/** 一段 CJK 字符，或一段其它字母、标记与数字。 */
const RUN = new RegExp(String.raw`${CJK}+|[[\p{L}\p{M}\p{N}]--${CJK}]+`, 'gv')
const CJK_START = new RegExp(String.raw`^${CJK}`, 'v')

/**
 * 将 NFKC 归一化后的文本切分为搜索词，使合成形与分解形、半角片假名以及兼容字符都
 * 产生相同的词。一段 CJK 文本会产出其相邻字符对以及最后一个字符，这样查询无需分词
 * 即可匹配，且该段中的每个字符都会作为某个词的起点。
 * @param text - 被索引或查询的文本。
 * @returns 按文本顺序排列的词，尚未小写化。
 */
function searchTerms(text: string): string[] {
  return [...text.normalize('NFKC').matchAll(RUN)].flatMap(([run]) => {
    if (!CJK_START.test(run)) return [run]
    // CJK 段只含字母，因此其码点即其字符。
    const chars = Array.from(run)
    return [...chars.slice(1).map((char, position) => `${chars[position] as string}${char}`), chars.at(-1) as string]
  })
}

/** 本地化文本的每一种语言变体。 */
function variants(text: LocalizedText | undefined): string[] {
  if (text === undefined) return []
  return typeof text === 'string' ? [text] : Object.values(text)
}

/** 一个插件按字段划分的可搜索文本；`id` 为其索引位置。 */
interface SearchDocument {
  readonly id: number
  readonly name: string
  readonly title: string
  readonly keywords: string
  readonly description: string
  readonly author: string
  /** 插件的分类标题与标签标题的每一种语言。 */
  readonly taxonomy: string
}

/** 一次查询的搜索排序与过滤器，不含分页。 */
type MarketSelection = Pick<MarketQuery, 'text' | 'category' | 'labels' | 'sort'>

/** 构建文本索引时，每个事件循环回合所索引的插件数量。 */
const BUILD_CHUNK = 500

/** 针对一个索引匹配查询；文本索引在首次带文本的查询时构建，并在各分块之间让出。 */
export class MarketSearch {
  private engine: Promise<MiniSearch<SearchDocument>> | undefined

  /** @param index - 要搜索的已校验索引。 */
  constructor(private readonly index: MarketIndex) {}

  /**
   * 选择并排序匹配某次查询的插件。
   * @param selection - 文本、过滤器与排序。
   * @returns 按结果顺序排列的每个匹配插件。
   */
  async select(selection: MarketSelection): Promise<MarketPlugin[]> {
    const plugins = this.index.plugins
    const text = selection.text ?? ''
    const scores = new Map<number, number>()
    let positions: number[]
    if (searchTerms(text).length === 0) {
      positions = plugins.map((_plugin, position) => position)
    } else {
      for (const result of await this.search(text)) scores.set(result.id as number, result.score)
      positions = [...scores.keys()].sort((a, b) => a - b)
    }
    const labels = selection.labels ?? []
    const matching = positions.filter((position) => {
      const { metadata } = plugins[position] as MarketPlugin
      return (selection.category === undefined || metadata.category === selection.category)
        && labels.every(label => metadata.labels.includes(label))
    })
    return this.order(matching, selection.sort, scores).map(position => plugins[position] as MarketPlugin)
  }

  private async search(text: string): Promise<ReturnType<MiniSearch<SearchDocument>['search']>> {
    this.engine ??= this.build()
    return (await this.engine).search(text)
  }

  private async build(): Promise<MiniSearch<SearchDocument>> {
    const { categories, labels } = this.index.metadata
    const engine = new MiniSearch<SearchDocument>({
      fields: ['name', 'title', 'keywords', 'description', 'author', 'taxonomy'],
      storeFields: [],
      tokenize: searchTerms,
      processTerm: term => term.toLowerCase(),
      searchOptions: {
        boost: { name: 3, title: 3, keywords: 2 },
        prefix: true,
        // 编辑距离为词长的五分之一（取整），最多 2；较短的词仅按原样或作为前缀匹配。
        fuzzy: term => term.length >= 4 ? 0.2 : false,
        maxFuzzy: 2,
        combineWith: 'AND',
      },
    })
    await engine.addAllAsync(this.index.plugins.map((plugin, id): SearchDocument => {
      const { category, keywords } = plugin.metadata
      // parseMarketIndex 只接受已声明的分类与标签 id。
      const title = (declarations: Readonly<Record<string, MarketDeclaration>>, id: string): string[] =>
        variants((declarations[id] as MarketDeclaration).title)
      const taxonomy = [
        ...category === undefined ? [] : title(categories, category),
        ...plugin.metadata.labels.flatMap(label => title(labels, label)),
      ]
      return {
        id,
        name: plugin.name,
        title: variants(plugin.title).join('\n'),
        keywords: keywords.join('\n'),
        description: variants(plugin.description).join('\n'),
        author: plugin.author ?? '',
        taxonomy: taxonomy.join('\n'),
      }
    }), { chunkSize: BUILD_CHUNK })
    return engine
  }

  private order(positions: number[], sort: MarketQuery['sort'], scores: ReadonlyMap<number, number>): number[] {
    switch (sort.kind) {
      case 'index': return positions
      case 'relevance': return positions.sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0) || a - b)
      case 'published':
      case 'key': {
        const value = (position: number): number | undefined => {
          const plugin = this.index.plugins[position] as MarketPlugin
          if (sort.kind === 'published') return Math.max(...plugin.versions.map(version => version.publishTimestamp))
          return Object.hasOwn(plugin.metadata.sortKeys, sort.id) ? plugin.metadata.sortKeys[sort.id] : undefined
        }
        const sign = sort.direction === 'asc' ? 1 : -1
        return positions.map(position => ({ position, value: value(position) })).sort((a, b) => {
          if (a.value === undefined || b.value === undefined) {
            return a.value === b.value ? a.position - b.position : a.value === undefined ? 1 : -1
          }
          return (a.value - b.value) * sign || a.position - b.position
        }).map(item => item.position)
      }
      /* v8 ignore next -- the Gateway validates `sort` against the closed union */
      default: return assertNever(sort)
    }
  }
}
