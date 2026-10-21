/** 托管执行结束之后，对原始进程输出做有界排空。 */
import type { Readable } from 'node:stream'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'

/**
 * 等待已排队的字节，同时不让某个继承来的描述符把一次运行永久拖住。
 * @param stream - 调用方持有的原始进程输出，若提供的话。
 * @param graceMs - 托管进程终止之后的最长等待时间。
 * @returns 该完整流是否在没有传输错误的情况下结束。
 */
export function drainOutput(stream: Readable | undefined, graceMs: number): Promise<boolean> {
  if (stream === undefined || stream.readableEnded) return Promise.resolve(true)
  if (stream.destroyed) return Promise.resolve(false)
  return new Promise((resolve) => {
    const finish = (complete: boolean): void => {
      clearTimeout(timer)
      stream.off('end', onEnd)
      stream.off('close', onClose)
      stream.off('error', onError)
      resolve(complete)
    }
    const onEnd = (): void => { finish(true) }
    const onClose = (): void => { finish(false) }
    const onError = (): void => { finish(false) }
    const timer = setTimeout(() => { finish(false) }, graceMs)
    stream.once('end', onEnd)
    stream.once('close', onClose)
    stream.once('error', onError)
  })
}

/**
 * 终止一个托管进程并排空它的管道，包括输出监听器挂上之前就发生的失败。
 * @param handle - 运行时持有的进程与流。
 * @param graceMs - 托管进程退出之后排空管道的最长等待时间。
 * @returns 两个输出流是否都干净地结束。
 */
export async function terminateProcess(handle: SubprocessHandle, graceMs: number): Promise<boolean> {
  try {
    handle.terminate()
    handle.stdout?.resume()
    handle.stderr?.resume()
    await Promise.all([handle.done.catch(() => {}), handle.waitForExit()])
    const drained = await Promise.all([drainOutput(handle.stdout, graceMs), drainOutput(handle.stderr, graceMs)])
    return !drained.includes(false)
  } finally {
    handle.stdout?.destroy()
    handle.stderr?.destroy()
  }
}
