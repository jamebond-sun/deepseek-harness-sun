/**
 * Win32 对话框驱动的真实进程部分：派生对话框子进程（源码面或产物面），并关闭某个对话框
 * 线程的窗口。本模块自身在所有平台都会加载（从 native-picker.ts 起的导入链是静态的）；
 * 只有 koffi 保持仅 win32 使用，它在 bindings 的函数内部动态导入。驱动的逻辑改为针对
 * 本接口的替身进行测试。
 */

import { spawn, type StdioOptions } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { Win32DialogWorkerData } from './win32-dialog-worker.ts'

/**
 * 派生对话框子进程。构建产物形态的消费方用普通 node 启动本模块旁边打包好的 CJS 入口；
 * 未构建（源码）形态的消费方先引导 tsx，与 dsh CLI 的源码启动方式一致。子进程自行将其
 * 对话框作为前台打开：`runFolderDialog` 在 `Show` 之前合成一次 Alt 按下，这在后台宿主
 * 派生子进程时至关重要。
 * @param data - 传给子进程的数据（对话框标题）。
 * @returns 派生出的子进程。
 */
export function spawnDialogWorker(data: Win32DialogWorkerData): ReturnType<typeof spawn> {
  const env = { ...process.env, DSH_DIALOG_TITLE: data.title }
  const stdio: StdioOptions = ['ignore', 'inherit', 'inherit', 'ipc']
  /* v8 ignore next 3 -- 构建产物分支：测试始终在未构建形态（src/）下运行 */
  if (!import.meta.url.endsWith('.ts')) {
    return spawn(process.execPath, [fileURLToPath(new URL('./worker.cjs', import.meta.url))], { env, stdio, windowsHide: true })
  }
  return spawn(process.execPath, ['--import', import.meta.resolve('tsx/esm'), fileURLToPath(new URL('./win32-dialog-worker.ts', import.meta.url))], { env, stdio, windowsHide: true })
}

export { closeThreadWindows } from './win32-dialog-bindings.ts'
