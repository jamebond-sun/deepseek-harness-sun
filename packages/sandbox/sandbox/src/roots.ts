/**
 * 所有把模式表达为规范化允许列表的强制方言，都共用这里的可写根推导：
 * `workspace-write` 的含义是"工作区根目录加上平台临时区"，而本模块就是
 * 这一含义的唯一归属。Seatbelt 配置文件（`@deepseek-ai/dsh-sandbox-local`）
 * 与进程内文件系统围栏（`@deepseek-ai/dsh-fs-sandbox`）都从这里派生各自的
 * 允许列表，因此两者之间不会出现"写工具不能写 /tmp 而 bash 可以"这类不对齐。
 * bwrap 与 Landlock 方言保留各自的授予写法（一次性的 `/tmp` 挂载、
 * 由启动器持有的标志位）——这是沙箱 RFC 中记录的、各运行器之间真实存在的
 * 差异，其一致性由测试锁定。
 *
 * @module dsh-sandbox/roots
 */

import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { SandboxExecutionPolicy } from './index.ts'

/**
 * 把一个已授予的根解析成强制层真正用于比较的路径：规范化形式（符号链接
 * 已解析），因为 Seatbelt 过滤器与 fs 围栏的包含性检查匹配的都是解析后的
 * 路径——在 darwin 上 `/tmp` 就是 `/private/tmp`，按原样拼写的授予将匹配
 * 不到任何东西。
 * @param path - 配置给定或平台上报的根。
 * @returns 规范化路径；解析失败时原样返回该拼写（一个尚不存在的根在它
 *   出现之前匹配不到任何东西——这是保守的结果；凭空造一个回退值会授予
 *   调用方从未指明的路径）。
 */
export function canonicalPath(path: string): string {
  try {
    // 在某些平台上，Node 的 JavaScript 版 realpath 会先按词法折叠 `..`，
    // 再去解析位于其之前的符号链接。原生实现则遵循文件系统逐分量查找的
    // 顺序，与 chdir/spawn 以及本标识所供给的强制层保持一致。
    return realpathSync.native(path)
  } catch {
    // realpathSync.native 失败：该路径（或其某个前缀）不存在或不可读。
    return path
  }
}

/**
 * 一次受限执行允许写入的根——即该模式作为一份规范化、已去重的允许列表的
 * 含义。`read-only` 不授予任何根；`workspace-write` 授予策略中的工作区根、
 * 宿主机 `/tmp`，以及按用户划分的平台临时目录（`os.tmpdir()`——mkstemp
 * 系列工具真正的临时区；漏掉它就会否决该模式所承诺的能力）。
 * @param policy - 用于派生允许列表的文件效应策略。
 * @returns 规范化的可写根；仅在 `read-only` 下为空。
 */
export function writableRoots(policy: SandboxExecutionPolicy): string[] {
  if (policy.mode !== 'workspace-write') return []
  return [...new Set([policy.workspaceRoot, '/tmp', tmpdir()].map(canonicalPath))]
}
