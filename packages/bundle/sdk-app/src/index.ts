/**
 * SDK profile 的命令行与 stdin 生命周期提供者。解析成功后发布
 * {@link SDK_APP_STARTUP_SERVICE}；JSON-RPC 服务器会等待该服务，因此请求帮助
 * 不会启动传输层。
 * @module @deepseek-ai/dsh-sdk-app
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { exitOnStdinEnd, parseCmdline } from '@deepseek-ai/dsh-cmdline'

/** 稳定的 Cordis 插件名。 */
export const name = 'sdk-app-startup'

/** 本应用解析本次调用之前所需的启动器服务。 */
export const inject = ['cmdlineArgs']

/** JSON-RPC 服务器行在接管 stdio 之前所等待的服务。 */
export const SDK_APP_STARTUP_SERVICE = 'sdkAppStartup'

/** SDK stdio 启动配置。 */
export interface Config {
  /** 渲染在帮助信息与诊断信息中的 profile 名（默认 `sdk`）。 */
  profile?: string
}

/** 校验并填充 SDK stdio 启动配置的默认值。 */
export const Config: z<Config> = z.object({
  profile: z.string().default('sdk'),
})

/**
 * 构建本应用的零选项命令与帮助信息。
 * @param profile - 渲染在命令文法中的所选 profile 名。
 * @returns 一次调用专用的全新 program。
 */
function sdkCommand(profile: string): Command {
  return new Command()
    .name(`dsh --profile ${profile}`)
    .description('Serve DeepSeek Harness SDK clients over stdio JSON-RPC.')
    .helpOption('-h, --help', 'show this help')
    .addHelpText('after', `
Example:
  dsh --profile ${profile}     serve one SDK runtime until its client disconnects
`)
}

/**
 * 接受一次 SDK profile 调用、发布就绪状态，并把 EOF 绑定到启动器的有界关闭流程。
 * @param ctx - 承载命令行值与退出启动器值的插件上下文。
 * @param config - 用于命令帮助信息的所选 profile 身份。
 */
export function apply(ctx: Context, config: Config = {}): void {
  const program = sdkCommand(config.profile ?? 'sdk')
  program.action(() => {
    exitOnStdinEnd(ctx, 'sdk-app.stdin')
    ctx.provide(SDK_APP_STARTUP_SERVICE, { accepted: true })
  })
  parseCmdline(ctx, program)
}
