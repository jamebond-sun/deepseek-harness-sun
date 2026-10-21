/**
 * 以 `$DSH_HOME/.credentials.yaml` 为后盾、叠加于环境之上、按以下优先级排序的
 * 凭证提供方：
 *
 * ```text
 * $DSH_HOME/.credentials.yaml        (提供方管理，由 set/unset 写入)
 * > 继承而来的进程环境            (回退；本提供方从不写入)
 * > <调用方 cwd>/.env            (回退；本提供方从不写入)
 * > $DSH_HOME/.env                   (回退；本提供方从不写入)
 * ```
 *
 * 托管存储胜出，是因为用户在产品中显式保存的凭证必须对每个提供方一致地生效。
 * 启动环境（含 CI 密钥）仅在文件未为该引用存储任何值时适用。参见
 * `.agents/notes/implemented/architecture/2026-10-09-stored-credential-precedence.md`。
 *
 * 被调用的项目可以提供某个键，因为产品信任其所在的启动项目。它排在托管存储之下，
 * 因此通过 Models 页面存储的键绝不会被某个签出恰好携带的键所取代。
 *
 * 该文件即提供方管理的可写来源：每次写入都会在一把跨进程写锁之下重新读取文档，
 * 然后只修补它自己的键——每条未改动条目的注释与格式都得以保留——外部编辑通过
 * 该 seam 即时发布，而每次重新加载都会整体替换快照，因此一条被删除的条目绝不会
 * 残留在内存中。
 *
 * 该文档持有凭证，这正是 `refs` 是一个严格的、`CredentialRef` 到字符串的映射
 * 而非 dotenv 文件的原因；另一个工具写入的、陌生的顶层键会被保留但解析不出任何
 * 东西：一个由 Harness 拥有、且从不物化进环境的存储，也不可能同时充当用户的环境
 * 层；一个兼任环境层的存储会以其优先级遮蔽非秘密条目，使它们静默地无法访问。
 * @module @deepseek-ai/dsh-credentials-local
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { watch as chokidarWatch } from 'chokidar'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { Document, isMap, isScalar, parseDocument, type YAMLError } from 'yaml'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { canonicalizeWatchPath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { CredentialProvider, credentialRef, parseCredentialKey } from '@deepseek-ai/dsh-credentials'
import type {
  ApiKeyRecord,
  CredentialInfo,
  CredentialKey,
  CredentialRecord,
  CredentialRecordEntry,
  CredentialRecordInfo,
  CredentialRef,
  ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import type { LaunchEnvironmentEntry } from '@deepseek-ai/dsh-launch-environment'

/** 凭证文档在 harness home 内的基本文件名。 */
export const CREDENTIALS_FILENAME = '.credentials.yaml'

/** 插件配置：文件位置与热重载行为。 */
export interface Config {
  /** 凭证文档路径；默认为 harness home 下的 `.credentials.yaml`。 */
  path?: string
  /** 当省略 `path` 时使用的 harness home；默认为 `$DSH_HOME` 或 `~/.dsh`。 */
  dshHome?: string
  /** 监视该文档并即时发布外部编辑；默认为 true。 */
  watch?: boolean
  /** 监视器的写落定窗口，以毫秒计；默认为 100。 */
  debounceMs?: number
}

/** 完全解析后的提供方参数；默认值在此处解析，绝不内联。 */
interface ResolvedSpec {
  filename: string
  watch: boolean
  debounceMs: number
}

/**
 * 从插件配置解析运行时 spec：显式的 `path` 优先，否则文档位于
 * `<harness home>/.credentials.yaml`。
 * @param config - 原始插件配置。
 * @returns 解析后的文件位置与监视行为。
 */
export function resolveSpec(config: Config): ResolvedSpec {
  return {
    filename: resolve(config.path ?? join(resolveDshHome(config.dshHome), CREDENTIALS_FILENAME)),
    watch: config.watch ?? true,
    debounceMs: config.debounceMs ?? 100,
  }
}

/** 属主之外的权限位；凭证文档不得带任何此类权限位。 */
const GROUP_OTHER_BITS = 0o077

/**
 * 一次记录写入等待跨进程写锁的时长。一次记录变更会在持有锁的同时运行其调用方的
 * 决策，而对于本半边所要服务的操作——一个拥有者刷新过期的令牌——该决策包含一次
 * 网络往返。文件操作的默认时长会在其持续期间让该文档的所有其他写入者都失败。
 * 竞争者的等待按它能遇到的、持有最久的一方来定长，而 refs 与 records 共用一个文件
 * 与一把锁，因此该文档的每一个写入者——引用写入与记录删除都包括在内——都等待这么久，
 * 而不只是持有锁的那次变更。与 `dsh-atomic-write` 中的重试节奏一样，这是写协议的
 * 健壮性上界，而非部署选择：它由一次提供方请求的成本决定，没有任何部署会改变它。
 */
const DOCUMENT_LOCK_WAIT_MS = 30_000

/**
 * 在读取凭证文档的内容之前，就拒绝一个其他 OS 用户可读取的文档。该提供方以 `0600`
 * 创建并替换该文件，但一个手工书写或由外部生成的文件带有其 umask 所产生的任何权限，
 * 而从一个世界可读的文件静默地提供秘密，会使该提供方所承诺的模式变得毫无意义。
 *
 * 仅限 POSIX：Windows 没有可检查的 mode——它的 ACL 在此无法表达——因此该检查被跳过
 * 而非被伪造，而该处文件的保护就是创建与替换 API 所表达的内容。
 * @param filename - 文档的绝对路径。
 * @throws 当路径层级无效，或文件存在且带有组或其他用户的权限位时。
 */
async function assertOwnerOnly(filename: string): Promise<void> {
  let mode: number
  try {
    mode = (await stat(filename)).mode
  } catch (error) {
    if (!isENOENT(error)) throw error
    await canonicalizeWatchPath(filename)
    return
  }
  /* v8 ignore next -- POSIX 覆盖无法接管 Windows 对等分支；原生的 Windows 覆盖可以。 */
  if (process.platform === 'win32') return
  /* v8 ignore start -- Windows 没有 POSIX 模式强制；POSIX 行为测试会强制这一对等分支。 */
  const offending = mode & GROUP_OTHER_BITS
  if (offending === 0) return
  throw new Error(
    `credentials-local: ${filename} is readable beyond its owner (mode ${(mode & 0o777).toString(8)});`
    + ` run "chmod 600 ${filename}" before starting again`,
  )
  /* v8 ignore stop */
}

/** 一个文件系统错误是否意味着“不存在”；每一个非 ENOENT 的失败都必须浮现。 */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/**
 * 描述一次 YAML 解析失败，但不引用源文本。解析器自身的消息内嵌了出错的行，而在此
 * 处该行正是秘密。
 * @param error - 解析器的错误。
 * @returns 错误码及其行号与列号。
 */
function describeYamlError(error: YAMLError): string {
  const at = error.linePos?.[0]
  /* v8 ignore next -- `prettyErrors` 在每次错误时都会填充 linePos；此守卫正是对其可选类型的应答 */
  const where = at === undefined ? '' : ` at line ${String(at.line)}, column ${String(at.col)}`
  return `${error.code}${where}`
}

/** 本构建所读取与写入的文档布局。 */
export const DOCUMENT_VERSION = 1

/** 一份已解析的凭证文档：它存储的两个键空间（按所写形式建键），加上它不读取的顶层键。 */
export interface CredentialsDocument {
  /** 引用条目，以 {@link CredentialRef} 为键。 */
  refs: Map<string, string>
  /** 已存储的记录，以 {@link CredentialKey} 为键。 */
  records: Map<string, CredentialRecord>
  /** 本构建不读取的顶层键；它们保留在磁盘上，且解析不出任何东西。 */
  ignoredKeys: string[]
}

/**
 * 解析一份凭证文档。在 `refs` 与 `records` 内部，一切都被拒绝而非跳过——不可寻址的
 * 键、类型错误的值、未知的记录标签或字段——因为一个被静默忽略的条目会被读作
 * “我存储的凭证没有效果”；一个未带版本的文档根也被拒绝。一个未知的顶层键会在
 * `ignoredKeys` 中返回给调用方报告，因此另一个工具写入的陌生条目不会阻断启动。
 * 重复的键作为解析器错误浮现。一份空文档即一个空存储，且无需版本。
 * @param text - 文档的文本。
 * @param filename - 绝对路径，在错误中引用。
 * @returns 已解析的引用、记录，以及被忽略的顶层键。
 */
export function parseCredentialsDocument(text: string, filename: string): CredentialsDocument {
  // `prettyErrors` 仅为 `linePos` 开启；`error.message` 从不使用，因为解析器会引用
  // 出错的源行，而在此文档中那一行正是秘密。只有错误码与位置会离开此函数，且同样的
  // 规则约束此处所有其他诊断——键名可以打印，值则不行。
  const document = parseDocument(text, { prettyErrors: true, uniqueKeys: true })
  if (document.errors.length > 0) {
    throw new Error(`credentials-local: invalid document at ${filename}: ${
      document.errors.map(describeYamlError).join('; ')}`)
  }
  const root: unknown = document.toJS() ?? {}
  if (typeof root !== 'object' || root === null || Array.isArray(root)) {
    throw new TypeError(`credentials-local: ${filename} must be a mapping`)
  }
  const fields = root as Record<string, unknown>
  const keys = Object.keys(fields)
  // 一份空（或仅含注释）的文档即是空存储，且无需版本：其中没有任何内容会被
  // 后续的布局所意指。
  if (keys.length === 0) return { refs: new Map(), records: new Map(), ignoredKeys: [] }
  if (!('version' in fields)) {
    throw new Error(
      `credentials-local: ${filename} uses the pre-release flat layout. Add \`version: ${DOCUMENT_VERSION}\``
      + ` and nest the existing ${keys.length} ${keys.length === 1 ? 'entry' : 'entries'} under \`refs:\`.`
      + ' No values need to change.',
    )
  }
  if (fields['version'] !== DOCUMENT_VERSION) {
    throw new Error(
      `credentials-local: ${filename} declares version ${JSON.stringify(fields['version'])};`
      + ` this build reads version ${DOCUMENT_VERSION}`,
    )
  }
  return {
    refs: parseRefs(fields['refs'], filename),
    records: parseRecords(fields['records'], filename),
    ignoredKeys: keys.filter(key => key !== 'version' && key !== 'refs' && key !== 'records'),
  }
}

/**
 * 为一份预发布扁平文档渲染 1 版布局，或对其他任何内容返回 `undefined`。扁平布局被
 * 精确识别——一个非空的、顶层映射，从可寻址引用名映射到非空字符串标量，没有 `version`
 * 键，也没有文档指令——而重写会把原始行按原样嵌套到 `refs:` 之下、缩进两空格，
 * 因此注释、空行，以及每个值的拼写都逐字节保留。
 * 任何识别器拒绝的内容都保留 {@link parseCredentialsDocument} 那响亮的拒绝：一份本构建
 * 无法证明自己理解的文档绝不会被重写。随首个带标签的发布、与预发布姿态一同移除。
 * @param text - 文档的文本。
 * @returns 迁移后的文本；当文本不是被识别的扁平布局时为 `undefined`。
 */
export function renderFlatLayoutMigration(text: string): string | undefined {
  const document = parseDocument(text, { prettyErrors: true, uniqueKeys: true })
  if (document.errors.length > 0) return undefined
  const flat = document.contents
  if (!isMap(flat) || flat.items.length === 0) return undefined
  for (const line of text.split('\n')) {
    // 指令或文档标记在缩进进 `refs:` 块之后无法存活；任何已发布的写入器都从未在此
    // 发出过此类内容。
    if (/^(%|---|\.\.\.)/.test(line)) return undefined
  }
  for (const pair of flat.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== 'string' || pair.key.value === 'version') return undefined
    try {
      credentialRef(pair.key.value)
    } catch {
      // 只有 credentialRef 对“非 POSIX 名称”的拒绝会落在此处；扁平读取器也拒绝过此种
      // 键，因此这不是被识别的布局，那响亮的拒绝维持不变。
      return undefined
    }
    if (!isScalar(pair.value) || typeof pair.value.value !== 'string' || pair.value.value.length === 0) return undefined
  }
  const body = text.split('\n').map(line => (line.length === 0 ? line : `  ${line}`)).join('\n')
  return `version: ${DOCUMENT_VERSION}\nrefs:\n${body}${text.endsWith('\n') ? '' : '\n'}`
}

/** 接纳一个 `refs` 段：以 POSIX 标识符为键、非空字符串为值。 */
function parseRefs(section: unknown, filename: string): Map<string, string> {
  const entries = new Map<string, string>()
  for (const [key, value] of Object.entries(asSection(section, 'refs', filename))) {
    // credentialRef 会对任何非 POSIX 标识符抛出，而这正是一条已存储引用若要可寻址
    // 于该 seam 所必须满足的约束。
    credentialRef(key)
    // 被引用的是键名，绝不是值：一个类型错误的条目仍然是用户想要存储的秘密。
    if (typeof value !== 'string') {
      throw new TypeError(`credentials-local: the value for "${key}" in ${filename} must be a string`)
    }
    if (value.length === 0) {
      throw new Error(`credentials-local: the value for "${key}" in ${filename} is empty; remove the key instead`)
    }
    entries.set(key, value)
  }
  return entries
}

/** 接纳一个 `records` 段：以 `<scope>/<id>` 为键、带标签的记录映射为值。 */
function parseRecords(section: unknown, filename: string): Map<string, CredentialRecord> {
  const entries = new Map<string, CredentialRecord>()
  for (const [key, value] of Object.entries(asSection(section, 'records', filename))) {
    parseCredentialKey(key)
    entries.set(key, parseRecord(key, value, filename))
  }
  return entries
}

/**
 * 在渲染之前，就拒绝一条读路径本无法接纳的 api-key 记录：空的 key、超出引用文法的
 * 环境名，或空的环境值会持久化出一份 `parseRecord` 在下一次启动时会拒绝的文档——
 * 一处持久化边界的写入要在它被写入之处就被校验。
 * @param key - 该记录的凭证键，用于失败消息。
 * @param record - 一次变更所返回的 api-key 记录。
 */
function assertStorableApiKey(key: CredentialKey, record: ApiKeyRecord): void {
  if (record.key !== undefined && record.key.length === 0) {
    throw new TypeError(`credentials-local: record "${key}" has an empty key; omit the field instead`)
  }
  for (const [name, value] of Object.entries(record.env ?? {})) {
    credentialRef(name)
    if (value.length === 0) {
      throw new TypeError(`credentials-local: record "${key}" env "${name}" must be a non-empty string`)
    }
  }
}

/** 文档的一个段，视为普通映射；缺省与 null 都表示空。 */
function asSection(section: unknown, name: string, filename: string): Record<string, unknown> {
  if (section === undefined || section === null) return {}
  if (typeof section !== 'object' || Array.isArray(section)) {
    throw new TypeError(`credentials-local: "${name}" in ${filename} must be a mapping`)
  }
  return section as Record<string, unknown>
}

/** 接纳一条记录条目，拒绝未知的标签或字段，而非将其丢弃。 */
function parseRecord(key: string, value: unknown, filename: string): CredentialRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`credentials-local: record "${key}" in ${filename} must be a mapping`)
  }
  const fields = value as Record<string, unknown>
  const kind = fields['kind']
  if (kind === 'api-key') {
    assertFields(key, fields, ['kind', 'key', 'env'], filename)
    const apiKey = fields['key']
    if (apiKey !== undefined && (typeof apiKey !== 'string' || apiKey.length === 0)) {
      throw new TypeError(`credentials-local: record "${key}" in ${filename} has a non-string or empty key`)
    }
    const env = parseRecordEnv(key, fields['env'], filename)
    return {
      kind: 'api-key',
      ...apiKey === undefined ? {} : { key: apiKey },
      ...env === undefined ? {} : { env },
    }
  }
  if (kind === 'grant') {
    assertFields(key, fields, ['kind', 'payload'], filename)
    if (!('payload' in fields)) {
      throw new Error(`credentials-local: record "${key}" in ${filename} has no payload`)
    }
    assertJsonValue(`record "${key}" payload in ${filename}`, fields['payload'], new Set())
    return { kind: 'grant', payload: fields['payload'] }
  }
  if (kind === undefined) throw new Error(`credentials-local: record "${key}" in ${filename} has no kind`)
  throw new Error(`credentials-local: record "${key}" in ${filename} has unknown kind ${JSON.stringify(kind)}`)
}

/** 拒绝该标签未定义的字段，以免一处拼写错误被静默丢弃。 */
function assertFields(key: string, fields: Record<string, unknown>, allowed: string[], filename: string): void {
  for (const field of Object.keys(fields)) {
    if (!allowed.includes(field)) {
      throw new Error(`credentials-local: record "${key}" in ${filename} has unknown field "${field}"`)
    }
  }
}

/** 接纳一条 api-key 记录的提供方环境：以 POSIX 名为键、非空字符串为值。 */
function parseRecordEnv(key: string, env: unknown, filename: string): Record<string, string> | undefined {
  if (env === undefined) return undefined
  if (typeof env !== 'object' || env === null || Array.isArray(env)) {
    throw new TypeError(`credentials-local: record "${key}" in ${filename} has a non-mapping env`)
  }
  const parsed: Record<string, string> = {}
  for (const [name, value] of Object.entries(env as Record<string, unknown>)) {
    credentialRef(name)
    if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError(
        `credentials-local: record "${key}" env "${name}" in ${filename} must be a non-empty string`,
      )
    }
    parsed[name] = value
  }
  return parsed
}

/**
 * 拒绝一个无法经历 JSON 往返的载荷，无论是进来时还是出去时。该 seam 向拥有者承诺
 * 其载荷会逐字原样返回，而两个方向都可能破坏这一点：文档可能拼出 `.inf` 或一个别名
 * 环，而拥有者可能交出本文档无法忠实拼写出的 `Date`、类实例或 `bigint`。在诊断中，
 * 无论是该值还是任何嵌套值都不会被引用。
 * @param where - 在诊断中所指明的主体，已经不含任何值。
 * @param value - 要接纳的载荷或嵌套值。
 * @param seen - 当前路径上的对象，用于环检测。
 * @throws 当该值无法往返时，以 `where` 命名的 TypeError。
 */
function assertJsonValue(where: string, value: unknown, seen: Set<object>): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return
    throw new TypeError(`credentials-local: ${where} holds a non-finite number`)
  }
  if (typeof value === 'object') {
    if (seen.has(value)) throw new TypeError(`credentials-local: ${where} is cyclic`)
    if (Object.getPrototypeOf(value) === Object.prototype || Array.isArray(value)) {
      seen.add(value)
      for (const nested of Object.values(value)) assertJsonValue(where, nested, seen)
      seen.delete(value)
      return
    }
  }
  throw new TypeError(`credentials-local: ${where} holds a value JSON cannot represent`)
}

/**
 * 一次编辑所基于的、保留注释的可变树。编辑已解析的文档而非重建它，能保留注释与
 * 每条未改动条目的格式；一份缺省的文档则从一个全新的文档开始。
 * @param text - 当前文档文本，文件缺省时为 `undefined`。
 * @returns 待编辑的树，带有本构建的版本戳。
 */
function mutableDocument(text: string | undefined): Document {
  // `text` 只会缓存解析成功的.content，因此这次为保留注释的可变树所做的重新解析
  // 不可能失败。`intAsBigInt` 能在一个陌生的顶层条目被重新序列化时，让超出 2^53 的
  // 整数保持精确。
  const document = text === undefined ? new Document({}) : parseDocument(text, { intAsBigInt: true })
  // 每次编辑都盖上戳，使得本提供方创建的文档能被接纳它所编辑文档的同一个解析器读取；
  // 既有的戳会被改写为相同的值。
  document.setIn(['version'], DOCUMENT_VERSION)
  return document
}

/**
 * 渲染出设置了或删除了某条引用的下一份文档文本。
 * @param text - 当前文档文本，文件缺省时为 `undefined`。
 * @param ref - 要写入的引用。
 * @param value - 新值，或 `undefined` 以删除该键。
 * @returns 待持久化的文本。
 */
function renderRef(text: string | undefined, ref: CredentialRef, value: string | undefined): string {
  const document = mutableDocument(text)
  if (value === undefined) deleteSectionEntry(document, 'refs', ref)
  else document.setIn(['refs', ref], value)
  return document.toString()
}

/**
 * 渲染出写入或删除了某条记录的下一份文档文本。记录节点被整体替换，而非逐字段编辑：
 * 记录是由机器写入的，因此其中没有需要保留的手工格式。
 * @param text - 当前文档文本，文件缺省时为 `undefined`。
 * @param key - 要写入的记录。
 * @param record - 新记录，或 `undefined` 以删除它。
 * @returns 待持久化的文本。
 */
function renderRecord(text: string | undefined, key: CredentialKey, record: CredentialRecord | undefined): string {
  const document = mutableDocument(text)
  if (record === undefined) deleteSectionEntry(document, 'records', key)
  else document.setIn(['records', key], record)
  return document.toString()
}

/**
 * 从一个 section 中移除一条条目，并一并带走它的注释。写在某个 section 首个条目上方的
 * 注释块标注的是该条目，但解析器把它挂到了该 section 的 map 上而非那个键值对——
 * 若把它留下，它会移动到变成第一个的任意条目上，看起来就像在为一个没有人写过的
 * 凭证做标注。
 * @param document - 正在被编辑的可变树。
 * @param section - 持有该条目的 section。
 * @param key - 要移除的条目。
 */
function deleteSectionEntry(document: Document, section: 'refs' | 'records', key: string): void {
  const map: unknown = document.get(section, true)
  /* v8 ignore next -- 两个调用方都只对它们刚在已解析快照中找到的条目渲染删除，
     因此该条目所在的 section 始终是 map；此守卫正是收窄 `get` 的 `unknown` 之处。 */
  if (isMap(map)) {
    const first = map.items[0]
    /* v8 ignore next -- 持有该条目的 map 必有首个项，且解析器只接纳标量键，
       因此只有同一性测试可能为假。 */
    if (first !== undefined && isScalar(first.key) && first.key.value === key) {
      map.commentBefore = null
    }
  }
  document.deleteIn([section, key])
}

/**
 * 两个已接纳 JSON 值之间的结构性相等。记录是在经过 {@link assertJsonValue} 之后才
 * 到达此处，因此遍历只会遇到 JSON 形状；键的顺序被忽略，因为外部编辑器可能在不改变
 * 所存储内容的情况下重排记录的字段。
 * @param left - 一个值。
 * @param right - 另一个值。
 * @returns 两者是否携带相同的 JSON 内容。
 */
function sameJsonValue(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every(key => key in right
    && sameJsonValue((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]))
}

/** 以文件为后盾的凭证提供方（`$DSH_HOME/.credentials.yaml`）。 */
export class LocalCredentialProvider extends CredentialProvider {
  static Config: z<Config> = z.object({
    path: z.string(),
    dshHome: z.string(),
    watch: z.boolean().default(true),
    debounceMs: z.number().min(0).default(100),
  })

  private readonly spec: ResolvedSpec
  /**
   * 上一次读取或持久化文档的原始文本；文件缺省时为 `undefined`。内容与此缓存相同的
   * 监视器事件是无操作，这也正是自我写入抑制。
   */
  private text: string | undefined
  /** 已解析的引用快照；每次重新加载都被整体替换。 */
  private values = new Map<string, string>()
  /** 已解析的记录快照；每次重新加载都被整体替换。 */
  private records = new Map<string, CredentialRecord>()
  /**
   * 单一独占操作链：监视器的重新加载与行编辑按入队顺序一次一个地运行（已结算尾），
   * 因此一次编辑绝不会从一份正被并发重新加载忙着替换的文本渲染出来。
   */
  private operations: Promise<void> = Promise.resolve()
  /** 在 dispose 时置位：拒绝新的写入，并让在途工作变为无操作。 */
  private closed = false

  /** 对 {@link closed} 的不透明读取：控制流无法跨 await 收窄它。 */
  private isClosed(): boolean {
    return this.closed
  }

  constructor(ctx: Context, public config: Config) {
    super(ctx)
    // 编程式构造可能绕过 Schemastery 的归一化；无论如何都用一个显式步骤解析相同的默认值。
    this.spec = resolveSpec(config)
  }

  /** 某个引用的、继承自环境的值；为空或未设置时为 `undefined`。 */
  private inherited(ref: CredentialRef): string | undefined {
    const entry = launchEnvironmentOf(this.ctx).getFrom(ref, ['process'])
    return entry !== undefined && entry.value.length > 0 ? entry.value : undefined
  }

  /**
   * 针对某个引用的、`.env` 回退——排在托管存储之下，绝不在其上。被调用的项目排在
   * 用户主目录文件之上，与环境分层一致：更具体的位置胜出。
   */
  private dotenvFallback(ref: CredentialRef): LaunchEnvironmentEntry | undefined {
    const entry = launchEnvironmentOf(this.ctx).getFrom(ref, ['project-env', 'user-env'])
    return entry !== undefined && entry.value.length > 0 ? entry : undefined
  }

  async* [Service.init](): AsyncGenerator<() => Promise<void> | void, void, void> {
    yield async () => {
      // 排空：拒绝新的操作，然后结算已入队的那些，以便处置只在存储静默之后完成。
      this.closed = true
      await this.operations
    }
    await this.loadInitial()
    if (!this.spec.watch) return
    const watcher = chokidarWatch(await canonicalizeWatchPath(this.spec.filename), {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: this.spec.debounceMs,
        pollInterval: Math.max(1, Math.min(this.spec.debounceMs, 10)),
      },
    })
    watcher.on('all', () => {
      if (this.closed) return
      this.queueRefresh()
    })
    watcher.on('ready', () => {
      // 初始加载与监视器自身的建立发生了竞速：在那一读取与监视器变为活跃之间写入的
      // 变更永远不会触发事件。在 ready 时做一次对账即可弥合这一间隙。
      if (this.closed) return
      this.queueRefresh()
    })
    const reportWatcherError = (error: unknown): void => {
      // 处置之后的监视器错误是不可操作的：被监视的 home 正随本提供方一同消失，记录它
      // 只会成为噪声。
      if (this.closed) return
      this.ctx.logger.warn('credentials-local: watcher error on %s', this.spec.filename)
      this.ctx.logger.warn(error)
    }
    watcher.on('error', reportWatcherError)
    yield async () => {
      // 静默：停止接收事件、关闭监视器，然后等待任何已入队或在途的操作，以便没有任何
      // 东西在处置之后发布。
      this.closed = true
      // `close()` 会丢弃所有监听器，但留下一个已排程的写落定轮询；它的滞留者会 stat
      // 本拆卸正在删除的文档，Windows 将其报告为 EPERM，而一个没有任何监听器时的
      // 'error' 发射会被重新抛出为未捕获异常。在 close 期间重新挂接，使该滞留者仍留在本
      // 提供方内部。
      const closing = watcher.close()
      watcher.on('error', reportWatcherError)
      await closing
      await this.operations
    }
  }

  override resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const stored = this.values.get(ref)
    if (stored !== undefined) return Promise.resolve({ value: stored, source: 'file' })
    const inherited = this.inherited(ref)
    if (inherited !== undefined) return Promise.resolve({ value: inherited, source: 'env' })
    const fallback = this.dotenvFallback(ref)
    if (fallback !== undefined) return Promise.resolve({ value: fallback.value, source: fallback.source })
    return Promise.resolve(undefined)
  }

  override describe(ref: CredentialRef): Promise<CredentialInfo> {
    const stored = this.values.get(ref)
    if (stored !== undefined) return Promise.resolve({ configured: true, source: 'file', writable: true })
    // 每个引用都是可写的：一次 set 会写入托管文件，而它优先于每一个回退；一次 unset
    // 则会再次让回退暴露出来。
    if (this.inherited(ref) !== undefined) return Promise.resolve({ configured: true, source: 'env', writable: true })
    const fallback = this.dotenvFallback(ref)
    if (fallback !== undefined) return Promise.resolve({ configured: true, source: fallback.source, writable: true })
    return Promise.resolve({ configured: false, writable: true })
  }

  override async set(ref: CredentialRef, value: string): Promise<void> {
    if (value.length === 0) {
      throw new Error(`credentials-local: an empty value cannot be stored for "${ref}"; use unset`)
    }
    await this.write(ref, value)
  }

  override async unset(ref: CredentialRef): Promise<void> {
    await this.write(ref, undefined)
  }

  override readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    return Promise.resolve(this.records.get(key))
  }

  override describeRecord(key: CredentialKey): Promise<CredentialRecordInfo> {
    const stored = this.records.get(key)
    // 此处存在性就是全部事实：没有任何层会在记录之上排名，因此没有任何东西能遮蔽一条
    // 记录，而一条既无 key 也无环境值的 api-key 记录是一种刻意的声明，而非空白。
    if (stored === undefined) return Promise.resolve({ configured: false, writable: true })
    return Promise.resolve({ configured: true, kind: stored.kind, writable: true })
  }

  override listRecords(): Promise<readonly CredentialRecordEntry[]> {
    return Promise.resolve([...this.records].map(([key, record]) => ({
      // 解析器已经证明每条已存储的键都是可寻址的。
      key: parseCredentialKey(key),
      kind: record.kind,
    })))
  }

  override async modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    if (this.isClosed()) throw new Error(`credentials-local is disposed: cannot modify "${key}"`)
    return this.enqueue(async () => {
      if (this.isClosed()) {
        throw new Error(`credentials-local was disposed before the queued "${key}" modify ran`)
      }
      await mkdir(dirname(this.spec.filename), { recursive: true, mode: 0o700 })
      return withFileLock(this.spec.filename, async () => {
        // 读取-修改-写入：`mutate` 必须依据记录此刻的状态做决定，而非本进程上一次
        // 看到的状态——另一个进程可能自那时起已经轮转过它。
        await this.reconcileFromDisk()
        const current = this.records.get(key)
        const next = await mutate(current)
        if (next === undefined) return current
        // 在渲染之前即被接纳校验：读路径会拒绝的东西在此处先被拒绝，因此调用方绝不可能
        // 持久化出一份下一次启动会拒绝的文档，而在此被拒绝的值也尚未被存储。
        if (next.kind === 'grant') assertJsonValue(`record "${key}" payload`, next.payload, new Set())
        else assertStorableApiKey(key, next)
        const nextText = renderRecord(this.text, key, next)
        // 0600：一份持有秘密的文档绝不可被世界可读。
        await writeFileAtomic(this.spec.filename, nextText, { mode: 0o600, dirMode: 0o700 })
        this.text = nextText
        this.records.set(key, next)
        // 提交之后，与引用写入相同的条件。
        this.notifyRecordUpdated(key)
        return next
      }, { waitMs: DOCUMENT_LOCK_WAIT_MS })
    })
  }

  override async deleteRecord(key: CredentialKey): Promise<void> {
    if (this.isClosed()) throw new Error(`credentials-local is disposed: cannot delete "${key}"`)
    await this.enqueue(async () => {
      if (this.isClosed()) {
        throw new Error(`credentials-local was disposed before the queued "${key}" delete ran`)
      }
      await mkdir(dirname(this.spec.filename), { recursive: true, mode: 0o700 })
      await withFileLock(this.spec.filename, async () => {
        await this.reconcileFromDisk()
        if (!this.records.has(key)) return
        const nextText = renderRecord(this.text, key, undefined)
        await writeFileAtomic(this.spec.filename, nextText, { mode: 0o600, dirMode: 0o700 })
        this.text = nextText
        this.records.delete(key)
        this.notifyRecordUpdated(key)
      }, { waitMs: DOCUMENT_LOCK_WAIT_MS })
    })
  }

  /** 将一次独占文档操作排入每一处更早操作之后。 */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.operations.then(operation)
    this.operations = task.then(() => undefined, () => undefined)
    return task
  }

  /** 排入一次重新加载；`refresh()` 会包容它自身的失败，因此入队任务从不拒绝。 */
  private queueRefresh(): void {
    void this.enqueue(() => this.refresh())
  }

  /** 排入一次行编辑；在入口与入队编辑运行时都会检查是否已被处置。 */
  private async write(ref: CredentialRef, value: string | undefined): Promise<void> {
    const verb = value === undefined ? 'unset' : 'set'
    if (this.isClosed()) {
      throw new Error(`credentials-local is disposed: cannot ${verb} "${ref}"`)
    }
    return this.enqueue(async () => {
      if (this.isClosed()) {
        throw new Error(`credentials-local was disposed before the queued "${ref}" ${verb} ran`)
      }
      // 写锁的独占创建需要父目录存在；0700 是因为 harness home 持有用户私有数据。
      await mkdir(dirname(this.spec.filename), { recursive: true, mode: 0o700 })
      await withFileLock(this.spec.filename, async () => {
        // 读取-修改-写入：并入本进程尚未观测到的任何磁盘状态——一个仍处在监视器去抖
        // 窗口内的外部编辑、监视器错过的一次变更，或另一个进程的写入——从而下方的行编辑
        // 绝不可能复活一份陈旧的文档。
        await this.reconcileFromDisk()
        const existing = this.values.get(ref)
        if (value === undefined && existing === undefined) return
        const nextText = renderRef(this.text, ref, value)
        // 0600：一份持有秘密的文档绝不可被世界可读。
        await writeFileAtomic(this.spec.filename, nextText, { mode: 0o600, dirMode: 0o700 })
        this.text = nextText
        if (value === undefined) this.values.delete(ref)
        else this.values.set(ref, value)
        // 提交之后：一个损坏的观察者绝不可让这次持久的写入看起来像是失败。
        this.notifyUpdated(ref)
      }, { waitMs: DOCUMENT_LOCK_WAIT_MS })
    })
  }

  /**
   * 启动读取：缺省的文件即一个空存储；而一份无效的文档会使插件激活失败，因为一份
   * 存在却不可信的凭证文档绝不可被当作“未存储任何凭证”。唯一的例外是那份被识别的、
   * 预发布的扁平布局，它会先就地升级——一份由更早构建存储的键必须能在布局变更后存活，
   * 而无需手工编辑。
   */
  private async loadInitial(): Promise<void> {
    await assertOwnerOnly(this.spec.filename)
    let text: string
    try {
      text = await readFile(this.spec.filename, 'utf8')
    } catch (error) {
      if (!isENOENT(error)) throw error
      return
    }
    if (renderFlatLayoutMigration(text) !== undefined) text = await this.migrateFlatDocument()
    const document = parseCredentialsDocument(text, this.spec.filename)
    this.warnIgnoredKeys(document)
    this.values = document.refs
    this.records = document.records
    this.text = text
  }

  /**
   * 在监视器存在之前，对那份被识别的、预发布扁平布局的一次性升级。重写在该文档的写锁
   * 之下运行，且先重新读取——一次并发的启动可能已迁移过——而重新读取所发现的、非扁平
   * 布局的任何内容都原样返回给普通的解析。值被逐字携带；只有外层布局发生变化。随首个
   * 带标签的发布、与预发布姿态一同移除。
   * @returns 本次启动应当解析的文档文本。
   */
  private async migrateFlatDocument(): Promise<string> {
    return withFileLock(this.spec.filename, async () => {
      const current = await readFile(this.spec.filename, 'utf8')
      const migrated = renderFlatLayoutMigration(current)
      /* v8 ignore next 2 -- 跨进程迁移竞速中落败的一方：另一个启动在未被锁保护的
         识别与这把锁之间重写了该文档。这种交错无法在整个启动过程中被确定性地调度
         （migration.spec 以尽力而为方式驱动它）；其决策本身正是识别器所覆盖的、
         对带版本文档的拒绝。 */
      if (migrated === undefined) return current
      // 0600：一份持有秘密的文档绝不可被世界可读。
      await writeFileAtomic(this.spec.filename, migrated, { mode: 0o600, dirMode: 0o700 })
      this.ctx.logger.info(
        'credentials-local: migrated %s to the version %d layout; values are unchanged',
        this.spec.filename,
        DOCUMENT_VERSION,
      )
      return migrated
    }, { waitMs: DOCUMENT_LOCK_WAIT_MS })
  }

  /**
   * 在监视器事件之后重新读取文档。未变更的内容（包括本提供方自身的写入）是无操作；
   * 一份不可读的文档会保留上一份良好快照并发出警告——一次进行中的热重载绝不可让
   * 进程崩溃。
   */
  private async refresh(): Promise<void> {
    if (this.closed) return
    try {
      await this.reconcileFromDisk()
    } catch (error) {
      this.ctx.logger.warn('credentials-local: reload failed at %s; keeping the last good document', this.spec.filename)
      this.ctx.logger.warn(error)
    }
  }

  /**
   * 将磁盘上的文本与缓存比较，并把任何差异发布到该 seam。缺省会发布空存储；一份不可读
   * 或无效的文档会抛出，因此每个调用方选择自己的策略——一次重新加载会警告并保留上一份
   * 良好快照，一次写入则响亮地失败，而非覆盖一份它无法理解的文档。
   */
  private async reconcileFromDisk(): Promise<void> {
    // 在每次重新加载与每次写入之前都重新检查：外部编辑器或一份被恢复的备份可能在启动
    // 之后放宽该 mode。
    await assertOwnerOnly(this.spec.filename)
    let text: string | undefined
    try {
      text = await readFile(this.spec.filename, 'utf8')
    } catch (error) {
      if (!isENOENT(error)) throw error
      text = undefined
    }
    if (text === this.text || this.isClosed()) return
    const next = text === undefined
      ? { refs: new Map<string, string>(), records: new Map<string, CredentialRecord>(), ignoredKeys: [] }
      : parseCredentialsDocument(text, this.spec.filename)
    this.warnIgnoredKeys(next)
    const changedRefs = this.changedRefs(this.values, next.refs)
    const changedRecords = this.changedRecords(this.records, next.records)
    this.text = text
    this.values = next.refs
    this.records = next.records
    for (const ref of changedRefs) this.notifyUpdated(ref)
    for (const key of changedRecords) this.notifyRecordUpdated(key)
  }

  /** 报告那些解析不出任何东西的顶层键；只打印键名，绝不打印值。 */
  private warnIgnoredKeys(document: CredentialsDocument): void {
    if (document.ignoredKeys.length === 0) return
    this.ctx.logger.warn(
      'credentials-local: ignoring unknown top-level keys %s in %s; only `refs` and `records` entries resolve',
      document.ignoredKeys.map(key => JSON.stringify(key)).join(', '),
      this.spec.filename,
    )
  }

  /** 已存储值发生变化的条目；解析器已经证明每个键都是可寻址的。 */
  private changedRefs(prev: Map<string, string>, next: Map<string, string>): CredentialRef[] {
    const changed: CredentialRef[] = []
    for (const key of new Set([...prev.keys(), ...next.keys()])) {
      if (prev.get(key) === next.get(key)) continue
      changed.push(credentialRef(key))
    }
    return changed
  }

  /** 已存储值发生变化的记录；解析器已经证明每个键都是可寻址的。 */
  private changedRecords(
    prev: Map<string, CredentialRecord>,
    next: Map<string, CredentialRecord>,
  ): CredentialKey[] {
    const changed: CredentialKey[] = []
    for (const key of new Set([...prev.keys(), ...next.keys()])) {
      if (sameJsonValue(prev.get(key), next.get(key))) continue
      changed.push(parseCredentialKey(key))
    }
    return changed
  }
}

export default LocalCredentialProvider
