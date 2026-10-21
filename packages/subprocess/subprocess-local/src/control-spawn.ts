/** 在父进程侧为一个被显式请求的继承式控制管道做设置。 */

import { SUBPROCESS_CONTROL_ENV, SUBPROCESS_CONTROL_FD } from '@deepseek-ai/dsh-subprocess/control'
import type { Duplex, Readable, Writable } from 'node:stream'

/**
 * 从 Node 的 stdio 元组中读取可选的额外管道。
 * @param child - 由其分配了所请求额外管道的子进程。
 * @param control - 请求的传输方式，缺省时为 undefined。
 * @returns 父进程的双工端点；当未被请求或原生启动失败时缺失。
 */
export function controlPipe(
  child: { readonly stdio: ReadonlyArray<Readable | Writable | null | undefined> },
  control?: 'pipe',
): Duplex | undefined {
  // Node's type declaration names only the first five descriptor slots.
  const streams: ReadonlyArray<Readable | Writable | null | undefined> = child.stdio
  return control === 'pipe' ? streams[SUBPROCESS_CONTROL_FD] as Duplex | undefined : undefined
}

/**
 * 在拒绝调用方覆盖之后，于一份全新的子进程环境上加盖私有标记。
 * @param env - 新建并物化的、由调用方拥有的子进程环境。
 * @param control - 请求的控制传输方式，缺省时为 undefined。
 * @returns 当被请求时，附加了提供方拥有的启动标记的同一份环境。
 */
export function controlEnvironment<T extends NodeJS.ProcessEnv>(env: T, control?: 'pipe'): T {
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === SUBPROCESS_CONTROL_ENV && value !== undefined) {
      throw new Error(`${SUBPROCESS_CONTROL_ENV} is reserved for subprocess control-channel setup`)
    }
  }
  if (control === 'pipe') Object.assign(env, { [SUBPROCESS_CONTROL_ENV]: 'pipe' })
  return env
}
