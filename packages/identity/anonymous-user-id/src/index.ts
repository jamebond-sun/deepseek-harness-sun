/**
 * 遥测与反馈共用的、按 harness home 划分的匿名用户 id。
 *
 * 该 id 是一个随机 UUID，以纯文本行的形式持久化在由 {@link resolveDshHome} 解析出的
 * harness home 内的 `.anonymous-user-id` 文件中（`$DSH_HOME` > `~/.dsh`），
 * 且从不由主机名、网络地址、git remote 或任何其他可识别来源派生。它的作用域是
 * harness home 而非机器：共享同一个 `$DSH_HOME` 的每个进程上报同一个 id，
 * 删除该文件后，下次启动会铸造一个全新的身份。
 *
 * 读写均为同步，因此启动期与命令类使用方可以共用一套 API。结果按解析后的文件路径
 * 记忆化：一个进程只访问磁盘一次；运行中途被删除的文件不会改变该进程的 id，
 * 一直保持到下次启动。
 *
 * @module @deepseek-ai/dsh-anonymous-user-id
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** 作用域为 harness home 的匿名用户 id（随机 UUID v4）。 */
export type AnonymousUserId = Branded<'AnonymousUserId'>

/** harness home 内存放该 id 的文件：一个纯 UUID 行，没有包装格式。 */
export const ANONYMOUS_USER_ID_FILE_NAME = '.anonymous-user-id'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 用于定位与生成该 id 的环境钩子；每个字段都有默认值。 */
export interface AnonymousUserIdOptions {
  /** 供查询 `DSH_HOME` 使用的环境；默认取 `process.env`。 */
  env?: NodeJS.ProcessEnv
  /** UUID 生成器；默认使用 `crypto.randomUUID`（测试钩子）。 */
  randomUUID?: () => string
}

/** 以解析后的文件路径为键的进程级记忆表，因此不同的测试 home 永远不会共享同一个 id。 */
const memo = new Map<string, AnonymousUserId>()

/** 从文件中读取一个有效的已持久化 id；文件缺失或损坏时返回 `undefined`。 */
function readPersistedId(file: string): AnonymousUserId | undefined {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    // 文件缺失或不可读：由调用方铸造并持久化一个全新的 id。
    return undefined
  }
  const value = text.trim()
  return UUID_PATTERN.test(value) ? (value as AnonymousUserId) : undefined
}

/**
 * 返回该 harness home 的匿名用户 id，首次使用时创建并持久化一个。
 * 并发的首次启动由独占创建式写入来定夺：失败方重新读取获胜方的 id。
 * （若重读恰好落在获胜方从创建到写入完成的狭窄窗口内，该次运行仍可能出现两个
 * 进程内 id；下次启动会收敛到已持久化的那个。）持久化是尽力而为的 —— 写入失败
 * （home 只读）仍会为本次运行返回一个可用的 id，因此反馈与遥测永远不会被阻塞。
 * @param options - home 定位与 UUID 生成的接缝。
 * @returns 该 harness home 下稳定的匿名用户 id。
 */
export function getOrCreateAnonymousUserId(options: AnonymousUserIdOptions = {}): AnonymousUserId {
  const file = join(resolveDshHome(undefined, options.env ?? process.env), ANONYMOUS_USER_ID_FILE_NAME)
  const cached = memo.get(file)
  if (cached !== undefined) return cached

  let id = readPersistedId(file)
  if (id === undefined) {
    const generate = options.randomUUID ?? randomUUID
    const created = generate() as AnonymousUserId
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, `${created}\n`, { encoding: 'utf8', flag: 'wx' })
      id = created
    } catch {
      // wx 被拒绝（EEXIST）同时覆盖并发获胜方与已存在的损坏文件两种情况：
      // 重读会采用一个有效的获胜方；若重读结果无效，则落到覆盖写入分支。
      // 非 EEXIST 的失败（home 只读）同样落到该分支，并在下面按尽力而为接受。
      id = readPersistedId(file)
      if (id === undefined) {
        try {
          writeFileSync(file, `${created}\n`, 'utf8')
        } catch {
          // 尽力而为的持久化：即使 home 不可写，也在内存中保留这个新 id，
          // 这样本次运行仍能上报一致的 id。
        }
        id = created
      }
    }
  }
  memo.set(file, id)
  return id
}
