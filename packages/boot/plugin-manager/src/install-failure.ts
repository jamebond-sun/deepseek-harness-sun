/**
 * 一次失败的 pnpm 运行是什么，从它如何结束以及它打印了什么来读取：pnpm 用稳定的
 * `ERR_PNPM_*` 错误码与 Node 的 errno 名称来命名其失败，而运行捕获到的尾部无论何种
 * 区域设置都会携带它们。
 * @module @deepseek-ai/dsh-plugin-manager/install-failure
 */

import type { PluginInstallFailureKind } from './types.ts'

/** 一次运行结束的方式，超出其退出码之外。 */
export interface InstallFailureFacts {
  /** 失败所报告的输出的尾部。 */
  readonly log: string
  /** 子进程从未运行时的 spawn 错误。 */
  readonly cause?: unknown
  /** 该运行是否超出了其边界（超时）。 */
  readonly timedOut?: boolean
}

/** 按判定顺序排列的模式：特定的错误码排在通用的网络类别之前。 */
const LOG_KINDS: readonly [PluginInstallFailureKind, RegExp][] = [
  ['build-blocked', /ERR_PNPM_IGNORED_BUILDS|Ignored build scripts/],
  ['not-found', /ERR_PNPM_FETCH_404|\bE404\b|404 Not Found|Not Found - GET/],
  ['no-matching-version', /ERR_PNPM_NO_MATCHING_VERSION|\bETARGET\b|No matching version/],
  ['disk-full', /\bENOSPC\b|no space left on device/i],
  ['permission', /\bEACCES\b|\bEPERM\b|permission denied/i],
  ['integrity', /ERR_PNPM_TARBALL_INTEGRITY|ERR_PNPM_BAD_TARBALL_SIZE|\bEINTEGRITY\b/],
  ['unknown', /The requested URL returned error: 40[134]\b/],
  ['network', /\bENOTFOUND\b|\bECONNRESET\b|\bETIMEDOUT\b|\bECONNREFUSED\b|\bEAI_AGAIN\b|ERR_PNPM_META_FETCH_FAIL|ERR_PNPM_FETCH_5\d\d|ERR_PNPM_FETCH_TIMEOUT|\bFETCH_ERROR\b|socket hang up|Could not resolve host|unable to access/],
]

/**
 * 对一次失败的运行进行分类。
 * @param facts - 该运行如何结束以及它打印了什么。
 * @returns 失败种类，`unknown` 表示事实中没有任何一项能对应到某一类。
 */
export function classifyInstallFailure(facts: InstallFailureFacts): PluginInstallFailureKind {
  if (facts.timedOut === true) return 'timeout'
  if ((facts.cause as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return 'pnpm-missing'
  for (const [kind, pattern] of LOG_KINDS) {
    if (pattern.test(facts.log)) return kind
  }
  return 'unknown'
}
