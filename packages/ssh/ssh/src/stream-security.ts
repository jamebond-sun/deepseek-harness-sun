/** TLS-PSK 为转发的流提供认证，即便远端路径名被替换也不会失效。 */
import { connect, type ConnectionOptions, type TLSSocket } from 'node:tls'
import type { Socket } from 'node:net'

/** 无需证书的 PSK 认证与 AEAD 记录；不存在未认证的密码套件回退。 */
export const SSH_STREAM_TLS_OPTIONS = {
  ciphers: 'PSK-AES256-GCM-SHA384', minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2',
} as const satisfies ConnectionOptions

/**
 * 使用私有的管理通道密钥认证一个已转发的 socket。
 * @param socket - 已连接的 OpenSSH 转发 socket。
 * @param capability - 每条流独有的 256 位密钥，以十六进制编码。
 * @param timeoutMs - 完成 TLS 认证的截止时间。
 * @param signal - 用于取消认证过程以及由此得到的 TLS 流。
 * @returns 一条已认证且处于暂停状态的流；密钥从不作为数据传输。
 */
export async function authenticateStream(socket: Socket, capability: string, timeoutMs: number, signal?: AbortSignal): Promise<TLSSocket> {
  if (signal?.aborted) { socket.destroy(); signal.throwIfAborted() }
  const stream = connect({
    ...SSH_STREAM_TLS_OPTIONS, socket, rejectUnauthorized: true,
    pskCallback: () => ({ psk: Buffer.from(capability, 'hex'), identity: 'dsh-stream' }),
    // PSK 无需 X.509 证书或主机名即可证明对端身份。
    checkServerIdentity: () => undefined,
  })
  const abort = (): void => { stream.destroy(signal?.reason instanceof Error ? signal.reason : new Error(String(signal?.reason))) }
  signal?.addEventListener('abort', abort, { once: true })
  stream.once('close', () => { signal?.removeEventListener('abort', abort) })
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        stream.off('secureConnect', secured)
        stream.off('error', failed)
        stream.off('close', closed)
        clearTimeout(timer)
      }
      const secured = (): void => { cleanup(); stream.disableRenegotiation(); stream.pause(); resolve() }
      const failed = (error: Error): void => { cleanup(); reject(error) }
      const closed = (): void => { failed(new Error('SSH stream closed during authentication')) }
      const timer = setTimeout(() => { failed(new Error('SSH stream authentication timed out')) }, timeoutMs)
      stream.once('secureConnect', secured)
      stream.once('error', failed)
      stream.once('close', closed)
    })
    return stream
  } catch (error) { stream.destroy(); throw error }
}
