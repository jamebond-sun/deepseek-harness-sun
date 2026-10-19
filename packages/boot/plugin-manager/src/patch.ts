/** 保留注释的 profile 插件启用编辑，以及它们所对比的条目扁平化。 */
import { readFile } from 'node:fs/promises'
import { isMap, isNode, isScalar, isSeq, parseDocument } from 'yaml'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { composeEntries, loadOptionalPatches, readBundlePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

/** 仅扁平化 profile 补丁组合器可寻址的组。
 * @param rows 组合后的顶层条目。
 * @returns 按深度优先顺序排列的条目。
 */
export function flatten(rows: EntryOptions[]): EntryOptions[] {
  return rows.flatMap(row => [row, ...(row.group && Array.isArray(row.config) ? flatten(row.config as EntryOptions[]) : [])])
}

/** 替换最后一条匹配的覆盖项，或在已有插入项之后追加一条。一条仅持有 `id` 与 `disabled`、
 * 且没有锚点的覆盖项，会在 bundle 层与剩余 profile 补丁已经为该条目给出所请求的
 * 字面 `disabled` 值时被移除（或不予追加）；home 补丁与启动覆盖不被考虑。
 * @param profile 其补丁文件被编辑、且其已选 bundle 提供所对比组合的 profile。
 * @param id 唯一的组合条目 id。
 * @param name 用于匹配带名称覆盖项的模块名。
 * @param enabled 期望的条目启用状态。
 * @returns 文件是否发生了变化。
 */
export async function writePluginEnabled(profile: ProfileContext, id: string, name: string, enabled: boolean): Promise<boolean> {
  const filename = profile.patchPath
  let text: string
  try {
    text = await readFile(filename, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    text = '[]\n'
  }
  const document = parseDocument(text, {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
  })
  const error = document.errors[0]
  if (error !== undefined) throw error
  if (!isSeq(document.contents)) throw new Error('Profile patch must be a YAML sequence')
  const patches = loadOptionalPatches('dsh', filename) ?? []
  const bundlePatches = readBundlePatches('dsh', profile)
  const items = document.contents.items
  const target = items.findLast((item, index) => {
    if (!isMap(item) || document.getIn([index, 'id']) !== id || item.has('insert')) return false
    const expectedName = document.getIn([index, 'name'])
    return !expectedName || expectedName === name
  })
  // 对比该条目自身的字面 `disabled`；`!!js` 值永远不会匹配，因此其覆盖项会被保留。
  const implied = (index: number): boolean => {
    const row = flatten(composeEntries([[...bundlePatches, ...patches.toSpliced(index, 1)]])).findLast(entry => entry.id === id)
    return row !== undefined && (row.disabled ?? false) === !enabled
  }
  if (isMap(target)) {
    const index = items.indexOf(target)
    // 被移除的锚点会让后续的别名无法解析。
    const onlySwitch = target.anchor === undefined && target.items.every(pair => isScalar(pair.key) && isScalar(pair.value)
      && pair.key.anchor === undefined && pair.value.anchor === undefined && (pair.key.value === 'id' || pair.key.value === 'disabled'))
    if (onlySwitch && implied(index)) {
      document.deleteIn([index])
      // 被移除的覆盖项上方的注释可能是文件头，因此它会移动到下一项上方、一个已清空序列
      // 的上方，或剩余各项之后。
      const comment = target.commentBefore
      const next = items[index]
      if (comment && isNode(next)) next.commentBefore = next.commentBefore ? `${comment}\n${next.commentBefore}` : comment
      else if (comment && items.length === 0) document.contents.commentBefore = comment
      else if (comment) document.comment = document.comment ? `${comment}\n${document.comment}` : comment
    } else if (document.getIn([index, 'disabled']) === !enabled) {
      return false
    } else {
      document.setIn([index, 'disabled'], !enabled)
    }
  } else {
    if (implied(items.length)) return false
    document.add({ id, disabled: !enabled })
  }
  await writeFileAtomic(filename, String(document), { mode: 0o600 })
  return true
}
