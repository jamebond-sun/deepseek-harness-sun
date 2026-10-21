/**
 * 按工作区划分的写入身份：由规范化工作区路径确定性派生出的一个 `S-1-4-x-y`
 * SID，其 ACE 构成该工作区的写入允许列表。同一工作区的每一次受限执行——
 * 跨会话、跨服务器重启、跨调用——都携带同一个写入 SID，因此工作区根目录的
 * ACE 按机器、按工作区只物化一次（授予的精确 ACE 跳过使得此后每次供应都是
 * O(1)），而不是按会话物化一次。该 SID 的权力完全由点名它的那些 ACE 定义
 * （它们只存在于工作区目录树与该会话的私有临时目录上），且只有为该工作区
 * 铸造的令牌才携带它——SID 字符串本身并不是秘密。临时目录使用来自
 * {@link tempWriteSid} 的、按目录划分的另一套身份；若与临时目录共享工作区
 * 身份，兄弟会话就能写入彼此的临时目录树。
 *
 * 输入必须是规范化的工作区路径（在 Windows 上即 `realpathSync.native`——
 * sandbox-policy 的 `resolveWorkspaceRoot` 已经应用了它）：规范化会让大小写
 * 与别名的不同拼写收敛，因此同一工作区的两种拼写派生出同一个 SID；而一个
 * 按原样拼写的回退路径会为同一个目录铸造出第二个身份（可自愈，代价是多
 * 一次整棵树的传播）。重命名工作区目录会派生出新的 SID——旧的常驻 ACE 成为
 * 惰性残留，下一个会话会重新传播一次。
 * @module @deepseek-ai/dsh-sandbox-windows-acl/workspace-sid
 */

import { createHash } from 'node:crypto'

/**
 * 派生工作区的写入 SID（`S-1-4-x-y`；子授权机构为 30 位，与令牌层和 ACE
 * 层所承载的工作区能力形状一致）。
 * @param workspaceRoot - 规范化的工作区路径。
 * @returns SDDL 字符串形式。
 */
export function workspaceWriteSid(workspaceRoot: string): string {
  const digest = createHash('sha256').update(workspaceRoot, 'utf8').digest()
  const first = (digest.readUInt32LE(0) % (2 ** 30 - 1)) + 1
  const second = (digest.readUInt32LE(4) % (2 ** 30 - 1)) + 1
  return `S-1-4-${first}-${second}`
}

/**
 * 派生某一个私有临时目录的写入 SID。随机的目录路径即能力身份；固定的第三个
 * 子授权机构把结果与所有只有两个子授权机构的工作区 SID 做了域分隔。
 * @param tempDir - 该私有临时目录的绝对路径。
 * @returns SDDL 字符串形式。
 */
export function tempWriteSid(tempDir: string): string {
  const digest = createHash('sha256').update('temp\0', 'utf8').update(tempDir, 'utf8').digest()
  const first = (digest.readUInt32LE(0) % (2 ** 30 - 1)) + 1
  const second = (digest.readUInt32LE(4) % (2 ** 30 - 1)) + 1
  return `S-1-4-${first}-${second}-1`
}
