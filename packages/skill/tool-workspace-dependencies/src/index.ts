/** 面向模型的查询：取得随包附带的 Python、Node.js 与 pnpm 载荷，可就地使用，也可安装到 Harness 主目录下。 */

import { cp, lstat, mkdir, mkdtemp, readFile, readlink, rename, rm, stat, symlink } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Cordis 插件身份。 */
export const name = 'tool-workspace-dependencies'
/** 该工具注册进入的注册表。 */
export const inject = ['tools']

/** 载荷位置与可选的安装目录。 */
export interface Config {
  /** 承载 `runtime.json` 与 `dependencies/` 的载荷目录。 */
  readonly source: string
  /**
   * Harness 主目录下的安装目录。设置时，载荷会在首次调用时被复制过去（桌面端行为）；
   * 省略时则就地使用载荷、不做复制，这适合容器镜像层之类的只读载体。
   */
  readonly root?: string
}

/** 在 Loader 启用该工具之前，要求先给出一个具名的载荷来源。 */
export const Config: z<Config> = z.object({
  source: z.string().min(1).required(),
  root: z.string().min(1),
})

/** 规范的构建元数据，与用户自行安装的包无关；旧格式文件在读取时被规范化。 */
export interface PrimaryRuntimeManifest {
  readonly desktopVersion: string
  readonly platform: string
  readonly arch: string
  /** 锁定的载荷身份；只有在引入载荷哈希之前的那些安装中才会缺失。 */
  readonly payloadDigest?: string
  /** 随包的 Python 解释器版本。 */
  readonly python: string
  /** 当载荷未附带 Node.js 时该字段不存在。 */
  readonly node?: string
  /** 随包的 pnpm 版本；要求存在随包的 Node.js 可执行文件。 */
  readonly pnpm?: string
  /** 全部已记录的 Python 发行版版本；对于没有发行版映射的旧格式文件为空。 */
  readonly pythonPackages: Readonly<Record<string, string>>
}

/** 绝对入口点与随包版本；pnpm 通过返回的那个 Node 可执行文件运行。 */
export interface WorkspaceDependencies {
  readonly python: string
  readonly node?: string
  readonly pnpm?: string
  readonly pythonPackages: string
  readonly nodePackages?: string
  /** 锁定的发行版版本；不含用户向已安装环境中自行添加的包。 */
  readonly pythonDistributions: Readonly<Record<string, string>>
}

const VERSION = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u
const PLATFORMS = ['win32', 'darwin', 'linux']

function isVersion(value: unknown): value is string {
  return typeof value === 'string' && VERSION.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isDistributionMap(value: unknown): value is Readonly<Record<string, string>> {
  return isRecord(value) && Object.entries(value).every(([name, version]) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name)
    && typeof version === 'string' && /^\d[\w.!+-]*$/u.test(version))
}

/**
 * 校验载荷 JSON，并把旧格式的 components 字段规范化为顶层的版本字段。
 * @param value - 未经验证的、已解码的 runtime.json 内容。
 * @returns 规范的元数据，只带一份 Python 发行版映射，且不再有 components 字段。
 * @throws 当格式错误或混用多种格式、发行版名称重复，或旧格式元数据自相矛盾时抛出。
 */
export function parsePrimaryRuntime(value: unknown): PrimaryRuntimeManifest {
  if (!isRecord(value)) throw new Error('primary runtime: invalid metadata')
  const legacy = value.components !== undefined
  const versions = legacy ? value.components : value
  if (!isRecord(versions) || (legacy && ['python', 'node', 'pnpm'].some(key => value[key] !== undefined))) {
    throw new Error('primary runtime: invalid metadata')
  }
  const { desktopVersion, platform, arch, payloadDigest } = value
  const { python, node, pnpm } = versions
  const pythonPackages = value.pythonPackages === undefined && legacy ? {} : value.pythonPackages
  if (typeof desktopVersion !== 'string' || desktopVersion.length === 0
    || typeof platform !== 'string' || !PLATFORMS.includes(platform)
    || typeof arch !== 'string' || !['x64', 'arm64'].includes(arch)
    || !isVersion(python)
    || (node !== undefined && !isVersion(node))
    || (pnpm !== undefined && (!isVersion(pnpm) || node === undefined))
    || (payloadDigest !== undefined && (typeof payloadDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(payloadDigest)))
    || !isDistributionMap(pythonPackages)) {
    throw new Error('primary runtime: invalid metadata')
  }
  const entries = Object.entries(pythonPackages)
  const distributions = new Map(entries.map(([name, version]) => [name.toLowerCase().replace(/[-_.]+/gu, '-'), version]))
  if (distributions.size !== entries.length) throw new Error('primary runtime: invalid metadata')
  // 只有旧的磁盘格式会重复保存这些版本。新的清单只依赖发行版映射本身。
  if (legacy) {
    for (const name of ['numpy', 'pandas'] as const) {
      if (!isVersion(versions[name])) throw new Error('primary runtime: invalid metadata')
      const version = distributions.get(name)
      if (version !== undefined && version !== versions[name]) {
        throw new Error(`primary runtime: conflicting ${name} distribution version`)
      }
    }
  }
  return {
    desktopVersion, platform, arch,
    ...(payloadDigest === undefined ? {} : { payloadDigest }),
    python,
    ...(node === undefined ? {} : { node }),
    ...(pnpm === undefined ? {} : { pnpm }),
    pythonPackages,
  }
}

/**
 * 读取并规范化构建元数据，但不重写源文件。
 * @param root - 已安装或随包附带的 primary runtime 目录。
 * @returns 已校验的顶层版本与目标标识，对旧格式的 components 清单同样适用。
 */
export async function readPrimaryRuntime(root: string): Promise<PrimaryRuntimeManifest> {
  const value: unknown = JSON.parse(await readFile(join(root, 'runtime.json'), 'utf8'))
  return parsePrimaryRuntime(value)
}

/**
 * 识别那些在载荷迁移之后仍然成立的 POSIX 解释器别名。
 * @param root - 载荷目录。
 * @param manifest - 已校验的载荷元数据。
 * @returns 相对别名路径到其同级解释器文件名的映射；普通命令文件被略去。
 * @throws 当某个解释器别名没有直接指向带版本号的那个普通文件时抛出。
 */
export async function primaryRuntimePythonAliases(root: string, manifest: PrimaryRuntimeManifest): Promise<ReadonlyMap<string, string>> {
  const aliases = new Map<string, string>()
  if (manifest.platform === 'win32') return aliases
  const interpreter = `python${manifest.python.split('.').slice(0, 2).join('.')}`
  for (const name of ['python', 'python3']) {
    const path = `dependencies/python/bin/${name}`
    let entry
    try { entry = await lstat(join(root, path)) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (!entry.isSymbolicLink()) continue
    if (await readlink(join(root, path)) !== interpreter
      || !(await lstat(join(root, 'dependencies/python/bin', interpreter))).isFile()) {
      throw new Error(`primary runtime: invalid Python alias ${path}`)
    }
    aliases.set(path, interpreter)
  }
  return aliases
}

/**
 * 复制一份载荷，只把经过校验的 Python 解释器别名保留为相对链接。
 * @param source - 载荷目录；其余所有链接都会被实体化。
 * @param destination - 由调用方持有的空目标目录。
 * @param manifest - 已校验的源元数据。
 * @returns 当每个被复制的文件与解释器别名都能独立于源目录使用时才 resolve。
 */
export async function copyPrimaryRuntime(source: string, destination: string, manifest: PrimaryRuntimeManifest): Promise<void> {
  const aliases = await primaryRuntimePythonAliases(source, manifest)
  const excluded = new Set([...aliases.keys()].map(path => join(source, path)))
  await cp(source, destination, { recursive: true, dereference: true, filter: path => !excluded.has(path) })
  for (const [path, target] of aliases) await symlink(target, join(destination, path))
}

/**
 * 解析各平台特有的解释器与库位置，且不改动环境。
 * @param root - 绝对的载荷或安装目录。
 * @param manifest - 已校验的运行时元数据。
 * @returns 用于显式执行脚本的绝对路径，以及已记录的随包 Python 版本。
 */
export function workspaceDependencyPaths(root: string, manifest: PrimaryRuntimeManifest): WorkspaceDependencies {
  const dependencies = join(root, 'dependencies')
  const windows = manifest.platform === 'win32'
  const node = manifest.node === undefined ? {} : {
    node: join(dependencies, 'node', 'bin', windows ? 'node.exe' : 'node'),
    nodePackages: join(dependencies, 'node', 'node_modules'),
  }
  const pnpm = manifest.pnpm === undefined ? {} : { pnpm: join(dependencies, 'pnpm', 'bin', 'pnpm.mjs') }
  return {
    python: join(dependencies, 'python', ...(windows ? ['python.exe'] : ['bin', 'python3'])),
    ...node,
    ...pnpm,
    pythonPackages: join(dependencies, 'python', ...(windows ? ['Lib'] : ['lib', `python${manifest.python.split('.').slice(0, 2).join('.')}`]), 'site-packages'),
    pythonDistributions: manifest.pythonPackages,
  }
}

async function validatePayloadEntries(paths: WorkspaceDependencies): Promise<void> {
  for (const [path, kind] of [
    [paths.python, 'file'], [paths.node, 'file'], [paths.pnpm, 'file'],
    [paths.pythonPackages, 'directory'], [paths.nodePackages, 'directory'],
  ] as const) {
    if (path === undefined) continue
    const entry = await stat(path)
    if (!(kind === 'file' ? entry.isFile() : entry.isDirectory())) {
      throw new Error(`primary runtime: expected ${kind} at ${path}`)
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error(`primary runtime: installation path is a filesystem link: ${path}`)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function compatibleManifest(source: string): Promise<PrimaryRuntimeManifest> {
  const manifest = await readPrimaryRuntime(source)
  if (manifest.platform !== process.platform || manifest.arch !== process.arch) throw new Error('primary runtime: incompatible platform or architecture')
  return manifest
}

/**
 * 就地使用载荷：校验其元数据与各条目，不复制任何内容。
 * @param source - 载荷目录，通常是只读的载体。
 * @returns 指向载荷内部的各路径。
 */
export async function resolvePrimaryRuntime(source: string): Promise<WorkspaceDependencies> {
  const manifest = await compatibleManifest(source)
  await primaryRuntimePythonAliases(source, manifest)
  const paths = workspaceDependencyPaths(source, manifest)
  await validatePayloadEntries(paths)
  return paths
}

/**
 * 在本地安装隶属于本应用的载荷，并在复制失败时保留一棵完整的旧目录树。
 * @param source - 由当前安装所携带的载荷。
 * @param root - Harness 主目录下固定的 primary runtime 目录。
 * @returns 指向已安装载荷内部的各路径；不修改 PATH 或任何包管理器配置。
 */
export async function installPrimaryRuntime(source: string, root: string): Promise<WorkspaceDependencies> {
  const manifest = await compatibleManifest(source)
  await mkdir(dirname(root), { recursive: true })
  const previous = `${root}.previous`
  const previousExists = await exists(previous)
  const rootExists = await exists(root)
  if (!rootExists && previousExists) await rename(previous, root)
  if (await exists(join(root, 'runtime.json')) && JSON.stringify(await readPrimaryRuntime(root)) === JSON.stringify(manifest)) {
    await primaryRuntimePythonAliases(root, manifest)
    const paths = workspaceDependencyPaths(root, manifest)
    await validatePayloadEntries(paths)
    return paths
  }
  const staging = await mkdtemp(join(dirname(root), '.primary-runtime-'))
  try {
    await copyPrimaryRuntime(source, staging, manifest)
    const paths = workspaceDependencyPaths(staging, manifest)
    await validatePayloadEntries(paths)
    await rm(previous, { recursive: true, force: true })
    const replacing = await exists(root)
    if (replacing) await rename(root, previous)
    try { await rename(staging, root) } catch (error) {
      if (replacing) await rename(previous, root)
      throw error
    }
    await rm(previous, { recursive: true, force: true })
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  return workspaceDependencyPaths(root, manifest)
}

/**
 * 注册这个只读的路径查询；首次调用会准备（或仅仅校验）该载荷。
 * @param ctx - 工具注册表的宿主。
 * @param config - 载荷位置与可选的安装目录。
 */
export function apply(ctx: Context, config: Config): void {
  if (!isAbsolute(config.source) || (config.root !== undefined && !isAbsolute(config.root))) {
    throw new Error('workspace dependencies: source and root must be absolute paths')
  }
  let preparation: Promise<WorkspaceDependencies> | undefined
  ctx.effect(() => async () => {
    // 工具执行会报告准备阶段的失败；释放时只等待文件系统工作落定。
    await preparation?.catch(() => undefined)
  })
  ctx.tools.register(defineTool({
    name: 'load_workspace_dependencies',
    description: 'Get absolute paths to bundled Python and library directories, plus bundled Python distribution versions. Node.js and pnpm paths are included when the payload provides them. Python includes numpy, pandas, python-docx, python-pptx, openpyxl, Pillow, lxml, and XlsxWriter. Use these libraries for Office files unless the user or workspace instructions select another environment. When Node.js and pnpm paths are returned, run pnpm with that Node executable and pnpm script path. This does not change PATH or package-manager settings.',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          python: { type: 'string', required: true },
          node: { type: 'string', description: 'Absent when the payload ships no Node.js.' },
          pnpm: { type: 'string', description: 'Absent when the payload ships no pnpm.' },
          pythonPackages: { type: 'string', required: true },
          nodePackages: { type: 'string', description: 'Absent when the payload ships no Node.js.' },
          pythonDistributions: { type: 'object', additionalProperties: true, required: true, description: 'Bundled distribution names and versions recorded in runtime.json; excludes user-installed additions.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, undefined, 2) }],
    },
    execute: () => {
      preparation ??= (config.root === undefined ? resolvePrimaryRuntime(config.source) : installPrimaryRuntime(config.source, config.root))
        .catch((error: unknown) => {
          preparation = undefined
          throw error
        })
      return preparation
    },
    presentCall: () => ({ card: 'generic', title: 'Load workspace dependencies', kind: 'read' }),
  }))
}
