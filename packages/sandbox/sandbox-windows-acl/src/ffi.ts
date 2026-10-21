/** 构建在共享 Win32 进程所有者之上的 ACL/令牌绑定。 */

import { createLazyRequire } from '@deepseek-ai/dsh-lazy-require'
import {
  ERROR_INSUFFICIENT_BUFFER,
  Win32Error,
  extendWin32ProcessBindings,
  isNullPtr,
  throwLastError,
} from '@deepseek-ai/dsh-win32-process'
import type { NativePtr, Win32ProcessBindings } from '@deepseek-ai/dsh-win32-process'
import * as abi from './win32-abi.ts'

export {
  allocPtrSlot,
  allocUint32,
  decodePtr,
  decodeUint32,
  isNullPtr,
  throwLastError,
  throwWin32,
} from '@deepseek-ai/dsh-win32-process'
export type { NativePtr } from '@deepseek-ai/dsh-win32-process'

type Koffi = typeof import('koffi')['default']
type Ptr = ReturnType<Koffi['pointer']>

const requireKoffi = createLazyRequire<Koffi>('koffi', import.meta.url)
let cachedTypes: { PVOID: Ptr; PPVOID: Ptr } | undefined

function ffiTypes(): { PVOID: Ptr; PPVOID: Ptr } {
  if (cachedTypes !== undefined) return cachedTypes
  const koffi = requireKoffi()
  const PVOID = koffi.pointer('void')
  return cachedTypes = { PVOID, PPVOID: koffi.pointer(PVOID) }
}

/** 与通用 Win32 进程绑定表组合在一起的 ACL/令牌调用。 */
export interface Win32Bindings extends Win32ProcessBindings {
  openProcess(desiredAccess: number, inheritHandle: number, pid: number): NativePtr
  openProcessToken(process: NativePtr, desiredAccess: number, tokenHandle: NativePtr): number
  localAlloc(flags: number, bytes: number): NativePtr
  localFree(memory: NativePtr): NativePtr
  convertStringSidToSidW(stringSid: string, sid: NativePtr): number
  createWellKnownSid(type: number, domainSid: null, sid: NativePtr, size: NativePtr): number
  isValidSid(sid: NativePtr): number
  getLengthSid(sid: NativePtr): number
  copySid(length: number, destination: NativePtr, source: NativePtr): number
  getTokenInformation(token: NativePtr, cls: number, info: Buffer | null, length: number, needed: NativePtr): number
  setTokenInformation(token: NativePtr, cls: number, info: Buffer, length: number): number
  createRestrictedToken(
    existing: NativePtr,
    flags: number,
    disableCount: number,
    disableSids: null,
    deletePrivilegeCount: number,
    privilegesToDelete: null,
    restrictCount: number,
    restrictingSids: Buffer,
    newToken: NativePtr,
  ): number
  setEntriesInAclW(count: number, entries: Buffer, oldAcl: NativePtr | null, newAcl: NativePtr): number
  initializeAcl(acl: NativePtr, length: number, revision: number): number
  addMandatoryAce(acl: NativePtr, revision: number, aceFlags: number, policy: number, sid: NativePtr): number
  setNamedSecurityInfoW(
    path: string,
    objectType: number,
    information: number,
    owner: null,
    group: null,
    dacl: NativePtr | null,
    sacl: NativePtr | null,
  ): number
  getNamedSecurityInfoW(
    path: string,
    objectType: number,
    information: number,
    owner: NativePtr,
    group: NativePtr,
    dacl: NativePtr,
    sacl: NativePtr,
    descriptor: NativePtr,
  ): number
  getTempPathW(length: number, buffer: Buffer): number
  setEnvironmentVariableW(name: string, value: string): number
  setConsoleCtrlHandler(handler: null, add: number): number
  createFileW(
    fileName: string,
    desiredAccess: number,
    shareMode: number,
    attributes: null,
    creationDisposition: number,
    flagsAndAttributes: number,
    templateFile: null,
  ): NativePtr
  lockFileEx(
    file: NativePtr,
    flags: number,
    reserved: number,
    bytesLow: number,
    bytesHigh: number,
    overlapped: NativePtr,
  ): number
  unlockFileEx(
    file: NativePtr,
    reserved: number,
    bytesLow: number,
    bytesHigh: number,
    overlapped: NativePtr,
  ): number
}

/**
 * 判断 CreateFileW 是否产生了 INVALID_HANDLE_VALUE。
 * @param handle - CreateFileW 返回的句柄。
 * @returns 对 null、0 或全 1 哨兵值返回 true。
 */
export function isInvalidHandle(handle: NativePtr | null | undefined): boolean {
  if (isNullPtr(handle)) return true
  return (handle as bigint) === 0xFFFFFFFFFFFFFFFFn || (handle as bigint) === -1n
}

/**
 * 把一个 uint32 编码进一个已分配的槽位。
 * @param slot - 由 allocUint32 分配的槽位。
 * @param value - 要存入的无符号值。
 */
export function encodeUint32(slot: NativePtr, value: number): void {
  requireKoffi().encode(slot, 'uint32', value)
}

/**
 * 返回一个 Koffi 指针的数值地址，供结构体打包使用。
 * @param ptr - 原生指针。
 * @returns 指针地址。
 */
export function ptrAddress(ptr: NativePtr): bigint {
  return requireKoffi().address(ptr)
}

/**
 * 分配一块原始字节内存。
 * @param length - 字节数。
 * @returns 已分配的指针。
 */
export function allocBytes(length: number): NativePtr {
  return requireKoffi().alloc('uint8', length) as NativePtr
}

/**
 * 分配一个已清零的 x64 OVERLAPPED 记录。
 * @returns 已分配的指针。
 * @remarks 当 LockFileEx 或 UnlockFileEx 收到 NULL 时，Koffi 3.1.1 会崩溃；
 * 对同步的锁文件句柄而言，一个清零的 OVERLAPPED 是等价的。
 */
export function allocOverlapped(): NativePtr {
  return allocBytes(32)
}

/**
 * 从一个 Buffer 字段中解码出指针值。
 * @param buffer - 已编码的原生记录。
 * @param offset - 指针字段的字节偏移。
 * @returns 解码出的指针；地址为 0 时返回 null。
 */
export function decodePtrAt(buffer: Buffer, offset: number): NativePtr | null {
  const value = requireKoffi().decode(buffer, offset, ffiTypes().PVOID) as NativePtr | null
  return isNullPtr(value) ? null : value
}

/**
 * 在原生指针偏移处解码一个 uint8 字段。
 * @param ptr - 原生记录指针。
 * @param offset - 字段的字节偏移。
 * @returns 解码出的值。
 */
export function decodeUint8At(ptr: NativePtr, offset: number): number {
  return requireKoffi().decode(ptr, offset, 'uint8') as number
}

/**
 * 在原生指针偏移处解码一个 uint16 字段。
 * @param ptr - 原生记录指针。
 * @param offset - 字段的字节偏移。
 * @returns 解码出的值。
 */
export function decodeUint16At(ptr: NativePtr, offset: number): number {
  return requireKoffi().decode(ptr, offset, 'uint16') as number
}

/**
 * 在原生指针偏移处解码一个 uint32 字段。
 * @param ptr - 原生记录指针。
 * @param offset - 字段的字节偏移。
 * @returns 解码出的值。
 */
export function decodeUint32At(ptr: NativePtr, offset: number): number {
  return requireKoffi().decode(ptr, offset, 'uint32') as number
}

/**
 * 在不分配字符串的情况下比较两条内存中的 SID 记录。
 * @param left - 第一个原生缓冲区。
 * @param leftOffset - 第一个 SID 的字节偏移。
 * @param right - 第二个原生缓冲区。
 * @param rightOffset - 第二个 SID 的字节偏移。
 * @returns 当修订号、授权机构与每一个子授权机构都相同时返回 true。
 */
export function sameSidAt(
  left: NativePtr,
  leftOffset: number,
  right: NativePtr,
  rightOffset: number,
): boolean {
  if (decodeUint8At(left, leftOffset) !== decodeUint8At(right, rightOffset)) return false
  const leftCount = decodeUint8At(left, leftOffset + 1)
  const rightCount = decodeUint8At(right, rightOffset + 1)
  if (leftCount !== rightCount || leftCount > abi.SID_MAX_SUB_AUTHORITIES) return false
  for (let index = 0; index < 6; index += 1) {
    if (decodeUint8At(left, leftOffset + 2 + index) !== decodeUint8At(right, rightOffset + 2 + index)) {
      return false
    }
  }
  for (let index = 0; index < leftCount; index += 1) {
    if (decodeUint32At(left, leftOffset + 8 + index * 4) !==
      decodeUint32At(right, rightOffset + 8 + index * 4)) return false
  }
  return true
}

let cached: Win32Bindings | undefined

function bindings(): Win32Bindings {
  if (cached !== undefined) return cached
  const koffi = requireKoffi()
  const { PVOID, PPVOID } = ffiTypes()
  cached = extendWin32ProcessBindings(({ kernel32, advapi32, bind }) => ({
    openProcess: bind(kernel32, 'OpenProcess', PVOID, ['uint32', 'int', 'uint32']),
    openProcessToken: bind(advapi32, 'OpenProcessToken', 'int', [PVOID, 'uint32', PPVOID]),
    localAlloc: bind(kernel32, 'LocalAlloc', PVOID, ['uint32', 'size_t']),
    localFree: bind(kernel32, 'LocalFree', PVOID, [PVOID]),
    convertStringSidToSidW: bind(advapi32, 'ConvertStringSidToSidW', 'int', ['str16', PPVOID]),
    createWellKnownSid: bind(advapi32, 'CreateWellKnownSid', 'int', [
      'int', PVOID, PVOID, koffi.pointer('uint32'),
    ]),
    isValidSid: bind(advapi32, 'IsValidSid', 'int', [PVOID]),
    getLengthSid: bind(advapi32, 'GetLengthSid', 'uint32', [PVOID]),
    copySid: bind(advapi32, 'CopySid', 'int', ['uint32', PVOID, PVOID]),
    getTokenInformation: bind(advapi32, 'GetTokenInformation', 'int', [
      PVOID, 'int', PVOID, 'uint32', koffi.pointer('uint32'),
    ]),
    setTokenInformation: bind(advapi32, 'SetTokenInformation', 'int', [PVOID, 'int', PVOID, 'uint32']),
    createRestrictedToken: bind(advapi32, 'CreateRestrictedToken', 'int', [
      PVOID, 'uint32', 'uint32', PVOID, 'uint32', PVOID, 'uint32', PVOID, PPVOID,
    ]),
    setEntriesInAclW: bind(advapi32, 'SetEntriesInAclW', 'uint32', ['uint32', PVOID, PVOID, PPVOID]),
    initializeAcl: bind(advapi32, 'InitializeAcl', 'int', [PVOID, 'uint32', 'uint32']),
    addMandatoryAce: bind(advapi32, 'AddMandatoryAce', 'int', [PVOID, 'uint32', 'uint32', 'uint32', PVOID]),
    setNamedSecurityInfoW: bind(advapi32, 'SetNamedSecurityInfoW', 'uint32', [
      'str16', 'int', 'uint32', PVOID, PVOID, PVOID, PVOID,
    ]),
    getNamedSecurityInfoW: bind(advapi32, 'GetNamedSecurityInfoW', 'uint32', [
      'str16', 'int', 'uint32', PPVOID, PPVOID, PPVOID, PPVOID, PPVOID,
    ]),
    getTempPathW: bind(kernel32, 'GetTempPathW', 'uint32', ['uint32', PVOID]),
    setEnvironmentVariableW: bind(kernel32, 'SetEnvironmentVariableW', 'int', ['str16', 'str16']),
    setConsoleCtrlHandler: bind(kernel32, 'SetConsoleCtrlHandler', 'int', [PVOID, 'int']),
    createFileW: bind(kernel32, 'CreateFileW', PVOID, [
      'str16', 'uint32', 'uint32', PVOID, 'uint32', 'uint32', PVOID,
    ]),
    lockFileEx: bind(kernel32, 'LockFileEx', 'int', [
      PVOID, 'uint32', 'uint32', 'uint32', 'uint32', PVOID,
    ]),
    unlockFileEx: bind(kernel32, 'UnlockFileEx', 'int', [
      PVOID, 'uint32', 'uint32', 'uint32', PVOID,
    ]),
  })) as Win32Bindings
  return cached
}

/**
 * 异步解析已缓存的 ACL/令牌绑定表。
 * @returns 通用进程绑定加上 ACL/令牌绑定。
 */
export function win32(): Promise<Win32Bindings> {
  return Promise.resolve(bindings())
}

/**
 * 同步解析已缓存的 ACL/令牌绑定表。
 * @returns 通用进程绑定加上 ACL/令牌绑定。
 */
export function win32Sync(): Win32Bindings {
  return bindings()
}

/**
 * 解析当前 Windows 临时目录。
 * @param api - 生效中的 ACL/令牌绑定表。
 * @returns GetTempPathW 上报的 UTF-16 路径。
 */
export function getTempPath(api: Win32Bindings): string {
  const buffer = Buffer.alloc((abi.MAX_PATH + 1) * 2)
  const length = api.getTempPathW(buffer.length / 2, buffer)
  if (length === 0) throwLastError(api, 'GetTempPathW')
  if (length > buffer.length / 2) {
    throw new Win32Error(
      'GetTempPathW',
      ERROR_INSUFFICIENT_BUFFER,
      `required ${length} chars exceed the ${buffer.length / 2}-char buffer; nothing was written`,
    )
  }
  return buffer.subarray(0, length * 2).toString('utf16le')
}
