/** 文本与不可分割图片的有序头/尾保留。 @module @deepseek-ai/dsh-spill-policy/retention */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/** 文本可切分、而图片必须保持完整的内容。 */
export type RetainableBlock = Extract<ContentBlock, { type: 'text' | 'image' }>

/** 被保留的两端，以及从原序列中排除掉的精确数量。 */
export interface RetainedContent {
  head: RetainableBlock[]
  tail: RetainableBlock[]
  omittedBytes: number
  omittedImages: number
}

/** 当文本预算正好切在代理对之间时，保住一个 UTF-16 码位。 */
function textSlice(text: string, length: number, tail: boolean): string {
  let cut = tail ? text.length - length : length
  const previous = text.charCodeAt(cut - 1)
  const current = text.charCodeAt(cut)
  if (previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff) {
    cut += tail ? 1 : -1
  }
  return tail ? text.slice(cut) : text.slice(0, cut)
}

/** 在单调的 token 估算下能容纳的最大连续文本端。 */
function fitText(text: string, budget: number, tail: boolean, price: (block: RetainableBlock) => number): string {
  let low = 0
  let high = text.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    const candidate = textSlice(text, middle, tail)
    if (candidate.length === 0 || price({ type: 'text', text: candidate }) <= budget) low = middle
    else high = middle - 1
  }
  return textSlice(text, low, tail)
}

/**
 * 保留连续的两端，且不移动图片或只保留图片的一部分。
 * 每一端获得内容预算的一半；在不可分割的图片处未用尽的空间就保持未用。
 * 文本定价必须对保留长度单调。
 * @param content - 有序的文本与图片块，其总价超出预算。
 * @param budget - 预留通知之后、非负整数的 token 预算。
 * @param price - 一个被保留块在模型路由上的成本，包含其 framing。
 * @returns 被保留的两端，以及被省略的 UTF-8 文本字节数与整张图片数。
 */
export function retainContent(
  content: readonly RetainableBlock[],
  budget: number,
  price: (block: RetainableBlock) => number,
): RetainedContent {
  const head: RetainableBlock[] = []
  const tail: RetainableBlock[] = []
  let first = 0
  let last = content.length - 1
  let headCharacters = 0
  let remaining = Math.ceil(budget / 2)
  while (first <= last) {
    const block = content[first] as RetainableBlock
    const cost = price(block)
    if (cost <= remaining) {
      head.push(block)
      remaining -= cost
      first++
      continue
    }
    if (block.type === 'text') {
      const text = fitText(block.text, remaining, false, price)
      headCharacters = text.length
      if (text.length > 0) head.push({ type: 'text', text })
    }
    break
  }
  remaining = Math.floor(budget / 2)
  while (last >= first) {
    const original = content[last] as RetainableBlock
    const block = last === first && original.type === 'text'
      ? { type: 'text' as const, text: original.text.slice(headCharacters) }
      : original
    const cost = price(block)
    if (cost <= remaining) {
      tail.push(block)
      remaining -= cost
      last--
      continue
    }
    if (block.type === 'text') {
      const text = fitText(block.text, remaining, true, price)
      if (text.length > 0) tail.push({ type: 'text', text })
    }
    break
  }
  tail.reverse()
  const bytes = (blocks: readonly RetainableBlock[]): number => blocks.reduce(
    (total, block) => total + (block.type === 'text' ? Buffer.byteLength(block.text, 'utf8') : 0), 0)
  const images = (blocks: readonly RetainableBlock[]): number => blocks.filter(block => block.type === 'image').length
  return {
    head,
    tail,
    omittedBytes: bytes(content) - bytes(head) - bytes(tail),
    omittedImages: images(content) - images(head) - images(tail),
  }
}
