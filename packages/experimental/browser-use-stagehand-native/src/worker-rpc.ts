/** 一次性的 MessagePort 承载浏览器操作及其结果。 */

import { MessageChannel, MessagePort } from 'node:worker_threads'
import type { Worker } from 'node:worker_threads'
import { z } from 'zod'

const responseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: z.unknown() }).strict(),
  z.object({ ok: z.literal(false), error: z.string() }).strict(),
])

/** 与一份经过校验的操作载荷配对的、可转移的应答通道。 */
export const requestSchema = z.object({
  method: z.string(),
  args: z.unknown(),
  reply: z.instanceof(MessagePort),
}).strict()

/**
 * 发送一个请求，并在应答或对端关闭之后释放其应答端口。
 * @param target - 所属的 Worker 或父级端口。
 * @param method - 接收方所理解的操作。
 * @param args - 可结构化克隆的请求数据。
 * @param signal - 所属 Worker 的生命周期，当由调用方观察时。
 * @returns 接收方的值，会拒绝格式错误的应答与对端关闭。
 */
export async function request(target: MessagePort | Worker, method: string, args?: unknown, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted()
  const { port1, port2 } = new MessageChannel()
  const result = Promise.withResolvers<unknown>()
  const abort = () => {
    result.reject(signal?.reason instanceof Error ? signal.reason : new Error('Stagehand Worker request canceled'))
  }
  try {
    signal?.addEventListener('abort', abort, { once: true })
    port1.once('message', (raw: unknown) => {
      const response = responseSchema.safeParse(raw)
      if (!response.success) result.reject(response.error)
      else if (response.data.ok) result.resolve(response.data.value)
      else result.reject(new Error(response.data.error))
    })
    port1.once('messageerror', result.reject)
    port1.once('close', () => { result.reject(new Error('Stagehand Worker reply channel closed')) })
    try {
      target.postMessage({ method, args, reply: port2 }, [port2])
    } catch (error) {
      result.reject(error)
    }
    return await result.promise
  } finally {
    signal?.removeEventListener('abort', abort)
    port1.close()
    port2.close()
  }
}

/**
 * 校验并应答一个请求，且不留下未被观察的、被拒绝的回调。
 * @param raw - 从 Worker 边界收到的、不可信的消息。
 * @param execute - 校验并执行方法参数的所有者。
 * @returns 在应答已发出且应答端口已释放之后。
 */
export async function answer(raw: unknown, execute: (method: string, args: unknown) => Promise<unknown>): Promise<void> {
  const { method, args, reply } = requestSchema.parse(raw)
  try {
    reply.postMessage({ ok: true, value: await execute(method, args) })
  } catch (error) {
    reply.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) })
  } finally {
    reply.close()
  }
}
