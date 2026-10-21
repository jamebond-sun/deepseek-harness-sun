/** 通过 pi-ai 公开目录与认证上下文生成展示元数据。 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import type { Provider } from '@earendil-works/pi-ai'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'

interface ProviderData {
  env: readonly string[]
  defaultBaseURL?: string
  baseURLEnv?: readonly string[]
}

const printer = ts.createPrinter()
const sourceFile = ts.createSourceFile('provider-data.ts', '', ts.ScriptTarget.Latest)
const quote = (value: string): string => printer.printNode(ts.EmitHint.Expression, ts.factory.createStringLiteral(value, true), sourceFile)

// 由各个 API 实现读取的那些端点变量，位于 AuthContext 与那些大写目录
// URL 占位符之外。请把例外保留在这里，而不是保留在界面里。
const SUPPLEMENTS: Readonly<Record<string, { baseURLEnv: readonly string[] }>> = {
  azure: { baseURLEnv: ['AZURE_OPENAI_BASE_URL', 'AZURE_OPENAI_RESOURCE_NAME'] },
  'amazon-bedrock': { baseURLEnv: ['AWS_REGION', 'AWS_DEFAULT_REGION'] },
  'google-vertex': { baseURLEnv: ['GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION'] },
}

/** 把新发现的名字插入到它的前驱之后，插入进那个解析器。 */
function merge(into: string[], sequence: readonly string[]): void {
  for (const [index, name] of sequence.entries()) {
    if (into.includes(name)) continue
    into.splice(index === 0 ? 0 : into.indexOf(sequence[index - 1]!) + 1, 0, name)
  }
}

/**
 * 仅使用合成的环境与文件应答来发现该解析器所读取的内容。
 * @param provider - 已安装的提供方；不使用任何凭据或登录流程。
 * @returns 在空配置、单项配置与后缀配置之下观测到的各个名字。
 */
export async function resolverEnv(provider: Provider): Promise<string[]> {
  const names: string[] = []
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout>
  const timedOut = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      const error = new Error(`${provider.id}: auth metadata probe timed out`)
      controller.abort(error)
      reject(error)
    }, 2000)
  })
  const reads = async (set: ReadonlySet<string>): Promise<string[]> => {
    const read: string[] = []
    await Promise.race([provider.auth.apiKey?.resolve({
      ctx: {
        env: (name) => {
          controller.signal.throwIfAborted()
          if (read.length >= 128) throw new Error(`${provider.id}: auth metadata probe exceeded its read limit`)
          read.push(name)
          return Promise.resolve(set.has(name) ? 'probe-value' : undefined)
        },
        fileExists: () => Promise.resolve(false),
      },
      signal: controller.signal,
    }), timedOut])
    controller.signal.throwIfAborted()
    return read
  }
  try {
    merge(names, await reads(new Set()))
    let previousLength: number
    do {
      previousLength = names.length
      if (names.length > 64) throw new Error(`${provider.id}: auth metadata probe exceeded its name limit`)
      for (let index = 0; index < previousLength; index++) {
        merge(names, await reads(new Set([names[index]!])))
        merge(names, await reads(new Set(names.slice(index))))
      }
    } while (names.length !== previousLength)
    return names
  } finally {
    clearTimeout(timeout!)
  }
}

/**
 * 在不解析真实凭据、也不流式输出一次请求的前提下生成元数据。
 * @param providers - 公开的已安装目录，或用于校验的各个隔离提供方。
 * @returns 以提供方 id 为键的展示元数据。
 */
export async function generateProviderData(providers: readonly Provider[] = builtinProviders()): Promise<Record<string, ProviderData>> {
  const data: Record<string, ProviderData> = {}
  for (const provider of providers) {
    let env: readonly string[]
    try { env = await resolverEnv(provider) }
    catch (error) {
      // compat 是一个临时的上游表面。只在万不得已时导入它，
      // 并使用一个从不读取 process.env 的合成字典。
      const fallback = (await import('@earendil-works/pi-ai/compat')).findEnvKeys(
        provider.id, new Proxy<Record<string, string>>({}, { get: () => 'probe-value' }),
      )
      if (fallback === undefined || fallback.length === 0) throw new Error(`${provider.id}: no auth metadata fallback`, { cause: error })
      console.warn(`${provider.id}: using findEnvKeys auth metadata fallback`, error)
      env = fallback
    }
    const urls = provider.getModels().map(model => model.baseUrl)
    const fixed = provider.baseUrl || (urls.length > 0 && urls.every(url => url === urls[0]) ? urls[0] : undefined)
    const baseURLEnv = [...new Set([
      ...(SUPPLEMENTS[provider.id]?.baseURLEnv ?? []),
      ...[provider.baseUrl ?? '', ...urls].flatMap(url => [...url.matchAll(/\{([A-Z][A-Z0-9_]+)\}/g)].map(match => match[1]!)),
    ])]
    data[provider.id] = {
      env,
      ...fixed && !fixed.includes('{') ? { defaultBaseURL: fixed } : {},
      ...baseURLEnv.length === 0 ? {} : { baseURLEnv },
    }
  }
  return data
}

/**
 * 写出那份确定性的目录，或在不变动它的前提下拒绝陈旧数据。
 * @param check - 改为校验那个工作区文件，而不是写入它。
 * @param cached - 改为校验那个已暂存的文件；绝不写入或暂存文件。
 */
export async function syncProviderData(check: boolean, cached = false): Promise<void> {
  const source = '/** 由已安装的 pi-ai 目录生成。运行 pnpm gen-provider-data；请勿手工编辑。 */\n\n'
    + "import type { BuiltinProvider } from '@earendil-works/pi-ai/providers/all'\n"
    + "import type { LlmConfigurableProvider } from '@deepseek-ai/dsh-llm'\n\n"
    + "type ProviderData = Pick<LlmConfigurableProvider, 'defaultBaseURL' | 'baseURLEnv'> & { env: readonly string[] }\n\n"
    + '/** 各个目录端点与环境名字；运行期不解析任何凭据。 */\n'
    + 'export const PROVIDER_DATA: Record<BuiltinProvider, ProviderData> & Partial<Record<string, ProviderData>> = {\n'
    + Object.entries(await generateProviderData()).map(([id, data]) => {
      const fields = [`env: [${data.env.map(quote).join(', ')}]`,
        ...data.defaultBaseURL === undefined ? [] : [`defaultBaseURL: ${quote(data.defaultBaseURL)}`],
        ...data.baseURLEnv === undefined ? [] : [`baseURLEnv: [${data.baseURLEnv.map(quote).join(', ')}]`],
      ]
      return `  ${quote(id)}: { ${fields.join(', ')} },\n`
    }).join('') + '}\n'
  const path = new URL('../src/provider-data.generated.ts', import.meta.url)
  let current: string | undefined
  try {
    current = cached ? execFileSync('git', ['show', ':packages/llm/llm-pi-ai/src/provider-data.generated.ts'], {
      cwd: fileURLToPath(new URL('../../../../', import.meta.url)), encoding: 'utf8', stdio: 'pipe',
    }) : readFileSync(path, 'utf8')
  }
  catch (error) {
    if (cached) throw new Error('Cannot read staged provider metadata; run pnpm gen-provider-data and stage provider-data.generated.ts', { cause: error })
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (current === source) return
  if (check || cached) throw new Error(`Provider metadata is stale; run pnpm gen-provider-data${cached ? ' and stage provider-data.generated.ts' : ''}`)
  writeFileSync(path, source)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await syncProviderData(process.argv.includes('--check'), process.argv.includes('--cached'))
  console.log('Provider metadata matches the installed pi-ai catalog.')
}
