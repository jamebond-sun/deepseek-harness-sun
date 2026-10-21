/**
 * 运行时子进程的私有拆除阶梯：stdin EOF（协作式静默），然后 SIGTERM，再 SIGKILL，
 * 只有在进程真正退出之后才 resolve。SDK 客户端运行在任意 harness context 之外，
 * 因此无法借助 `dsh-subprocess` 服务 —— 本模块是该能力缝针对 SDK 自管传输
 * 所记录的例外。
 *
 * @module @deepseek-ai/dsh-sdk-client/dispose
 */

import type { ChildProcess } from 'node:child_process'

/**
 * 让子进程的退出与一个定时器竞争。两种结果都不会在子进程上留下残留：
 * 超时时移除 exit 监听器，退出时清除定时器，因此阶梯的各层永不累积监听器。
 */
function exitsWithin(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer)
      resolve(true)
    }
    // 调用 `.unref()`，使待定的宽限定时器永不维持父进程的事件循环。
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit)
      resolve(false)
    }, ms).unref()
    child.once('exit', onExit)
  })
}

/** 强制终止运行时；若在宽限期内没有到达退出边沿则 reject。 */
function forceTerminateWithin(child: ChildProcess, ms: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    let accepted = false
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timer)
      child.off('exit', onExit)
      child.off('error', onError)
    }
    const settle = (complete: () => void): void => {
      if (settled) return
      settled = true
      cleanup()
      complete()
    }
    const onExit = (): void => { settle(resolve) }
    const onError = (error: Error): void => { settle(() => { reject(error) }) }
    child.once('exit', onExit)
    child.once('error', onError)
    const timer = setTimeout(() => {
      const disposition = accepted ? 'accepted' : 'refused'
      settle(() => {
        reject(new Error(`runtime process did not exit within ${ms}ms after SIGKILL was ${disposition}`))
      })
    }, ms).unref()
    try {
      accepted = child.kill('SIGKILL')
      if (child.exitCode !== null || child.signalCode !== null) settle(resolve)
    } catch (error: unknown) {
      settle(() => { reject(new Error('SIGKILL failed', { cause: error })) })
    }
  })
}

/**
 * 将运行时拆除至静默，仅在退出之后才 resolve：关闭 stdin 并允许协作式
 * 刷新，然后使用宿主机的优雅与强制终止语义。POSIX 会在 `SIGKILL` 之前
 * 发送 `SIGTERM`；Windows 则直接跳到强制终止，因为 Node 把这两个信号
 * 都映射为 `TerminateProcess`。
 * @param child - 待拆除的运行时子进程。
 * @param graces - EOF 与终止确认窗口（毫秒）。
 * @param platform - 宿主机平台，可注入以便单元测试覆盖。
 * @throws 当强制终止出错，或子进程未在 `disposeGraceMs` 内上报退出时抛出。
 */
export async function disposeRuntimeProcess(
  child: ChildProcess,
  graces: { disposeEofGraceMs: number; disposeGraceMs: number },
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  // 已经退出：无需回收。
  if (child.exitCode !== null || child.signalCode !== null) return
  // 1. 关闭 stdin，允许协作式拆除与持久化状态刷新。
  child.stdin?.end()
  if (await exitsWithin(child, graces.disposeEofGraceMs)) return
  // 2. POSIX 得到一个可捕获的优雅信号；Windows 的信号一律强制终止。
  if (platform !== 'win32') {
    child.kill('SIGTERM')
    if (await exitsWithin(child, graces.disposeGraceMs)) return
  }
  // 3. 强制 kill，并在有界时间内等待退出边沿。
  await forceTerminateWithin(child, graces.disposeGraceMs)
}
