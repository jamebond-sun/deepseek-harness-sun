/**
 * 生成的 Typert 产物的包内本地文件。tsdown 插件与独立的 workspace 生成都通过
 * 本模块写入，因此针对同一批产物的两次写入会在磁盘上留下相同的字节。
 * @module @deepseek-ai/dsh-typert-generator/artifact-files
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WorkspaceEmitResult } from './workspace.ts'

const REMOTE_CLIENT_FILES = [
  'typert.remote-client.js',
  'typert.remote-client.d.ts',
  'typert.remote-client.d.ts.map',
] as const

/**
 * 在某个包的 `<packageDir>/lib` 下写入一个包的产物：每个产物一份
 * `typert.<face>.js` 与 `typert.<face>.d.ts`；当某个产物携带 Remote 方法时，
 * 还会写入三份 `typert.remote-client.*` 文件。一个不含 Remote 方法的 Host 产物
 * 会移除早先写入留下的任何 Remote client 文件。文件逐个写入，因此一次失败的写入
 * 可能使本包的输出被部分替换。
 * @param packageDir - 绝对包根目录。
 * @param artifacts - 仅该包的产物。
 * @throws 当输出目录或某个文件无法写入时的文件系统错误。
 */
export function writePackageArtifacts(packageDir: string, artifacts: readonly WorkspaceEmitResult[]): void {
  const output = join(packageDir, 'lib')
  mkdirSync(output, { recursive: true })
  let emittedRemote = false
  for (const artifact of artifacts) {
    writeFileSync(join(output, `typert.${artifact.face}.js`), artifact.js)
    writeFileSync(join(output, `typert.${artifact.face}.d.ts`), artifact.dts)
    if (artifact.remote !== undefined) {
      emittedRemote = true
      writeFileSync(join(output, 'typert.remote-client.js'), artifact.remote.js)
      writeFileSync(join(output, 'typert.remote-client.d.ts'), artifact.remote.dts)
      writeFileSync(join(output, 'typert.remote-client.d.ts.map'), artifact.remote.dtsMap)
    }
  }
  if (!emittedRemote && artifacts.some(artifact => artifact.face === 'host')) {
    for (const file of REMOTE_CLIENT_FILES) rmSync(join(output, file), { force: true })
  }
}

/**
 * 将一次 workspace 通过的每个产物按产物顺序写入其所属包，使用
 * {@link writePackageArtifacts}。一次失败的写入会中止本次通过；较早的包保留其
 * 新文件，较晚的包保留其之前的文件。
 * @param root - 每个产物的 `packageRoot` 所相对的 workspace 根。
 * @param artifacts - 一次 `WorkspaceTypertGenerator` 通过返回的产物。
 * @throws 当某个输出目录或文件无法写入时的文件系统错误。
 */
export function writeWorkspaceArtifacts(root: string, artifacts: readonly WorkspaceEmitResult[]): void {
  for (const artifact of artifacts) writePackageArtifacts(join(root, artifact.packageRoot), [artifact])
}
