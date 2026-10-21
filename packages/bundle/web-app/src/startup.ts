/**
 * Web 应用的命令行提供者：它解析 `dsh --profile web` 的标志族（`--host`、`--port`、
 * `--public-url`、`--trusted-host`、`--no-open`、TLS）及其 `--help` 文本，然后把这些
 * 不可变的值作为 {@link WEB_STARTUP_SERVICE} 提供出来。普通的行先从惰性配置注入该服务，
 * 再读取它。
 * @module @deepseek-ai/dsh-web-app/startup
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import { isWildcardHost, type TlsConfig } from '@deepseek-ai/dsh-host-webserver'
import { parsePublicUrl } from './public-url.ts'

/** 稳定的 Cordis 插件名。 */
export const name = 'web-startup'

/** 解析这些标志之前所需的服务。 */
export const inject = ['cmdlineArgs']

/** 本普通插件提供、并由依赖标志配置的行注入的服务。 */
export const WEB_STARTUP_SERVICE = 'webStartup'

/** web 各行从 {@link WEB_STARTUP_SERVICE} 读取的内容。 */
export interface WebStartupValues {
  /** 本次调用是否在启动后打开默认浏览器。 */
  openBrowser: boolean
  /** `--host`，本次调用未指定时缺省。 */
  host?: string
  /** `--port`，本次调用未指定时缺省。 */
  port?: number
  /**
   * `--public-url`，未指定时缺省：所宣告的 HTTP(S) 根路径。
   * 参见[公开部署](../README.md#public-deployments)。
   */
  publicUrl?: string
  /** 显式的 `--trusted-host` authority，按参数顺序排列。 */
  trustedHosts: string[]
  /** 一同提供的服务器证书链与未加密私钥。 */
  tls?: TlsConfig
}

/** web 标志族，即 commander 解析出的形态。 */
interface WebOptions {
  host?: string
  open: boolean
  port?: string
  publicUrl?: string
  trustedHost?: string[]
  tlsCert?: string
  tlsKey?: string
}

/**
 * 本应用的命令：它的标志、描述与帮助文本。
 * @returns 一个全新的 program，这样一个进程可以多次解析（测试所需）。
 */
function webCommand(): Command {
  return new Command()
    .name('dsh --profile web')
    .description('Serve the DeepSeek Harness browser UI.')
    .helpOption('-h, --help', 'show this help')
    .option('--host <host>', 'bind address: one concrete IPv4 or IPv6 literal of a local interface; wildcard addresses are rejected')
    .option('--no-open', 'do not open the Web UI in the default browser')
    .option('--port <port>', 'listen port; pass 0 to let the OS pick a free one')
    .option('--public-url <url>', 'advertise this HTTP(S) root in the printed, opened, runtime-context, and DSH_WEB_URL forms; grants no trust')
    .option('--trusted-host <authority...>', 'extra authority the /api browser-trust fence accepts (host or host:port; repeatable)')
    .option('--tls-cert <file>', 'PEM server certificate chain; requires --tls-key')
    .option('--tls-key <file>', 'unencrypted PEM private key; requires --tls-cert')
    .addHelpText('after', `
Examples:
  dsh --profile web                          serve on the composed host and port
  dsh --profile web --no-open                serve without opening a browser
  dsh --profile web --port 8080              serve on another port
  dsh --profile web --host 10.0.0.7          bind one local interface address
  dsh --profile web --public-url https://app.example/ui/ --trusted-host app.example
                                             advertise a prefix-stripping HTTPS proxy entry and admit its authority
  dsh --profile web --tls-cert ./server-chain.pem --tls-key ./server-key.pem
                                             serve HTTPS with an existing certificate and key
`)
}

/**
 * 把 Web 调用解析出来，并以普通 Cordis 服务的形式提供。命令的 action 发布本次调用
 * 所给出的那些标志。无效的标志（包括未成对的 TLS 证书或私钥）属于用法错误；被拒绝时
 * 以及 `--help` 不提供任何服务。
 * @param ctx - 承载命令行的插件上下文。
 */
export function apply(ctx: Context): void {
  const program = webCommand()
  program.action(() => {
    const options = program.opts<WebOptions>()
    if (options.host !== undefined && isWildcardHost(options.host)) {
      program.error(`error: --host ${options.host} is an unspecified (wildcard) address, which is not supported: binding every interface would expose remote code execution to the network; bind one concrete IPv4 or IPv6 address instead`)
    }
    if (options.port !== undefined && !/^\d+$/.test(options.port)) {
      program.error(`error: --port must be a number, got ${JSON.stringify(options.port)}`)
    }
    let tls: TlsConfig | undefined
    if (options.tlsCert !== undefined && options.tlsKey !== undefined) {
      tls = { certFile: options.tlsCert, keyFile: options.tlsKey }
    } else if (options.tlsCert !== undefined || options.tlsKey !== undefined) {
      program.error('error: --tls-cert and --tls-key must be supplied together')
    }
    if (options.publicUrl !== undefined) {
      try {
        parsePublicUrl(options.publicUrl, '--public-url')
      } catch (error) {
        program.error(`error: ${(error as Error).message}`)
      }
    }
    ctx.provide(WEB_STARTUP_SERVICE, {
      openBrowser: options.open,
      ...options.host !== undefined && { host: options.host },
      ...options.port !== undefined && { port: Number(options.port) },
      ...options.publicUrl !== undefined && { publicUrl: options.publicUrl },
      ...tls !== undefined && { tls },
      trustedHosts: options.trustedHost ?? [],
    } satisfies WebStartupValues)
  })
  parseCmdline(ctx, program)
}
