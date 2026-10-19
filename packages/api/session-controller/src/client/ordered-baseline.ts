/**
 * 合并一个权威基线，而不移动 client 已可见的身份。
 * 仅基线持有的身份相对于最近的下一个已知身份插入；
 * 基线中缺席的身份被移除。
 *
 * @param current - 已建立的 client 顺序。
 * @param baseline - 最新的权威行。
 * @param keyOf - 稳定的身份选择器。
 * @returns 携带基线值并保留既有相对顺序的行。
 */
export function mergeOrderedBaseline<T>(
  current: readonly T[],
  baseline: readonly T[],
  keyOf: (value: T) => unknown,
): T[] {
  const baselineByKey = new Map<unknown, T>()
  for (const value of baseline) baselineByKey.set(keyOf(value), value)

  const merged = current
    .map(value => baselineByKey.get(keyOf(value)))
    .filter((value): value is T => value !== undefined)
  const mergedKeys = new Set(merged.map(keyOf))

  for (let index = 0; index < baseline.length; index++) {
    const value = baseline[index]
    /* v8 ignore next -- 稠密数组守卫：index 由 baseline.length 约束。 */
    if (value === undefined || mergedKeys.has(keyOf(value))) continue
    let insertion = merged.length
    for (let following = index + 1; following < baseline.length; following++) {
      const candidate = baseline[following]
      /* v8 ignore next -- 稠密数组守卫：following 由 baseline.length 约束。 */
      if (candidate === undefined) continue
      const known = merged.findIndex(item => keyOf(item) === keyOf(candidate))
      if (known !== -1) {
        insertion = known
        break
      }
    }
    merged.splice(insertion, 0, value)
    mergedKeys.add(keyOf(value))
  }
  return merged
}
