/**
 * 注册随包分发的 Windows 沙箱 ACL 诊断技能。
 *
 * 该提供者持有一份私有的资源文件系统副本，因此即使本包位于 ASAR 或 SEA
 * 之内，外部 PowerShell 也能执行它们。释放该注册会同时移除提供者及其资源
 * 副本。
 *
 * @module @deepseek-ai/dsh-sandbox-windows-acl
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { BUNDLED_SKILL_RANK, type SkillCandidate, type SkillProvider } from '@deepseek-ai/dsh-skill'
import { parse as parseYaml } from 'yaml'

/** 用于诊断 Windows 沙箱 ACL 失败的随包技能。 */
export const ACL_DIAGNOSIS_SKILL = 'diagnose-windows-sandbox-acl'

/** 本模块注册该技能时所使用的提供者名称。 */
const PROVIDER = 'dsh-windows-acl'

function parseSkill(raw: string, path: string): { description: string; content: string } {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  if (frontmatter?.[1] === undefined) throw new Error(`dsh-sandbox-windows-acl: ${path} has no YAML frontmatter`)
  const metadata: unknown = parseYaml(frontmatter[1])
  const description = typeof metadata === 'object' && metadata !== null && 'description' in metadata
    ? metadata.description
    : undefined
  if (typeof description !== 'string' || description.length === 0) {
    throw new Error(`dsh-sandbox-windows-acl: ${path} has no description`)
  }
  return { description, content: raw.slice(frontmatter[0].length).trim() }
}

/**
 * 以本 fiber 所持有的私有资源目录注册随包的诊断技能。打包资源缺失或无效
 * 会导致注册失败；释放时会删除该目录。
 * @param ctx - 携带技能注册表的 Context。
 */
export function registerAclDiagnosisSkill(ctx: Context): void {
  const packaged = fileURLToPath(new URL(`../assets/${ACL_DIAGNOSIS_SKILL}/`, import.meta.url))
  ctx.effect(function* () {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-acl-skill-'))
    yield async () => { await rm(directory, { recursive: true, force: true }) }
    mkdirSync(join(directory, 'scripts'))
    for (const path of ['SKILL.md', 'scripts/diagnose-windows-sandbox-acl.ps1']) {
      writeFileSync(join(directory, path), readFileSync(join(packaged, path)), { flag: 'wx', mode: 0o600 })
    }
    const locator = join(directory, 'SKILL.md')
    const { description } = parseSkill(readFileSync(locator, 'utf8'), locator)
    const candidate: SkillCandidate = {
      name: ACL_DIAGNOSIS_SKILL,
      description,
      invocation: { modelInvocable: true, userInvocable: true },
      provider: PROVIDER,
      source: 'bundled',
      rank: BUNDLED_SKILL_RANK,
      resourceBase: { kind: 'directory', path: directory },
      locator,
    }
    const provider: SkillProvider = {
      name: PROVIDER,
      list: () => Promise.resolve([candidate]),
      async get(entry, options) {
        const { rank: _rank, locator: entryPath, ...summary } = entry
        const raw = await readFile(entryPath as string, { encoding: 'utf8', signal: options.signal })
        return { ...summary, content: parseSkill(raw, entryPath as string).content }
      },
    }
    yield ctx.skills.registerProvider(() => provider)
  }, 'Windows ACL diagnosis skill resources')
}
