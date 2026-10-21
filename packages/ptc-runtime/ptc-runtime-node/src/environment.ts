/** 在模型求值之前，原生可执行文件所需的启动变量。 */

/** 操作系统环境中保留的：原生可执行文件搜索路径、Windows 系统路径，以及沙箱临时路径。 */
export const STARTUP_ENVIRONMENT_NAMES: ReadonlySet<string> = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP'])

/**
 * 清除继承而来的凭据，同时保留原生子进程所需的启动路径。
 * @param state - 子进程环境，会被替换为一个程序可见的空对象。
 */
export function clearProgramEnvironment(state: { env: NodeJS.ProcessEnv }): void {
  for (const key of Object.keys(state.env)) {
    if (!STARTUP_ENVIRONMENT_NAMES.has(key.toUpperCase())) Reflect.deleteProperty(state.env, key)
  }
  state.env = Object.create(null) as NodeJS.ProcessEnv
}
