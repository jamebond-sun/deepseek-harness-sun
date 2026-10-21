/**
 * 面向 SDK 的、基于 stdio 的 JSON-RPC 插件。是否加载它由所选的 dsh profile 决定；
 * 参见单次启动的 Agent Note 与包 README。stdout 被保留给协议帧，因此插件树
 * 不得加载 stdout logger。本插件应答 `shutdown`、释放完整的根运行时并以 0 退出；
 * 应用 bin 负责 EOF 与信号退出。请保持具名的插件导出且不使用默认导出，
 * 这样 Loader 的 `unwrapExports` 才能保留 `name`、`inject`、`Config` 与 `apply`。
 *
 * @module @deepseek-ai/dsh-sdk-jsonrpc-server
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Readable, Writable } from 'node:stream'
import Schema from '@deepseek-ai/schemastery'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { HarnessSdkJsonRpcServer } from './server.ts'

export * from './server.ts'

export const name = 'sdk-jsonrpc-server'
export const inject = ['agents', 'workingDirectory']

/** JSON-RPC 部署配置，加上仅用于运行时的测试钩子。 */
export interface JsonRpcConfig {
  /** 将 max-token 导致的轮次/subagent 终止上报为成功的 SDK 结果。 */
  maxTokensAsSuccess?: boolean
  /** 传输输入覆盖；生产环境使用 `process.stdin`。 */
  input?: Readable
  /** 传输输出覆盖；生产环境使用 `process.stdout`。 */
  output?: Writable
  /** 进程退出覆盖；生产环境使用 `process.exit`。 */
  exit?: (code: number) => void
}

export const Config: Schema<JsonRpcConfig> = Schema.object({
  maxTokensAsSuccess: Schema.boolean().default(false),
})

/**
 * 在已配置的流之上提供 SDK 请求服务。effect 释放时会关闭 SDK 创建的 agent
 * 并关闭传输。在根运行时被释放、进程以 0 退出之前，会先刷新 `shutdown`
 * 响应；应用 bin 负责 EOF 与信号场景下的根 context 释放。
 */
export function apply(ctx: Context, config: JsonRpcConfig): void {
  // Cordis 在调用插件之前会先应用 schema 默认值。
  const resolvedConfig = config as JsonRpcConfig & { maxTokensAsSuccess: boolean }
  // 协议 shutdown 掌管完整的运行时进程，因此它必须在退出前等待根生命周期
  // （包括持久化）完成。
  const rootFiber = ctx.root.fiber
  /* v8 ignore next -- 生产环境 stdio 接线；测试始终注入运行时钩子 */
  const input = config.input ?? process.stdin
  /* v8 ignore next -- 生产环境 stdio 接线；测试始终注入运行时钩子 */
  const output = config.output ?? process.stdout
  /* v8 ignore next -- 生产环境 exit 接线；测试始终注入运行时钩子 */
  const exit = config.exit ?? ((code: number): void => { process.exit(code) })

  const transport = new JsonRpcLineTransport(input, output)
  const server = new HarnessSdkJsonRpcServer(ctx, transport, {
    maxTokensAsSuccess: resolvedConfig.maxTokensAsSuccess,
  })

  // 共享同一个退出任务，使并发的 shutdown 请求不会重复释放根 runtime
  // 或重复退出进程。
  let exitTask: Promise<void> | undefined
  const disposeAndExit = (): Promise<void> => {
    exitTask ??= (async () => {
      await Promise.allSettled([Promise.resolve().then(() => transport.flush())])
      await Promise.allSettled([Promise.resolve().then(() => rootFiber.dispose())])
      exit(0)
    })()
    return exitTask
  }

  transport.onRequest(async (method, params) => {
    // `initialize` 是 SDK 的就绪边界。本插件可能在异步的兄弟 Loader 条目
    // （例如 MCP 客户端的初始工具发现）之前激活，因此在整棵当前插件树
    // 稳定之前，不要宣称运行时已经就绪。Loader 的稳定会汇合条目导入、
    // fiber 生命周期工作与同步 effect 注册；调度延迟不属于就绪的一部分。
    // 手工构造、不含 Loader 的 context 仍然可以立即使用。
    if (method === 'initialize') {
      await ctx.get('loader')?.await()
    }
    const result = await server.handleRequest(method, params)
    if (method === 'shutdown') {
      // 在处理器结果写入之后运行；该任务随后会刷新、释放并退出。
      setImmediate(() => { void disposeAndExit() })
    }
    return result
  })

  ctx.effect(() => {
    transport.start()
    return async () => {
      await server.shutdown()
      transport.close()
    }
  }, 'jsonrpc.serve')
}
