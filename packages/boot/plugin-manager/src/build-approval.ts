/** 在当前 profile 的工作区设置中批准 pnpm 待决的依赖脚本。 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isAlias, isMap, isNode, isScalar, parseDocument, visit } from 'yaml'
import { ManagementFailure } from './failure.ts'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

/** pnpm 为一个仍待决定的构建脚本保留的值。 */
const UNDECIDED_BUILD = 'set this to true or false'

/** 非交互式运行点名它所跳过的构建脚本的位置。 */
const IGNORED_BUILDS = /\bIgnored build scripts: (.+)/

async function readPolicy(dir: string) {
  let text: string
  try { text = await readFile(join(dir, 'pnpm-workspace.yaml'), 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    text = '{}\n'
  }
  const document = parseDocument(text)
  if (document.errors[0] !== undefined) throw document.errors[0]
  if (!isMap(document.contents)) throw new Error('pnpm-workspace.yaml must be a YAML mapping')
  const builds = document.get('allowBuilds')
  if (builds !== undefined && !isMap(builds)) throw new Error('allowBuilds must be a YAML mapping')
  visit(builds ?? null, (_key, node) => {
    if (isAlias(node) || (isNode(node) && 'anchor' in node && node.anchor)) {
      throw new Error('allowBuilds must not contain YAML anchors or aliases')
    }
  })
  const keys = isMap(builds) ? builds.items.flatMap(({ key }) =>
    isScalar(key) && typeof key.value === 'string' ? [key.value] : []) : []
  const pending = isMap(builds) ? builds.items.flatMap(({ key, value }) =>
    isScalar(key) && typeof key.value === 'string' && !/[*?]/.test(key.value)
      && isScalar(value) && value.value === UNDECIDED_BUILD ? [key.value] : []) : []
  return { document, pending, keys }
}

/**
 * 记录一次失败运行所报告为被忽略的构建脚本，然后列出每一个等待决定的名称。
 *
 * pnpm 仅在能够交互提示时才会自行写入这些策略条目，而管理器始终以非交互方式运行它，
 * 因此运行自身的报告就是能够保留下来的记录。
 * @param dir 当前 profile 目录。
 * @param output 失败运行捕获到的输出。
 * @returns 等待构建决定的确切包名；通配规则被排除。
 */
export async function recordPendingBuilds(dir: string, output: string): Promise<string[]> {
  const { document, pending, keys } = await readPolicy(dir)
  const known = new Set(keys)
  const added = ignoredBuildNames(output).filter(name => !known.has(name))
  if (added.length === 0) return pending
  for (const name of added) document.setIn(['allowBuilds', name], UNDECIDED_BUILD)
  await writeFileAtomic(join(dir, 'pnpm-workspace.yaml'), String(document), { mode: 0o600 })
  return [...pending, ...added]
}

/**
 * 读取一次 pnpm 运行所报告为被忽略构建脚本的包名。
 * @param output 该运行捕获到的输出。
 * @returns 按报告顺序排列的确切名称；通配模式被排除。
 */
export function ignoredBuildNames(output: string): string[] {
  const reported = IGNORED_BUILDS.exec(output)?.[1]
  if (reported === undefined) return []
  return reported.split(',').map(name => name.trim()).filter(name => name !== '' && !/[*?]/.test(name))
}

/** 在不运行脚本的情况下持久化批准；调用方持有 profile 清单锁。
 * @param dir 当前 profile 目录。
 * @param names 来自待决构建列表的显式包名。
 * @throws 当某个名称不再待决，或 allowBuilds 含有 YAML 锚点或别名时抛出；此时不会写入任何批准。
 */
export async function approveBuilds(dir: string, names: readonly string[]): Promise<void> {
  const { document, pending } = await readPolicy(dir)
  if (names.some(name => !pending.includes(name))) throw new ManagementFailure('stale-approval')
  if (names.length === 0) return
  for (const name of names) document.setIn(['allowBuilds', name], true)
  await writeFileAtomic(join(dir, 'pnpm-workspace.yaml'), String(document), { mode: 0o600 })
}
