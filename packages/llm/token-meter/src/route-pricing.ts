/**
 * 按请求投影的表面定价：把附件块的启发式替换为发送给被路由模型的
 * 图像与文件表示。
 *
 * @module @deepseek-ai/dsh-token-meter/route-pricing
 */

import type { ContentBlock, LlmImageRequestPricing } from '@deepseek-ai/dsh-llm'
import { estimateContent } from './estimate.ts'
import type { MeterSurfaceNode } from './surface-fold.ts'
import type { TokenSurfaceNode } from './types.ts'

type FileAttachmentRef = Extract<ContentBlock, { type: 'file' }>['attachment']

/** 为一个请求路由定价后的表面：公开节点及其总计。 */
export interface PricedSurface {
  /** 同时携带路由定价与固定启发式定价的位置节点。 */
  readonly nodes: TokenSurfaceNode[]
  /** 整个表面上路由定价之和。 */
  readonly surfaceTokens: number
}

/**
 * 在其模型请求附件投影之下，为一个有序表面定价。
 * @param nodes - 折叠的当前或快照表面，按模型可见顺序排列。
 * @param pricing - 被路由模型的图像定价；为 undefined 时保留固定启发式。
 * @param fileText - 已挂载的 LLM 服务所使用的精确文件句柄投影。
 * @returns 已分离的公开节点及其按路由定价的总计。
 * @throws 当定价返回的出现次数与所询问的次数不同时——错位会静默地
 *   错误定价各个节点，因此必须立即失败。
 */
export function priceSurface(
  nodes: readonly MeterSurfaceNode[],
  pricing: LlmImageRequestPricing | undefined,
  fileText?: (ref: FileAttachmentRef) => string,
): PricedSurface {
  const images = pricing === undefined ? [] : nodes.flatMap(node => node.images)
  const hasFiles = fileText !== undefined && nodes.some(node => node.files.length > 0)
  if ((pricing === undefined || images.length === 0) && !hasFiles) {
    let surfaceTokens = 0
    const publicNodes = nodes.map((node) => {
      surfaceTokens += node.heuristicTokens
      return { seq: node.seq, tokens: node.heuristicTokens, heuristicTokens: node.heuristicTokens }
    })
    return { nodes: publicNodes, surfaceTokens }
  }
  const prices = pricing === undefined ? [] : pricing.priceImages(images)
  if (pricing !== undefined && prices.length !== images.length) {
    throw new Error(
      `token meter: route image pricing answered ${prices.length} prices for ${images.length} occurrences`,
    )
  }
  let cursor = 0
  let surfaceTokens = 0
  const publicNodes = nodes.map((node) => {
    let tokens = node.heuristicTokens
    if (fileText !== undefined && node.files.length > 0) {
      tokens -= node.fileStructuralTokens
      for (const file of node.files) {
        tokens += estimateContent([{ type: 'text', text: fileText(file) }])
      }
    }
    if (pricing !== undefined && node.images.length > 0) {
      tokens -= node.imageStructuralTokens
      for (let occurrence = 0; occurrence < node.images.length; occurrence += 1) {
        // oxlint-disable-next-line typescript/no-non-null-assertion -- 长度相等性已在上面断言
        const price = prices[cursor]!
        cursor += 1
        tokens += price.visualTokens + estimateContent([{ type: 'text', text: price.text }])
      }
    }
    surfaceTokens += tokens
    return { seq: node.seq, tokens, heuristicTokens: node.heuristicTokens }
  })
  return { nodes: publicNodes, surfaceTokens }
}
