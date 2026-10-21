/**
 * 本地溢出后端与 Cordis 无关的存储机制：私有会话作用域目录的选择、
 * 安全名称派生、路径穿越防护，以及独占的仅属主写入。
 *
 * @module @deepseek-ai/dsh-spill-local/store
 */

import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/** 默认根目录的创建与启动发现共用的前缀。 */
export const DEFAULT_ROOT_PREFIX = 'dsh-spill-'

/**
 * 判断一个被捕获的值是否带有指定的 Node 系统错误码。
 *
 * @param error 被捕获的值。
 * @param code 期望的系统错误码。
 * @returns 错误码是否匹配。
 */
export function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code
}

let defaultRoot: string | undefined

/**
 * 返回惰性创建的私有、每进程独有的溢出根目录。
 *
 * @returns 私有根目录路径。
 */
export function privateRoot(): string {
  defaultRoot ??= mkdtempSync(join(tmpdir(), DEFAULT_ROOT_PREFIX))
  return defaultRoot
}

// Spill 把空名称策略保留在本地，使存储后端保持解耦。
/* jscpd:ignore-start */
/**
 * 把任意字符串编码为单个安全路径段，对全部 JS（UTF-16）字符串保持单射。
 * 会话 id / 建议名称属于不可信输入，因此在触及文件系统之前就要中和掉
 * `../`、绝对路径、NUL 与分隔符。每个码元要么保持字面量
 * （`[A-Za-z0-9._-]`，去掉 `~`），要么转义成 `~XXXX`；`~` 自身也被转义，
 * 因此该映射可逆，且不同输入绝不会碰撞。整段 token `.`/`..` 同样被转义，
 * 因此绝不可能穿越。空字符串编码为 `~`（绝不会是空段）。
 *
 * @param raw 不可信文本。
 * @returns 单个单射的、文件系统安全的路径段。
 */
export function encodeSegment(raw: string): string {
  if (raw.length === 0) return '~'
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    out += ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)
      ? ch
      : '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}
/* jscpd:ignore-end */

/**
 * 派生出溢出根目录下稳定的会话作用域目录。
 *
 * @param root 溢出根目录。
 * @param sessionId 归属的会话 id。
 * @returns 稳定的会话作用域目录。
 */
export function sessionDir(root: string, sessionId: string): string {
  const hash = createHash('sha256').update(sessionId).digest('hex').slice(0, 12)
  return join(root, `session-${hash}`)
}

/** 保存一个本地溢出文件所需的输入。 */
export interface SaveTextOptions {
  /** 溢出根目录。 */
  root: string
  /** 归属的会话 id。 */
  sessionId: string
  /** 调用方建议的文件名。 */
  suggestedName: string
  /** 要持久化的完整文本。 */
  content: string
}

/** 一个已写入的溢出文件。 */
export interface SavedText {
  /** 已保存的绝对路径。 */
  path: string
  /** UTF-8 内容长度。 */
  bytes: number
}

/**
 * 把文本写入其私有会话目录下的一个全新 0600 文件。
 * @param options 保存请求。
 * @returns 已保存路径与 UTF-8 字节长度。
 */
export async function saveTextFile(options: SaveTextOptions): Promise<SavedText> {
  const dir = sessionDir(options.root, options.sessionId)
  const path = join(dir, `${randomBytes(6).toString('hex')}-${encodeSegment(options.suggestedName)}`)
  let handle
  for (;;) {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    try {
      handle = await open(path, 'wx', 0o600)
      break
    } catch (error: unknown) {
      /* v8 ignore start -- 需要另一个进程在 mkdir 与 open 之间删除该目录，
         或者出现外部的权限/IO 竞态。 */
      if (isErrno(error, 'ENOENT')) continue
      throw error
      /* v8 ignore stop */
    }
  }
  try {
    await handle.writeFile(options.content)
  } finally {
    await handle.close()
  }
  return { path, bytes: Buffer.byteLength(options.content, 'utf8') }
}
