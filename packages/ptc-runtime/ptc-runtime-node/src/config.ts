/** Node PTC provider 的执行模式与资源限额。 */
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { LaunchConfig } from './launch.ts'

/** 随部署变化的运行时边界与启动选择。 */
export interface Config {
  /** 子进程执行世界中的 worker 调用方式；省略则选择本地载体。 */
  launch?: LaunchConfig
  /** per-call 每次启动全新进程；persistent-in-memory 在同一文件策略下为每个所有者保留一个 REPL。 */
  executionMode?: 'per-call' | 'persistent-in-memory'
  /** 默认执行截止时间，包含嵌套的工具与审批等待。 */
  timeoutMs?: number
  /** resolve 所接受的数值型执行预算上限。 */
  maxTimeoutMs?: number
  /** 序列化后的日志、完成值与诊断文本的合并字节上限。 */
  maxOutputBytes?: number
  /** V8 老生代堆上限，单位 MiB；原生分配不计入。 */
  maxOldGenerationSizeMb?: number
  /** 控制帧、在途参数与排队控制输出的字节上限。 */
  maxMessageBytes?: number
  /** 同一个程序同时发起的宿主绑定调用上限。 */
  maxPendingCalls?: number
  /** 托管进程终止与输出排空的宽限期，单位毫秒。 */
  graceMs?: number
}

/** 经过 Loader 默认值填充与可执行文件选择之后的配置。 */
export type ResolvedConfig = Required<Config>
/** Node PTC provider 的 Loader 默认值。 */
export const NodeConfig: z<Config> = z.object({
  executionMode: z.union([z.const('per-call'), z.const('persistent-in-memory')]).default('per-call'),
  timeoutMs: z.number().default(120_000),
  maxTimeoutMs: z.number().default(600_000),
  maxOutputBytes: z.number().default(67_108_864),
  maxOldGenerationSizeMb: z.number().default(512),
  maxMessageBytes: z.number().default(134_217_728),
  maxPendingCalls: z.number().default(128),
  graceMs: z.number().default(3_000),
  launch: z.union([
    z.object({ kind: z.const('node-script').required(), executable: z.string().required(), bootstrapPath: z.string() }),
    z.object({ kind: z.const('embedded').required(), executable: z.string().required() }),
  ]),
})

/**
 * 校验已解析的 Node 限额与路径。
 * @param config - 经 Loader 填充默认值的字段，含已选定的可执行文件。
 */
export function validateConfig(config: ResolvedConfig): void {
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === 'number' && (!Number.isFinite(value) || value <= 0)) throw new Error(`ptc-runtime-node: ${key} must be positive and finite`)
  }
  for (const key of ['timeoutMs', 'maxTimeoutMs', 'graceMs'] as const) {
    if (config[key] > MAX_TIMER_DELAY_MS) throw new Error(`ptc-runtime-node: ${key} exceeds the supported timer range`)
  }
  if (!Number.isSafeInteger(config.maxOutputBytes) || config.maxOutputBytes < 4) throw new Error('ptc-runtime-node: maxOutputBytes must be an integer of at least 4')
  if (!Number.isSafeInteger(config.maxMessageBytes) || config.maxMessageBytes > 0xffff_ffff) throw new Error('ptc-runtime-node: maxMessageBytes must fit an unsigned 32-bit frame length')
  if (!Number.isSafeInteger(config.maxPendingCalls)) throw new Error('ptc-runtime-node: maxPendingCalls must be an integer')
  if (!Number.isSafeInteger(config.maxOldGenerationSizeMb)) throw new Error('ptc-runtime-node: maxOldGenerationSizeMb must be an integer')
}
