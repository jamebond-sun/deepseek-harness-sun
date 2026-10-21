/**
 * 重复安装安全的名义原始类型辅助工具。
 *
 * 品牌（brand）在类型层面使结构相同的字符串或数字不可互换：不能把
 * `SessionId` 传给期望 `ToolCallId` 的地方，也不能把事件序号当作日志
 * 偏移量传入。比较、日志和序列化仍保留底层原始类型的行为。
 *
 * 本包不拥有任何具体的领域值，也不保留运行时标识或可变的
 * 状态，因此独立安装的多个副本产生的也是可互换的值。
 *
 * @module @deepseek-ai/dsh-brand
 */

declare const BRAND: unique symbol

/** 携带仅编译期品牌 `B` 的字符串。 */
export type Branded<B extends string> = string & { readonly [BRAND]: B }

/** 携带仅编译期品牌 `B` 的数字。 */
export type BrandedNumber<B extends string> = number & { readonly [BRAND]: B }

/**
 * 在不改变值的前提下套用编译期字符串品牌。
 * @param value - 拥有目标品牌的领域所接纳的字符串。
 * @returns 带有所请求编译期品牌的同一字符串。
 */
export function brandString<T extends Branded<string>>(value: string | T): T {
  return value as T
}

/**
 * 在不改变值的前提下套用编译期数字品牌。
 * @param value - 拥有目标品牌的领域所接纳的数字。
 * @returns 带有所请求编译期品牌的同一数字。
 */
export function brandNumber<T extends BrandedNumber<string>>(value: number | T): T {
  return value as T
}
