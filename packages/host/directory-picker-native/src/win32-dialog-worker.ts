/**
 * Win32 文件夹对话框的子进程入口：让本进程阻塞在模态 `Show` 内部，从而使宿主事件循环
 * 保持活跃，并通过 IPC 通道上报结果。以子进程（而非 worker 线程）方式派生，这样原生故障
 * 被隔离在本地，模态调用也不会卡死宿主。后台宿主（Web GUI 服务器）会使本进程不具备前台
 * 权限，因此 `runFolderDialog` 在 `Show` 之前立即合成一次 Alt 按下，对话框随后即可作为
 * 前台激活。协议：在阻塞调用之前发送 `{kind:'showing',threadId}`（驱动的 abort 手段需要
 * 原生线程 id），随后恰好发送 `{kind:'done',path}` 或 `{kind:'error',message}` 之一。
 */

import { loadWin32DialogBindings } from './win32-dialog-bindings.ts'
import { runFolderDialog } from './win32-dialog-logic.ts'

/** 驱动传给子进程的数据：对话框标题（经由环境变量传递）。 */
export interface Win32DialogWorkerData { title: string }

/** 回传给驱动的一条通知或结果。 */
export type Win32DialogWorkerMessage =
  | { kind: 'showing'; threadId: number }
  | { kind: 'done'; path: string | null }
  | { kind: 'error'; message: string }

const title = process.env.DSH_DIALOG_TITLE ?? ''
if (title === '') throw new Error('win32-dialog-worker: DSH_DIALOG_TITLE is required')
if (process.send === undefined) throw new Error('win32-dialog-worker must run as a child process with an IPC channel')
// node 内部的 `send` 会读取 `this.connected`，因此需要绑定接收者。
const send = process.send.bind(process)

const post = (message: Win32DialogWorkerMessage): void => {
  // 在关闭通道前冲刷；事件循环排空后进程即退出。
  /* v8 ignore next 3 -- disconnect 需要一条活跃的 IPC 通道，单元测试通道不应切断（built-worker.e2e.ts 负责真实的关闭路径）。 */
  send(message, () => { if (process.connected) process.disconnect() })
}

// 已结束的驱动（或已死亡的父进程）不得留下仍然显示在屏幕上的对话框。
/* v8 ignore next 3 -- 该处理器会 exit(0)，从而终止单元测试进程；built-worker.e2e.ts 负责真实的断开生命周期。 */
process.on('disconnect', () => process.exit(0))

// 不使用顶层 await：构建出的 worker 以 CJS 形式发布，CJS 无法承载 TLA。
void (async () => {
  try {
    const bindings = await loadWin32DialogBindings()
    const path = runFolderDialog(bindings, title, (threadId) => {
      post({ kind: 'showing', threadId } satisfies Win32DialogWorkerMessage)
    })
    post({ kind: 'done', path } satisfies Win32DialogWorkerMessage)
  } catch (error: unknown) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
    post({ kind: 'error', message } satisfies Win32DialogWorkerMessage)
  }
})()
