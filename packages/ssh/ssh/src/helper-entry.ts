/** 私有 OpenSSH 进程入口；请求与清理行为由 helper 模块负责。 */
/* v8 ignore file -- 在 SSH 验收中由纯 Node 启动；helper 行为通过其显式传入的流来测试。 */
import { fileURLToPath } from 'node:url'
import { isSea } from 'node:sea'
import { runSshHelper } from './helper.ts'

/** 处理一次 helper 请求；所有失败都会写入 stderr 并以退出码 127 结束。 */
async function main(): Promise<void> {
  const controller = new AbortController()
  const stop = (): void => { controller.abort(new Error('SSH helper process terminated')) }
  for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) process.once(signal, stop)
  try {
    if (process.argv.length !== 2) throw new Error('SSH helper accepts no command arguments')
    const packaged = isSea()
    await runSshHelper({
      input: process.stdin, output: process.stdout,
      entryPath: packaged ? process.execPath : fileURLToPath(import.meta.url),
      kind: packaged ? 'executable' : 'node-script', signal: controller.signal,
    })
  } catch (error) {
    process.stderr.write(`dsh-ssh-sandbox: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 127
  } finally {
    for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) process.off(signal, stop)
  }
}

void main()
