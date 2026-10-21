/** 标题文本归一化与 UTF-8 安全的截断。 */

/** 操作系统命令转义序列，包括未终止的尾部。 */
const OSC_SEQUENCE = /(?:\u001B\]|\u009D)(?:(?!\u0007|\u001B\\)[\s\S])*(?:\u0007|\u001B\\|$)/gu
/** 控制序列引入符转义，例如 SGR 颜色码。 */
const CSI_SEQUENCE = /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/gu
/** 余下的双字节 ESC 控制序列。 */
const ESC_SEQUENCE = /\u001B[@-_]/gu
/** 非空白的 C0/C1 控制字符。 */
const CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu
/** 方向性与不可见控制字符，可能让显示出的标题具有欺骗性。 */
const DIRECTIONAL_CONTROL = /[\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/gu

/** 拒绝一个无效的公开文本上限。 */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
}

/** 移除控制字符，并产出一行经过裁剪、空白已归一化的文本。 */
function cleanTitleText(input: string): string {
  return input
    .replace(OSC_SEQUENCE, '')
    .replace(CSI_SEQUENCE, '')
    .replace(ESC_SEQUENCE, '')
    .replace(CONTROL_CHARACTER, '')
    .replace(DIRECTIONAL_CONTROL, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

/**
 * 把字符串截断到 UTF-8 字节预算之内，而不拆分 Unicode 码点。
 * @param input - 已归一化的标题文本。
 * @param maxBytes - 正的 UTF-8 字节预算。
 * @returns 预算之内最长的、带头码点前缀。
 */
export function truncateTitleUtf8(input: string, maxBytes: number): string {
  assertPositiveInteger('maxBytes', maxBytes)
  if (Buffer.byteLength(input, 'utf8') <= maxBytes) return input
  let used = 0
  let output = ''
  for (const character of input) {
    const bytes = Buffer.byteLength(character, 'utf8')
    if (used + bytes > maxBytes) break
    output += character
    used += bytes
  }
  return output
}

/**
 * 归一化一个被接受的会话标题，并强制其 UTF-8 字节预算。
 * @param input - 不受信任的标题文本。
 * @param maxBytes - 正的最大编码大小。
 * @returns 一个终端安全的单行标题，在清洗之后可能为空。
 */
export function normalizeSessionTitle(input: string, maxBytes: number): string {
  return truncateTitleUtf8(cleanTitleText(input), maxBytes).trimEnd()
}

/**
 * 推导确定性的“首提示”回退标题。
 * @param input - 来自第一条合格人类消息的文本。
 * @param maxWords - 正的、以空白分隔的词数上限。
 * @param maxBytes - 正的 UTF-8 字节上限。
 * @returns 在两个上限之内、已归一化的最靠前词。
 */
export function fallbackSessionTitle(input: string, maxWords: number, maxBytes: number): string {
  assertPositiveInteger('maxWords', maxWords)
  const words = cleanTitleText(input).split(' ').filter(Boolean).slice(0, maxWords)
  return truncateTitleUtf8(words.join(' '), maxBytes).trimEnd()
}
