/** 在已挂载的执行世界中选择源码态或构建后的 bootstrap 资产。 */
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { assertNever } from '@deepseek-ai/dsh-util-values'

/** 由部署方决定的、子进程执行世界中的 worker 调用方式。 */
export type LaunchConfig = {
  /** 启动一个单独安装的 Node 可执行文件与 JavaScript bootstrap。 */
  kind: 'node-script'
  /** 由 subprocess provider 解析的可执行文件名或路径。 */
  executable: string
  /** 已预装的 bootstrap 绝对路径；省略时把本包的 bootstrap 映射进执行世界。 */
  bootstrapPath?: string
} | {
  /** 启动打包可执行文件中内嵌的私有 PTC worker。 */
  kind: 'embedded'
  /** 由 subprocess provider 解析的打包可执行文件名或路径。 */
  executable: string
}

/**
 * 解析出本地载体的默认调用方式，或校验一个显式的执行世界调用方式。
 * @param config - 显式的远程或本地 worker 配置；省略时选择本载体。
 * @returns worker 调用方式，不从执行世界的路径去猜测。
 */
export function resolveLaunch(config?: LaunchConfig): LaunchConfig {
  const launch: LaunchConfig = config ?? { kind: 'pkg' in process ? 'embedded' : 'node-script', executable: process.execPath }
  if (launch.executable.length === 0) throw new Error('ptc-runtime-node: launch.executable must be non-empty')
  if (launch.kind === 'node-script' && launch.bootstrapPath !== undefined && !isAbsolute(launch.bootstrapPath)) {
    throw new Error('ptc-runtime-node: launch.bootstrapPath must be absolute')
  }
  return launch
}

/**
 * 选出显式的参数，不继承宿主的 loader 或 inspector 标志。
 * @param fs - 把宿主 bootstrap 资产映射进进程世界的文件系统。
 * @param config - 已解析的 worker 调用方式。
 * @param maxMessageBytes - 已校验的帧与排队写入上限。
 * @param persistent - 选择内存 REPL 的 bootstrap，而非一次性求值器。
 * @returns 紧跟在已解析 Node 可执行文件之后的参数。
 */
export function bootstrapArgs(fs: Pick<FileSystem, 'processPathFromHostPath'>, config: LaunchConfig, maxMessageBytes: number, persistent = false): string[] {
  switch (config.kind) {
    case 'embedded':
      if (persistent) throw new Error('Persistent PTC requires a node-script launch')
      return [String(maxMessageBytes)]
    case 'node-script': return scriptBootstrapArgs(fs, config.bootstrapPath, maxMessageBytes, persistent)
    /* v8 ignore next -- 调用方传入的是已解析的、封闭的 LaunchConfig 联合。 */
    default: return assertNever(config)
  }
}

function scriptBootstrapArgs(
  fs: Pick<FileSystem, 'processPathFromHostPath'>, bootstrapPath: string | undefined, maxMessageBytes: number, persistent: boolean,
): string[] {
  const moduleName = persistent ? 'persistent-process' : 'process'
  if (bootstrapPath !== undefined) return [bootstrapPath, String(maxMessageBytes)]
  const mapped = (path: string): string => {
    const result = fs.processPathFromHostPath(path)
    if (result === undefined) throw new Error(`PTC runtime bootstrap is unavailable in the subprocess execution world: ${path}`)
    return result
  }
  /* v8 ignore next 3 -- built-lib.e2e.ts 会在纯 Node 下执行打包后的 provider 与同级的 process.js。 */
  if (!new URL(import.meta.url).pathname.endsWith('.ts')) {
    return [mapped(fileURLToPath(new URL(`./${moduleName}.js`, import.meta.url))), String(maxMessageBytes)]
  }
  const entry = mapped(fileURLToPath(new URL(`./${moduleName}.ts`, import.meta.url)))
  const subprocess = dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-subprocess/package.json')))
  const helper = mapped(resolve(subprocess, 'src/control.ts'))
  const main = persistent ? 'runPersistentMain' : 'runNodeMain'
  const source = `const {openInheritedControlChannel}=await import(${JSON.stringify(pathToFileURL(helper).href)});const {${main}}=await import(${JSON.stringify(pathToFileURL(entry).href)});await ${main}(openInheritedControlChannel(),${maxMessageBytes},process);`
  return ['--input-type=module', '--eval', source]
}
