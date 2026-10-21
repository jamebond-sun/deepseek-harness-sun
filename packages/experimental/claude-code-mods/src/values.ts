/**
 * 由引擎与宿主共享的小型取值辅助函数：读取某个 mod 的无类型调用输入、
 * 措辞化一个被抛出的值，以及按其所做之事定类型的 JSON 编码。
 * @module
 */

/**
 * 一个被抛出值的消息：Error 的 `message`，其余任何值都作为文本。
 * @param error - 被抛出的值。
 * @returns 消息文本。
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 将某个 mod 的调用输入作为字段记录读取；任何非对象的取值都读作空。
 * @param input - 该 mod 传入的值。
 * @returns 字段，或一条空记录。
 */
export function record(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null ? input as Record<string, unknown> : {}
}

/**
 * 要求某个 mod 的调用输入包含一个字符串字段。
 * @param value - 该字段的值。
 * @param what - 出错时用于指名的字段。
 * @returns 该字符串。
 * @throws TypeError 当该值不是字符串时。
 */
export function requireString(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new TypeError(`${what} must be a string`)
  return value
}

/**
 * 按其所做之事定类型的 `JSON.stringify`：对于 JSON 无法承载的值返回 undefined。
 * @param value - 待编码的值。
 * @returns JSON 文本，或 undefined。
 */
export function stringify(value: unknown): string | undefined {
  const encoded: string | undefined = JSON.stringify(value)
  return encoded
}
