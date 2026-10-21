/**
 * Win32 文件夹对话框的主线程驱动：派生对话框子进程（它阻塞在模态 `Show` 内部），把其
 * 消息协议映射为一个 promise，并通过向对话框线程的窗口投递 `WM_CLOSE` 来响应中止，
 * 直到子进程回报结果。真实的进程/窗口接口可注入，因此驱动的各条路径都能在任意平台上
 * 测试。
 */

import { closeThreadWindows as hostCloseThreadWindows, spawnDialogWorker } from './win32-dialog-host.ts'
import type { Win32DialogWorkerData, Win32DialogWorkerMessage } from './win32-dialog-worker.ts'

/** 驱动所操控的子进程接口（由 `node:child_process` 满足）。 */
export interface Win32DialogWorkerLike {
  /**
   * 订阅子进程事件。
   * @param event - `message`、`error` 或 `exit`。
   * @param listener - 事件消费方。
   */
  on(event: 'message', listener: (message: Win32DialogWorkerMessage) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  /**
   * 强制停止子进程；当 `WM_CLOSE` 始终没有送达时（例如对话框窗口从未创建），这是 abort
   * 路径的最后手段。
   * @returns 是否投递了终止信号。
   */
  kill(): boolean
  /**
   * 释放事件循环引用。选择结束后调用一次，使卡在原生模态调用中的子进程永远不会阻塞
   * 进程退出。
   */
  unref?(): void
}

/** 为确定性驱动测试注入的进程接口。 */
export interface Win32DialogInternals {
  /** 替换真实的子进程派生（`win32-dialog-host.ts`）。 */
  spawnWorker?: (data: Win32DialogWorkerData) => Win32DialogWorkerLike
  /** 替换真实的 `WM_CLOSE` 投递器（`win32-dialog-host.ts`）。 */
  closeThreadWindows?: (threadId: number) => Promise<void>
  /** 中止服务节奏的覆盖开关，使测试无需等待真实时钟时间。 */
  closeRetryMs?: number
}

/** 每个宿主都显示的对话框标题。 */
export const DIALOG_TITLE = 'Select Workspace Directory'

/** 中止等待 worker 退出期间重新投递 `WM_CLOSE` 的节奏。 */
const CLOSE_RETRY_MS = 150
/** 强制终止 worker 之前的中止服务尝试次数。 */
const CLOSE_MAX_ATTEMPTS = 20

/** 若已封闭的 worker→driver 联合类型新增了未处理的成员，则大声失败。 */
/* v8 ignore start -- 封闭联合类型的兜底；在不违反 TypeScript 契约的前提下不可达 */
function assertNever(value: never): never {
  throw new TypeError(`unknown win32 dialog worker message kind: ${String(value)}`)
}
/* v8 ignore stop */

/**
 * 在事件循环之外打开现代 Win32 文件夹选择器。
 * @param signal - 调用方生命周期；中止会关闭对话框并拒绝。
 * @param internals - 供确定性测试注入的 worker/窗口钩子。
 * @returns 所选路径；用户取消时为 null。
 */
export async function pickWin32Directory(
  signal: AbortSignal,
  internals: Win32DialogInternals = {},
): Promise<string | null> {
  if (signal.aborted) throw new Error('native directory picker aborted')
  const spawnWorker = internals.spawnWorker ?? spawnDialogWorker
  const closeWindows = internals.closeThreadWindows ?? hostCloseThreadWindows
  const closeRetryMs = internals.closeRetryMs ?? CLOSE_RETRY_MS

  const worker: Win32DialogWorkerLike = spawnWorker({ title: DIALOG_TITLE })
  let dialogThreadId: number | undefined
  let closeTimer: NodeJS.Timeout | undefined
  let settled = false

  return await new Promise<string | null>((resolve, reject) => {
    const settle = (outcome: () => void): void => {
      if (settled) return
      settled = true
      if (closeTimer !== undefined) clearInterval(closeTimer)
      signal.removeEventListener('abort', onAbort)
      worker.unref?.()
      outcome()
    }

    const postClose = (): void => {
      // 在 `showing` 之前没有可关闭的窗口；下面的预算照常运行，这样从不回报的子进程
      // 也无法让本次选择悬空。被拒绝的关闭尝试（EnumThreadWindows/PostMessageW 失败）
      // 直接丢弃：定时器会重试，kill 是兜底手段。
      if (dialogThreadId !== undefined) void closeWindows(dialogThreadId).catch(() => undefined)
    }

    // 唯一调用方：只注册一次的 abort 监听器，因此无需重入保护。
    const serviceAbort = (): void => {
      let attempts = 0
      // `showing` 通知先于阻塞的 `Show`，因此第一次 WM_CLOSE 可能与窗口创建竞争；持续
      // 重新投递直到子进程回报，最后再强制 kill。预算是无条件的——在 `showing` 之前的
      // 中止（子进程卡在 koffi 或 COM 初始化中）同样以 kill 收场，而不是留下一个悬空的
      // promise。
      closeTimer = setInterval(() => {
        attempts += 1
        if (attempts > CLOSE_MAX_ATTEMPTS) {
          settle(() => {
            worker.kill()
            reject(new Error('native directory picker aborted (dialog unresponsive; worker killed)'))
          })
          return
        }
        postClose()
      }, closeRetryMs)
      postClose()
    }

    const onAbort = (): void => {
      serviceAbort()
    }
    signal.addEventListener('abort', onAbort, { once: true })

    worker.on('message', (message: Win32DialogWorkerMessage) => {
      switch (message.kind) {
        case 'showing':
          dialogThreadId = message.threadId
          // 早于该通知发生的中止现在有了可以命中的窗口。
          if (signal.aborted) postClose()
          return
        case 'done':
          settle(() => {
            if (signal.aborted) reject(new Error('native directory picker aborted'))
            else resolve(message.path)
          })
          return
        case 'error':
          settle(() => {
            reject(new Error(`win32 folder dialog failed: ${message.message}`))
          })
          return
        /* v8 ignore next 2 -- worker 自有的封闭联合类型；出现第四种 kind 会导致编译错误 */
        default:
          assertNever(message)
      }
    })
    worker.on('error', (error: Error) => {
      settle(() => {
        reject(error)
      })
    })
    worker.on('exit', () => {
      settle(() => {
        reject(new Error('win32 folder dialog worker exited before reporting a result'))
      })
    })
  })
}
