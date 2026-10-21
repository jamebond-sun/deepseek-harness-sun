/**
 * ACP profile 的命令行与 stdin 生命周期提供者。解析成功后发布
 * {@link ACP_APP_STARTUP_SERVICE}；ACP 桥会等待该服务，因此请求帮助不会启动传输层。
 * @module @deepseek-ai/dsh-acp-app
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { exitOnStdinEnd, parseCmdline } from '@deepseek-ai/dsh-cmdline'

/** 稳定的 Cordis 插件名。 */
export const name = 'acp-app-startup'

/** 本应用解析本次调用之前所需的启动器服务。 */
export const inject = ['cmdlineArgs']

/** ACP 桥接行在接管 stdio 之前所等待的服务。 */
export const ACP_APP_STARTUP_SERVICE = 'acpAppStartup'

/**
 * 构建本应用的零选项命令与帮助信息。
 * @returns 一次调用专用的全新 program。
 */
function acpCommand(): Command {
  return new Command()
    .name('dsh --profile acp')
    .description('Serve automation clients over Agent Client Protocol stdio.')
    .helpOption('-h, --help', 'show this help')
    .addHelpText('after', `
Example:
  dsh --profile acp     serve ACP until the client disconnects
`)
}

/**
 * 接受一次 ACP profile 调用、发布就绪状态，并把 EOF 绑定到启动器的有界关闭流程。
 * @param ctx - 承载命令行值与退出启动器值的插件上下文。
 */
export function apply(ctx: Context): void {
  const program = acpCommand()
  program.action(() => {
    exitOnStdinEnd(ctx, 'acp-app.stdin')
    ctx.provide(ACP_APP_STARTUP_SERVICE, { accepted: true })
  })
  parseCmdline(ctx, program)
}
