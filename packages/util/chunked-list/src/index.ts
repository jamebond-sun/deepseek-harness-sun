/**
 * 持久化、仅追加的列表，带有有界复制与 JSON 检查点校验。
 * @module @deepseek-ai/dsh-chunked-list
 */

import { z } from 'zod'

const CHUNK_CAPACITY = 64

/**
 * 不可变列表的最新分块；`undefined` 表示空列表。每个分块内的值遵循
 * 插入顺序。调用方应将节点、数组和存储的值视为不可变；各操作共享值
 * 与较旧的分块。
 */
export interface ChunkedList<T> {
  readonly values: readonly T[]
  readonly previous?: ChunkedList<T> | undefined
}

/**
 * 追加而不修改输入，最多复制一个 64 值分块。
 * @param head - 当前列表，或空列表时的 `undefined`。
 * @param value - 以引用方式保留的值。
 * @returns 共享未变较旧分块的新列表。
 */
export function appendChunkedList<T>(head: ChunkedList<T> | undefined, value: T): ChunkedList<T> {
  if (head === undefined || head.values.length === CHUNK_CAPACITY) {
    return { values: [value], ...head === undefined ? {} : { previous: head } }
  }
  return {
    values: [...head.values, value],
    ...head.previous === undefined ? {} : { previous: head.previous },
  }
}

/**
 * 按插入顺序遍历所有值，时间复杂度 O(N)，临时空间 O(N / 64)。
 * @param head - 当前列表，或空列表时的 `undefined`。
 * @returns 按引用产出存储值的迭代器，不做截断。
 */
export function* iterateChunkedList<T>(head: ChunkedList<T> | undefined): Generator<T> {
  const chunks: ChunkedList<T>[] = []
  for (let chunk = head; chunk !== undefined; chunk = chunk.previous) chunks.push(chunk)
  for (const chunk of chunks.reverse()) yield* chunk.values
}

/**
 * 校验非空列表检查点，包括每个存储值与分块大小。
 * @param valueSchema - 调用方对每个存储值的校验。
 * @returns 递归 Zod 模式，拒绝空分块、超大分块及未知字段。
 */
export function chunkedListSchema<T>(valueSchema: z.ZodType<T>): z.ZodType<ChunkedList<T>> {
  const schema: z.ZodType<ChunkedList<T>> = z.lazy(() => z.object({
    values: z.array(valueSchema).min(1).max(CHUNK_CAPACITY),
    previous: schema.optional(),
  }).strict())
  return schema
}
