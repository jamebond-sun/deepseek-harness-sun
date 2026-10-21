/**
 * 工作区指令去重抑制所用的内容标识。
 *
 * @module @deepseek-ai/dsh-agent-instructions/digest
 */

import { createHash } from 'node:crypto'

/**
 * 计算指令加载与会话状态所共用的内容标识。
 * @param content - 精确的 UTF-8 指令文本。
 * @returns 十六进制形式的小写 SHA-1 摘要。
 */
export function instructionContentSha1(content: string): string {
  return createHash('sha1').update(content).digest('hex')
}

/**
 * 计算用于按目录去重抑制的、对空白不敏感的内容标识。
 * 在哈希之前会先裁剪首尾空白，因此仅围绕空白不同、
 * 但通过符号链接或字节复制得到的兄弟文件仍会折叠为单个渲染文件。
 * @param content - 精确的 UTF-8 指令文本。
 * @returns 裁剪后内容的 SHA-1 摘要。
 */
export function trimmedInstructionDigest(content: string): string {
  return instructionContentSha1(content.trim())
}
