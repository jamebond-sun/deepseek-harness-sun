/** 在不导入 provider 代码的前提下，从运行中的安装中选出 Official bundle 包。 */
import { existsSync, globSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { bundlePatchPaths, type ProfileManifest } from '@deepseek-ai/dsh-app-boot'

interface WorkspaceManifest extends ProfileManifest {
  main?: string
}

function manifestAt(file: string): WorkspaceManifest {
  return JSON.parse(readFileSync(file, 'utf8')) as WorkspaceManifest
}

/**
 * 提供源码检出链接或精确的已发布包版本。源码安装由真实的 CLI 清单及其解包的 workspace
 * 依赖（包括 Desktop 的开发符号链接）来识别。不完整的检出是一种错误，而绝不会回退到
 * 注册表。
 * @param name - Official 目录的包名。
 * @param installAnchor - 运行中的应用所对应的 DSH package.json，可能经由符号链接抵达。
 * @param version - 其发布系列所使用的运行中 DSH 版本。
 * @returns 一个普通的包管理器 spec 及其包版本。
 * @throws 当源码安装缺少其 workspace 包、bundle 补丁，或已构建的运行时时。
 */
export function officialBundleInstallTarget(name: string, installAnchor: string, version: string): { spec: string; version: string } {
  const anchor = realpathSync(installAnchor)
  const installation = manifestAt(anchor)
  const source = installation.name === '@deepseek-ai/dsh'
    && Object.values(installation.dependencies ?? {}).some(value => value.startsWith('workspace:'))
  if (!source) return { spec: `${name}@${version}`, version }
  const root = resolve(dirname(anchor), '../..')
  if (anchor !== join(root, 'apps', 'cli', 'package.json')
    || !existsSync(join(root, 'package.json'))
    || manifestAt(join(root, 'package.json')).name !== '@deepseek-ai/dsh-root') {
    throw new Error(`Official bundle ${name}: source DSH installation ${anchor} requires its complete workspace checkout`)
  }
  const matches = globSync('packages/*/*/package.json', { cwd: root })
    .map(file => ({ file: join(root, file), manifest: manifestAt(join(root, file)) }))
    .filter(entry => entry.manifest.name === name)
  const selected = matches[0]
  if (matches.length !== 1 || selected === undefined) {
    throw new Error(`Official bundle ${name}: expected one workspace package in ${root}, found ${matches.length}; restore the checkout and run pnpm install`)
  }
  const { file, manifest } = selected
  const directory = realpathSync(dirname(file))
  if (manifest.version !== version || manifest.private === true || manifest.dsh?.bundle === undefined) {
    throw new Error(`Official bundle ${name}: ${file} must declare a public bundle at DSH version ${version}`)
  }
  const main = typeof manifest.main === 'string' ? resolve(directory, manifest.main) : undefined
  if (main === undefined || !existsSync(main) || !statSync(main).isFile()) {
    throw new Error(`Official bundle ${name}: built runtime is missing in ${directory}; run pnpm install and pnpm run build in ${root}`)
  }
  for (const patch of bundlePatchPaths(directory, manifest.dsh.bundle)) {
    if (!existsSync(patch) || !statSync(patch).isFile()) {
      throw new Error(`Official bundle ${name}: bundle patch ${patch} is missing; restore the checkout`)
    }
  }
  return { spec: `link:${directory}`, version }
}
