/**
 * 受限令牌的构造：打开当前进程令牌、提取其登录 SID、构建已知 SID，并以
 * POC 的限制 SID 允许列表调用 CreateRestrictedToken。每个 API 调用都会被
 * 检查；任何失败都会抛出 API 名称与精确的 Win32 错误码——最初的 POC 忽略了
 * 这一切，静默地以完整、不受限的令牌运行子进程。
 * @module @deepseek-ai/dsh-sandbox-windows-acl/token
 */

import { allocBytes, allocPtrSlot, allocUint32, decodePtr, decodePtrAt, decodeUint32, encodeUint32, isNullPtr, ptrAddress, throwLastError, throwWin32 } from './ffi.ts'
import type { NativePtr, Win32Bindings } from './ffi.ts'
import { buildExplicitAccess } from './acl.ts'
import * as abi from './win32-abi.ts'

/**
 * 以 CreateRestrictedToken 所需的权限打开当前进程的访问令牌（即 POC 中的
 * OpenProcessToken 调用；令牌句柄是通过一个真实的 OpenProcess 句柄取得的，
 * 因为 GetCurrentProcess() 伪句柄无法经由 koffi 取址）。
 * @param api - 绑定表。
 * @returns 已打开的令牌句柄。
 */
export function openCurrentProcessToken(api: Win32Bindings): NativePtr {
  const processHandle = api.openProcess(abi.PROCESS_QUERY_INFORMATION, 0, process.pid)
  if (isNullPtr(processHandle)) throwLastError(api, 'OpenProcess', `pid ${process.pid}`)

  const tokenSlot = allocPtrSlot()
  const opened = api.openProcessToken(
    processHandle,
    abi.TOKEN_QUERY | abi.TOKEN_DUPLICATE | abi.TOKEN_ADJUST_DEFAULT | abi.TOKEN_ASSIGN_PRIMARY,
    tokenSlot,
  )
  if (opened === 0) {
    const win32Code = api.getLastError()
    api.closeHandle(processHandle) // best-effort on the error path
    throwWin32(api, 'OpenProcessToken', win32Code, `pid ${process.pid}`)
  }
  if (api.closeHandle(processHandle) === 0) throwLastError(api, 'CloseHandle', 'OpenProcess process handle')
  const token = decodePtr(tokenSlot)
  if (token === null) throwWin32(api, 'OpenProcessToken', api.getLastError(), 'null token handle')
  return token
}

/**
 * 查找并复制该令牌的登录会话 SID（S-1-5-5-x-y，属性为 SE_GROUP_LOGON_ID）。
 * 受限令牌需要它才能访问 WinSta0/desktop 以及其他按登录划分的对象；POC
 * 也是以同样的方式提取它的。
 * @param api - 绑定表。
 * @param token - 其组被扫描的那个令牌。
 * @returns 复制出的登录 SID（当令牌不含该 SID 时抛出）。
 */
export function findLogonSid(api: Win32Bindings, token: NativePtr): NativePtr {
  const neededSlot = allocUint32()
  api.getTokenInformation(token, abi.TokenGroups, null, 0, neededSlot) // expected to fail with ERROR_INSUFFICIENT_BUFFER
  const needed = decodeUint32(neededSlot)
  if (needed === 0) throwLastError(api, 'GetTokenInformation', 'TokenGroups size query')
  if (needed < abi.TOKEN_GROUPS_OFFSET) throwWin32(api, 'GetTokenInformation', api.getLastError(), `implausible TokenGroups size ${needed}`)

  const groups = Buffer.alloc(needed)
  if (api.getTokenInformation(token, abi.TokenGroups, groups, groups.length, neededSlot) === 0) {
    throwLastError(api, 'GetTokenInformation', 'TokenGroups')
  }
  const groupCount = groups.readUInt32LE(0)
  for (let index = 0; index < groupCount; index++) {
    const sidPtr = decodePtrAt(groups, abi.TOKEN_GROUPS_OFFSET + index * abi.SID_AND_ATTRIBUTES_SIZE)
    const attributes = groups.readUInt32LE(abi.TOKEN_GROUPS_OFFSET + index * abi.SID_AND_ATTRIBUTES_SIZE + 8)
    // >>> 0：JS 的按位 & 是有符号 32 位的；SE_GROUP_LOGON_ID 的第 31 位为 1。
    const isLogonId = ((attributes & abi.SE_GROUP_LOGON_ID) >>> 0) === (abi.SE_GROUP_LOGON_ID >>> 0)
    if (sidPtr === null || !isLogonId) continue
    const sidLength = api.getLengthSid(sidPtr)
    if (sidLength === 0) throwLastError(api, 'GetLengthSid', `logon SID group ${index}`)
    const copy = allocBytes(sidLength)
    if (api.copySid(sidLength, copy, sidPtr) === 0) throwLastError(api, 'CopySid', `logon SID group ${index}`)
    return copy
  }
  throw new Error(`CreateRestrictedToken prerequisite failed: no logon SID found among ${groupCount} token groups`)
}

/**
 * 创建一个已知 SID（68 字节缓冲区）并断言其有效性。
 * @param api - 绑定表。
 * @param type - 要创建的 WELL_KNOWN_SID_TYPE。
 * @returns 已创建的 SID 指针。
 */
export function makeWellKnownSid(api: Win32Bindings, type: number): NativePtr {
  const sid = allocBytes(abi.SECURITY_MAX_SID_SIZE)
  const sizeSlot = allocUint32()
  encodeUint32(sizeSlot, abi.SECURITY_MAX_SID_SIZE)
  if (api.createWellKnownSid(type, null, sid, sizeSlot) === 0) {
    throwLastError(api, 'CreateWellKnownSid', `type ${type}`)
  }
  if (api.isValidSid(sid) === 0) throwLastError(api, 'IsValidSid', `CreateWellKnownSid type ${type}`)
  return sid
}

/**
 * 把一条针对 `sidPtr` 的完全访问允许 ACE 合并进该令牌的默认 DACL——所谓
 * 默认 DACL，就是令牌持有者所创建（且未显式指定安全描述符）的每一个新对象
 * 都会采用的那个 DACL。受限令牌逐字继承了用户的默认 DACL，而后者没有点名
 * 任何限制 SID：于是一个新建的匿名管道（子进程 stdio）在创建时就会无法通过
 * 写入的第二趟检查（ERROR_ACCESS_DENIED；Node 把它表现为 spawn EPERM），
 * 从而破坏每一次管道式 stdio 的孙进程派生。合并进去的这条 ACE 点名的是一个
 * 限制 SID（workspace-write 下是写入 SID，read-only 下是 Everyone），因此每个
 * 新对象自身的 DACL 能通过第二趟检查，而对象创建本身仍受父容器 DACL 的把关
 * （位于已授予目录树之外的文件依旧无法创建）。失败即关闭：任何 Win32 失败
 * 都会在派生之前抛出。
 * @param api - 绑定表。
 * @param token - 待调整的受限令牌（需要 TOKEN_ADJUST_DEFAULT）。
 * @param sidPtr - 其完全访问 ACE 要并入默认 DACL 的那个限制 SID。
 */
export function setTokenDefaultDaclGrant(api: Win32Bindings, token: NativePtr, sidPtr: NativePtr): void {
  const neededSlot = allocUint32()
  api.getTokenInformation(token, abi.TokenDefaultDacl, null, 0, neededSlot) // expected to fail with ERROR_INSUFFICIENT_BUFFER
  const needed = decodeUint32(neededSlot)
  if (needed === 0) throwLastError(api, 'GetTokenInformation', 'TokenDefaultDacl size query')
  const buffer = Buffer.alloc(needed)
  if (api.getTokenInformation(token, abi.TokenDefaultDacl, buffer, buffer.length, neededSlot) === 0) {
    throwLastError(api, 'GetTokenInformation', 'TokenDefaultDacl')
  }
  const currentDacl = decodePtrAt(buffer, 0)
  if (currentDacl === null) {
    throw new Error('setTokenDefaultDaclGrant: the token carries no default DACL to extend')
  }
  const newDaclSlot = allocPtrSlot()
  const result = api.setEntriesInAclW(
    1,
    buildExplicitAccess(sidPtr, abi.GRANT_ACCESS, abi.FILE_ALL_ACCESS),
    currentDacl,
    newDaclSlot,
  )
  if (result !== abi.ERROR_SUCCESS) throwWin32(api, 'SetEntriesInAclW', result, 'default DACL merge')
  const newDacl = decodePtr(newDaclSlot)
  if (newDacl === null) throwWin32(api, 'SetEntriesInAclW', result, 'null merged default DACL')
  // TOKEN_DEFAULT_DACL { PACL DefaultDacl; }——该结构体恰好就是那个指针；
  // SetTokenInformation 会在返回之前复制这份 ACL。
  const info = Buffer.alloc(8)
  info.writeBigUInt64LE(newDacl, 0)
  if (api.setTokenInformation(token, abi.TokenDefaultDacl, info, info.length) === 0) {
    const win32Code = api.getLastError()
    api.localFree(newDacl)
    throwWin32(api, 'SetTokenInformation', win32Code, 'TokenDefaultDacl')
  }
  api.localFree(newDacl)
}

/**
 * 把受限令牌的完整性级别降到 Low（S-1-16-4096），即 `grantWrite` 所应用的
 * 那些强制标签要与之匹配的级别；一个停留在 Medium 的令牌会无视它们。需要
 * 该令牌具备 TOKEN_ADJUST_DEFAULT；在任何子进程被派生之前失败即关闭。
 * @param api - 绑定表。
 * @param token - 待降级的受限令牌。
 * @param lowLabelSidPtr - Low 完整性 SID（S-1-16-4096）。
 */
export function restrictTokenIntegrity(api: Win32Bindings, token: NativePtr, lowLabelSidPtr: NativePtr): void {
  const sidLength = api.getLengthSid(lowLabelSidPtr)
  if (sidLength === 0) throwLastError(api, 'GetLengthSid', 'Low integrity label SID')
  const info = Buffer.alloc(abi.TOKEN_MANDATORY_LABEL_SIZE + sidLength)
  info.writeBigUInt64LE(ptrAddress(lowLabelSidPtr), 0) // Label.Sid
  info.writeUInt32LE(abi.SE_GROUP_INTEGRITY, 8) // Label.Attributes
  if (api.setTokenInformation(token, abi.TokenIntegrityLevel, info, info.length) === 0) {
    throwLastError(api, 'SetTokenInformation', 'TokenIntegrityLevel (Low)')
  }
}

/** 打包 `SID_AND_ATTRIBUTES[count]`（步长 16 字节；Attributes 保持为 0）。 */
function buildRestrictingSids(sids: readonly NativePtr[]): Buffer {
  const buffer = Buffer.alloc(abi.SID_AND_ATTRIBUTES_SIZE * sids.length)
  sids.forEach((sid, index) => {
    buffer.writeBigUInt64LE(ptrAddress(sid), abi.SID_AND_ATTRIBUTES_SIZE * index)
  })
  return buffer
}

/** 被打包进每一个受限令牌限制列表的已知 SID。 */
export interface RestrictingSidSet {
  world: NativePtr
}

/**
 * 用按模式选定的限制列表创建写入受限的令牌（已在 Win11 26200 上验证，见
 * POC 工作树中的 restrict-variant 测试台）：
 *  - read-only：       [登录 SID, EVERYONE]
 *  - workspace-write： [登录 SID, EVERYONE, 工作区 SID, 可选的临时 SID]
 *
 * 登录 SID + EVERYONE 这一保活组由两种模式共用：缺少它们时，早期的 DLL
 * 初始化会以 0xC0000142 死亡，CNG（`\Device\CNG` 的写入受托者——pwsh 会以
 * 0xE0434352 崩溃）也会失败。写入 SID 只加入 workspace-write——read-only
 * 不携带任何写入 SID，因此来自更早一段 workspace-write 时期的常驻授予 ACE
 * （一次 `/permission` 模式降级，或一个崩溃后恢复的会话）在 read-only 下保持
 * 惰性：WRITE_RESTRICTED 的第二趟检查只授予限制列表所携带的内容，从而让那份
 * 工作区授予在 read-only 下保持惰性，而未撤销的 ACE 则使再次升级变得廉价
 * （授予的精确 ACE 跳过——无需重新传播）。Everyone 自身那些环境授予仍是已
 * 记录的部分边界。Authenticated Users 在两份列表中都不出现：WMI 命名空间
 * 安全检查会失败（0x80041003），因此 CIM 在每一种受限模式下都不可用，而
 * C:\ 根目录建树的逃逸路径（常驻的 `AU:(AD)` 与 `AU:(OI)(CI)(IO)(M)` ACE）
 * 在两种模式下都被关闭——已记录在 README 中。INTERACTIVE/LOCAL 同样在两份
 * 列表中都不出现——宿主机的 Public 目录树向 INTERACTIVE 授予了写权限，因此
 * 移除它就关闭了那条逃逸路径。S-1-2-1（控制台登录）被刻意省略：包内 README
 * 的"Console isolation is unavailable"条目记录了已验证的失败模式。
 * 失败即关闭：任何失败都抛出——绝不派生不受限的进程。
 * @param api - 绑定表。
 * @param currentToken - 待施加限制的进程令牌。
 * @param logonSid - 已复制的登录会话 SID。
 * @param writeSids - 构成工作区与可选临时允许列表的那些互不相同的写入 SID
 *   （仅在 workspace-write 下；read-only 下为空）。
 * @param known - 进入限制列表的已知 SID。
 * @param mode - 选择限制列表（workspace-write 会追加那些能力 SID）。
 * @returns 受限令牌句柄。
 */
export function createRestrictedToken(
  api: Win32Bindings,
  currentToken: NativePtr,
  logonSid: NativePtr,
  writeSids: readonly NativePtr[],
  known: RestrictingSidSet,
  mode: 'read-only' | 'workspace-write',
): NativePtr {
  const restrictingSids = buildRestrictingSids(mode === 'read-only'
    ? [logonSid, known.world]
    : writeSids.length === 0
      ? (() => { throw new Error('createRestrictedToken: workspace-write restricting list requires at least one write SID') })()
      : [logonSid, known.world, ...writeSids])
  const tokenSlot = allocPtrSlot()
  const created = api.createRestrictedToken(
    currentToken,
    abi.DISABLE_MAX_PRIVILEGE | abi.LUA_TOKEN | abi.WRITE_RESTRICTED,
    0, null, // no SIDs disabled
    0, null, // no privileges deleted
    restrictingSids.length / abi.SID_AND_ATTRIBUTES_SIZE,
    restrictingSids,
    tokenSlot,
  )
  if (created === 0) throwLastError(api, 'CreateRestrictedToken', `restricting SIDs: ${restrictingSids.length / abi.SID_AND_ATTRIBUTES_SIZE}`)
  const token = decodePtr(tokenSlot)
  if (token === null) throwWin32(api, 'CreateRestrictedToken', api.getLastError(), 'null token handle')
  return token
}
