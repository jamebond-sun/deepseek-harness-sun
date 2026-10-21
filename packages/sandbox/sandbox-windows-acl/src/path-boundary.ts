/**
 * 针对 Windows ACL 工作区与私有临时目录能力的规范化目录边界检查。
 * @module @deepseek-ai/dsh-sandbox-windows-acl/path-boundary
 */

import { realpathSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'

/** `root` 是否与 `candidate` 是同一个规范化目录，或包含它。 */
function containsDirectory(root: string, candidate: string): boolean {
  const relation = relative(realpathSync.native(root), realpathSync.native(candidate))
  return relation === '' || (!isAbsolute(relation) && relation !== '..' && !relation.startsWith(`..${sep}`))
}

/**
 * 拒绝一个位于工作区之内的临时父目录：在其下创建的每一个子目录都会继承
 * 常驻的工作区能力。
 * @param workspaceRoot - 接收常驻 ACE 的规范化工作区根。
 * @param tempRoot - 私有临时子目录将被创建于其下的那个既有父目录。
 */
export function assertTempRootOutsideWorkspace(workspaceRoot: string, tempRoot: string): void {
  if (containsDirectory(workspaceRoot, tempRoot)) {
    throw new Error(`Windows ACL temp root must be outside the workspace: workspace=${workspaceRoot}; temp=${tempRoot}`)
  }
}

/**
 * 拒绝一个真实的私有临时目录与任何可写目录发生重叠：无论哪个方向的继承
 * 都会把两种能力合并到一起。
 * @param writableDirs - 承载常驻工作区能力的那些目录。
 * @param tempDir - 承载可撤销临时能力的那个既有目录。
 */
export function assertPrivateTempDisjoint(writableDirs: readonly string[], tempDir: string): void {
  for (const writableDir of writableDirs) {
    if (containsDirectory(writableDir, tempDir) || containsDirectory(tempDir, writableDir)) {
      throw new Error(`AclSandbox private temp directory must be disjoint from writable directories: writable=${writableDir}; temp=${tempDir}`)
    }
  }
}
