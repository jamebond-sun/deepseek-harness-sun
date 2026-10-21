/** 通过导出的资源读取插件展示文本与图标，而不求值插件代码。 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ModuleLoader } from '@deepseek-ai/cordis-plugin-loader'
import type { LocalizedText, PluginLocalizedMeta } from '@deepseek-ai/dsh-package-manifest'
import { barePackageName } from './profile-resolution/resolver.ts'
import { realModuleFile } from './profile-resolution/legacy-links.ts'

const LANGUAGE_ID = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u

type DisplayFields = Record<'title' | 'description', string | undefined>

/** 被插件元数据接纳的、原始图标的最大字节数。 */
const MAX_ICON_BYTES = 256 * 1024
const ICON_MEDIA_TYPES = new Map([
  ['.svg', 'image/svg+xml'], ['.png', 'image/png'], ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'],
])

function iconOf(
  specifier: string, packageName: string, parentURL: string, manifestPath: string | undefined, value: unknown,
): string | undefined {
  const icon = manifestPath === undefined ? undefined : textOf(value, `${manifestPath}: icon`)
  let target: string
  // 诊断会点名作者所编辑的文件：声明清单或导出的图像。
  let label: string
  if (manifestPath !== undefined && icon !== undefined) {
    if (isAbsolute(icon) || win32.isAbsolute(icon) || /^[A-Za-z][A-Za-z\d+.-]*:/u.test(icon)) {
      throw new Error(`${manifestPath}: icon must be a relative file path`)
    }
    label = manifestPath
    const root = realpathSync(dirname(manifestPath))
    target = resolve(root, icon)
    const local = relative(root, realModuleFile(target))
    if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) {
      throw new Error(`${label}: icon must remain inside its manifest directory`)
    }
  } else {
    const exported = optionalResourcePath(`${specifier}/icon`, parentURL)
    if (exported === undefined) return undefined
    target = label = exported
    assertPackageOwned(realModuleFile(target), packageName)
  }
  const mediaType = ICON_MEDIA_TYPES.get(extname(target).toLowerCase())
  if (mediaType === undefined) throw new Error(`${label}: icon must be SVG, PNG, JPEG, or WebP`)
  const file = realModuleFile(target)
  const stat = statSync(file)
  if (!stat.isFile()) throw new Error(`${label}: icon must be a regular file`)
  if (stat.size > MAX_ICON_BYTES) throw new Error(`${label}: icon exceeds 256 KiB`)
  const bytes = readFileSync(file)
  if (bytes.length > MAX_ICON_BYTES) throw new Error(`${label}: icon exceeds 256 KiB`)
  return `data:${mediaType};base64,${bytes.toString('base64')}`
}

/** 要求真实文件的一个祖先，其 package.json 命名了所属包。 */
function assertPackageOwned(file: string, name: string): void {
  for (let directory = dirname(file); ; directory = dirname(directory)) {
    const manifest = join(directory, 'package.json')
    if (existsSync(manifest) && readObject(manifest).name === name) return
    if (dirname(directory) === directory) throw new Error(`${file}: icon must remain inside its package directory`)
  }
}

/**
 * 在不求值的前提下，通过活跃的 Node ESM 解析器解析一个插件资源。
 * @param specifier - 插件模块或导出的资源指示符。
 * @param parentURL - 所属模块的解析基址。
 * @returns Node 与活跃 profile 所选择的本地文件系统路径。
 * @throws 当解析器不可用，或资源无法解析为本地文件时。
 */
export function resolvePluginResource(specifier: string, parentURL: string): string {
  const loader = ModuleLoader.fromInternal()
  if (loader === undefined) throw new Error('Plugin metadata requires the Node module resolver')
  const result = loader.version === 'v2'
    ? loader.resolveSync(parentURL, { specifier, attributes: {} })
    : loader.resolveSync(specifier, parentURL, {})
  return fileURLToPath(result.url)
}

function missingResource(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ERR_PACKAGE_PATH_NOT_EXPORTED' || code === 'ERR_MODULE_NOT_FOUND'
    || code === 'MODULE_NOT_FOUND' || code === 'ENOENT' || code === 'ENOTDIR'
}

function optionalResourcePath(specifier: string, parentURL: string): string | undefined {
  try {
    return resolvePluginResource(specifier, parentURL)
  } catch (error) {
    if (missingResource(error)) return undefined
    throw error
  }
}

function objectOf(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`)
  }
  return value as Record<string, unknown>
}

function textOf(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${path} must be a non-empty string`)
  return value
}

function readObject(file: string): Record<string, unknown> {
  let contents: unknown
  try {
    contents = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`${file}: ${String(error)}`)
  }
  return objectOf(contents, file)
}

function fallbackText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function dictionariesOf(englishPath: string, specifier: string, parentURL: string): Map<string, DisplayFields> {
  const dictionaries = new Map<string, DisplayFields>()
  for (const entry of readdirSync(dirname(englishPath), { withFileTypes: true })) {
    if (!entry.name.endsWith('.json')) continue
    const resource = `${specifier}/locale/${entry.name}`
    const language = entry.name.slice(0, -5)
    if (!LANGUAGE_ID.test(language)) throw new Error(`${resource} must use a language id as its filename`)
    const id = language.toLowerCase()
    if (dictionaries.has(id)) throw new Error(`${resource} duplicates locale ${id}`)
    const file = resolvePluginResource(resource, parentURL)
    if (dirname(file) !== dirname(englishPath)) {
      throw new Error(`${resource}: ${file} must share the English locale directory ${dirname(englishPath)}`)
    }
    const parsed = readObject(file)
    const meta = parsed.meta === undefined ? undefined : objectOf(parsed.meta, `${file}: meta`)
    dictionaries.set(id, {
      title: textOf(meta?.title, `${file}: meta.title`),
      description: textOf(meta?.description, `${file}: meta.description`),
    })
  }
  return dictionaries
}

function localizedText(
  field: keyof DisplayFields, dictionaries: Map<string, DisplayFields>, fallback: string | undefined, finalFallback: string,
): LocalizedText | undefined {
  const entries = [...dictionaries].flatMap(([language, fields]): [string, string][] => {
    const value = fields[field]
    return value === undefined ? [] : [[language, value]]
  })
  if (entries.length === 0) return fallback
  return { en: fallback ?? finalFallback, ...Object.fromEntries(entries) }
}

/**
 * 在不求值 JavaScript 条目的前提下，读取插件 locale JSON 展示文本与图标。
 * 只有包根指示符会读取其导出的 package.json：`name`/`description` 填充缺失的
 * locale 字段，而声明的 `icon` 优先于 `<specifier>/icon` 资源。子路径指示符从不读取
 * package.json；其图标只来自 `<specifier>/icon`。清单图标保留在其声明目录之内；导出的
 * 图标在 realpath 解析之后仍保留在其所属包之内。两者都接受 SVG、PNG、JPEG 或 WebP，最大 256 KiB。
 * 图标失败会保留展示文本而不回退。非包指示符会被跳过，而不调用资源解析器。语言文件共享
 * 包含已解析 English 资源的目录；每个文件在读取之前都通过完整的插件指示符解析。翻译映射
 * 保留一个 English 回退，最终对标题为完整模块指示符、对描述为空。
 * @param specifier - 已配置的插件模块名，包括任何包子路径。
 * @param parentURL - 所属 Loader 树的模块解析基址。
 * @returns 展示字段与任意资源诊断；对于非包指示符或缺失的元数据为 undefined。
 */
export function readPluginMeta(specifier: string, parentURL: string): PluginLocalizedMeta | undefined {
  const packageName = barePackageName(specifier)
  if (packageName === undefined) return undefined
  try {
    const englishPath = optionalResourcePath(`${specifier}/locale/en.json`, parentURL)
    const dictionaries = englishPath === undefined ? new Map<string, DisplayFields>() : dictionariesOf(englishPath, specifier, parentURL)
    const manifestPath = packageName === specifier ? optionalResourcePath(`${specifier}/package.json`, parentURL) : undefined
    const manifest = manifestPath === undefined ? undefined : readObject(manifestPath)
    const title = localizedText('title', dictionaries, fallbackText(manifest?.name), specifier)
    const description = localizedText('description', dictionaries, fallbackText(manifest?.description), '')
    const text = {
      ...title === undefined ? {} : { title },
      ...description === undefined ? {} : { description },
    }
    let icon: string | undefined
    try {
      icon = iconOf(specifier, packageName, parentURL, manifestPath, manifest?.icon)
    } catch (error) {
      return { ...text, error: `Plugin metadata for ${specifier}: ${String(error)}` }
    }
    if (title === undefined && description === undefined && icon === undefined) return undefined
    return { ...text, ...icon === undefined ? {} : { icon } }
  } catch (error) {
    return { error: `Plugin metadata for ${specifier}: ${String(error)}` }
  }
}
