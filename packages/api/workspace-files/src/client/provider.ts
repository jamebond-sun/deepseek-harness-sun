/**
 * `file` protocol 的提供方：以 `RemoteResult` 帧流的形式给出
 * workspace 文件的元数据。
 *
 * 地址在两种 scope 之一中命名文件。`session` 地址
 * `dsh-resource://file/session/<sessionId>/<path>` 携带绝对路径或相对该
 * Session workspace 根的路径：Host 原样接收路径，并以它持有的根解析。
 * 只有 Host 的 `stat.absolutePath` 决定变更流键；不需要 Client Session 摘要。
 * `absolute` 地址 `dsh-resource://file/absolute/<path>` 不携带 Session，
 * 无法授权 Host 调用。两种 scope 都无法解析的地址产生一个失败帧——
 * 语法之外的字符串为 `workspace-file/unsupported-address`，
 * 地址不携带 Session 时为 `workspace-file/unknown-workspace`——随后结束。
 *
 * 第一帧是文件的 `stat`；后续失效会再次执行 `stat`，除非其版本或
 * 缺席已可知。重连时也会重新 stat。失败以 `ok: false` 帧传递，从不以
 * 抛错传递：Remote 接口面不会 reject，流内抛出的任何内容都是资源模型
 * 允许暴露的编程错误。一次失败的 stat 不会结束流：下一次写入会再次
 * stat。一个 {@link ChangeFeed} 服务 Client 的每个打开文件。
 */
import type { ResourceProvider } from '@deepseek-ai/dsh-client-resources/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { parseFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import type { WorkspaceFileStat } from '../types.ts'
import type { ChangeFeed } from './change-feed.ts'
import type { WorkspaceFilesRemote } from './remote.ts'

/** 提交给 Host 的 Session 与未修改的路径。 */
interface HostFile {
  readonly sessionId: SessionId
  /** Host 收到的路径：绝对或 workspace 相对。 */
  readonly path: string
}

/**
 * 在一个 Remote 接口面与一个变更流之上构建 `file` 提供方。
 * @param remote - 携带 `workspaceFiles.stat` 的 Remote 接口面。
 * @param changes - 由文件资源共享的目标范围变更流。
 * @returns 注册进 `ctx.resources` 的提供方。
 */
export function createFileResourceProvider(
  remote: WorkspaceFilesRemote,
  changes: ChangeFeed,
): ResourceProvider<'file'> {
  return {
    protocol: 'file',
    async *open(address, { signal }): AsyncIterable<RemoteResult<WorkspaceFileStat>> {
      const resolved = resolve(address)
      if (!resolved.ok) {
        yield resolved
        return
      }
      const { sessionId, path } = resolved.value
      // stat 等待期间，将送达本 Client 的变更排队。
      const notices = changes.follow(sessionId, path, signal)
      const stat = (): Promise<RemoteResult<WorkspaceFileStat>> => remote.workspaceFiles.stat(sessionId, path, signal)
      // 通过函数调用读取：裸的 `signal.aborted` 会被首次检查收窄为
      // `false`，在后续 await 之后将恒读为 false。
      const aborted = (): boolean => signal.aborted
      // 上一次 stat 失败时为 undefined：follow 关注的是地址而非文件，
      // 因此一次写入仍能让文件复活。
      let current: WorkspaceFileStat | undefined
      try {
        if (!await notices.ready) {
          if (aborted()) return
          const result = await stat()
          if (!aborted()) yield result
          return
        }
        if (aborted()) return
        const first = await stat()
        if (aborted()) return
        if (first.ok) {
          notices.bind(first.value.absolutePath)
          current = first.value
          yield { ok: true, value: current }
        } else {
          yield first
        }
        for await (const notice of notices) {
          if (aborted()) return
          if (current === undefined) {
            // 仍然不存在：没有新内容可报告。
            if (notice.kind === 'absent') continue
          } else if (notice.kind === 'changed') {
            // 帧报告的是观察：已持有该版本即意味着消费方
            // 学不到新东西。
            if (notice.version === current.version) continue
          }
          // Host 通知可能意味着内容已过时。
          const again = await stat()
          if (aborted()) return
          if (!again.ok) {
            current = undefined
            yield again
            continue
          }
          notices.bind(again.value.absolutePath)
          current = again.value
          yield { ok: true, value: current }
        }
      } finally {
        notices.dispose()
      }
    },
  }
}

/**
 * 将一个地址解析为它所代表的 Host 调用，或它应得的失败帧。
 * @param address - 完整地址，含 scheme。
 * @returns Host 文件，或 `unsupported-address` / `unknown-workspace` 失败。
 */
function resolve(address: string): RemoteResult<HostFile> {
  const parsed = parseFileAddress(address)
  if (parsed === undefined) return { ok: false, error: unsupportedAddress(address) }
  if (parsed.scope === 'session') {
    // 该地址是字符串边界：其 id 段就是它命名的 Session id。
    const sessionId = parsed.sessionId as SessionId
    return { ok: true, value: { sessionId, path: parsed.path } }
  }
  return { ok: false, error: unknownWorkspace(address) }
}

/**
 * 本提供方不服务的地址所对应的失败帧错误。
 * @param address - 违规地址。
 * @returns 类型化错误。
 */
function unsupportedAddress(address: string): RemoteError<'workspace-file/unsupported-address'> {
  return new RemoteError(
    'workspace-file/unsupported-address',
    `${address} is not a dsh-resource://file/session/<sessionId>/<path> or dsh-resource://file/absolute/<path> address`,
    { address },
  )
}

/**
 * 不携带 Session 的 absolute 地址所对应的失败帧错误。
 * @param address - 违规地址。
 * @returns 类型化错误。
 */
function unknownWorkspace(address: string): RemoteError<'workspace-file/unknown-workspace'> {
  return new RemoteError(
    'workspace-file/unknown-workspace',
    `${address} requires a dsh-resource://file/session/<sessionId>/<path> address`,
    { address },
  )
}
