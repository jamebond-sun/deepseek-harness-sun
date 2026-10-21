/** 在 SSH 主机上选择并应用沙箱的远端 argv 包装器。 */
import { SandboxProvider, SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-ssh'
import { z } from 'zod'

const factsSchema = z.object({ argv: z.array(z.string()).min(1), enforcement: z.enum(['full', 'partial']), denialSignatures: z.array(z.string()), runnerFailureRules: z.array(z.object({ allowedExitCodes: z.array(z.number().int()).optional(), fatalSignatures: z.array(z.string()), informationalLines: z.array(z.string()).optional() }).strict()) }).strict()

/** 每个限制请求都在与其文件系统和子进程 provider 相同的主机上解析。 */
export class SshSandboxProvider extends SandboxProvider {
  static inject = ['ssh']

  override async confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv> {
    signal?.throwIfAborted()
    try {
      const confined = await this.ctx.ssh.request('sandbox', { argv, policy }, factsSchema, signal)
      signal?.throwIfAborted()
      return {
        ...confined,
        runnerFailureRules: confined.runnerFailureRules.map(rule => ({
          fatalSignatures: rule.fatalSignatures,
          ...(rule.allowedExitCodes === undefined ? {} : { allowedExitCodes: rule.allowedExitCodes }),
          ...(rule.informationalLines === undefined ? {} : { informationalLines: rule.informationalLines }),
        })),
      }
    } catch (error) {
      signal?.throwIfAborted()
      throw new SandboxUnavailableError(policy.mode, error instanceof Error ? error.message : String(error))
    }
  }
}

export default SshSandboxProvider
