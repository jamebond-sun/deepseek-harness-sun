/** 基于注入的主机观测所做 Linux 原生隔离决策。 */

import type { LiteralArgvOptions } from './linux-scope.ts'

/** 每次决策背后的主机观测；运行时提供真实检查，测试则通过脚本设定它们。 */
export interface LinuxScopeObservations {
  /** 运行深度临时 scope 探测：当 scope 可启动时返回字面 argv 选项，否则为 undefined。 */
  probe(): LiteralArgvOptions | undefined
  /** 识别正在用户管理器私有套接字上监听的进程，若无人监听则为 undefined。 */
  managerListener(): string | undefined
  /** Confirm the user manager before a launch under a positive verdict. */
  confirmManager(): boolean
  /** 识别 scope 启动所解析到的 systemd-run 可执行文件，若无法解析则为 undefined。 */
  launcherIdentity(): string | undefined
}

/** Event that made the selector probe: the first selection or one that invalidated the previous verdict. */
export type LinuxProbeTrigger = 'first' | 'scope-not-started' | 'new-listener' | 'launcher-changed'

/** One containment decision and the branch that produced it. */
export type LinuxScopeDecision =
  | {
    readonly kind: 'scope'
    /** A probe found scope support, or a positive verdict confirmed the user manager. */
    readonly reason: 'probe-available' | 'manager-confirmed'
    readonly literalArgv: LiteralArgvOptions
    /** Probe count when the verdict was made; pass it to scopeNotStarted for a failed launch. */
    readonly generation: number
    readonly probe: LinuxProbeTrigger | undefined
  }
  | {
    readonly kind: 'fallback'
    /**
     * A probe found no scope support; a positive verdict failed to confirm the manager for this launch;
     * or a negative verdict saw no listener or the listener present at the failed probe.
     */
    readonly reason: 'probe-unavailable' | 'manager-unconfirmed' | 'no-listener' | 'same-listener'
    readonly probe: LinuxProbeTrigger | undefined
  }

type LinuxScopeState =
  | { readonly kind: 'unprobed'; readonly trigger: LinuxProbeTrigger }
  | { readonly kind: 'available'; readonly literalArgv: LiteralArgvOptions; readonly launcher: string | undefined }
  | { readonly kind: 'unavailable'; readonly listener: string | undefined }

/**
 * 提供方生命周期内的 Linux scope 选择。探测在首次选择时运行，且仅在以下情况再次运行：
 * 某次 scope 启动从未启动其目标；否定结论下出现了不同的用户管理器监听者；
 * 或肯定结论下 systemd-run 可执行文件发生变化。肯定结论会在每次选择时确认用户管理器。
 * 选择是同步的，因此一个决策对其随后的那次启动始终有效。
 */
export class LinuxScopeSelector {
  private state: LinuxScopeState = { kind: 'unprobed', trigger: 'first' }
  private generation = 0

  /** @param observe - 每次选择都会咨询的主机检查。 */
  constructor(private readonly observe: LinuxScopeObservations) {}

  /**
   * 为一次符合资格的启动选择隔离方式。
   * @returns 决策及其所产生的分支。
   */
  select(): LinuxScopeDecision {
    const state = this.state
    if (state.kind === 'unprobed') return this.probe(state.trigger)
    if (state.kind === 'available') {
      if (this.observe.launcherIdentity() !== state.launcher) return this.probe('launcher-changed')
      return this.observe.confirmManager()
        ? { kind: 'scope', reason: 'manager-confirmed', literalArgv: state.literalArgv, generation: this.generation, probe: undefined }
        : { kind: 'fallback', reason: 'manager-unconfirmed', probe: undefined }
    }
    const listener = this.observe.managerListener()
    if (listener === undefined) return { kind: 'fallback', reason: 'no-listener', probe: undefined }
    if (listener === state.listener) return { kind: 'fallback', reason: 'same-listener', probe: undefined }
    return this.probe('new-listener')
  }

  /**
   * 记录一次在 generation 下启动的 scope 于其引导程序启动目标之前便已退出，
   * 因此下一次选择会再次探测。来自已被取代的探测的启动会被忽略。
   * @param generation - 启动它的 scope 决策的代次。
   */
  scopeNotStarted(generation: number): void {
    if (generation === this.generation) this.state = { kind: 'unprobed', trigger: 'scope-not-started' }
  }

  private probe(trigger: LinuxProbeTrigger): LinuxScopeDecision {
    this.generation += 1
    // Read before probing: a manager that starts during a failed probe then counts as a new listener.
    const listener = this.observe.managerListener()
    const launcher = this.observe.launcherIdentity()
    const literalArgv = this.observe.probe()
    if (literalArgv === undefined) {
      this.state = { kind: 'unavailable', listener }
      return { kind: 'fallback', reason: 'probe-unavailable', probe: trigger }
    }
    this.state = { kind: 'available', literalArgv, launcher }
    return { kind: 'scope', reason: 'probe-available', literalArgv, generation: this.generation, probe: trigger }
  }
}
