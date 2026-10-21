/**
 * 检测被载入已分析端程序的 workspace 构建产物，以及解析为空的 workspace 导入。
 * Typert 仅在调用方拒绝构建产物时从源码读取 workspace 包，因此其结果不应
 * 依赖于包编译是否运行、或何时运行：在编译后的树上命中 `lib/` 的导入在干净的树上
 * 解析为空，而两者都会被拒绝。
 * @module @deepseek-ai/dsh-typert-generator/build-output-guard
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import ts from 'typescript'

/** 一个 workspace 包的 `lib/` 所持有的、带有加载它的导入的程序文件。 */
export interface BuildOutputLoad {
  /** 构建产物的绝对路径。 */
  readonly file: string
  /** 位于构建产物之外、其导入说明符解析到 {@link file} 的程序文件。 */
  readonly importers: readonly BuildOutputImporter[]
  /** 编译为 {@link file} 的 workspace 源码的绝对路径，存在时给出。 */
  readonly source: string | undefined
}

/** 一个来自构建产物之外程序文件的对构建产物的导入。 */
export interface BuildOutputImporter {
  /** 导入文件的绝对路径。 */
  readonly file: string
  /** 所写的导入说明符。 */
  readonly specifier: string
}

/**
 * 列出一个 workspace 包在其 `lib/` 目录下持有的程序文件。一个包是 `root` 处或之下的
 * 最近、带有 `package.json` 的目录；`node_modules` 下的文件是外部的。导入方通过再次
 * 解析每个程序文件的导入说明符来发现，因此本次通过仅当产物存在时产生额外开销。
 * @param program - 被分析的端程序。
 * @param root - workspace 根。
 * @param host - 程序的模块解析宿主。
 * @returns 按文件路径顺序排列的加载；当每个 workspace 文件都来自源码时为空。
 */
export function findBuildOutputLoads(
  program: ts.Program,
  root: string,
  host: ts.ModuleResolutionHost,
): BuildOutputLoad[] {
  const classifier = new BuildOutputClassifier(root)
  const outputs = new Map<string, BuildOutputImporter[]>()
  for (const sourceFile of program.getSourceFiles()) {
    if (classifier.isBuildOutput(sourceFile.fileName)) outputs.set(classifier.canonical(sourceFile.fileName), [])
  }
  if (outputs.size === 0) return []
  const options = program.getCompilerOptions()
  for (const sourceFile of program.getSourceFiles()) {
    if (!classifier.isWorkspaceFile(sourceFile.fileName) || classifier.isBuildOutput(sourceFile.fileName)) continue
    for (const { fileName: specifier } of ts.preProcessFile(sourceFile.text, true, true).importedFiles) {
      const resolved = ts.resolveModuleName(specifier, sourceFile.fileName, options, host).resolvedModule
      const importers = resolved === undefined ? undefined : outputs.get(classifier.canonical(resolved.resolvedFileName))
      importers?.push({ file: classifier.display(sourceFile.fileName), specifier })
    }
  }
  return [...outputs]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([file, importers]) => ({ file: classifier.display(file), importers, source: classifier.sourceFor(file) }))
}

/** 一个来自程序源文件、模块解析无法解析的对 workspace 包的导入。 */
export interface UnresolvedWorkspaceImport {
  /** 导入文件的绝对路径。 */
  readonly file: string
  /** 所写的导入说明符。 */
  readonly specifier: string
  /** 该说明符的包导出所编译自的 workspace 源码的绝对路径，存在时给出。 */
  readonly source: string | undefined
}

/**
 * 列出 workspace 程序文件中、命名一个 workspace 包却解析为空的导入。一个 workspace 包是
 * 从导入文件的目录中找到的、其 `node_modules` 链接位于 `root` 之内任何 `node_modules`
 * 之外并指向内部的包；缺少该链接或 `paths` 别名时，包无法被识别，类型检查会报告该导入。
 * 子路径的源码从包 `exports` 在 `lib/types/` 下的 `types` 条件派生。
 * @param program - 被分析的端程序。
 * @param root - workspace 根。
 * @param host - 程序的模块解析宿主。
 * @returns 按文件与说明符顺序排列的未解析导入。
 */
export function findUnresolvedWorkspaceImports(
  program: ts.Program,
  root: string,
  host: ts.ModuleResolutionHost,
): UnresolvedWorkspaceImport[] {
  const classifier = new BuildOutputClassifier(root)
  const options = program.getCompilerOptions()
  const cache = ts.createModuleResolutionCache(root, file => file, options)
  const found: UnresolvedWorkspaceImport[] = []
  for (const sourceFile of program.getSourceFiles()) {
    if (!classifier.isWorkspaceFile(sourceFile.fileName) || classifier.isBuildOutput(sourceFile.fileName)) continue
    for (const { fileName: specifier } of ts.preProcessFile(sourceFile.text, true, true).importedFiles) {
      if (specifier.startsWith('.') || isAbsolute(specifier) || specifier.includes(':')) continue
      if (ts.resolveModuleName(specifier, sourceFile.fileName, options, host, cache).resolvedModule !== undefined) continue
      const packageRoot = classifier.linkedWorkspacePackage(sourceFile.fileName, packageNameOf(specifier))
      if (packageRoot === undefined) continue
      const source = exportSource(packageRoot, specifier)
      found.push({
        file: classifier.display(sourceFile.fileName),
        specifier,
        source: source === undefined ? undefined : classifier.display(source),
      })
    }
  }
  return found.sort((left, right) => left.file.localeCompare(right.file) || left.specifier.localeCompare(right.specifier))
}

function packageNameOf(specifier: string): string {
  const parts = specifier.split('/')
  return parts.slice(0, specifier.startsWith('@') ? 2 : 1).join('/')
}

function exportSource(packageRoot: string, specifier: string): string | undefined {
  const packageName = packageNameOf(specifier)
  const subpath = specifier === packageName ? '.' : `.${specifier.slice(packageName.length)}`
  let manifest: unknown
  try {
    manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  } catch (_unreadableManifest) {
    // 该错误给出了导入名，但没有建议的源路径。
    return undefined
  }
  const entry = property(property(manifest, 'exports'), subpath)
  const types = typeof entry === 'string' ? entry : property(entry, 'types')
  if (typeof types !== 'string' || !types.startsWith('./lib/types/')) return undefined
  const stem = join(packageRoot, 'src', types.slice('./lib/types/'.length).replace(/\.d\.([cm]?)ts$/u, '.$1ts'))
  return [stem, `${stem}x`].find(candidate => existsSync(candidate))
}

function property(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined
}

/**
 * 按真实路径对程序文件分类，因为模块解析报告符号链接目标与 Windows 长文件名，
 * 而 workspace 根可能经由链接或 8.3 短名拼写；报告出的路径都拼写在调用方的根之下。
 */
class BuildOutputClassifier {
  private readonly packageRoots = new Map<string, string | undefined>()
  private readonly realPaths = new Map<string, string>()
  private readonly realRoot: string

  constructor(private readonly root: string) {
    this.realRoot = this.canonical(root)
  }

  canonical(file: string): string {
    const absolute = resolve(file)
    const cached = this.realPaths.get(absolute)
    if (cached !== undefined) return cached
    let real = absolute
    try {
      real = realpathSync.native(absolute)
    } catch (_missingPath) {
      // 不存在的路径（例如未解析的候选）保留其解析后的拼写。
    }
    this.realPaths.set(absolute, real)
    return real
  }

  display(file: string): string {
    const path = relative(this.realRoot, this.canonical(file))
    return path.startsWith('..') || isAbsolute(path) ? resolve(file) : join(this.root, path)
  }

  isWorkspaceFile(file: string): boolean {
    const path = relative(this.realRoot, this.canonical(file))
    return path !== '' && !path.startsWith('..') && !isAbsolute(path) && !path.split(sep).includes('node_modules')
  }

  isBuildOutput(file: string): boolean {
    if (!this.isWorkspaceFile(file)) return false
    const real = this.canonical(file)
    const packageRoot = this.packageRoot(dirname(real))
    return packageRoot !== undefined && relative(packageRoot, real).split(sep)[0] === 'lib'
  }

  sourceFor(file: string): string | undefined {
    const real = this.canonical(file)
    const packageRoot = this.packageRoot(dirname(real))
    if (packageRoot === undefined) return undefined
    const [lib, types, ...rest] = relative(packageRoot, real).split(sep)
    const last = rest.at(-1)
    if (lib !== 'lib' || types !== 'types' || last === undefined) return undefined
    const stem = join(packageRoot, 'src', ...rest.slice(0, -1), last.replace(/\.d\.([cm]?)ts$/u, '.$1ts'))
    const source = [stem, `${stem}x`].find(candidate => existsSync(candidate))
    return source === undefined ? undefined : this.display(source)
  }

  linkedWorkspacePackage(importer: string, packageName: string): string | undefined {
    let directory = dirname(resolve(importer))
    for (;;) {
      const link = join(directory, 'node_modules', packageName)
      if (existsSync(link)) {
        const target = this.canonical(link)
        return this.isWorkspaceFile(join(target, 'package.json')) ? target : undefined
      }
      if (this.canonical(directory) === this.realRoot || dirname(directory) === directory) return undefined
      directory = dirname(directory)
    }
  }

  private packageRoot(directory: string): string | undefined {
    if (this.packageRoots.has(directory)) return this.packageRoots.get(directory)
    const found = existsSync(join(directory, 'package.json'))
      ? directory
      : directory === this.realRoot || dirname(directory) === directory
        ? undefined
        : this.packageRoot(dirname(directory))
    this.packageRoots.set(directory, found)
    return found
  }
}
