/**
 * ACL 编辑辅助：通过 SetEntriesInAclW + SetNamedSecurityInfoW 在一个目录上
 * 授予/撤销某个能力 SID（与 POC 所用的调用相同，但补上了 POC 缺失的失败
 * 处理）。每个 API 调用都会被检查，每一次失败都会连同 API 名称、精确的
 * Win32 错误码、格式化后的系统文本以及受影响的路径一起上报。
 *
 * 每次授予都在一次 SetNamedSecurityInfoW 调用中应用三项编辑：能力 SID 的
 * 允许 ACE、一条从 world SID 手上剥夺环境 `FILE_DELETE_CHILD` 权限的拒绝
 * ACE，以及一个 Low 禁止向上写入的强制标签（{@link buildLowLabelAcl}）。
 * 正是这条拒绝让一个已授予的根无法触及另一个根：Windows 还会依据父目录的
 * `FILE_DELETE_CHILD` 权限授权一次删除，而令牌的写入受限交集触达不到它，
 * 同时每个已授予的根都带有能通过完整性检查的 Low 标签。
 *
 * 并发：授予是针对该目录当前 DACL 的读-合并-写，并且整个"取-合并-设"序列
 * 都在一个按路径划分的独占 LockFileEx 锁之下运行（见 {@link withPathLock}），
 * 因此并发的沙箱实例无法互相踩踏彼此的 ACE。
 * @module @deepseek-ai/dsh-sandbox-windows-acl/acl
 */

import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { allocOverlapped, allocPtrSlot, decodePtr, decodeUint8At, decodeUint16At, decodeUint32At, getTempPath, isInvalidHandle, isNullPtr, ptrAddress, sameSidAt, throwLastError, throwWin32 } from './ffi.ts'
import type { NativePtr, Win32Bindings } from './ffi.ts'
import * as abi from './win32-abi.ts'

/**
 * 打包一个 EXPLICIT_ACCESS_W（48 字节，布局由 abi-probe.cpp 验证）：
 * perms@0、mode@4、inheritance@8、Trustee@16 { pMultipleTrustee@16、
 * MultipleTrusteeOperation@24、TrusteeForm@28、TrusteeType@32、ptstrName@40 }。
 * `permissions` 即访问掩码；POC 在 REVOKE_ACCESS 时传入 0，这会移除该受托者
 * 的每一条 ACE。`inheritance` 默认为两类子项；环境删除那条拒绝把它收窄到
 * 容器，因为 FILE_DELETE_CHILD 对文件没有意义，而它的那个位若不加限制就会
 * 通过文件的继承掩码扩散出去。
 * @param sidPtr - 该条目所点名的受托者 SID。
 * @param mode - 访问模式（GRANT_ACCESS、DENY_ACCESS 或 REVOKE_ACCESS）。
 * @param permissions - 要授予或拒绝的访问掩码（REVOKE_ACCESS 时为 0）。
 * @param inheritance - ACE 的继承标志。
 * @returns 打包好的条目缓冲区。
 */
export function buildExplicitAccess(
  sidPtr: NativePtr,
  mode: number,
  permissions: number,
  inheritance: number = abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT,
): Buffer {
  const entry = Buffer.alloc(abi.EXPLICIT_ACCESS_W_SIZE)
  entry.writeUInt32LE(permissions, 0) // grfAccessPermissions
  entry.writeUInt32LE(mode, 4) // grfAccessMode
  entry.writeUInt32LE(inheritance, 8) // grfInheritance
  entry.writeUInt32LE(abi.NO_MULTIPLE_TRUSTEE, 24) // Trustee.MultipleTrusteeOperation
  entry.writeUInt32LE(abi.TRUSTEE_IS_SID, 28) // Trustee.TrusteeForm
  entry.writeUInt32LE(abi.TRUSTEE_IS_UNKNOWN, 32) // Trustee.TrusteeType
  entry.writeBigUInt64LE(ptrAddress(sidPtr), 40) // Trustee.ptstrName = the capability SID
  return entry
}

/**
 * 每个受保护路径对应一个锁文件：`<GetTempPathW()>\dsh-acl-locks\<sha256(
 * 小写化路径) 的前 16 个十六进制字符>.lock`。锁根目录来自 GetTempPathW
 * （绝不来自运行器 argv 或 DSH_HOME），而小写化把 Windows 大小写不敏感的
 * 各种路径拼写映射到同一把锁上。
 * @param api - 绑定表。
 * @param path - 受保护的目录（绝对路径）。
 * @returns 该目录对应的锁文件路径。
 */
export function lockFilePath(api: Win32Bindings, path: string): string {
  const digest = createHash('sha256').update(path.toLowerCase()).digest('hex').slice(0, 16)
  return join(getTempPath(api), 'dsh-acl-locks', `${digest}.lock`)
}

/**
 * 在持有该路径独占锁的前提下运行 `action`：先是 CreateFileW
 * （OPEN_ALWAYS，共享读/写但不共享删除——一个可删除的锁文件会被持锁者之外
 * 的人删除并重建，从而让两个进程持有"同一把"锁），接着是一次一字节的
 * LockFileEx（LOCKFILE_EXCLUSIVE_LOCK，清零的 OVERLAPPED 表示在同步句柄上
 * 从偏移 0 处加锁——为何不用 NULL 见 allocOverlapped），然后是
 * UnlockFileEx + CloseHandle。失败即关闭：打开/加锁/解锁/关闭的失败都像本包
 * 中其他 Win32 调用一样抛出；`action` 自身的失败仍会（尽最大努力）解锁并
 * 重新抛出原来的错误。
 * @param api - 绑定表。
 * @param path - 受保护的目录（绝对路径）。
 * @param action - 需要串行化的"取-合并-设"序列。
 * @returns action 的结果。
 */
export function withPathLock<T>(api: Win32Bindings, path: string, action: () => T): T {
  const lockPath = lockFilePath(api, path)
  mkdirSync(dirname(lockPath), { recursive: true })
  const handle = api.createFileW(
    lockPath,
    abi.GENERIC_READ | abi.GENERIC_WRITE,
    abi.FILE_SHARE_READ | abi.FILE_SHARE_WRITE,
    null, abi.OPEN_ALWAYS, 0, null,
  )
  if (isInvalidHandle(handle)) throwLastError(api, 'CreateFileW', lockPath)
  const overlapped = allocOverlapped() // stays zeroed: offset 0, hEvent NULL
  if (api.lockFileEx(handle, abi.LOCKFILE_EXCLUSIVE_LOCK, 0, 1, 0, overlapped) === 0) {
    const win32Code = api.getLastError()
    api.closeHandle(handle) // best-effort on the lock-failure path
    throwWin32(api, 'LockFileEx', win32Code, lockPath)
  }

  let result: T
  try {
    result = action()
  } catch (error) {
    // 在 action 失败路径上尽最大努力释放：清理失败不得掩盖 action 的错误。
    api.unlockFileEx(handle, 0, 1, 0, overlapped)
    api.closeHandle(handle)
    throw error
  }
  if (api.unlockFileEx(handle, 0, 1, 0, overlapped) === 0) {
    const win32Code = api.getLastError()
    api.closeHandle(handle) // best-effort on the unlock-failure path
    throwWin32(api, 'UnlockFileEx', win32Code, lockPath)
  }
  if (api.closeHandle(handle) === 0) throwLastError(api, 'CloseHandle', `lock file ${lockPath}`)
  return result
}

/**
 * 通过 GetNamedSecurityInfoW 读取该目录当前的显式 DACL 与强制标签。
 * 分配契约（即 POC 的 RevokeAccess，去掉了它缺失的那些检查）：返回的 ACL
 * 指针位于安全描述符分配块之内——只有该描述符可以被 LocalFree，而且它在
 * SetEntriesInAclW 消费完那份 ACL 之前不得被释放。直接释放 ACL 指针本身会
 * 破坏堆（这一点是吃过苦头才验证的）。
 * @param api - 绑定表。
 * @param path - 其 DACL 与标签被读取的目录。
 * @returns 当前的显式 DACL 与标签 ACL（该目录未携带时为 null）以及持有它们的描述符。
 */
function readCurrentSecurity(
  api: Win32Bindings,
  path: string,
): { oldAcl: NativePtr | null; labelAcl: NativePtr | null; descriptor: NativePtr | null } {
  const ownerSlot = allocPtrSlot()
  const groupSlot = allocPtrSlot()
  const daclSlot = allocPtrSlot()
  const saclSlot = allocPtrSlot()
  const descriptorSlot = allocPtrSlot()
  const readResult = api.getNamedSecurityInfoW(
    path, abi.SE_FILE_OBJECT, abi.DACL_SECURITY_INFORMATION | abi.LABEL_SECURITY_INFORMATION,
    ownerSlot, groupSlot, daclSlot, saclSlot, descriptorSlot,
  )
  if (readResult !== abi.ERROR_SUCCESS) throwWin32(api, 'GetNamedSecurityInfoW', readResult, path)
  return { oldAcl: decodePtr(daclSlot), labelAcl: decodePtr(saclSlot), descriptor: decodePtr(descriptorSlot) }
}

/**
 * 构建随每次写入授予一起应用的 Low 强制标签：一条 SYSTEM_MANDATORY_LABEL_ACE
 * 点名 `lowLabelSidPtr` 并采用禁止向上写入策略，且继承到子容器与子对象，
 * 使后续的子项带上同样的标签。调用方用 LocalFree 释放返回的 ACL
 * （SetNamedSecurityInfoW 会复制它）；每个 Win32 调用都会被检查，一个只建了
 * 一半的 ACL 会在错误抛出之前被释放。
 * @param api - 绑定表。
 * @param lowLabelSidPtr - 该标签所点名的 Low 完整性 SID（S-1-16-4096）。
 * @returns 承载着那一条可继承标签 ACE 的 ACL。
 */
export function buildLowLabelAcl(api: Win32Bindings, lowLabelSidPtr: NativePtr): NativePtr {
  const sidLength = api.getLengthSid(lowLabelSidPtr)
  if (sidLength === 0) throwLastError(api, 'GetLengthSid', 'Low mandatory label SID')
  const aclLength = abi.ACL_HEADER_SIZE + abi.MANDATORY_ACE_OVERHEAD + sidLength
  const acl = api.localAlloc(abi.LPTR, aclLength)
  if (isNullPtr(acl)) throwLastError(api, 'LocalAlloc', 'Low mandatory label ACL')
  if (api.initializeAcl(acl, aclLength, abi.ACL_REVISION) === 0) {
    const win32Code = api.getLastError()
    api.localFree(acl) // best-effort on the error path
    throwWin32(api, 'InitializeAcl', win32Code, 'Low mandatory label ACL')
  }
  if (api.addMandatoryAce(
    acl, abi.ACL_REVISION, abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT, abi.SYSTEM_MANDATORY_LABEL_NO_WRITE_UP, lowLabelSidPtr,
  ) === 0) {
    const win32Code = api.getLastError()
    api.localFree(acl) // best-effort on the error path
    throwWin32(api, 'AddMandatoryAce', win32Code, 'Low mandatory label ACL')
  }
  return acl
}

/**
 * 当标签 ACL 已经携带了本模块将会添加的那个完全相同的标签（强制标签 ACE、
 * OI|CI 继承、禁止向上写入策略、Low SID）时返回 true，这样一次重新授予就能
 * 跳过那次急切的整树传播。
 * @param labelAcl - 当前的标签 ACL 指针（来自 {@link readCurrentSecurity}）。
 * @param lowLabelSidPtr - 要匹配的 Low 完整性 SID。
 * @returns 该精确标签 ACE 是否已经存在。
 */
function hasExactLabel(labelAcl: NativePtr, lowLabelSidPtr: NativePtr): boolean {
  return hasExactEntry(
    labelAcl, abi.SYSTEM_MANDATORY_LABEL_ACE_TYPE, abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT,
    abi.SYSTEM_MANDATORY_LABEL_NO_WRITE_UP, lowLabelSidPtr,
  )
}

/**
 * 一次应用中涉及强制标签的那一半：设置给定的标签 ACL、清除该标签，或让它
 * 保持原样。当该目录上没有其他能力授予时，撤销执行的是 `clear`；当另一份
 * 授予仍然依赖这个共享的 Low 级别时，执行的是 `keep`。
 */
type LabelEdit = { kind: 'apply'; acl: NativePtr } | { kind: 'clear' } | { kind: 'keep' }

/**
 * grantWrite 与 revokeWrite 共用的尾部：把 `entries` 合并进 `oldAcl`
 * （null 表示还没有显式 DACL；SetEntriesInAclW 会从零构建一份），在应用合并
 * 后的 ACL 之前先释放描述符，在一次 SetNamedSecurityInfoW 调用中同时应用合并
 * 后的 DACL 与标签编辑，然后释放本次调用所持有的每一个 ACL——逐步检查每个
 * 调用，并以调用方的 label 上报。条目数由缓冲区推导，因此一次授予可以在
 * 一次合并中同时带上它的能力 ACE 与环境删除拒绝。
 * @param api - 绑定表。
 * @param path - DACL 与标签编辑所作用的目录。
 * @param entries - 待合并的已打包 EXPLICIT_ACCESS_W 记录（授予、拒绝或撤销）。
 * @param oldAcl - 当前的显式 DACL（来自 {@link readCurrentSecurity}）。
 * @param labelEdit - 与 DACL 一并应用的标签变更。
 * @param descriptor - 持有 `oldAcl` 的那个描述符分配块。
 * @param label - 调用方用于错误详情的名称。
 */
function mergeAndApply(
  api: Win32Bindings,
  path: string,
  entries: Buffer,
  oldAcl: NativePtr | null,
  labelEdit: LabelEdit,
  descriptor: NativePtr | null,
  label: string,
): void {
  const newAclSlot = allocPtrSlot()
  const mergeResult = api.setEntriesInAclW(entries.length / abi.EXPLICIT_ACCESS_W_SIZE, entries, oldAcl, newAclSlot)
  if (mergeResult !== abi.ERROR_SUCCESS) {
    if (descriptor !== null) api.localFree(descriptor) // frees the ACL block too
    if (labelEdit.kind === 'apply') api.localFree(labelEdit.acl)
    throwWin32(api, 'SetEntriesInAclW', mergeResult, `${label}(${path})`)
  }
  const newAcl = decodePtr(newAclSlot)
  if (newAcl === null) {
    if (descriptor !== null) api.localFree(descriptor)
    if (labelEdit.kind === 'apply') api.localFree(labelEdit.acl)
    throwWin32(api, 'SetEntriesInAclW', api.getLastError(), `${label}(${path}): null new ACL`)
  }

  // 合并之后，描述符块（含 oldAcl）即已失效——在应用之前释放它，
  // 与 POC 的做法完全一致。
  const freedDescriptor = descriptor !== null ? api.localFree(descriptor) : null
  const applyResult = api.setNamedSecurityInfoW(
    path, abi.SE_FILE_OBJECT,
    labelEdit.kind === 'keep' ? abi.DACL_SECURITY_INFORMATION : abi.DACL_SECURITY_INFORMATION | abi.LABEL_SECURITY_INFORMATION,
    null, null, newAcl, labelEdit.kind === 'apply' ? labelEdit.acl : null,
  )
  const freedNew = api.localFree(newAcl)
  const freedLabel = labelEdit.kind === 'apply' ? api.localFree(labelEdit.acl) : null
  if (applyResult !== abi.ERROR_SUCCESS) throwWin32(api, 'SetNamedSecurityInfoW', applyResult, `${label}(${path})`)
  if (freedDescriptor !== null && !isNullPtr(freedDescriptor)) throwLastError(api, 'LocalFree', `${label}(${path}) descriptor`)
  if (!isNullPtr(freedNew)) throwLastError(api, 'LocalFree', `${label}(${path}) new ACL`)
  if (freedLabel !== null && !isNullPtr(freedLabel)) throwLastError(api, 'LocalFree', `${label}(${path}) label ACL`)
}

/**
 * 当显式 DACL 已经携带了完全相同的条目
 * `(aceType, inheritance, mask, 受托者 SID)` 时返回 true。每个字段都是通过
 * koffi.decode 在指针偏移处读取的——不做 memcpy，也不做指针算术。ACE 的 SID
 * 是内联的（嵌在该 ACE 中 4 字节掩码之后——并没有指针可读；读出一个会得到
 * 垃圾地址并让 EqualSid 崩溃，这一点由 gdb 验证），因此它通过有界偏移读取
 * 与受托者 SID 逐字段比较（{@link sameSidAt}）。允许型与拒绝型 ACE 共用
 * Mask@4/SID@8 的布局。一个畸形的头部会被读作"没有精确条目"，于是调用方
 * 回退到合并-应用路径，而那条路径才拥有健壮的失败处理。
 * @param acl - 当前的显式 DACL 指针（来自 {@link readCurrentSecurity}）。
 * @param aceType - 要匹配的 ACE 类型。
 * @param inheritance - 要匹配的 ACE 继承标志。
 * @param mask - 要匹配的访问掩码。
 * @param sidPtr - 要匹配的受托者 SID。
 * @returns 该精确条目是否已经存在。
 */
function hasExactEntry(acl: NativePtr, aceType: number, inheritance: number, mask: number, sidPtr: NativePtr): boolean {
  const aclSize = decodeUint16At(acl, 2)
  const aceCount = decodeUint16At(acl, 4)
  if (aclSize < 8 || aclSize > 1_048_576) return false // implausible: fall back to the merge path
  let offset = 8 // 第一个 ACE 紧跟在 8 字节的 ACL 头之后
  for (let index = 0; index < aceCount; index++) {
    // ACE_HEADER：AceType@0、AceFlags@1、AceSize@2（WORD）；Mask@4、内联 SID@8。
    const aceSize = decodeUint16At(acl, offset + 2)
    if (aceSize < 8 || offset + aceSize > aclSize) return false // 不合理：回退到合并路径
    const exact = decodeUint8At(acl, offset) === aceType
      && decodeUint8At(acl, offset + 1) === inheritance
      && decodeUint32At(acl, offset + 4) === mask
    if (exact && sameSidAt(acl, offset + 8, sidPtr, 0)) return true
    offset += aceSize
  }
  return false
}

/**
 * 当显式 DACL 已经携带了本模块将会添加的那个完全相同的写入授予时返回 true：
 * 即针对 {@link abi.GRANT_MASK}、点名该能力 SID 的允许 ACE。
 * @param oldAcl - 当前的显式 DACL 指针（来自 {@link readCurrentSecurity}）。
 * @param sidPtr - 要匹配的能力 SID。
 * @returns 该精确授予 ACE 是否已经存在。
 */
function hasExactGrant(oldAcl: NativePtr, sidPtr: NativePtr): boolean {
  return hasExactEntry(oldAcl, abi.ACCESS_ALLOWED_ACE_TYPE, abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT, abi.GRANT_MASK, sidPtr)
}

/**
 * 当显式 DACL 已经携带了完全相同的环境删除拒绝时返回 true：即针对
 * {@link abi.FILE_DELETE_CHILD}、点名 world SID 的容器继承拒绝 ACE。它是
 * 幂等跳过的一部分，因此一个由更早版本授予过的根会在下一次供应时收到这条
 * 拒绝。
 * @param oldAcl - 当前的显式 DACL 指针（来自 {@link readCurrentSecurity}）。
 * @param worldSidPtr - 该拒绝所点名的 Everyone SID。
 * @returns 该精确拒绝 ACE 是否已经存在。
 */
function hasExactDeny(oldAcl: NativePtr, worldSidPtr: NativePtr): boolean {
  return hasExactEntry(oldAcl, abi.ACCESS_DENIED_ACE_TYPE, abi.CONTAINER_INHERIT_ACE, abi.FILE_DELETE_CHILD, worldSidPtr)
}

/**
 * 当该 DACL 上存在一个针对 `sidPtr` 之外的其他 SID 的能力授予时返回 true——
 * 这正是撤销必须保留共享 Low 标签的条件，否则剩下那份授予的子项会失去其
 * 写权限。
 * @param oldAcl - 当前的显式 DACL 指针（来自 {@link readCurrentSecurity}）。
 * @param sidPtr - 正被撤销的那个能力 SID。
 * @returns 是否还残留着另一个能力授予。
 */
function hasForeignGrant(oldAcl: NativePtr, sidPtr: NativePtr): boolean {
  const aclSize = decodeUint16At(oldAcl, 2)
  const aceCount = decodeUint16At(oldAcl, 4)
  if (aclSize < 8 || aclSize > 1_048_576) return false // implausible: leave the label alone
  let offset = 8
  for (let index = 0; index < aceCount; index++) {
    const aceSize = decodeUint16At(oldAcl, offset + 2)
    if (aceSize < 8 || offset + aceSize > aclSize) return false // implausible: leave the label alone
    const isGrant = decodeUint8At(oldAcl, offset) === abi.ACCESS_ALLOWED_ACE_TYPE
      && decodeUint32At(oldAcl, offset + 4) === abi.GRANT_MASK
    if (isGrant && !sameSidAt(oldAcl, offset + 8, sidPtr, 0)) return true
    offset += aceSize
  }
  return false
}

/**
 * 在 `path` 上把 `GRANT_MASK`（写入+删除，显示为"修改"）授予该能力 SID，
 * 拒绝 world SID 的环境 `FILE_DELETE_CHILD` 权限，并应用 Low 强制标签——
 * 一次合并完成。该拒绝只继承到容器：这一权限是在目录上判定的，而把它的位
 * 继承到文件上会拒绝对该根内每一次 `FILE_ALL_ACCESS`/`GENERIC_ALL` 的打开
 * （0x40 属于那个掩码）。于是能力 ACE 的 DELETE 位成为该根内部唯一的删除
 * 授权，一个自身 DACL 未授予 DELETE 的文件便无法再借助其父目录的权限被删除。
 *
 * 幂等：精确的 ACE、拒绝与标签三者齐备时会跳过 SetNamedSecurityInfoW 的
 * 应用，否则那会把同一份描述符重新传播到整棵树上（急切继承；在大型工作区
 * 上耗时数分钟）。其余情形则是读-合并-写，因此既有的显式 ACE 得以保留
 * （与 {@link revokeWrite} 形状相同）。在按路径的锁之下运行。该目录必须由
 * 调用方拥有且授予 WRITE_OWNER（标签位于 SACL；所有者隐式权限只覆盖
 * READ_CONTROL 与 WRITE_DAC）——一个完全控制的工作区同时满足两者。
 * @param api - 绑定表。
 * @param path - 其 DACL 与标签将获得该授予的目录（工作区根或临时根）。
 * @param sidPtr - 该 ACE 所点名的能力 SID。
 * @param lowLabelSidPtr - 强制标签所点名的 Low 完整性 SID。
 * @param worldSidPtr - 环境删除拒绝所点名的 Everyone SID。
 */
export function grantWrite(
  api: Win32Bindings,
  path: string,
  sidPtr: NativePtr,
  lowLabelSidPtr: NativePtr,
  worldSidPtr: NativePtr,
): void {
  withPathLock(api, path, () => {
    const { oldAcl, labelAcl, descriptor } = readCurrentSecurity(api, path)
    if (oldAcl !== null && labelAcl !== null
      && hasExactGrant(oldAcl, sidPtr) && hasExactDeny(oldAcl, worldSidPtr)
      && hasExactLabel(labelAcl, lowLabelSidPtr)) {
      // 精确的 ACE、拒绝与标签已然齐备：释放描述符就是全部操作。
      if (descriptor !== null) {
        const freed = api.localFree(descriptor)
        if (!isNullPtr(freed)) throwLastError(api, 'LocalFree', `grantWrite(${path}) descriptor`)
      }
      return
    }
    let label: NativePtr
    try {
      label = buildLowLabelAcl(api, lowLabelSidPtr)
    } catch (error) {
      // 那次读取已经持有一个描述符分配块；在标签失败向外传播之前先释放它。
      if (descriptor !== null) api.localFree(descriptor)
      throw error
    }
    mergeAndApply(
      api, path,
      Buffer.concat([
        buildExplicitAccess(worldSidPtr, abi.DENY_ACCESS, abi.FILE_DELETE_CHILD, abi.CONTAINER_INHERIT_ACE),
        buildExplicitAccess(sidPtr, abi.GRANT_ACCESS, abi.GRANT_MASK),
      ]),
      oldAcl, { kind: 'apply', acl: label }, descriptor, 'grantWrite',
    )
  })
}

/**
 * 从该目录 DACL 中移除该能力 SID 的每一条 ACE（REVOKE_ACCESS 合并——其他
 * 条目予以保留）。共享的 Low 标签仅当该目录上不再残留任何其他能力授予时
 * 才被清除：两份授予可能指向同一个目录，而幸存的那一份仍需要该标签来完成
 * 其子项的写入。返回是否尝试过一次 ACE 移除（当该目录根本不携带 DACL 时
 * 返回 false）。
 *
 * 在按路径的锁之下运行（整个"取-合并-设"序列）；描述符/ACL 的分配契约
 * 见 {@link readCurrentSecurity}。
 * @param api - 绑定表。
 * @param path - 其 DACL 将失去这些能力 SID ACE 的目录。
 * @param sidPtr - 其 ACE 被移除的那个能力 SID。
 * @returns 是否尝试过一次 ACE 移除（当该目录根本不携带 DACL 时返回 false）。
 */
export function revokeWrite(api: Win32Bindings, path: string, sidPtr: NativePtr): boolean {
  return withPathLock(api, path, () => {
    const { oldAcl, descriptor } = readCurrentSecurity(api, path)
    if (oldAcl === null) {
      if (descriptor !== null) {
        const freed = api.localFree(descriptor)
        if (!isNullPtr(freed)) throwLastError(api, 'LocalFree', `revokeWrite(${path}) descriptor`)
      }
      return false
    }
    mergeAndApply(
      api, path, buildExplicitAccess(sidPtr, abi.REVOKE_ACCESS, 0), oldAcl,
      hasForeignGrant(oldAcl, sidPtr) ? { kind: 'keep' } : { kind: 'clear' },
      descriptor, 'revokeWrite',
    )
    return true
  })
}
