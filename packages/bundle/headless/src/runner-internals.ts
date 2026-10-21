/**
 * runner 读写的进程流，放在包入口之外，以便测试替换它们时不会增加任何公开包 API。
 * 其形状在结构上与 runner 自身的 IO 载体一致。
 * @module @deepseek-ai/dsh-headless/runner-internals
 */

/** runner 读写的进程流；测试会替换为捕获实现。 */
export const internals: {
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
  readStdin: () => Promise<string>
} = {
  stdout: process.stdout,
  stderr: process.stderr,
  readStdin: async () => {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin as AsyncIterable<Buffer>) chunks.push(chunk)
    return Buffer.concat(chunks).toString('utf8')
  },
}
