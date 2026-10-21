/** 针对带一个被继承控制管道的 Node 载荷的 Windows CRT 启动描述符。 */

import type { NativePtr, Win32ProcessBindings } from './ffi.ts'

/** 原生 stdio 句柄，外加由启动器选定的单个额外描述符。 */
export interface InheritedControlStdio {
  stdin: NativePtr
  stdout: NativePtr
  stderr: NativePtr
  control: { fileDescriptor: 7; handle: NativePtr }
}

const HANDLE_BYTES = 8
const INVALID_HANDLE = 0xffff_ffff_ffff_ffffn
const FOPEN = 0x01
const FPIPE = 0x08
const FDEV = 0x40
const FILE_TYPE_CHAR = 2
const FILE_TYPE_PIPE = 3

/**
 * 在子运行时分配描述符之前，编码 CRT 的描述符表。受支持的 Windows 目标使用
 * 64 位句柄。空槽位保持关闭，且底层 Buffer 必须保持存活，直到 CreateProcess 返回。
 * @param api - 用于被继承句柄的原生文件类型检查。
 * @param stdio - 标准句柄，以及由提供方拥有的 fd-7 控制管道。
 * @returns 描述符数量、标志字节，以及供 STARTUPINFO 保留 CRT 字段使用的句柄值。
 */
export function inheritedControlStdio(api: Pick<Win32ProcessBindings, 'getFileType'>, stdio: InheritedControlStdio): Buffer {
  const count = stdio.control.fileDescriptor + 1
  const handleOffset = 4 + count
  const bytes = Buffer.alloc(handleOffset + count * HANDLE_BYTES)
  bytes.writeUInt32LE(count, 0)
  for (let index = 0; index < count; index++) {
    bytes.writeBigUInt64LE(INVALID_HANDLE, handleOffset + index * HANDLE_BYTES)
  }
  const entries = [[0, stdio.stdin], [1, stdio.stdout], [2, stdio.stderr], [stdio.control.fileDescriptor, stdio.control.handle]] as const
  for (const [fd, handle] of entries) {
    const kind = api.getFileType(handle)
    if (fd === stdio.control.fileDescriptor && kind !== FILE_TYPE_PIPE) {
      throw new Error('subprocess control descriptor is not a Windows pipe')
    }
    bytes[4 + fd] = FOPEN | (kind === FILE_TYPE_PIPE ? FPIPE : kind === FILE_TYPE_CHAR ? FDEV : 0)
    bytes.writeBigUInt64LE(handle, handleOffset + fd * HANDLE_BYTES)
  }
  return bytes
}
