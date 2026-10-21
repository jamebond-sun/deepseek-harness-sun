/** 随包分发的 Office 工作流与文件系统资源，用于文档写作与文档处理。 */

import { readFileSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, sep } from 'node:path'
import { isSea } from 'node:sea'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BUNDLED_SKILL_RANK, type SkillCandidate, type SkillProvider } from '@deepseek-ai/dsh-skill'
import { parse as parseYaml } from 'yaml'

const SKILL_NAMES = ['office', 'office-docx', 'office-pptx', 'office-xlsx', 'office-render', 'office-recalculate', 'office-export-pdf'] as const

/** Office 技能的资源位置。 */
export interface Config {
  /** 容纳各技能文件夹的绝对资源目录；默认为随包打包的资源。 */
  assetRoot?: string
  /** 独立的 Node 可执行文件；在 Electron 与 SEA 之外默认为当前可执行文件。 */
  node?: string
  /** LibreOffice Kit CLI 入口的绝对路径；显式的 false 表示禁用 CLI 访问。 */
  cli?: string | false
}

/** 经过校验的资源配置。 */
export const Config: z<Config> = z.object({
  assetRoot: z.string().min(1),
  node: z.string().min(1),
  cli: z.union([z.string().min(1), z.const(false)]),
})

/** Cordis 插件身份。 */
export const name = 'skill-office'
/** 该随包提供方所用的注册表。 */
export const inject = ['skills']

function parseSkill(raw: string, path: string): { description: string; content: string } {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  if (frontmatter?.[1] === undefined) throw new Error(`skill-office: ${path} has no YAML frontmatter`)
  const metadata: unknown = parseYaml(frontmatter[1])
  const description = typeof metadata === 'object' && metadata !== null && 'description' in metadata
    ? metadata.description : undefined
  if (typeof description !== 'string' || description.length === 0) throw new Error(`skill-office: ${path} has no description`)
  return { description, content: raw.slice(frontmatter[0].length).trim() }
}

function officeRuntime(config: Config): string {
  if (config.cli === false) return '\n\nLibreOffice Kit is disabled in this deployment.'
  if (config.node === undefined && (isSea() || process.versions.electron !== undefined)) {
    throw new Error('skill-office: packaged applications must supply a standalone Node executable')
  }
  const node = config.node ?? process.execPath
  let cli = config.cli
  if (cli === undefined) {
    const manifestPath = fileURLToPath(import.meta.resolve('@deepseek-ai/libreoffice-kit/package.json'))
    cli = join(dirname(manifestPath), 'lib', 'cli.js')
  }
  for (const path of [node, cli]) {
    if (!isAbsolute(path) || !statSync(path).isFile()) throw new Error(`skill-office: expected an absolute executable file: ${path}`)
  }
  return `\n\n## Installed LibreOffice Kit\n\nUse these absolute paths for every LibreOffice Kit command. Pass the CLI entry as the first argument to Node.\n\n${JSON.stringify({ libreofficeKit: { node, cli } }, undefined, 2)}`
}

/**
 * 注册 Office 技能，并让其资源可被脚本解释器读取。
 * @param ctx - 携带技能注册表的 Context。
 * @param config - 可选的外部资源目录，供打包后的应用使用。
 */
export function apply(ctx: Context, config: Config = {}): void {
  const assetRoot = config.assetRoot ?? fileURLToPath(new URL('../assets/', import.meta.url))
  if (!isAbsolute(assetRoot)) throw new Error('skill-office: assetRoot must be an absolute directory')
  const candidates: SkillCandidate[] = SKILL_NAMES.map((skillName) => {
    const directory = join(assetRoot, skillName)
    const path = join(directory, 'SKILL.md')
    const { description } = parseSkill(readFileSync(path, 'utf8'), path)
    return {
      name: skillName, description,
      invocation: { modelInvocable: true, userInvocable: true },
      provider: 'dsh-office', source: 'bundled', rank: BUNDLED_SKILL_RANK,
      resourceBase: { kind: 'directory', path: directory.split(sep).join('/') }, locator: path,
    }
  })
  const provider: SkillProvider = {
    name: 'dsh-office',
    list: () => Promise.resolve(candidates),
    async get(candidate, options) {
      const { rank: _rank, locator, ...summary } = candidate
      const raw = await readFile(locator as string, { encoding: 'utf8', signal: options.signal })
      const content = parseSkill(raw, locator as string).content
        + (['office-render', 'office-recalculate', 'office-export-pdf'].includes(candidate.name) ? officeRuntime(config) : '')
      return { ...summary, content }
    },
  }
  ctx.skills.registerProvider(() => provider)
}
