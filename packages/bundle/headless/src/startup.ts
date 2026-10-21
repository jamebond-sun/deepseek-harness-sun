/**
 * 一次性应用的命令行提供者：它解析 task 位置参数、`--session-id`、`--json` 与
 * `--help`，然后发布 {@link HEADLESS_STARTUP_SERVICE}。runner 是一个普通消费者，
 * 其惰性配置等待该服务。
 * @module @deepseek-ai/dsh-headless/startup
 */

import { Command, CommanderError } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import { boundJsonLine } from './json-stream.ts'
import { internals } from './startup-internals.ts'

/** 稳定的 Cordis 插件名。 */
export const name = 'headless-startup'

/** 解析任务之前所需的服务。 */
export const inject = ['cmdlineArgs']

/** 本插件提供、并由一次性 runner 注入的服务。 */
export const HEADLESS_STARTUP_SERVICE = 'headlessStartup'

/** runner 行从 {@link HEADLESS_STARTUP_SERVICE} 读取的内容。 */
export interface HeadlessStartupValues {
  /** 本次调用给出的任务文本；当 runner 读取 stdin 时缺省。 */
  task: string | undefined
  /** 要沿用的确切 Session 身份；缺省时使用新的随机身份。 */
  sessionId: string | undefined
  /** stdout 是否输出机器可读的事件流而不是最终文本。 */
  json: boolean
}

/**
 * 本应用的命令：task 位置参数、它的选项与帮助文本。
 * @returns 一个全新的 program，这样一个进程可以多次解析（测试所需）。
 */
function headlessCommand(): Command {
  return new Command()
    .name('dsh --profile headless')
    .description('Answer one task and exit; the answer goes to stdout and diagnostics to stderr.')
    .helpOption('-h, --help', 'show this help')
    .option('--json', 'write newline-delimited run events to stdout instead of the final message')
    .option('--session-id <id>', 'adopt the persisted Session with this id; an unknown id is an error')
    .argument('[task...]', 'the task text; multiple words are joined by spaces, and `-` reads stdin')
    .addHelpText('after', `
Examples:
  dsh --profile headless "run the tests"          answer one task and exit
  echo "run the tests" | dsh --profile headless   read the task from stdin
  dsh --profile headless --json "run the tests"   emit machine-readable run events
  dsh --profile headless --session-id session-… "continue"   resume an existing Session
`)
}

/**
 * 原始调用是否请求机器可读的事件流。扫描在 `--` 处停止，并跳过 `--session-id`
 * 的值，因此作为选项值或位置参数出现的字面量 `--json` 永远不会安装 JSON 错误覆写。
 * @param argv - 本次调用的原始参数。
 * @returns `--json` 是否为本次调用中真实的标志。
 */
function jsonRequested(argv: readonly string[]): boolean {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--') return false
    if (argument === '--json') return true
    if (argument === '--session-id') index += 1
  }
  return false
}

/**
 * 把一次性任务解析出来，并以普通 Cordis 服务的形式提供。命令的 action 发布该任务；
 * 在交互式 stdin 上缺少任务属于用法错误，因此解析被拒绝时（以及 `--help`）不提供任何服务。
 * @param ctx - 承载命令行的插件上下文。
 */
export function apply(ctx: Context): void {
  const program = headlessCommand()
  // 由原始快照决定 JSON 契约：Commander 会在 action 运行之前拒绝语法错误（未知选项、
  // 缺少选项值），而这类拒绝仍应向 --json 调用方补上 error 事件。
  if (jsonRequested(ctx.get('cmdlineArgs')?.get() ?? [])) {
    program.error = (message: string, errorOptions?: Parameters<Command['error']>[1]): never => {
      // 事件消息与 runner 的运行时错误保持一致，后者不携带 commander 的 `error: ` 前缀。
      const payload = boundJsonLine({ type: 'error', message: message.replace(/^error: /, '') })
      internals.stdout.write(`${payload}\n`)
      // JSON 契约把 stderr 留给 `dsh:` 诊断信息，因此 commander 自身对该消息的打印
      // 不得执行；抛出同样的控制流错误仍会经由启动器的退出路径离开。
      throw new CommanderError(1, errorOptions?.code ?? 'commander.error', message)
    }
  }
  program.action(() => {
    if (program.args.length > 1 && program.args.includes('-')) {
      program.error('error: `-` must be the only task argument')
    }
    const joined = program.args.join(' ')
    if (program.args.length > 0 && joined.trim() === '') {
      program.error('error: a task is required, for example: dsh --profile headless "run the tests"')
    }
    const task = program.args.length === 0 ? undefined : joined
    if (task === undefined && internals.stdinIsTty()) {
      program.error('error: a task is required, for example: dsh --profile headless "run the tests"')
    }
    const options = program.opts<{ json?: boolean; sessionId?: string }>()
    // SessionId 是不透明的，空白也属于身份的一部分：用修剪后的值校验是否为空，
    // 但交给 runner 的是原始字符串。
    const sessionId = options.sessionId
    if (sessionId !== undefined && sessionId.trim() === '') {
      program.error('error: --session-id requires a non-empty session id')
    }
    ctx.provide(HEADLESS_STARTUP_SERVICE, {
      task,
      sessionId,
      json: options.json === true,
    } satisfies HeadlessStartupValues)
  })
  parseCmdline(ctx, program)
}
