/** 原生 RegExp 校验与 Unicode JSON Schema 模式之间的保守兼容性检查。 */

import type { AST } from '@eslint-community/regexpp'

function bmpOnly(node: AST.Node): boolean {
  switch (node.type) {
    case 'Character': return node.value <= 0xffff && (node.value < 0xd800 || node.value > 0xdfff)
    case 'CharacterClassRange': return bmpOnly(node.min) && bmpOnly(node.max) && (node.max.value < 0xd800 || node.min.value > 0xdfff)
    case 'CharacterClass': return !node.negate && node.elements.every(bmpOnly)
    case 'CharacterSet': return (node.kind === 'digit' || node.kind === 'space' || node.kind === 'word') && !node.negate
    case 'Quantifier': return bmpOnly(node.element)
    case 'Assertion': return ['start', 'end', 'word'].includes(node.kind)
    default: return false
  }
}

function broadSet(node: AST.Node): boolean {
  return node.type === 'CharacterSet' && (node.kind === 'any'
    || ((node.kind === 'digit' || node.kind === 'space' || node.kind === 'word') && node.negate))
}

function portableAlternative(alternative: AST.Alternative): boolean {
  // 一个孤立、未锚定的宽泛集合只询问是否存在一个匹配的字符。
  if (alternative.elements.length === 1 && alternative.elements.some(broadSet)) return true
  let broadRepetitions = 0
  const wordAssertion = alternative.elements.some(element => element.type === 'Assertion' && element.kind === 'word')
  return alternative.elements.every((element) => {
    if (element.type === 'Quantifier' && element.max === Infinity && element.min <= 1 && broadSet(element.element)) {
      // 单词断言与多个宽泛组可能观察到代理对的中点。
      return !wordAssertion && ++broadRepetitions === 1
    }
    return bmpOnly(element)
  })
}

function signature(pattern: AST.Pattern): string {
  const incidental = new Set(['parent', 'start', 'end', 'raw', 'references', 'resolved'])
  return JSON.stringify(pattern, (key: string, value: unknown) => incidental.has(key) ? undefined : value)
}

/**
 * 为那些在 Unicode 正则语义下能保留原生接受度的模式创建一个检查器。
 * 未被识别的无标志语法保持明确的“部分”状态，而非变成误导性的约束。
 * @returns 兼容性谓词；解析绝不会对配置值执行该正则表达式。
 */
export async function createPatternCheck(): Promise<(source: string, flags?: string) => boolean> {
  const { RegExpParser } = await import('@eslint-community/regexpp')
  const parser = new RegExpParser()
  return (source, flags = '') => {
    if (flags !== '' && flags !== 'u') return false
    try {
      const unicode = parser.parsePattern(source, 0, source.length, { unicode: true })
      if (flags === 'u') return true
      const native = parser.parsePattern(source, 0, source.length, { unicode: false })
      return signature(native) === signature(unicode) && native.alternatives.every(portableAlternative)
    } catch (error) {
      // 无效的 Unicode 语法无法作为标准模式约束发出。
      if (error instanceof SyntaxError) return false
      throw error
    }
  }
}
