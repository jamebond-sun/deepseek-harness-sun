/**
 * 自适应目录选择组合的启动期后端判定：从采样到的宿主事实到具体后端类型的一次纯决策。
 * 调用方每次启动只采样一次，因此挂载后的能力在服务生命周期内保持稳定，这正是接缝的
 * 要求。
 * @module @deepseek-ai/dsh-host-directory-picker-auto/resolve
 */

import { isLoopbackHost, type Config as HttpServerConfig } from '@deepseek-ai/dsh-host-webserver'

/** 解析器在其中做选择的具体交互后端。 */
export type DirectoryPickerBackendKind = 'native' | 'browse'

/** 判定过程读取的环境键（`process.env` 的一个子集）。 */
export type DirectoryPickerEnv = Readonly<
  Partial<Record<'DISPLAY' | 'WAYLAND_DISPLAY', string>>
>

/** 后端选择所依据的宿主事实，启动时采样一次，判定是这些事实的纯函数。 */
export interface DirectoryPickerHostFacts {
  /** Webserver 生效的绑定地址（某个本地接口的具体 IP 字面量）。 */
  bindHost: HttpServerConfig['host']
  /**
   * Connection 信任策略是否接纳非回环来源（`trustedHosts` 中存在一条指向远程主机名的
   * 已校验条目）。
   */
  allowsRemoteAuthorities: boolean
  /** 宿主进程的平台。 */
  platform: NodeJS.Platform
  /** 来自继承进程层的 SSH 启动事实，与 `.env` 取值无关。 */
  ssh: boolean
  /** 环境采样；DISPLAY/WAYLAND_DISPLAY 标志 Linux 上存在显示会话。 */
  env: DirectoryPickerEnv
  /** PATH 上是否存在原生后端可驱动的 Linux 选择器二进制文件（zenity/kdialog）；仅当 `platform` 为 linux 时才参考。 */
  linuxChooser: boolean
}

/** 环境变量仅在已设置且非空白时才算存在（按 shell 约定，空导出等同于“未设置”）。 */
const present = (value: string | undefined): boolean => value !== undefined && value !== ''

/**
 * 判定本次启动由哪个后端提供服务。`native` 要求满足全部信号，以确保操作者能看到宿主
 * 显示器、且原生后端能够提供服务：不信任远程来源、绑定在回环地址（信任远程来源或绑定
 * 非回环地址都会接纳操作系统选择器触及不到的远程浏览器）、非 SSH 启动（转发连接无法显
 * 示服务端的选择器），并且存在可服务的显示会话——darwin/win32 上假定存在，linux 上要求
 * `DISPLAY`/`WAYLAND_DISPLAY` 且存在选择器二进制文件，其他平台则永不为真（原生后端只
 * 支持 darwin/win32/linux）。任何不确定的情况一律判定为
 * `browse`，它在任何环境都可用。
 * @param facts - 采样得到的宿主事实。
 * @returns 要挂载的后端类型。
 */
export function resolveDirectoryPickerBackend(facts: DirectoryPickerHostFacts): DirectoryPickerBackendKind {
  if (facts.allowsRemoteAuthorities || !isLoopbackHost(facts.bindHost)) return 'browse'
  if (facts.ssh) return 'browse'
  if (facts.platform === 'darwin' || facts.platform === 'win32') return 'native'
  if (facts.platform !== 'linux' || !facts.linuxChooser) return 'browse'
  return present(facts.env.DISPLAY) || present(facts.env.WAYLAND_DISPLAY) ? 'native' : 'browse'
}
