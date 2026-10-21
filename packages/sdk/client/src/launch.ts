/**
 * 将公开的 SDK 启动配置解析为一个 dsh 子进程。
 * @module @deepseek-ai/dsh-sdk-client/launch
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { HarnessClientOptions } from './types.ts'

/** profile 应答 SDK initialize 握手的默认时限。 */
export const DEFAULT_INITIALIZE_TIMEOUT_MS = 10_000

/** 传输层与 fake-runtime 测试所使用的内部通用进程启动描述。 */
export interface RuntimeProcessOptions {
  command: string
  args: string[]
  cwd?: string
  /** 在客户端启动其子进程时物化完整的子进程环境。 */
  environment: () => NodeJS.ProcessEnv
  description: string
  initializeTimeoutMs: number
  requestTimeoutMs?: number
  shutdownTimeoutMs?: number
  disposeEofGraceMs?: number
  disposeGraceMs?: number
}

/** 某个已解析 dsh 入口所需的 Node argv 与内部 profile 补丁。 */
export interface DshNodeLaunch {
  /** 位于 profile 选择器之前的参数。 */
  nodeArgs: string[]
  /** 在调用方提供的补丁之下应用的内部补丁。 */
  patches: string[]
  /** 已解析入口模式所要求的环境变量值。 */
  environment: NodeJS.ProcessEnv
}

interface PackageManifest {
  version?: unknown
  bin?: unknown
}

/** 从一个已解析的 package.json URL 读取包清单。 */
function manifest(url: string): PackageManifest {
  return JSON.parse(readFileSync(fileURLToPath(url), 'utf8')) as PackageManifest
}

/**
 * 从包清单中解析并做版本校验，得到 dsh 可执行文件。
 * @param dshManifestUrl - dsh 包清单的已解析 URL。
 * @param clientManifestUrl - SDK 客户端清单的已解析 URL。
 * @returns dsh 可执行文件的绝对路径。
 */
export function resolveDshBinFromManifests(dshManifestUrl: string, clientManifestUrl: string): string {
  const dshManifest = manifest(dshManifestUrl)
  const clientManifest = manifest(clientManifestUrl)
  if (typeof dshManifest.version !== 'string' || dshManifest.version !== clientManifest.version) {
    throw new Error(`dsh SDK client ${String(clientManifest.version)} requires the same dsh version, got ${String(dshManifest.version)}`)
  }
  const bin = typeof dshManifest.bin === 'object' && dshManifest.bin !== null
    ? (dshManifest.bin as Record<string, unknown>).dsh
    : dshManifest.bin
  if (typeof bin !== 'string' || bin === '') throw new Error('@deepseek-ai/dsh declares no dsh executable')
  return resolve(dirname(fileURLToPath(dshManifestUrl)), bin)
}

/**
 * 解析并做版本校验，得到随本 SDK 一起安装的已构建 dsh 可执行文件。
 * @returns 已构建可执行文件的绝对路径，无论它在源码检出中是否存在。
 */
export function installedDshBin(): string {
  return resolveDshBinFromManifests(
    import.meta.resolve('@deepseek-ai/dsh/package.json'),
    new URL('../package.json', import.meta.url).href,
  )
}

/**
 * 解析某个同版本 dsh 包的 Node 启动方式。
 * @param dshManifestUrl - dsh 包清单的已解析 URL。
 * @param clientManifestUrl - SDK 客户端清单的已解析 URL。
 * @param sourceLoaderUrl - 可选的绝对 tsx loader URL，用于确定性测试。
 * @returns 已构建产物，或源码入口加上其兼容性补丁与 tsx 环境变量。
 */
export function resolveDshNodeLaunchFromManifests(
  dshManifestUrl: string,
  clientManifestUrl: string,
  sourceLoaderUrl?: string,
): DshNodeLaunch {
  const bin = resolveDshBinFromManifests(dshManifestUrl, clientManifestUrl)
  if (existsSync(bin)) return { nodeArgs: [bin], patches: [], environment: {} }

  const packageDir = dirname(fileURLToPath(dshManifestUrl))
  const sourceBin = resolve(packageDir, 'src/bin.ts')
  const sourcePatch = resolve(packageDir, 'src/sdk-source.cordis.patch.yml')
  const sourceTsconfig = resolve(packageDir, 'tsconfig.json')
  if (!existsSync(sourceBin) || !existsSync(sourcePatch) || !existsSync(sourceTsconfig)) {
    throw new Error(
      `@deepseek-ai/dsh is missing its built executable ${bin} and complete source launch files ${sourceBin}, ${sourcePatch}, ${sourceTsconfig}`,
    )
  }
  const loader = sourceLoaderUrl ?? import.meta.resolve('tsx/esm')
  return {
    nodeArgs: ['--import', loader, sourceBin],
    patches: [sourcePatch],
    environment: { TSX_TSCONFIG_PATH: sourceTsconfig },
  }
}

/**
 * 将已安装的 dsh 包解析为已构建或源码形式的 Node 启动方式。
 * @returns 当前检出或已安装包所对应的启动描述符。
 */
function installedDshNodeLaunch(): DshNodeLaunch {
  return resolveDshNodeLaunchFromManifests(
    import.meta.resolve('@deepseek-ai/dsh/package.json'),
    new URL('../package.json', import.meta.url).href,
  )
}

/**
 * 解析相对调用方的文件系统输入，并构造规范的 dsh argv。
 * @param options - 公开的 SDK 启动选项。
 * @param callerCwd - 用于词法解析的父进程目录。
 * @returns 供 JSON-RPC 传输层使用的一个通用子进程规格。
 */
export function resolveDshLaunch(
  options: HarnessClientOptions = {},
  callerCwd: string = process.cwd(),
): RuntimeProcessOptions {
  const profile = options.profile ?? 'sdk'
  const dshLaunch = options.dshBin === undefined
    ? installedDshNodeLaunch()
    : { nodeArgs: [resolve(callerCwd, options.dshBin)], patches: [], environment: {} }
  const patches = [
    ...dshLaunch.patches,
    ...(options.patches ?? []).map(path => resolve(callerCwd, path)),
  ]
  const dshHome = options.dshHome === undefined ? undefined : resolve(callerCwd, options.dshHome)
  return {
    command: process.execPath,
    args: [...dshLaunch.nodeArgs, '--profile', profile, ...patches.flatMap(path => ['--patch', path])],
    ...options.processCwd === undefined ? {} : { cwd: resolve(callerCwd, options.processCwd) },
    environment: () => ({
      ...(options.env ?? process.env),
      ...dshLaunch.environment,
      ...dshHome === undefined ? {} : { DSH_HOME: dshHome },
    }),
    description: `dsh profile ${JSON.stringify(profile)}`,
    initializeTimeoutMs: options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS,
    ...options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs },
    ...options.shutdownTimeoutMs === undefined ? {} : { shutdownTimeoutMs: options.shutdownTimeoutMs },
    ...options.disposeEofGraceMs === undefined ? {} : { disposeEofGraceMs: options.disposeEofGraceMs },
    ...options.disposeGraceMs === undefined ? {} : { disposeGraceMs: options.disposeGraceMs },
  }
}
