/**
 * 在可注入的平台绑定之上，对 Win32 `IFileOpenDialog` 文件夹选择器的 COM 会话做纯顺序
 * 编排，从而让每条结果路径（选中、取消、HRESULT 失败、清理顺序）都能在任意平台上测试。
 * 基于 koffi 的绑定位于 `win32-dialog-bindings.ts`，只有真实的 win32 进程才会加载它。
 */

/** `HRESULT_FROM_WIN32(ERROR_CANCELLED)`：用户关闭了对话框。 */
export const HRESULT_CANCELLED = 0x800704c7 | 0

/** `FOS_PICKFOLDERS`：对话框选择目录而非文件。 */
export const FOS_PICKFOLDERS = 0x20
/** `FOS_FORCEFILESYSTEM`：只有具备文件系统路径的结果才可被选择。 */
export const FOS_FORCEFILESYSTEM = 0x40
/** `FOS_NOCHANGEDIR`：绝不改动进程的工作目录。 */
export const FOS_NOCHANGEDIR = 0x8

/** 一个已创建的文件夹对话框：编排所需的 vtable 调用。 */
export interface Win32FolderDialog {
  /**
   * `IFileDialog::SetOptions`。
   * @param options - 要应用的 `FOS_*` 标志并集。
   * @returns 该调用的 HRESULT。
   */
  setOptions(options: number): number
  /**
   * `IFileDialog::SetTitle`。
   * @param title - 对话框标题文本。
   * @returns 该调用的 HRESULT。
   */
  setTitle(title: string): number
  /**
   * `IModalWindow::Show`，无属主窗口；会阻塞调用线程直到用户选择或关闭。
   * @returns 该调用的 HRESULT（关闭时为 `HRESULT_CANCELLED`）。
   */
  show(): number
  /**
   * `IFileDialog::GetResult` + `IShellItem::GetDisplayName(SIGDN_FILESYSPATH)`，
   * 并在之后释放 shell item、释放 COM 字符串。
   * @returns 调用链的 HRESULT，成功时还返回所选路径。
   */
  resultPath(): { hr: number; path?: string }
  /** 释放对话框的 COM 引用。 */
  release(): void
}

/** 对话框编排所运行的线程级原生接口。 */
export interface Win32DialogBindings {
  /**
   * 让调用线程选择加入其所支持的最高 DPI 感知级别（per-monitor-v2，其次 per-monitor，
   * 再其次 system-aware），并检查每次调用的结果。这是刻意的尽力而为：即使宿主一个都不
   * 接受（或缺少该 API，1607 之前），也仍然显示现代对话框——超过 100% 缩放时可能发虚，
   * 因为观感上的退化不应让我们丢掉这一档实现。
   */
  setThreadDpiAwareness(): void
  /**
   * 在调用线程上执行 `CoInitializeEx(COINIT_APARTMENTTHREADED)`。
   * @returns 该调用的 HRESULT（重返入时的 `S_FALSE` 仍算成功）。
   */
  coInitializeSta(): number
  /**
   * 在调用线程上执行 `CoUninitialize`——COM 要求每一次成功（含 `S_FALSE`）的
   * `CoInitializeEx` 都配一次该调用，即使在会话结束后线程立即退出也一样。
   */
  coUninitialize(): void
  /**
   * `CoCreateInstance(CLSID_FileOpenDialog)`。
   * @returns 创建出的对话框接口；创建失败时抛出。
   */
  createFolderDialog(): Win32FolderDialog
  /**
   * `GetCurrentThreadId`——驱动从外部关闭本线程窗口所需的原生 id。
   * @returns 调用线程的原生 id。
   */
  currentThreadId(): number
  /**
   * 让 `Show` 即将创建的对话框能够取得前台。Windows 只把激活权限授予前台进程、由它
   * 启动的进程，或最近接收过输入的进程；由后台宿主（Web GUI 服务器）派生的 worker
   * 一条都不满足，对话框就会打开在所有其他窗口之后。通过 `keybd_event` 合成一次 Alt
   * 按下（先按下再抬起），即可让本进程被视为最近的输入所有者——这是社区记载的技巧，
   * 没有书面契约保证。请在 `Show` 之前立即调用。当进程本就拥有前台权限时（控制台启动
   * 的 CLI），该按键是无效的，但焦点窗口仍会收到这一次单独的 Alt，并可能在对话框激活
   * 前短暂高亮其菜单栏。
   */
  pressAltForForeground(): void
}

/**
 * 当 HRESULT 表示失败时抛出错误。
 * @param hr - 待检查的 HRESULT。
 * @param what - 失败调用的名称，用于错误信息。
 * @returns 原样返回（成功的）HRESULT。
 */
function check(hr: number, what: string): number {
  if (hr < 0) throw new Error(`${what} failed: HRESULT 0x${(hr >>> 0).toString(16)}`)
  return hr
}

/**
 * 在调用线程上跑一次模态文件夹选择会话：DPI 选择加入、STA 初始化、创建对话框、`Show`
 * 以及结果提取，并在每条路径上释放对话框。
 * @param bindings - 原生接口（生产环境为 koffi 实现，测试中为替身）。
 * @param title - 对话框标题文本。
 * @param onShowing - 在阻塞的 `Show` 之前立即以原生线程 id 调用，使另一线程上的驱动
 *   可以关闭该对话框。
 * @returns 所选的文件系统路径；用户取消时为 null。
 */
export function runFolderDialog(
  bindings: Win32DialogBindings,
  title: string,
  onShowing: (threadId: number) => void,
): string | null {
  bindings.setThreadDpiAwareness()
  check(bindings.coInitializeSta(), 'CoInitializeEx')
  // 从此刻起单元已初始化（S_OK 或 S_FALSE），每条路径上都必须恰好反初始化一次。
  try {
    const dialog = bindings.createFolderDialog()
    try {
      check(dialog.setOptions(FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_NOCHANGEDIR), 'SetOptions')
      check(dialog.setTitle(title), 'SetTitle')
      onShowing(bindings.currentThreadId())
      bindings.pressAltForForeground()
      const shown = dialog.show()
      if (shown === HRESULT_CANCELLED) return null
      check(shown, 'Show')
      const result = dialog.resultPath()
      check(result.hr, 'GetResult')
      return result.path as string
    } finally {
      dialog.release()
    }
  } finally {
    bindings.coUninitialize()
  }
}
