/** 面向拥有 profile 关闭与写排除权的调用方的文件系统恢复。 */

import { existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { PROFILE_PATCH_FILENAME, readProfileManifest } from './profile.ts'
import { writeProfileBundles } from './profile-plugins.ts'

/**
 * 备份 profile 补丁，并仅保留调用方的恢复 bundle。
 * 调用方必须停止 profile 并排除并发的 profile 写入。
 * 已安装的包与其它清单字段会被保留；补丁绝不会被解析。
 * 失败会向上传播，并可能将已完成的变更留在原地以便重试。
 * @param binName - 针对无效 profile 清单的诊断前缀。
 * @param profileDir - 在不加载其插件的前提下恢复的 profile 目录。
 * @param bundles - 恢复后要启用的有序 bundle。
 * @returns 带有 Unix 毫秒时间戳与可选碰撞序数的备份路径；若不存在则为 undefined。
 */
export function sanitizeProfile(binName: string, profileDir: string, bundles: readonly string[]): string | undefined {
  const manifest = existsSync(join(profileDir, 'package.json')) ? readProfileManifest(binName, profileDir) : undefined
  const patchPath = join(profileDir, PROFILE_PATCH_FILENAME)
  const backupBase = `${patchPath}.bak-${Date.now()}`
  let backupPath: string | undefined = backupBase
  let ordinal = 0
  // 调用方拥有的写排除会确保所选目标在重命名之前不存在。
  while (existsSync(backupPath)) backupPath = `${backupBase}-${++ordinal}`
  try {
    renameSync(patchPath, backupPath)
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    backupPath = undefined
  }
  if (manifest !== undefined) writeProfileBundles(profileDir, manifest, bundles)
  return backupPath
}
