/**
 * 从共享的受管进程句柄到官方 Claude Agent SDK 自定义 spawn 进程接口的投影。
 *
 * @module @deepseek-ai/dsh-subagent-claude-code/process
 */

import { EventEmitter } from 'node:events'
import type {
  SpawnedProcess,
  SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk'
import {
  scrubbedParentEnv,
  type SubprocessHandle,
  type SubprocessOutcome,
  type SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'

function thrown(value: unknown): Error {
  /* v8 ignore next -- subprocess 接缝以 Error 拒绝。 */
  return value instanceof Error ? value : new Error(String(value))
}

/**
 * 把 SDK 完整的子环境编码为一个 subprocess 覆盖层。
 * @param env - 在其移除与替换之后的、由 SDK 组成的子环境。
 * @returns 显式值，外加针对 SDK 已移除但仍存活的环境名称的墓碑。
 */
export function sdkEnvironmentOverlay(
  env: SpawnOptions['env'],
): NodeJS.ProcessEnv {
  const overlay: NodeJS.ProcessEnv = { ...env }
  for (const name of Object.keys(scrubbedParentEnv())) {
    if (!(name in env)) overlay[name] = undefined
  }
  return overlay
}

/**
 * 把一个官方 SDK spawn 请求翻译给共享的进程属主。
 * @param options - 来自 SDK 的命令、实参、工作区、环境与转发信号。
 * @param graceMs - 受管范围终止宽限。
 * @returns 完全显式的共享 subprocess 请求。
 */
export function claudeSpawnSpec(
  options: SpawnOptions,
  graceMs: number,
): SubprocessSpawnSpec {
  if (options.cwd === undefined || options.cwd.length === 0) {
    throw new Error('subagent-claude-code: SDK spawn request omitted its workspace')
  }
  return {
    argv: [options.command, ...options.args],
    cwd: options.cwd,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
    graceMs,
    signal: options.signal,
    env: sdkEnvironmentOverlay(options.env),
  }
}

/**
 * 一个共享受管进程的、面向 SDK 的视图。协议传输仍留在官方 SDK 中；
 * 本适配器只投影流与退出事件。
 */
export class ManagedClaudeCodeProcess implements SpawnedProcess {
  readonly stdin
  readonly stdout
  private readonly events = new EventEmitter()
  private outcomeValue: SubprocessOutcome | undefined
  private killRequested = false

  /**
   * 投影一个带有管道 stdin 与 stdout 的受管进程。
   * @param child - 仍是受管范围权威的共享句柄。
   */
  constructor(private readonly child: SubprocessHandle) {
    this.stdin = child.stdin as NonNullable<SubprocessHandle['stdin']>
    this.stdout = child.stdout as NonNullable<SubprocessHandle['stdout']>
    // EventEmitter 在没有监听器时给 `error` 特殊的抛出语义。
    // SDK 在自定义 spawn 返回之后同步附加其监听器，而这个空操作同时也
    // 隔离了一个已被拒绝的 spawn 句柄。
    this.events.on('error', () => {})
    void child.done.then(
      (outcome) => {
        this.outcomeValue = outcome
        this.events.emit('exit', outcome.exitCode, outcome.signal)
      },
      (error: unknown) => {
        this.events.emit('error', thrown(error))
      },
    )
  }

  /** SDK 是否已请求受管范围终止。 */
  get killed(): boolean {
    return this.killRequested
  }

  /** 直接子进程的退出码，运行中或信号退出之后为 null。 */
  get exitCode(): number | null {
    return this.outcomeValue?.exitCode ?? null
  }

  /** 直接子进程的终止信号，若有。 */
  get signalCode(): NodeJS.Signals | null {
    return this.outcomeValue?.signal ?? null
  }

  /** 退出之后的精确受管进程结果，运行中则为 undefined。 */
  get outcome(): SubprocessOutcome | undefined {
    return this.outcomeValue
  }

  /**
   * 把 SDK 的终止请求路由给受管范围进程属主。
   * @param _signal - SDK 选择的信号；共享接缝拥有它自己的升级阶梯。
   * @returns 仅在退出之后或已有先前终止请求时为 false。
   */
  kill(_signal: NodeJS.Signals): boolean {
    if (
      this.killRequested
      || this.outcomeValue !== undefined
    ) {
      return false
    }
    this.killRequested = true
    this.child.terminate()
    return true
  }

  /** 注册一个持久的进程生命周期监听器。 */
  on(
    event: 'exit' | 'error',
    listener: ((code: number | null, signal: NodeJS.Signals | null) => void)
      | ((error: Error) => void),
  ): void {
    this.events.on(event, listener)
  }

  /** 注册一个一次性的进程生命周期监听器。 */
  once(
    event: 'exit' | 'error',
    listener: ((code: number | null, signal: NodeJS.Signals | null) => void)
      | ((error: Error) => void),
  ): void {
    this.events.once(event, listener)
  }

  /** 移除一个进程生命周期监听器。 */
  off(
    event: 'exit' | 'error',
    listener: ((code: number | null, signal: NodeJS.Signals | null) => void)
      | ((error: Error) => void),
  ): void {
    this.events.off(event, listener)
  }
}
