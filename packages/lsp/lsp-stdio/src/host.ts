/** 通过文件系统接缝为通用 stdio LSP provider 提供的源码访问。 */

import { Buffer } from 'node:buffer'
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'
import { throwIfAborted } from './abort.ts'

/** 文件系统/子进程执行世界中的一个规范工作区。 */
export interface HostWorkspace {
  /** 用于 provider 池化的稳定文件系统身份。 */
  readonly target: FsTarget
  /** 可作为子进程 cwd 的规范绝对路径。 */
  readonly canonicalPath: string
  /** LSP 初始化期间发送的规范 file URI。 */
  readonly fileUrl: string
}

/** 一个已校验的源码，以及发送给语言服务的确切 URI。 */
export interface HostSource {
  /** 执行世界平台语法下的规范 file URI。 */
  readonly fileUrl: string
  /** 当前完整的 UTF-8 文本。 */
  readonly text: string
}

/**
 * 通过 `ctx.fs` 解析并校验一个工作区。
 * @param fs - 与语言服务共享执行世界的文件系统 provider。
 * @param workspaceRoot - 调用方提供的工作区路径。
 * @param signal - 围绕 provider 操作的可选取消信号。
 * @returns 稳定身份，外加进程路径与 file URI。
 */
export async function canonicalizeWorkspace(
  fs: FileSystem,
  workspaceRoot: string,
  signal?: AbortSignal,
): Promise<HostWorkspace> {
  throwIfAborted(signal)
  let target: FsTarget
  try {
    target = await fs.resolve(workspaceRoot, signal === undefined ? {} : { signal })
  } catch (error: unknown) {
    throwIfAborted(signal)
    throw new Error(`workspace root "${workspaceRoot}" cannot be resolved: ${messageOf(error)}`, { cause: error })
  }
  throwIfAborted(signal)
  const info = await fs.stat(target, signal).catch((error: unknown) => {
    throwIfAborted(signal)
    throw error
  })
  throwIfAborted(signal)
  if (info?.type !== 'directory') {
    throw new Error(`workspace root "${workspaceRoot}" is not a directory`)
  }
  return {
    target,
    canonicalPath: fs.processPath(target),
    fileUrl: fs.fileUrl(target),
  }
}

/**
 * 通过 `ctx.fs` 解析、约束并读取一个受字节上限约束的查询源码。
 * 本层负责 LSP 特有的“完整文档”上限，而文件系统 provider 负责流式读取、
 * 常规文件检查与 UTF-8 校验。
 * @param fs - 与服务端共享执行世界的文件系统 provider。
 * @param filePath - 绝对源码路径，或相对于 `workspace` 的路径。
 * @param workspace - 已规范化的工作区。
 * @param maxDocumentBytes - 本宿主接受的完整源码上限。
 * @param signal - 可选的取消信号。
 * @returns 规范的 file URI 与当前文本。
 */
export async function readHostSource(
  fs: FileSystem,
  filePath: string,
  workspace: HostWorkspace,
  maxDocumentBytes: number,
  signal?: AbortSignal,
): Promise<HostSource> {
  throwIfAborted(signal)
  let target: FsTarget
  try {
    target = await fs.resolve(filePath, {
      cwd: workspace.canonicalPath,
      ...signal === undefined ? {} : { signal },
    })
  } catch (error: unknown) {
    throwIfAborted(signal)
    throw new Error(`source "${filePath}" cannot be resolved: ${messageOf(error)}`, { cause: error })
  }
  throwIfAborted(signal)
  if (!fs.contains(workspace.target, target)) {
    throw new Error(`source "${filePath}" resolves outside the workspace`)
  }
  const chunks: string[] = []
  let bytes = 0
  try {
    // XXX(lsp-source-replacement)：仅当真实查询观察到在规范包含性检查与本 provider 打开该流
    // 之间发生了替换时，才需要重新审视稳定句柄的身份问题。
    const stream = await fs.streamText(target, signal)
    for await (const chunk of stream) {
      throwIfAborted(signal)
      bytes += Buffer.byteLength(chunk)
      if (bytes > maxDocumentBytes) break
      chunks.push(chunk)
    }
  } catch (error: unknown) {
    throwIfAborted(signal)
    throw new Error(`source "${filePath}" could not be read: ${messageOf(error)}`, { cause: error })
  }
  if (bytes > maxDocumentBytes) {
    throw new Error(
      `source "${filePath}" exceeds the ${maxDocumentBytes}-byte limit; reading stopped after ${bytes} bytes`,
    )
  }
  throwIfAborted(signal)
  return {
    fileUrl: fs.fileUrl(target),
    text: chunks.join(''),
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
