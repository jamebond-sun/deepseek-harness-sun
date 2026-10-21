/**
 * Typert 生成器的可选 tsdown（rolldown）插件端。它在打包前先在 TypeScript
 * 依赖中降级标准装饰器，然后在包输出根处发射模型驱动的端产物。没有 Typert 或
 * Remote 导出的包会被跳过。Workspace 模式在由本次通过的第一个 `buildStart`
 * 启动的 Worker 线程中生成，因此打包在主线程上继续，而 Typert 进行分析；本次
 * 通过的第一个 `writeBundle` 等待结果并一次性写入每个产物。
 * @module @deepseek-ai/dsh-typert-generator/tsdown
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import ts from 'typescript'
import { writePackageArtifacts, writeWorkspaceArtifacts } from './artifact-files.ts'
import { findWorkspaceRoot, hasTypertExport, WorkspaceTypertGenerator } from './workspace.ts'
import type { WorkspaceEmitResult } from './workspace.ts'
import type { TypertFace } from './model.ts'
import type { WorkspaceWorkerRequest, WorkspaceWorkerResponse } from './worker.ts'

/** 此处使用的 rolldown 插件契约子集（结构化；避免 rolldown 类型依赖）。 */
interface TypertPlugin {
  name: string
  buildStart: (options: { cwd: string }) => void
  transform: {
    filter: { id: RegExp }
    handler: (code: string, id: string) => { code: string; map: string | undefined } | undefined
  }
  writeBundle: (options: { dir?: string }) => Promise<void>
}

/** A module id whose path (before any `?query`) names a TypeScript source. */
const TYPESCRIPT_MODULE = /^[^?]*\.[cm]?tsx?(?:\?|$)/
const DECORATOR_SYNTAX = /^\s*@[A-Za-z_$][\w$]*/m

// 完整构建与类型检查各自拥有 TypeScript 诊断。仅基准的发射将这些诊断推迟到
// 所需的完整构建 CI 作业；Typert 生成反射而不重复这些诊断。
const TSC_OWNED_DIAGNOSTICS = { checkDiagnostics: false } as const

/** 由 tsdown 构建阶段选定的生成范围。 */
export interface TypertPluginOptions {
  /** package 模式只发射正在被打包的包；workspace 模式一次性发射每个显式贡献者。 */
  readonly mode?: 'package' | 'workspace'
  /** 本阶段包含的、独立的 TypeScript 程序端。 */
  readonly faces?: readonly TypertFace[]
}

/** 一个在 Typert Worker 线程上报告或观察到的 workspace 模式生成失败。 */
export class TypertWorkerError extends Error {
  override name = 'TypertWorkerError'
}

/** 已结算的 workspace 生成；失败作为值返回，因此未被认领的生成绝不会以未处理的方式 reject。 */
type GenerationOutcome =
  | { readonly ok: true; readonly artifacts: readonly WorkspaceEmitResult[] }
  | { readonly ok: false; readonly error: TypertWorkerError }

/**
 * 为根 tsdown 配置创建装饰器降级与 typert 生成插件。
 * @param pluginOptions - 包/workspace 发射模式与独立的程序端。
 * @returns 一个与 rolldown 兼容的插件，降级源码装饰器并发射本地与 Host-for-Client 产物。
 */
export function typertPlugin(pluginOptions: TypertPluginOptions = {}): TypertPlugin {
  const artifactsByRoot = new Map<string, readonly WorkspaceEmitResult[]>()
  const generations = new Map<string, Promise<GenerationOutcome>>()
  const emittedWorkspaces = new Set<string>()
  const workspaceGeneration = (root: string): Promise<GenerationOutcome> => {
    let generation = generations.get(root)
    if (generation === undefined) {
      generation = generateInWorker({
        root,
        ...(pluginOptions.faces === undefined ? {} : { faces: pluginOptions.faces }),
        options: TSC_OWNED_DIAGNOSTICS,
      })
      generations.set(root, generation)
    }
    return generation
  }
  return {
    name: 'dsh-typert-generator',
    buildStart(inputOptions) {
      // tsdown 通过这一个插件实例并发构建每个 workspace 包；
      // 第一个开始构建的包会启动生成。
      if (pluginOptions.mode === 'workspace') void workspaceGeneration(findWorkspaceRoot(inputOptions.cwd))
    },
    transform: {
      // Rolldown 原生求值 id 过滤器，因此非 TypeScript 模块永远不会进入
      // 这个 JavaScript 钩子。
      filter: { id: TYPESCRIPT_MODULE },
      handler(code, id) {
        if (!TYPESCRIPT_MODULE.test(id) || !DECORATOR_SYNTAX.test(code)) return
        const file = id.replace(/\?.*$/su, '')
        const result = ts.transpileModule(code, {
          fileName: file,
          compilerOptions: {
            target: ts.ScriptTarget.ES2024,
            module: ts.ModuleKind.ESNext,
            ...(file.endsWith('x') ? { jsx: ts.JsxEmit.ReactJSX } : {}),
            sourceMap: true,
          },
        })
        return {
          code: result.outputText.replace(/\n?\/\/# sourceMappingURL=.*$/u, '\n'),
          map: result.sourceMapText,
        }
      },
    },
    async writeBundle(bundleOptions) {
      // options.dir 是包的绝对 outDir（<package>/lib）；即便自定义配置写入
      // 如 <package>/lib/dev 这样的嵌套输出，其最近的 package.json 仍拥有该 bundle。
      if (bundleOptions.dir === undefined) return
      const root = findWorkspaceRoot(bundleOptions.dir)
      if (emittedWorkspaces.has(root)) return
      if (pluginOptions.mode === 'workspace') {
        // 第一个完成的 bundle 认领发射并报告任何失败；
        // 本次通过的后续 bundle 不等待直接返回。
        emittedWorkspaces.add(root)
        const outcome = await workspaceGeneration(root)
        if (!outcome.ok) throw outcome.error
        writeWorkspaceArtifacts(root, outcome.artifacts)
        return
      }
      const packageDir = packageRoot(bundleOptions.dir, root)
      if (packageDir === undefined) return
      const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
        name?: string
        exports?: unknown
      }
      if (manifest.name === undefined || !hasTypertExport(manifest.exports)) return
      let artifacts = artifactsByRoot.get(root)
      if (artifacts === undefined) {
        const generator = new WorkspaceTypertGenerator(root, TSC_OWNED_DIAGNOSTICS)
        artifacts = pluginOptions.faces === undefined
          ? generator.generate()
          : generator.generate(undefined, pluginOptions.faces)
        artifactsByRoot.set(root, artifacts)
      }
      writePackageArtifacts(packageDir, artifacts.filter(candidate => candidate.package === manifest.name))
    },
  }
}

/**
 * 在 Worker 线程中运行 workspace 生成。结果绝不会 reject，且每个终结路径都会在
 * 结果结算前终止 worker。
 */
function generateInWorker(request: WorkspaceWorkerRequest): Promise<GenerationOutcome> {
  const worker = spawnWorker(request)
  return new Promise((settle) => {
    let settled = false
    const finish = (outcome: GenerationOutcome): void => {
      if (settled) return
      settled = true
      worker.terminate().then(
        () => { settle(outcome) },
        (error: unknown) => { settle({ ok: false, error: workerError(request, 'could not terminate its worker', error) }) },
      )
    }
    const fail = (problem: string, cause?: unknown): void => {
      finish({ ok: false, error: workerError(request, problem, cause) })
    }
    worker.once('message', (value: unknown) => {
      const response = parseWorkerResponse(value)
      if (response === undefined) {
        fail('received a malformed worker response')
      } else if (response.kind === 'failure') {
        const cause = new Error(response.message)
        cause.name = response.name
        if (response.stack !== undefined) cause.stack = response.stack
        fail(`failed: ${response.name}: ${response.message}`, cause)
      } else {
        finish({ ok: true, artifacts: response.artifacts })
      }
    })
    worker.once('messageerror', (error) => { fail('received a worker response that could not be deserialized', error) })
    worker.once('error', (error) => { fail(`crashed: ${error.message}`, error) })
    worker.once('exit', (code) => { fail(`stopped: its worker exited with code ${String(code)} before reporting artifacts`) })
  })
}

function workerError(request: WorkspaceWorkerRequest, problem: string, cause: unknown): TypertWorkerError {
  return new TypertWorkerError(
    `typert-generator: workspace generation for ${request.root} ${problem}`,
    cause === undefined ? undefined : { cause },
  )
}

function spawnWorker(request: WorkspaceWorkerRequest): Worker {
  /* v8 ignore next 3 -- tsdown 的宿主构建会运行已构建的 worker 入口。 */
  if (!import.meta.url.endsWith('.ts')) {
    return new Worker(new URL('./worker.js', import.meta.url), { workerData: request })
  }
  // 源码运行通过 tsx 加载 TypeScript worker 入口。
  const bootstrap = [
    `import { register } from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))}`,
    'register()',
    `await import(${JSON.stringify(new URL('./worker.ts', import.meta.url).href)})`,
  ].join('\n')
  return new Worker(new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`), { workerData: request, execArgv: [] })
}

function parseWorkerResponse(value: unknown): WorkspaceWorkerResponse | undefined {
  if (!isRecord(value)) return undefined
  if (value.kind === 'failure') {
    if (typeof value.name !== 'string' || typeof value.message !== 'string'
      || (value.stack !== undefined && typeof value.stack !== 'string')) return undefined
    return {
      kind: 'failure',
      name: value.name,
      message: value.message,
      ...(value.stack === undefined ? {} : { stack: value.stack }),
    }
  }
  if (value.kind !== 'artifacts' || !Array.isArray(value.artifacts)) return undefined
  const artifacts: WorkspaceEmitResult[] = []
  for (const artifact of value.artifacts) {
    const parsed = parseArtifact(artifact)
    if (parsed === undefined) return undefined
    artifacts.push(parsed)
  }
  return { kind: 'artifacts', artifacts }
}

function parseArtifact(value: unknown): WorkspaceEmitResult | undefined {
  if (!isRecord(value)
    || typeof value.package !== 'string'
    || typeof value.packageRoot !== 'string'
    || (value.face !== 'host' && value.face !== 'client')
    || !Array.isArray(value.exports)
    || !value.exports.every((entry): entry is string => typeof entry === 'string')
    || typeof value.js !== 'string'
    || typeof value.dts !== 'string') return undefined
  const remote = parseRemoteArtifact(value.remote)
  if (value.remote !== undefined && remote === undefined) return undefined
  return {
    package: value.package,
    packageRoot: value.packageRoot,
    face: value.face,
    exports: value.exports,
    js: value.js,
    dts: value.dts,
    ...(remote === undefined ? {} : { remote }),
  }
}

function parseRemoteArtifact(value: unknown): WorkspaceEmitResult['remote'] {
  if (!isRecord(value)
    || typeof value.js !== 'string'
    || typeof value.dts !== 'string'
    || typeof value.dtsMap !== 'string') return undefined
  return { js: value.js, dts: value.dts, dtsMap: value.dtsMap }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function packageRoot(start: string, workspace: string): string | undefined {
  let current = resolve(start)
  while (current !== workspace) {
    if (existsSync(join(current, 'package.json'))) return current
    current = dirname(current)
  }
  return undefined
}
