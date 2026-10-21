/**
 * Workspace-level discovery and model-driven Typert generation.
 * @module @deepseek-ai/dsh-typert-generator/workspace
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { TypertAnalysisError, WorkspaceAnalyzer, WorkspaceCaches } from './analyzer.ts'
import type { DiscoveredTypertPackage } from './analyzer.ts'
import { FaceModelEmitter } from './emitter.ts'
import type { ModelEmitResult } from './emitter.ts'
import type { TypertFace } from './model.ts'

/** 一个发射产物与其源包根配对。 */
export interface WorkspaceEmitResult extends ModelEmitResult {
  readonly packageRoot: string
}

/** Behavior switches for one {@link WorkspaceTypertGenerator}. */
export interface WorkspaceTypertGeneratorOptions {
  /**
   * Run the per-package syntactic/semantic diagnostic pass before analysis
   * (default true). Pass false only when the same orchestration already
   * verified the workspace with tsc; the Typert-specific analysis checks
   * (annotation coverage, private cross-package references, unretainable
   * merges) run regardless.
   */
  readonly checkDiagnostics?: boolean
  /**
   * Fail when an analyzed face program loads a file from a workspace
   * package's `lib/` directory or cannot resolve an import of a workspace
   * package (default false); see
   * `WorkspaceAnalyzerOptions.rejectBuildOutputs`.
   */
  readonly rejectBuildOutputs?: boolean
}

/** 发现、分析并从独立的端发射包反射。 */
export class WorkspaceTypertGenerator {
  /** 本生成器创建的每个分析器所共享的、已解析配置与程序宿主状态。 */
  private readonly caches = new WorkspaceCaches()

  /**
   * 将生成绑定到某个 workspace 根。
   * @param root - 包含端聚合 tsconfig 的目录。
   * @param options - 应用于本生成器每次通过的、行为开关。
   */
  constructor(
    private readonly root: string,
    private readonly options: WorkspaceTypertGeneratorOptions = {},
  ) {}

  /**
   * 发现贡献 Cordis 服务/事件或显式标记 Typert 根的公共包端。
   * @param faces - 可选的、要检查的独立程序端。
   * @param includeManifest - 可选的 `package.json` 谓词；被拒绝的包的源码与项目配置不会被读取。
   * @returns 按稳定的包名顺序排列的已发现包。
   */
  discover(
    faces?: readonly TypertFace[],
    includeManifest?: (manifest: Readonly<Record<string, unknown>>) => boolean,
  ): DiscoveredTypertPackage[] {
    return new WorkspaceAnalyzer({
      root: this.root,
      caches: this.caches,
      ...(faces === undefined ? {} : { faces }),
    }).discoverPackages(includeManifest)
  }

  /**
   * 生成所有已发现的贡献者，或一个显式的包子集。
   * @param packages - 可选的、要发射的精确包名；每次通过都包含同样的、端级声明合并。
   * @param faces - 可选的、要分析的独立程序端。
   * @returns 每个包端一个产物。
   */
  generate(packages?: readonly string[], faces?: readonly TypertFace[]): WorkspaceEmitResult[] {
    const contributors = this.discover(faces).map(candidate => candidate.package)
    const selected = new Set(packages ?? contributors)
    const workspace = new WorkspaceAnalyzer({
      root: this.root,
      packages: contributors,
      caches: this.caches,
      ...(faces === undefined ? {} : { faces }),
      ...(this.options.checkDiagnostics === undefined ? {} : { checkDiagnostics: this.options.checkDiagnostics }),
      ...(this.options.rejectBuildOutputs === undefined ? {} : { rejectBuildOutputs: this.options.rejectBuildOutputs }),
    }).analyze()
    const artifacts: WorkspaceEmitResult[] = []
    for (const face of workspace.faces) {
      const emitter = new FaceModelEmitter(face)
      for (const packageModel of face.packages) {
        if (!selected.has(packageModel.name)) continue
        const artifact = {
          ...emitter.emit(packageModel.name),
          packageRoot: packageModel.root,
        }
        this.validateExport(artifact)
        artifacts.push(artifact)
      }
    }
    return artifacts
  }

  /**
   * 生成每个显式贡献者：其 manifest 声明了 Typert 产物导出、且其公共图拥有
   * Typert 表面的包。
   * @param faces - 可选的、要分析的独立程序端。
   * @returns 每个贡献者端一个产物。
   */
  generateContributors(faces?: readonly TypertFace[]): WorkspaceEmitResult[] {
    const packages = this.discover(faces, manifest => hasTypertExport(manifest.exports))
      .map(candidate => candidate.package)
    return packages.length === 0 ? [] : this.generate(packages, faces)
  }

  private validateExport(artifact: WorkspaceEmitResult): void {
    const manifestPath = resolve(this.root, artifact.packageRoot, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      exports?: unknown
      files?: unknown
    }
    const subpath = artifact.face === 'host' ? './typert' : './client/typert'
    const expected = {
      types: `./lib/typert.${artifact.face}.d.ts`,
      default: `./lib/typert.${artifact.face}.js`,
    }
    const actual = manifest.exports !== null && typeof manifest.exports === 'object'
      ? (manifest.exports as Record<string, unknown>)[subpath]
      : undefined
    if (!sameExport(actual, expected)) {
      throw new TypertAnalysisError(
        `typert(${artifact.face}): ${artifact.package} must export ${subpath} as ${JSON.stringify(expected)}`,
      )
    }
    const files = Array.isArray(manifest.files) ? manifest.files : []
    for (const file of [`lib/typert.${artifact.face}.js`, `lib/typert.${artifact.face}.d.ts`]) {
      if (!files.includes(file)) {
        throw new TypertAnalysisError(`typert(${artifact.face}): ${artifact.package} package files must include ${file}`)
      }
    }
    if (artifact.face !== 'host') return
    const remoteExpected = {
      types: './lib/typert.remote-client.d.ts',
      default: './lib/typert.remote-client.js',
    }
    const remoteActual = manifest.exports !== null && typeof manifest.exports === 'object'
      ? (manifest.exports as Record<string, unknown>)['./remote']
      : undefined
    // 声明映射与这两个文件一同发出，但从不发布：它服务于 workspace 中
    // 的编辑器导航，包的链接在那里解析其源码。
    const remoteFiles = [
      'lib/typert.remote-client.js',
      'lib/typert.remote-client.d.ts',
    ]
    if (artifact.remote === undefined) {
      if (remoteActual !== undefined || remoteFiles.some(file => files.includes(file))) {
        throw new TypertAnalysisError(
          `typert(host): ${artifact.package} publishes Remote artifacts but has no Remote methods`,
        )
      }
      return
    }
    if (!sameExport(remoteActual, remoteExpected)) {
      throw new TypertAnalysisError(
        `typert(host): ${artifact.package} must export ./remote as ${JSON.stringify(remoteExpected)}`,
      )
    }
    for (const file of remoteFiles) {
      if (!files.includes(file)) {
        throw new TypertAnalysisError(`typert(host): ${artifact.package} package files must include ${file}`)
      }
    }
  }
}

/**
 * 找到 Typert 生成所针对的 workspace 根：在 `start` 处或其上方、同时持有
 * `tsconfig.host.json` 与 `packages/` 的最近目录。分析器在 `<root>/packages`
 * 下注册工程，因此某个包自身 `tsconfig.host.json` 端叶子不符合条件。
 * @param start - 要从中搜索的目录，例如 bundle 输出或工作目录。
 * @returns 绝对的 workspace 根。
 * @throws 当 `start` 的任一祖先都不符合条件时。
 */
export function findWorkspaceRoot(start: string): string {
  let current = resolve(start)
  while (!existsSync(join(current, 'tsconfig.host.json')) || !existsSync(join(current, 'packages'))) {
    const parent = dirname(current)
    if (parent === current) throw new Error(`typert-generator: cannot find workspace root above ${start}`)
    current = parent
  }
  return current
}

/**
 * 一个 `package.json#exports` 字段是否声明了 Typert 产物子路径
 * （`./typert`、`./client/typert`，或 `./remote`）。
 * @param exportsField - manifest 的 `exports` 值。
 * @returns 当包选择加入 Typert 发布时为 true。
 */
export function hasTypertExport(exportsField: unknown): boolean {
  if (exportsField === null || typeof exportsField !== 'object' || Array.isArray(exportsField)) return false
  return Object.hasOwn(exportsField, './typert')
    || Object.hasOwn(exportsField, './client/typert')
    || Object.hasOwn(exportsField, './remote')
}

function sameExport(actual: unknown, expected: { types: string; default: string }): boolean {
  if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return false
  const value = actual as Record<string, unknown>
  return value.types === expected.types && value.default === expected.default
}
