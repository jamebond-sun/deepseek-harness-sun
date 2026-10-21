/** 子进程启动器与 Node 子进程共享的继承式字节通道协议。 */

import { Socket } from 'node:net'
import type { Duplex } from 'node:stream'

/** 为可选的 subprocess 控制通道保留的子进程描述符。 */
export const SUBPROCESS_CONTROL_FD = 7

/** 在 Node 子进程执行应用代码之前消费的私有启动标记。 */
export const SUBPROCESS_CONTROL_ENV = 'DSH_SUBPROCESS_CONTROL' as const

/**
 * 消费启动标记，并在 fd 7 处打开继承的控制管道。
 * 返回的流拥有该描述符。在执行不可信代码之前调用一次；
 * 即便端点是继承而来，其中的消息仍属不可信。
 * @returns 由调用方拥有的已连接字节模式双工流。
 * @throws 当标记缺失/无效，或继承的描述符无法打开时。
 */
export function openInheritedControlChannel(): Duplex {
  const marker = process.env[SUBPROCESS_CONTROL_ENV]
  Reflect.deleteProperty(process.env, SUBPROCESS_CONTROL_ENV)
  if (marker !== 'pipe') throw new Error('subprocess control channel was not inherited')
  return new Socket({ fd: SUBPROCESS_CONTROL_FD, readable: true, writable: true, allowHalfOpen: true })
}
