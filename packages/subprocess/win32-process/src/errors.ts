/** 带有确切 API 名称与错误码的 Win32 调用失败。 */
export class Win32Error extends Error {
  /** 其受检查结果失败的 Win32 函数。 */
  readonly api: string
  /** 确切的 GetLastError 值或直接 Win32 API 错误码。 */
  readonly win32Code: number

  constructor(api: string, win32Code: number, detail?: string) {
    super(`${api} failed (Win32 ${win32Code})${detail === undefined ? '' : `: ${detail}`}`)
    this.name = 'Win32Error'
    this.api = api
    this.win32Code = win32Code
  }
}
