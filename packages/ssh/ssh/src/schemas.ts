/** SSH helper 请求与远端观察结果的严格 JSON 校验。 */
import { z } from 'zod'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { SSH_PROTOCOL_VERSION } from './protocol.ts'

/** 由其所属 SSH helper 分配的、单个已准备或运行中进程的标识。 */
export type SshProcessId = Branded<'SshProcessId'>
/** 由其所属 SSH helper 分配的、单个已打开文本迭代器的标识。 */
export type SshTextStreamId = Branded<'SshTextStreamId'>
/** 从私有 helper 协议接收一个进程标识。 */
export const processIdSchema = z.uuid().transform((value): SshProcessId => value as SshProcessId)
/** 从私有 helper 协议接收一个文本迭代器标识。 */
export const textStreamIdSchema = z.uuid().transform((value): SshTextStreamId => value as SshTextStreamId)

/** 远端 POSIX 绝对路径；在远端做规范化之前保持原样书写。 */
export const remotePath = z.string().min(1).refine(value => value.startsWith('/') && !value.includes('\0'), 'expected an absolute POSIX path')
/** 远端文件系统 provider 返回的文件标识。 */
export const targetSchema = z.object({ targetKey: remotePath, displayPath: z.string() }).strict()
/** 远端的元数据观察结果。 */
export const infoSchema = z.object({ version: z.string(), type: z.enum(['file', 'directory', 'other']), size: z.number().nonnegative().optional() }).strict()
/** 保留最终符号链接的元数据。 */
export const pathInfoSchema = infoSchema.extend({ type: z.enum(['file', 'directory', 'symlink', 'other']) })
/** 已解析的文件副作用策略；路径规范化由远端 helper 负责。 */
export const policySchema = z.object({ mode: z.enum(['read-only', 'workspace-write', 'danger-full-access']), workspaceRoot: remotePath, sessionId: z.string().optional() }).strict()
/** 完整的目录项。 */
export const entriesSchema = z.array(z.object({ name: z.string(), type: z.enum(['file', 'directory', 'other']), target: targetSchema, version: z.string().optional(), size: z.number().nonnegative().optional() }).strict())
/** 受保护的写入意图。 */
export const intentSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('createIfAbsent') }).strict(), z.object({ kind: z.literal('replaceIfVersion'), version: z.string() }).strict()])
/** 字面文本编辑。 */
export const editSchema = z.object({ oldString: z.string(), newString: z.string(), replaceAll: z.boolean() }).strict()
/** 原子写入的观察结果。 */
export const writeResultSchema = z.object({ operation: z.enum(['create', 'update']), version: z.string(), before: z.string().nullable(), after: z.string() }).strict()
/** 原子编辑的观察结果。 */
export const editResultSchema = z.object({ version: z.string(), before: z.string(), after: z.string() }).strict()
/** 显式的子进程环境；null 表示一个环境删除标记。 */
export const environmentSchema = z.record(z.string(), z.string().nullable())
const collection = z.object({
  maxBytes: z.number().int().positive(),
  spill: z.object({ maxBytes: z.number().int().positive() }).strict().optional(),
}).strict()
/** 受信任的 SSH 客户端所请求的普通进程或终端进程。 */
export const spawnSchema = z.object({
  argv: z.array(z.string().refine(value => !value.includes('\0'))).min(1),
  cwd: remotePath,
  env: environmentSchema.optional(), graceMs: z.number().int().positive().max(2_147_483_647),
  stdio: z.object({
    stdin: z.union([z.literal('ignore'), z.literal('pipe'), z.object({ data: z.string() }).strict()]),
    stdout: z.union([z.literal('pipe'), z.literal('inherit'), collection]),
    stderr: z.union([z.literal('pipe'), z.literal('inherit'), collection]),
    control: z.literal('pipe').optional(),
  }).strict().optional(),
  terminal: z.object({
    terminalType: z.string().min(1), rows: z.number().int().positive(), cols: z.number().int().positive(),
    shellActivity: z.boolean().optional(),
  }).strict().optional(),
}).strict().refine(value => (value.stdio === undefined) !== (value.terminal === undefined), 'select ordinary or terminal execution')
/** 连接握手把 socket 与工作区绑定到同一个 helper 进程。 */
export const helloSchema = z.object({
  protocol: z.literal(SSH_PROTOCOL_VERSION), hash: z.string().regex(/^[0-9a-f]{64}$/),
  kind: z.enum(['node-script', 'executable']), platform: z.enum(['linux', 'darwin']),
  nodeVersion: z.string(), executable: remotePath, root: remotePath, workspace: remotePath,
  bootstrapHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
}).strict()
/** 一个已准备的进程会在目标代码执行之前公布其 socket。 */
export const streamEndpointSchema = z.object({ path: remotePath, capability: z.string().regex(/^[0-9a-f]{64}$/) }).strict()
/** 流的密钥只会被已认证的 SSH 客户端与它的 helper 知晓。 */
export type SshStreamEndpoint = z.infer<typeof streamEndpointSchema>
/** 已准备的进程及其各自独立认证的流端点。 */
export const preparedSchema = z.object({ id: processIdSchema, streams: z.partialRecord(z.enum(['stdin', 'stdout', 'stderr', 'control', 'terminal']), streamEndpointSchema) }).strict()
/** 进程退出的直接事实。 */
export const outcomeSchema = z.object({ exitCode: z.number().int().nullable(), signal: z.string().nullable() }).strict()
/** 一段有界的原始尾部数据，其位置以整条流的字节坐标表示。 */
export const outputSnapshotSchema = z.object({ tail: z.base64(), totalBytes: z.number().int().nonnegative() }).strict()
/**
 * 按声明的采集预算限制单帧已编码尾部数据及其 RPC 信封的大小。
 * @param maxBytes - 采集器保留的原始字节上限。
 * @returns 私有快照帧的上限，并受 helper 协议天花板约束。
 */
export function outputSnapshotFrameLimit(maxBytes: number): number {
  return Math.min(64 * 1024 * 1024, maxBytes * 2 + 1024)
}
/** 直接退出结果、保留的输出快照，以及可选的完整溢出位置。 */
export const doneSchema = z.object({
  outcome: outcomeSchema,
  spills: z.object({ stdout: remotePath.optional(), stderr: remotePath.optional() }).strict(),
  collected: z.object({
    stdout: outputSnapshotSchema.optional(),
    stderr: outputSnapshotSchema.optional(),
  }).strict(),
}).strict()
/** 远端终端的前台观察结果。 */
export const foregroundSchema = z.object({ processGroupId: z.number().int().positive(), inputWaiting: z.boolean() }).strict().nullable()
/** 由执行 provider 返回的、保守的 shell 生命周期与进程观察结果。 */
export const terminalActivitySchema = z.object({ state: z.enum(['idle', 'busy', 'unknown']), revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict()
