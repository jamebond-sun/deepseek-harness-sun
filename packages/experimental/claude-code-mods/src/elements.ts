/**
 * 一个 `ui.render` 钩子所应答的元素词汇表——即 Claude Code 的 `Box`、
 * `Text` 与 `Button` 构造函数——以及宿主会如何处理一棵树：校验它、
 * 将回调替换成动作 id 后序列化它，并像 mod 的测试那样搜索它。
 * @module
 */

import type { SerializedNode } from './types.ts'

/** 一个构造函数所返回的元素；`props` 即该构造函数的参数，已被冻结。 */
export interface UiElement {
  readonly type: 'Box' | 'Text' | 'Button'
  readonly props: Readonly<Record<string, unknown>>
}

/** 一个 `ui.render` 钩子返回的内容：一个元素、文本、空，或这些内容的列表。 */
export type UiNode = UiElement | string | number | null | undefined | false | readonly UiNode[]

/** 本宿主所布局的 `Box` 属性；被设为 `undefined` 的属性是某个 mod 省略掉的。 */
export interface BoxProps {
  readonly flexDirection?: 'row' | 'column' | undefined
  readonly paddingX?: number | undefined
  readonly paddingY?: number | undefined
  readonly padding?: number | undefined
  readonly gap?: number | undefined
  readonly border?: boolean | string | undefined
  readonly borderColor?: string | undefined
  readonly children?: UiNode | undefined
}

/** 本宿主所设置样式的 `Text` 属性。 */
export interface TextProps {
  readonly color?: string | undefined
  readonly bold?: boolean | undefined
  readonly dimColor?: boolean | undefined
  readonly italic?: boolean | undefined
  readonly underline?: boolean | undefined
  readonly children?: UiNode | undefined
}

/** `Button` 属性：一个标签、一个可选的快捷键提示，以及一次按下时由宿主运行的回调。 */
export interface ButtonProps {
  readonly label: string
  readonly hotkey?: string | undefined
  readonly disabled?: boolean | undefined
  readonly onPress?: (() => unknown) | undefined
}

/** `$.ui.resolve(e)` 所返回的构造函数。 */
export interface UiElements {
  readonly Box: (props: BoxProps) => UiElement
  readonly Text: (props: TextProps) => UiElement
  readonly Button: (props: ButtonProps) => UiElement
}

export type { SerializedElement, SerializedNode } from './types.ts'

/** 一棵序列化后的树在每个属性上可以携带的内容：仅标量。 */
function scalarProps(props: Readonly<Record<string, unknown>>): Record<string, string | number | boolean> {
  const scalars: Record<string, string | number | boolean> = {}
  for (const [name, value] of Object.entries(props)) {
    if (name === 'children' || name === 'onPress') continue
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') scalars[name] = value
  }
  return scalars
}

const elementBrand = Symbol('claude-code-mods.element')

function element(type: UiElement['type'], props: BoxProps | TextProps | ButtonProps): UiElement {
  return Object.freeze({ type, props: Object.freeze({ ...props }), [elementBrand]: true })
}

/**
 * 某个值是否为本宿主某个构造函数所返回的元素。
 * @param value - 候选值。
 * @returns 对于构造函数所造的元素为 true。
 */
export function isUiElement(value: unknown): value is UiElement {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[elementBrand] === true
}

/**
 * 供一次渲染使用的元素构造函数。
 * @returns `Box`、`Text` 与 `Button`。
 */
export function uiElements(): UiElements {
  return Object.freeze({
    Box: (props: BoxProps) => element('Box', props),
    Text: (props: TextProps) => element('Text', props),
    Button: (props: ButtonProps) => element('Button', props),
  })
}

/** 将一个节点展平为它所绘制出的元素与文本片段，并丢弃那些不绘制任何内容的部分。 */
function childrenOf(node: UiNode): (UiElement | string)[] {
  if (node === null || node === undefined || node === false) return []
  if (typeof node === 'string') return node.length === 0 ? [] : [node]
  if (typeof node === 'number') return [String(node)]
  if (isUiElement(node)) return [node]
  if (Array.isArray(node)) return (node as readonly UiNode[]).flatMap(childrenOf)
  throw new TypeError(`a tree node is ${typeof node}, not an element, text, or a list of them`)
}

/**
 * 将某个 `ui.render` 应答对照词汇表进行校验。
 * @param node - 该钩子的应答。
 * @returns 对于合法的树返回 undefined，否则返回它未能通过校验的理由。
 */
export function treeProblem(node: UiNode): string | undefined {
  try {
    for (const child of childrenOf(node)) {
      if (typeof child === 'string') continue
      if (child.type === 'Button') {
        if (typeof child.props['label'] !== 'string') return 'a Button needs a string label'
        if (child.props['onPress'] !== undefined && typeof child.props['onPress'] !== 'function') return 'a Button onPress must be a function'
        continue
      }
      const nested = treeProblem(child.props['children'] as UiNode)
      if (nested !== undefined) return nested
    }
    return undefined
  } catch (error: unknown) {
    /* v8 ignore next -- childrenOf 只会抛出 TypeError；而 String 分支覆盖了未来可能的非 Error 抛出 */
    return error instanceof Error ? error.message : String(error)
  }
}

/**
 * 为一客户端序列化一棵已校验的树：保留标量、展平子节点，并将每个 `onPress`
 * 替换为 `holdAction` 为它返回的 id。
 * @param node - 该钩子的应答，已经过 {@link treeProblem} 校验。
 * @param holdAction - 存储一个回调并返回其 id。
 * @returns 按绘制顺序排列的、序列化后的节点。
 */
export function serializeTree(node: UiNode, holdAction: (callback: () => unknown) => string): SerializedNode[] {
  return childrenOf(node).map((child): SerializedNode => {
    if (typeof child === 'string') return child
    if (child.type === 'Button') {
      const onPress = child.props['onPress']
      return {
        type: 'Button',
        props: scalarProps(child.props),
        children: [],
        ...typeof onPress === 'function' ? { actionId: holdAction(onPress as () => unknown) } : {},
      }
    }
    return { type: child.type, props: scalarProps(child.props), children: serializeTree(child.props['children'] as UiNode, holdAction) }
  })
}

/** 一个节点所绘制的文本，其子文本按序拼接。 */
function textOf(node: UiElement | string): string {
  if (typeof node === 'string') return node
  if (node.type === 'Button') return String(node.props['label'])
  return childrenOf(node.props['children'] as UiNode).map(textOf).join('')
}

/** 树搜索所匹配的依据。 */
export interface TreePattern {
  readonly type?: UiElement['type']
  /** 该元素所绘制的文本，含其后代；字符串作为子串匹配。 */
  readonly text?: string | RegExp
  /** 一个 Button 的标签。 */
  readonly label?: string | RegExp
}

function textMatches(expected: string | RegExp, actual: string): boolean {
  return typeof expected === 'string' ? actual.includes(expected) : expected.test(actual)
}

/**
 * 一棵满足某模式的所有元素，按绘制顺序。
 * @param node - 该树。
 * @param pattern - 要匹配的类型、文本与标签；空模式匹配每一个元素。
 * @returns 匹配到的元素。
 */
export function findAll(node: UiNode, pattern: TreePattern): UiElement[] {
  const found: UiElement[] = []
  const visit = (child: UiElement | string): void => {
    if (typeof child === 'string') return
    const matchesType = pattern.type === undefined || child.type === pattern.type
    const matchesText = pattern.text === undefined || textMatches(pattern.text, textOf(child))
    const matchesLabel = pattern.label === undefined || (child.type === 'Button' && textMatches(pattern.label, String(child.props['label'])))
    if (matchesType && matchesText && matchesLabel) found.push(child)
    if (child.type !== 'Button') for (const grandchild of childrenOf(child.props['children'] as UiNode)) visit(grandchild)
  }
  for (const child of childrenOf(node)) visit(child)
  return found
}

/**
 * 一棵树所绘制的纯文本，每个顶层节点一行：即测试套件与宿主日志对某个画面的视角。
 * @param node - 该树。
 * @returns 被绘制的文本。
 */
export function renderText(node: UiNode): string {
  return childrenOf(node).map(textOf).join('\n')
}
