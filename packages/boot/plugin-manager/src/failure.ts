/** profile 管理操作共享的可本地化拒绝。 */
import type { PluginCompatibility } from '@deepseek-ai/dsh-app-boot'
import type { IncompatiblePlugin, ManagementError } from './types.ts'

/** 预期的管理拒绝；展示由调用方的区域设置负责。 */
export class ManagementFailure extends Error {
  /** 由调用方区域词典渲染的错误码。 */
  readonly code: ManagementError['code']
  /** 一个 `incompatible-version` 拒绝所点名的包。 */
  readonly incompatible: IncompatiblePlugin[] | undefined
  /**
   * @param code 可本地化的管理拒绝。
   * @param incompatible 运行中的 DSH 版本拒绝的包，用于 `incompatible-version`。
   */
  constructor(code: ManagementError['code'], incompatible?: IncompatiblePlugin[]) {
    super(code)
    this.code = code
    this.incompatible = incompatible
  }
}

/**
 * 从一个未被豁免的兼容性结果中丢弃豁免状态。
 * @param issue 其豁免未生效的结果。
 * @returns 包、运行时，以及未被满足的 DSH 要求。
 */
export function incompatiblePlugin(issue: PluginCompatibility): IncompatiblePlugin {
  return { name: issue.name, version: issue.version, runtimeVersion: issue.runtimeVersion, requirements: issue.requirements }
}
