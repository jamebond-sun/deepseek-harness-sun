/** 使用安装器的 Git 配置与环境进行的、有边界的 GitHub 仓库检查。 */
import { mkdir, mkdtemp, open } from 'node:fs/promises'
import { join } from 'node:path'
import { execa } from 'execa'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { classifyInstallFailure } from './install-failure.ts'
import type { ParsedInstallSpec } from './install-spec.ts'
import type { PackageResult } from './types.ts'

/** 一次只读 GitHub 检查的截止时间、诊断与取消。 */
export interface GithubConnectionOptions {
  timeoutMs: number
  outputBytes: number
  signal: AbortSignal
  /** 应用所拥有的包管理器环境，其 Git 子进程也使用它。 */
  env?: Readonly<Record<string, string>>
}

/**
 * 在 pnpm 启动之前检查一个 GitHub 仓库，但不下载或构建其包。
 * Git 读取 profile 的 Git 与代理配置，而不调用凭据助手或进行交互提示。
 * 超时与取消也会终止其后代进程；pnpm 负责鉴权与传输回退。
 * @param spec 解析后的安装地址；npm 包、本地路径以及其它主机不会被检查。
 * @param dir 安装运行的 profile 目录。
 * @param options 连接截止时间、输出上限与操作取消。
 * @returns 一次失败的检查（带有受限输出与位于 logPath 的完整日志）；对于可达的仓库或
 *   无法处理的 spec，则为 undefined。
 */
export async function checkGithubConnection(
  spec: ParsedInstallSpec, dir: string, options: GithubConnectionOptions,
): Promise<PackageResult | undefined> {
  if (spec.kind !== 'git') return undefined
  const host = spec.host.toLowerCase().replace(/:.*$/, '')
  if (host !== 'github.com' && !host.endsWith('.github.com')) return undefined
  const repository = spec.spec.replace(/#.*$/s, '')
    .replace(/^github:/i, 'https://github.com/')
    .replace(/^gist:/i, 'https://gist.github.com/')
    .replace(/^git\+/i, '')
  const logRoot = join(dir, '.plugin-manager', 'logs')
  await mkdir(logRoot, { recursive: true, mode: 0o700 })
  const logDir = await mkdtemp(join(logRoot, 'github-connection-'))
  const logPath = join(logDir, 'git.log')
  const log = await open(logPath, 'ax+', 0o600)
  try {
    const result = await execa('git', ['-c', 'credential.helper=', 'ls-remote', '--', repository, 'HEAD'], {
      cwd: dir,
      env: {
        ...scrubbedParentEnv(), ...options.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: '', SSH_ASKPASS: '', SSH_ASKPASS_REQUIRE: 'never',
      },
      extendEnv: false,
      stdin: 'ignore', stdout: 'ignore', stderr: { file: logPath, append: true }, buffer: false, reject: false,
      timeout: options.timeoutMs, cancelSignal: options.signal, killDescendants: true, killSignal: 'SIGKILL',
    })
    if (!result.failed) return undefined
    if (result.timedOut) await log.write(`dsh: connection to ${spec.host} timed out after ${String(options.timeoutMs)}ms\n`)
    if ((await log.stat()).size === 0) await log.write(result.shortMessage ?? 'GitHub connection check failed')
    const { size } = await log.stat()
    const bytes = Buffer.alloc(Math.min(size, options.outputBytes))
    await log.read(bytes, 0, bytes.length, size - bytes.length)
    const output = bytes.toString('utf8')
    return {
      exitCode: result.exitCode ?? (result.code === 'ENOENT' ? 127 : 1), output, truncated: size > options.outputBytes, logPath,
      kind: classifyInstallFailure({ log: output, timedOut: result.timedOut }),
    }
  } finally {
    await log.close()
  }
}
