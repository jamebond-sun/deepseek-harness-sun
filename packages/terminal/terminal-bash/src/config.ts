/** 本地 PTY 后端校验后的配置。 */

import z from '@deepseek-ai/schemastery'
import { resolvePwshPath } from '@deepseek-ai/dsh-pwsh-local'

/** 一种受支持的交互式 shell 方言。 */
export type ShellDialect = 'bash' | 'pwsh'

/** 公共插件配置。 */
export interface Config {
  /** Backend registry type (default: `shell`). */
  backendType?: string
  /** Interactive shell dialect (default: `bash`); selects the argv/env/startup defaults. */
  shellDialect?: ShellDialect
  /** Interactive shell executable (default per dialect: `/bin/bash`, or the resolved pwsh). */
  shellPath?: string
  /** Shell arguments (default per dialect: bash `--noprofile --norc -i`, pwsh `-NoLogo -NoProfile`). */
  shellArgs?: string[]
  /** Terminal rows. */
  rows?: number
  /** Terminal columns. */
  cols?: number
  /** Maximum retained logical lines. */
  scrollbackLines?: number
  /** Maximum retained UTF-8 bytes. */
  scrollbackMaxBytes?: number
  /** Maximum bytes returned by one read or settled viewport. */
  maxReadBytes?: number
  /** Readiness polling interval. */
  pollIntervalMs?: number
  /** Delay before Linux exact syscall probes. */
  exactProbeAfterMs?: number
  /** Silence duration that yields `inferred_idle`. */
  idleSilenceMs?: number
  /**
   * Extra wait beyond `idleSilenceMs`, once a prompt marker was seen, for the shell to
   * regain the foreground before `inferred_idle` settles; at least one `pollIntervalMs`.
   */
  handoffGraceMs?: number
  /**
   * Extra wait beyond `idleSilenceMs` and `handoffGraceMs`, once a prompt marker was seen but
   * its printable tail has not arrived, before `inferred_idle` settles. The marker is written
   * by the shell's own prompt function and the tail by the same render, so a missing tail is a
   * delivery delay on a contended host rather than an absent prompt. Zero keeps the bound at
   * `idleSilenceMs + handoffGraceMs`; any other value covers at least one `pollIntervalMs`, so a
   * nonzero tolerance always contains a readiness poll.
   */
  promptTailGraceMs?: number
  /** Absolute bound for one send and the complete pwsh startup sequence. */
  timeoutMs?: number
  /** Grace before teardown escalates to `SIGKILL`. */
  disposeGraceMs?: number
}

/** 经过 Schemastery 默认值与方言解析后的配置。 */
export type ResolvedConfig = Omit<Required<Config>, 'shellDialect' | 'shellPath' | 'shellArgs'> & {
  shellDialect: ShellDialect
  shellPath: string
  shellArgs: string[]
}

/** Bash 方言的默认可执行文件。 */
export const DEFAULT_BASH_SHELL = '/bin/bash'
/** Bash 方言的默认参数（交互式、无 profile）。 */
export const DEFAULT_BASH_ARGS = ['--noprofile', '--norc', '-i']
/** Pwsh 方言的默认参数（交互式宿主、无 profile）。 */
export const DEFAULT_PWSH_ARGS = ['-NoLogo', '-NoProfile']

/**
 * 解析各方言真正生效的 shell 规格。默认值设定本就是这一显式步骤：未设置或为空数组的
 * `shellPath`/`shellArgs` 会选择该方言的默认值，而非空显式值始终优先。
 * （Schemastery 会将缺失的可选数组物化为 `[]`，因此“为空”——不仅仅是 `undefined`——
 * 即表示“方言默认”。）
 * @param config - Schemastery 解析后的插件配置。
 * @returns 完全解析后的配置。
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const shellDialect = config.shellDialect ?? 'bash'
  return {
    ...(config as Required<Config>),
    shellDialect,
    shellPath: config.shellPath !== undefined && config.shellPath.length > 0
      ? config.shellPath
      : (shellDialect === 'pwsh' ? resolvePwshPath() : DEFAULT_BASH_SHELL),
    shellArgs: config.shellArgs !== undefined && config.shellArgs.length > 0
      ? config.shellArgs
      : (shellDialect === 'pwsh' ? DEFAULT_PWSH_ARGS : DEFAULT_BASH_ARGS),
  }
}

/** 插件暴露的 Schemastery 配置。 */
export const Config: z<Config> = z.object({
  backendType: z.string().default('shell'),
  shellDialect: z.union(['bash', 'pwsh'] as const).default('bash'),
  shellPath: z.string().required(false),
  shellArgs: z.array(z.string()).required(false),
  rows: z.number().default(40),
  cols: z.number().default(160),
  scrollbackLines: z.number().default(10_000),
  scrollbackMaxBytes: z.number().default(4 * 1024 * 1024),
  maxReadBytes: z.number().default(256 * 1024),
  pollIntervalMs: z.number().default(50),
  exactProbeAfterMs: z.number().default(150),
  idleSilenceMs: z.number().default(3_000),
  handoffGraceMs: z.number().default(500),
  promptTailGraceMs: z.number().default(0),
  timeoutMs: z.number().default(30_000),
  disposeGraceMs: z.number().default(3_000),
})

/**
 * Assert every effective numeric config field is a positive safe integer — except
 * `promptTailGraceMs`, whose zero is the documented "no extension" value — and that bounds
 * compose.
 * @param config - Schemastery-resolved plugin configuration.
 * @returns Narrows the input to the fully resolved configuration.
 */
export function validateConfig(config: Config): asserts config is ResolvedConfig {
  const resolved = config as ResolvedConfig
  if (resolved.backendType.length === 0) throw new Error('terminal-bash: backendType must be non-empty')
  if (resolved.shellPath.length === 0) throw new Error('terminal-bash: shellPath must be non-empty')
  for (const [name, value] of Object.entries(resolved)) {
    if (name === 'promptTailGraceMs') continue
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new Error(`terminal-bash: ${name} must be a positive safe integer`)
    }
  }
  if (typeof resolved.promptTailGraceMs === 'number'
    && (!Number.isSafeInteger(resolved.promptTailGraceMs) || resolved.promptTailGraceMs < 0)) {
    throw new Error('terminal-bash: promptTailGraceMs must be a non-negative safe integer')
  }
  if (resolved.maxReadBytes > resolved.scrollbackMaxBytes) {
    throw new Error('terminal-bash: maxReadBytes must not exceed scrollbackMaxBytes')
  }
  if (resolved.handoffGraceMs < resolved.pollIntervalMs) {
    throw new Error('terminal-bash: handoffGraceMs must be at least pollIntervalMs so one readiness poll runs inside the grace window')
  }
  if (resolved.promptTailGraceMs !== 0 && resolved.promptTailGraceMs < resolved.pollIntervalMs) {
    throw new Error('terminal-bash: promptTailGraceMs must be zero or at least pollIntervalMs so a nonzero tolerance contains one readiness poll')
  }
}
