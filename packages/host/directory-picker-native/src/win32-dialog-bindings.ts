/**
 * 文件夹对话框的 koffi 版 Win32 绑定：{@link Win32DialogBindings} 背后的 COM vtable 调用，
 * 以及驱动用于响应中止的跨线程窗口关闭器。本模块在所有平台都会加载；koffi 本身则在每个
 * 函数内部惰性导入，因此非 Windows 进程永远不会加载它——与仓库中其他 `win32.ts` 模块
 * 采用相同的隔离方式。
 *
 * 此处用到的 COM 接口（IModalWindow/IFileDialog/IFileOpenDialog 与 IShellItem 的 vtable
 * 顺序、相关 GUID、`FOS_*` 与 `SIGDN_FILESYSPATH`）是自 Vista 起冻结的 Windows ABI；
 * 槽位是对象首个指针所指向 vtable 中的偏移量。
 */

import type { Win32DialogBindings, Win32FolderDialog } from './win32-dialog-logic.ts'

interface KoffiFunction { (...args: unknown[]): unknown }
interface KoffiLibrary { func(convention: string, name: string, result: string, args: string[]): KoffiFunction }
interface Koffi {
  load(path: string): KoffiLibrary
  proto(declaration: string): unknown
  pointer(type: unknown): unknown
  call(pointer: unknown, proto: unknown, ...args: unknown[]): unknown
  decode(value: unknown, offsetOrType: unknown, type?: unknown): unknown
  register(fn: (...args: unknown[]) => unknown, type: unknown): unknown
  unregister(callback: unknown): void
  sizeof(type: string): number
}

/**
 * 在不需要外部缓冲区的情况下读取一段合法的 NUL 结尾 UTF-16 分配内存。
 * 通用的 `koffi.decode(..., 'str16')` 需要一个指针变量，因此缓冲区里存放的是字符串
 * 地址而不是字符串字节。
 * @param koffi - 已加载的 koffi 绑定。
 * @param address - `_Out_ void **` 参数给出的字符串地址。
 * @param pointerSize - 进程的指针宽度（`koffi.sizeof('void *')`）。
 * @returns 解码出的 UTF-16 路径。
 */
function readUtf16(koffi: Koffi, address: unknown, pointerSize: number): string {
  const pointer = Buffer.alloc(8)
  // koffi 3 把 `_Out_ void **` 的值以 BigInt 形式的原生地址呈现。
  pointer.writeBigUInt64LE(BigInt(address as bigint | number))
  return koffi.decode(pointer.subarray(0, pointerSize), 'str16') as string
}

const COINIT_APARTMENTTHREADED = 0x2
const CLSCTX_INPROC_SERVER = 0x1
const SIGDN_FILESYSPATH = 0x80058000 | 0
/**
 * 线程 DPI 感知上下文，按优先级从高到低：per-monitor-v2（Windows 10 1703+）、
 * per-monitor（1607+），最后是 system-aware。`SetThreadDpiAwarenessContext`
 * 对不支持的上下文返回 NULL 而不是抛出错误，因此调用方逐级回退到宿主可接受的最高一级；
 * DPI 始终只是观感上的尽力而为——即使宿主不支持，也仍然会拿到现代对话框。
 */
const DPI_AWARENESS_CONTEXTS = [-4, -3, -2]
const WM_CLOSE = 0x10
/** `VK_MENU`：合成的 Alt 按下所对应的虚拟键。 */
const VK_MENU = 0x12
/** `KEYEVENTF_KEYUP`：合成的 Alt 按下所用的释放标志。 */
const KEYEVENTF_KEYUP = 0x2

/** IFileOpenDialog 的 vtable 槽位（IUnknown 0-2，IModalWindow 3，IFileDialog 4+）。 */
const SLOT_RELEASE = 2
const SLOT_SHOW = 3
const SLOT_SET_OPTIONS = 9
const SLOT_SET_TITLE = 17
const SLOT_GET_RESULT = 20
/** IShellItem 中 `GetDisplayName` 的 vtable 槽位。 */
const SLOT_GET_DISPLAY_NAME = 5

/**
 * 将规范形式的 GUID 字符串编码为其 16 字节小端表示。
 * @param text - `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` 形式。
 * @returns CoCreateInstance 所需的内存内 GUID 字节。
 */
function guidBytes(text: string): Buffer {
  const match = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/i.exec(text) as RegExpExecArray
  const bytes = Buffer.alloc(16)
  bytes.writeUInt32LE(parseInt(match[1] as string, 16), 0)
  bytes.writeUInt16LE(parseInt(match[2] as string, 16), 4)
  bytes.writeUInt16LE(parseInt(match[3] as string, 16), 6)
  Buffer.from((match[4] as string) + (match[5] as string), 'hex').copy(bytes, 8)
  return bytes
}

const CLSID_FILE_OPEN_DIALOG = guidBytes('dc1c5a9c-e88a-4dde-a5a1-60f82a20aef7')
const IID_IFILE_OPEN_DIALOG = guidBytes('d57c7288-d4ad-4768-be02-9d969532d960')

/**
 * 加载 koffi 并为当前线程暴露对话框绑定。
 * @returns {@link runFolderDialog} 所编排调用的绑定。
 */
export async function loadWin32DialogBindings(): Promise<Win32DialogBindings> {
  const koffi = (await import('koffi')).default as Koffi
  const ole32 = koffi.load('ole32.dll')
  const user32 = koffi.load('user32.dll')
  const kernel32 = koffi.load('kernel32.dll')

  // vtable 槽位与出参指针都是指针宽度的偏移量：x64/arm64 上为 8，ia32 上为 4——
  // koffi 报告的是当前运行进程的宽度。
  const pointerSize = koffi.sizeof('void *')
  const coInitializeEx = ole32.func('__stdcall', 'CoInitializeEx', 'int32', ['void *', 'uint32'])
  const coUninitialize = ole32.func('__stdcall', 'CoUninitialize', 'void', [])
  const coCreateInstance = ole32.func('__stdcall', 'CoCreateInstance', 'int32', ['void *', 'void *', 'uint32', 'void *', 'void *'])
  const coTaskMemFree = ole32.func('__stdcall', 'CoTaskMemFree', 'void', ['void *'])
  const getCurrentThreadId = kernel32.func('__stdcall', 'GetCurrentThreadId', 'uint32', [])
  const keybdEvent = user32.func('__stdcall', 'keybd_event', 'void', ['uint8', 'uint8', 'uint32', 'uintptr'])

  const protoShow = koffi.proto('int32 __stdcall DshDialogShow(void *self, void *owner)')
  const protoSetOptions = koffi.proto('int32 __stdcall DshDialogSetOptions(void *self, uint32 options)')
  const protoSetTitle = koffi.proto('int32 __stdcall DshDialogSetTitle(void *self, str16 title)')
  const protoGetResult = koffi.proto('int32 __stdcall DshDialogGetResult(void *self, _Out_ void **item)')
  const protoGetDisplayName = koffi.proto('int32 __stdcall DshItemGetDisplayName(void *self, int32 form, _Out_ void **name)')
  const protoRelease = koffi.proto('uint32 __stdcall DshComRelease(void *self)')

  /** 通过 `proto` 把 COM 对象 `self` 的 vtable 槽位 `slot` 绑定为可调用函数。 */
  const method = (self: unknown, slot: number, proto: unknown): (...args: unknown[]) => number => {
    const vtable = koffi.decode(self, 'void *')
    const fn = koffi.decode(vtable, slot * pointerSize, 'void *')
    return (...args: unknown[]) => koffi.call(fn, proto, self, ...args) as number
  }

  return {
    setThreadDpiAwareness: () => {
      let setContext: KoffiFunction
      try {
        setContext = user32.func('__stdcall', 'SetThreadDpiAwarenessContext', 'void *', ['intptr'])
      } catch {
        // 符号不存在（1607 之前的 Windows）：不存在任何按线程的 DPI 控制能力。
        // 仍然继续——代价只是在这类老宿主上超过 100% 缩放时对话框发虚，而为了一个观感
        // 问题退回旧的 5.1 目录树远不如保留现代选择器。
        return
      }
      for (const context of DPI_AWARENESS_CONTEXTS) {
        if (setContext(context) !== null) return
      }
      // 实践中不可达（只要有该符号，SYSTEM_AWARE 就会被接受）；即便某个宿主拒绝全部
      // 上下文，对话框依然可用——只是没有 DPI 选择加入而已。
    },
    coInitializeSta: () => coInitializeEx(null, COINIT_APARTMENTTHREADED) as number,
    coUninitialize: () => {
      coUninitialize()
    },
    currentThreadId: () => getCurrentThreadId() as number,
    pressAltForForeground: () => {
      keybdEvent(VK_MENU, 0, 0, 0)
      keybdEvent(VK_MENU, 0, KEYEVENTF_KEYUP, 0)
    },
    createFolderDialog: (): Win32FolderDialog => {
      const out = Buffer.alloc(pointerSize)
      const created = coCreateInstance(CLSID_FILE_OPEN_DIALOG, null, CLSCTX_INPROC_SERVER, IID_IFILE_OPEN_DIALOG, out) as number
      if (created < 0) throw new Error(`CoCreateInstance(FileOpenDialog) failed: HRESULT 0x${(created >>> 0).toString(16)}`)
      const dialog = koffi.decode(out, 'void *')
      return {
        setOptions: options => method(dialog, SLOT_SET_OPTIONS, protoSetOptions)(options),
        setTitle: title => method(dialog, SLOT_SET_TITLE, protoSetTitle)(title),
        show: () => method(dialog, SLOT_SHOW, protoShow)(null),
        resultPath: () => {
          const itemOut: unknown[] = [null]
          const gotItem = method(dialog, SLOT_GET_RESULT, protoGetResult)(itemOut)
          if (gotItem < 0) return { hr: gotItem }
          const item = itemOut[0]
          try {
            const nameOut: unknown[] = [null]
            const gotName = method(item, SLOT_GET_DISPLAY_NAME, protoGetDisplayName)(SIGDN_FILESYSPATH, nameOut)
            if (gotName < 0) return { hr: gotName }
            const path = readUtf16(koffi, nameOut[0], pointerSize)
            coTaskMemFree(nameOut[0])
            return { hr: gotName, path }
          } finally {
            method(item, SLOT_RELEASE, protoRelease)()
          }
        },
        release: () => {
          method(dialog, SLOT_RELEASE, protoRelease)()
        },
      }
    },
  }
}

/**
 * 向某个原生线程的每个窗口投递 `WM_CLOSE`——这是驱动针对阻塞在 `Show` 内部的 worker 的
 * 中止手段；之后 `Show` 会返回 `HRESULT_CANCELLED`，worker 便正常退出。
 * @param threadId - 对话框线程的原生 id（来自 `showing` 通知）。
 */
export async function closeThreadWindows(threadId: number): Promise<void> {
  const koffi = (await import('koffi')).default as Koffi
  const user32 = koffi.load('user32.dll')
  const enumThreadWindows = user32.func('__stdcall', 'EnumThreadWindows', 'int', ['uint32', 'void *', 'intptr'])
  const postMessageW = user32.func('__stdcall', 'PostMessageW', 'int', ['void *', 'uint32', 'uintptr', 'intptr'])
  const protoEnumProc = koffi.proto('int __stdcall DshEnumThreadWndProc(void *hwnd, intptr lparam)')
  const callback = koffi.register((hwnd: unknown) => {
    postMessageW(hwnd, WM_CLOSE, 0, 0)
    return 1
  }, koffi.pointer(protoEnumProc))
  try {
    enumThreadWindows(threadId, callback, 0)
  } finally {
    koffi.unregister(callback)
  }
}
