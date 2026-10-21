/** 基于继承来的控制通道的 Node 子进程执行；此处不运行任何 Harness 服务。 */
import type { Duplex } from 'node:stream'
import { JsonChannel } from './channel.ts'
import { runProgram } from './bootstrap.ts'
import { clearProgramEnvironment } from './environment.ts'
import type { PatchableStream } from './bootstrap.ts'
import type { ReplyMessage, ProgramBootData, ProgramToHost } from './protocol.ts'

/** 由子进程 bootstrap 消费的、进程自有的环境与输出流。 */
export interface ProgramProcess {
  env: NodeJS.ProcessEnv
  stdout: PatchableStream
  stderr: PatchableStream
  exitCode: string | number | null | undefined
}

/**
 * 在控制握手之后运行一个宿主提供的程序。
 * @param stream - 继承而来、已被接管的控制端点。
 * @param maxMessageBytes - 宿主已校验的帧与排队写入字节上限。
 * @param processState - 该 Node 子进程的环境、输出流与退出状态。
 * @returns 在控制输出冲刷完毕且观察到宿主关闭之后返回，或因传输失败关闭通道。
 */
export async function runNodeMain(stream: Duplex, maxMessageBytes: number, processState: ProgramProcess): Promise<void> {
  if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes <= 0 || maxMessageBytes > 0xffff_ffff) throw new Error('invalid control message limit')
  clearProgramEnvironment(processState)
  const boot = Promise.withResolvers<ProgramBootData>()
  const listeners: Array<(message: ReplyMessage) => void> = []
  let started = false
  let failed = false
  let terminalSent = false
  const hostClosed = Promise.withResolvers<void>()
  const onClose = (): void => { hostClosed.resolve() }
  stream.once('close', onClose)
  const channel = new JsonChannel(stream, maxMessageBytes, (raw) => {
    if (!started) {
      started = true
      if (typeof raw !== 'object' || raw === null || (raw as { type?: unknown }).type !== 'boot') {
        boot.reject(new Error('expected program boot frame'))
        return
      }
      boot.resolve((raw as { data: ProgramBootData }).data)
      return
    }
    if (terminalSent) return
    for (const listener of listeners) listener(raw as ReplyMessage)
  }, (error, kind) => {
    if (!terminalSent || kind === 'protocol') {
      failed = true
      boot.reject(error)
      channel.close()
      processState.exitCode = 1
    }
    hostClosed.resolve()
  })
  const pending = new Set<Promise<void>>()
  const send = (message: ProgramToHost): void => {
    if (terminalSent) return
    if (message.type === 'done') terminalSent = true
    const task = channel.send(message).catch(() => {
      failed = true
      channel.close()
      processState.exitCode = 1
      hostClosed.resolve()
    }).finally(() => { pending.delete(task) })
    pending.add(task)
  }
  try {
    await channel.send({ type: 'ready' })
    const data = await boot.promise
    await runProgram({
      postMessage: send,
      on: (_event, listener) => { listeners.push(listener) },
    }, data, { stdout: processState.stdout, stderr: processState.stderr })
    while (pending.size > 0) await Promise.all(pending)
    await channel.drain()
    // 宿主绑定回复可能与终结帧竞速；通道关闭由宿主负责。
    await hostClosed.promise
  } finally {
    stream.off('close', onClose)
    channel.close()
    // 传输回调可能在被 await 的程序执行期间把 failed 置位。
    // oxlint-disable-next-line typescript/no-unnecessary-condition
    if (failed) processState.exitCode = 1
  }
}
