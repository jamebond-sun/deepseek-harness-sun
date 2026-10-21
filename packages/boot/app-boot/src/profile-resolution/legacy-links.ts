/** 通过活跃运行时载体文件系统进行的包目录与资源规范化。 */

import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/**
 * 返回进程是否从 pkg 的虚拟文件系统读取应用模块。
 * @returns pkg 是否拥有该模块文件系统。
 */
function isPackagedExecutable(): boolean {
  return (process as NodeJS.Process & { pkg?: unknown }).pkg !== undefined
}

/**
 * 通过活跃载体的文件系统实现来解析一个目录。
 * @param path - 待规范化的目录路径。
 * @returns 规范化后的目录路径。
 */
export function realModuleDirectory(path: string): string {
  return isPackagedExecutable() ? realpathSync(path) : realpathSync.native(path)
}

/** 规范化一个模块资源，同时保留物理文件别名。
 * SEA 归档文件没有符号链接，并支持 stat 与读取，而其所在的目录支持 realpath。
 * @param path 既有的模块资源路径。
 * @returns 在活跃载体文件系统之下的规范化资源路径。
 * @throws 当该资源或其目录无法被检查或解析时。
 */
export function realModuleFile(path: string): string {
  return !isPackagedExecutable() || lstatSync(path).isSymbolicLink()
    ? realpathSync(path)
    : join(realModuleDirectory(dirname(path)), basename(path))
}
