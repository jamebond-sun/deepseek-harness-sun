/** 面向 SSH helper 及其托管进程 worker 的私有 SEA 分发器。 */
/* v8 ignore file -- 可执行产物测试通过 pkg 的 SEA 加载器运行该入口。 */
import { registerHooks } from 'node:module'
import { statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isSea } from 'node:sea'
import { pathToFileURL } from 'node:url'

/**
 * 从私有 SEA 引导程序中一次分发出随包发布的 helper 或 worker。
 * @returns 被选中的进程入口完成清理之后返回。
 * @throws 在 SEA 之外调用时，或无法加载原生资源时抛出。
 */
export async function runSshHelperRuntime(): Promise<void> {
  if (!isSea()) throw new Error('SSH helper runtime must run from its packaged executable')

  // 操作系统在 SEA 虚拟文件系统之外执行 Landlock。
  const nativeManifest = join(dirname(process.execPath), 'native', 'system', 'package.json')
  statSync(nativeManifest)
  const platformPackage = `@deepseek-ai/node-addon-system-${process.platform}-${process.arch}/package.json`
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === platformPackage) return { url: pathToFileURL(nativeManifest).href, shortCircuit: true }
      return nextResolve(specifier, context)
    },
  })

  const selection = process.env.DSH_SUBPROCESS_RUNNER
  Reflect.deleteProperty(process.env, 'DSH_SUBPROCESS_RUNNER')
  if (process.env.DSH_PTC_RUNTIME_NODE === '1') {
    Reflect.deleteProperty(process.env, 'DSH_PTC_RUNTIME_NODE')
    await import('@deepseek-ai/dsh-ptc-runtime-node/process')
  } else if (selection !== undefined) {
    const { runSelectedSubprocessRunner } = await import('@deepseek-ai/dsh-subprocess-local/runner')
    await runSelectedSubprocessRunner(selection)
  } else {
    await import('@deepseek-ai/dsh-ssh/helper')
  }
}
