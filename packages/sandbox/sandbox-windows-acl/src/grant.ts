/**
 * 服务端写入授予的物化。沙箱接缝为每个工作区持有一份常驻的工作区授予，
 * 并为每个活跃的会话/工作区对持有一份可撤销的临时授予。工作区身份依靠
 * 确定性派生及其常驻 ACE 得以留存；临时身份由随机的私有路径派生，重启后
 * 刻意取新的。
 *
 * 失败即关闭：`add` 在任何授予失败时抛出，由调用方释放该实例（撤销迄今
 * 已授予的每一个路径）；`dispose` 撤销每一个可撤销的授予、保留常驻的
 * 工作区编辑不动，并上报每一次清理失败。
 * @module @deepseek-ai/dsh-sandbox-windows-acl/grant
 */

import { grantWrite, revokeWrite } from './acl.ts'
import { allocPtrSlot, decodePtr, isNullPtr, throwLastError, win32Sync } from './ffi.ts'
import type { NativePtr, Win32Bindings } from './ffi.ts'
import { makeWellKnownSid } from './token.ts'
import * as abi from './win32-abi.ts'

/**
 * 一个写入 SID 在提供者生命周期内的授予物化：已解析的 SID 指针，加上每一个
 * 其 DACL 当前携带着该 ACE、且其标签 ACL 携带着 Low 强制标签的目录。工作区
 * 路径以常驻方式加入（它们的安全描述符编辑就是跨会话复用缓存，比这份授予
 * 活得更久——dispose() 会跳过对它们的撤销，否则下一次供应就得重新传播整棵
 * 树）；临时路径是可撤销的（dispose() 会撤销它们——一个可继承的 ACE 决不能
 * 比它所属会话的临时目录活得更久）。用 {@link AclWriteGrant.create} 创建；
 * dispose 会撤销那些可撤销的路径并释放每一个 SID。
 */
export class AclWriteGrant {
  /** SDDL 字符串形式的写入 SID。 */
  readonly writeSid: string
  private readonly api: Win32Bindings
  private readonly sidPtr: NativePtr
  private readonly lowLabelSidPtr: NativePtr
  private readonly worldSidPtr: NativePtr
  private readonly revocablePaths: string[] = []
  private readonly standingPaths: string[] = []

  private constructor(
    api: Win32Bindings,
    sidPtr: NativePtr,
    lowLabelSidPtr: NativePtr,
    worldSidPtr: NativePtr,
    writeSid: string,
  ) {
    this.api = api
    this.sidPtr = sidPtr
    this.lowLabelSidPtr = lowLabelSidPtr
    this.worldSidPtr = worldSidPtr
    this.writeSid = writeSid
  }

  /**
   * 解析该 SID 字符串，创建这些授予用于打标签的 Low 完整性 SID、以及其
   * 环境删除拒绝所点名的 world SID，并打开绑定表（惰性，每服务器一次）。
   * 失败即关闭：任何失败都抛出——此时尚未授予任何东西。
   * @param writeSid - 工作区（`S-1-4-x-y`）或临时目录（`S-1-4-x-y-1`）的能力 SID 字符串。
   * @param api - 可选的、已解析好的绑定表（测试用）。
   * @returns 就绪的授予（此时还没有任何 ACE）。
   */
  static create(writeSid: string, api?: Win32Bindings): AclWriteGrant {
    const bindings = api ?? win32Sync()
    const sidSlot = allocPtrSlot()
    if (bindings.convertStringSidToSidW(writeSid, sidSlot) === 0) {
      throwLastError(bindings, 'ConvertStringSidToSidW', writeSid)
    }
    const sidPtr = decodePtr(sidSlot)
    if (sidPtr === null) throwLastError(bindings, 'ConvertStringSidToSidW', `null SID for ${writeSid}`)
    try {
      const lowLabelSidPtr = makeWellKnownSid(bindings, abi.WinLowLabelSid)
      try {
        const worldSidPtr = makeWellKnownSid(bindings, abi.WinWorldSid)
        return new AclWriteGrant(bindings, sidPtr, lowLabelSidPtr, worldSidPtr, writeSid)
      } catch (error) {
        // Low 标签 SID 是由 LocalAlloc 分配的：在 world SID 的失败传播到
        // 下面对 sidPtr 的释放之前，先把它释放掉。
        bindings.localFree(lowLabelSidPtr)
        throw error
      }
    } catch (error) {
      bindings.localFree(sidPtr)
      throw error
    }
  }

  /**
   * 在一个目录上授予写入 ACE、环境删除拒绝与 Low 强制标签（幂等：一个已经
   * 常驻的精确 ACE、拒绝与标签会跳过那次急切的整树重新传播——见
   * {@link grantWrite}），并在它不是常驻路径时把该路径记录给 {@link dispose}。
   * 路径是在授予之前记录的：一次应用后抛错（SetNamedSecurityInfoW 成功之后
   * 的 LocalFree 失败）也必须仍然撤销它，而撤销一个从未授予过的路径是一次
   * 空操作式的合并。调用方把抛出视为一次失败的物化，并释放该实例以撤销
   * 迄今已授予的路径。
   * @param path - 其 DACL 与标签将获得该授予的目录。
   * @param standing - 这些编辑比本授予活得更久（工作区复用缓存；
   *   dispose() 会跳过对它的撤销）。默认 false（在 dispose 时撤销——
   *   即临时目录的生命周期）。
   */
  add(path: string, standing = false): void {
    ;(standing ? this.standingPaths : this.revocablePaths).push(path)
    grantWrite(this.api, path, this.sidPtr, this.lowLabelSidPtr, this.worldSidPtr)
  }

  /** 当前承载着该授予的所有目录，按授予顺序排列。 */
  get paths(): readonly string[] {
    return [...this.standingPaths, ...this.revocablePaths]
  }

  /** 撤销每一个可撤销的授予（常驻的安全描述符编辑保留）并释放这些 SID；上报每一次清理失败。 */
  dispose(): void {
    const failures: unknown[] = []
    for (const path of this.revocablePaths) {
      try {
        revokeWrite(this.api, path, this.sidPtr)
      } catch (error) {
        failures.push(error)
      }
    }
    for (const [label, sidPtr] of [
      ['write SID', this.sidPtr],
      ['Low label SID', this.lowLabelSidPtr],
      ['world SID', this.worldSidPtr],
    ] as const) {
      try {
        const freed = this.api.localFree(sidPtr)
        if (!isNullPtr(freed)) throwLastError(this.api, 'LocalFree', label)
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `AclWriteGrant dispose completed with ${failures.length} cleanup failure(s)`)
    }
  }
}
