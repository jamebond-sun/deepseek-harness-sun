/** 已持久化的溢出策略通知的浏览器安全格式化与识别。 */
import { describeOmitted, type Omitted } from '@deepseek-ai/dsh-output-retention'
import type { SpillRef } from '@deepseek-ai/dsh-spill'

const OPEN = '('
const CLOSE = ')'
const LOCATION = ' Full formatted result stored at: '
const GUIDANCE_SEPARATOR = '. '
const SEPARATOR = '\n\n'
const EXACT_OMISSION = describeOmitted({ kind: 'exact', count: 0 }, 'bytes')
const COUNT_OFFSET = EXACT_OMISSION.indexOf('0')
const COUNT_SUFFIX = EXACT_OMISSION.slice(COUNT_OFFSET + 1)

/**
 * 格式化追加到保留预览之后的通知，并保留其持久化后的拼写形式。
 * @param omitted - 保留策略省略的字节数。
 * @param ref - 已保存文本的定位信息与取回指引。
 * @param images - 与文本一同被整体省略的图片数量。
 * @returns 不含前置预览分隔符的完整通知。
 */
export function formatSpillNotice(omitted: Omitted, ref: Pick<SpillRef, 'locator' | 'retrievalHint'>, images = 0): string {
  const imageNotice = images > 0 ? ` Omitted ${images} images.` : ''
  return `${OPEN}${describeOmitted(omitted, 'bytes')}${imageNotice}${LOCATION}${ref.locator}${GUIDANCE_SEPARATOR}${ref.retrievalHint}${CLOSE}`
}

function isOmission(text: string): boolean {
  const imageNotice = / Omitted ([1-9][0-9]*) images\.$/.exec(text)
  if (imageNotice !== null) {
    if (!Number.isSafeInteger(Number(imageNotice[1]))) return false
    text = text.slice(0, imageNotice.index)
  }
  if (text === describeOmitted({ kind: 'none' }, 'bytes')
    || text === describeOmitted({ kind: 'unknown' }, 'bytes')) return true
  const count = Number(text.slice(COUNT_OFFSET, text.length - COUNT_SUFFIX.length))
  return Number.isSafeInteger(count) && count >= 0
    && text === describeOmitted({ kind: 'exact', count }, 'bytes')
}

/**
 * 识别持久化文本中位于末尾的溢出策略通知，包括只有通知的输出。
 * 这识别的是文本约定，而非经过认证的工具输出来源。
 * @param text - 完整的已记录文本结果。
 * @returns 结果末尾是否占据着一条完整通知。
 */
export function hasSpillNotice(text: string): boolean {
  if (!text.endsWith(CLOSE)) return false
  let start = 0
  while (true) {
    const next = text.indexOf(`${SEPARATOR}${OPEN}`, start)
    const candidate = text.slice(start, next < 0 ? -CLOSE.length : next)
    const location = candidate.indexOf(LOCATION, OPEN.length)
    if (candidate.startsWith(OPEN) && location >= 0
      && isOmission(candidate.slice(OPEN.length, location))) {
      return text.indexOf(GUIDANCE_SEPARATOR, start + location + LOCATION.length) >= 0
    }
    if (next < 0) return false
    start = next + SEPARATOR.length
  }
}
