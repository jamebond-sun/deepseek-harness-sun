/** 私有 shell 生命周期文件；普通输出绝不会授权回收终端。 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { SubprocessTerminalActivity, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }

/** 为一个普通交互式 shell 提供的、可选加入的启动集成与修订跟踪。 */
export class ShellActivity {
  private revision = 0
  private observed = ''
  private invalidated: string | undefined
  private state: SubprocessTerminalActivity['state'] = 'unknown'

  /**
   * @param directory - 私有启动与状态文件目录。
   * @param argv - 保留受支持用户启动文件的 shell 启动参数。
   * @param env - 携带任何临时启动重定向的环境。
   */
  constructor(private readonly directory: string, readonly argv: readonly string[], readonly env: Record<string, string>) {}

  /** 在投递输入或前台信号之前，使提示符证据失效。 */
  invalidate(): void {
    this.invalidated = this.read()
    this.revision++
    this.state = 'unknown'
  }

  /**
   * 读取最新的顶层 shell 转换，并以自该转换以来的输入作为栅栏。
   * @param pid - 原始 shell 进程 id。
   * @returns 生命周期证据；进程所有权必须另行检查。
   */
  inspect(pid: number): SubprocessTerminalActivity {
    const record = this.read()
    if (record !== this.observed) { this.observed = record; this.revision++ }
    const match = /^(\d+):(\d+):(idle|busy)\n?$/u.exec(record)
    this.state = record === this.invalidated || match?.[1] !== String(pid) ? 'unknown'
      : match[3] as 'idle' | 'busy'
    return { state: this.state, revision: this.revision }
  }

  /** 在进程静默之后，移除私有启动与状态文件。 */
  dispose(): void { rmSync(this.directory, { recursive: true, force: true }) }

  private read(): string {
    try { return readFileSync(join(this.directory, 'state'), 'utf8') }
    catch (_unavailableShellObservation) { return '' }
  }
}

/**
 * 为一个普通的、非登录的交互式启动准备可选的 Bash 或 Zsh 集成。
 * @param spec - 终端请求；自定义参数与被包装的可执行文件保持不变。
 * @param env - 已清理的目标环境。
 * @param platform - 执行平台。
 * @returns 私有集成；对于不支持的启动则为 undefined。
 */
export function prepareShellActivity(
  spec: SubprocessTerminalSpawnSpec, env: Record<string, string>, platform: NodeJS.Platform,
): ShellActivity | undefined {
  if (spec.shellActivity !== true || platform === 'win32' || spec.argv.length !== 2 || spec.argv[1] !== '-i') return undefined
  const shell = basename(spec.argv[0] as string)
  if (shell !== 'bash' && shell !== 'zsh') return undefined
  const directory = mkdtempSync(join(tmpdir(), 'dsh-shell-'))
  const state = quote(join(directory, 'state'))
  const guards = quote(join(directory, 'guards'))
  try {
    if (shell === 'bash') {
      const rc = join(directory, 'bashrc')
      writeFileSync(rc, [
        '[[ ! -r ~/.bashrc ]] || builtin source ~/.bashrc',
        'if (( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4) )) && [[ ! $(declare -p PROMPT_COMMAND PS0 2>/dev/null) =~ declare\\ -[^[:space:]]*r ]]; then',
        '  __dsh_shell_pid=$BASHPID; __dsh_shell_sequence=0',
        '  __dsh_shell_idle() {',
        '    local result=$?',
        '    if [[ $BASHPID == "$__dsh_shell_pid" ]]; then',
        '      (( ++__dsh_shell_sequence ))',
        '      local activity=idle',
        `      builtin trap -p >| ${guards}`,
        `      [[ ! -s ${guards} ]] || activity=unknown`,
        `      builtin printf '%s:%s:%s\\n' "$BASHPID" "$__dsh_shell_sequence" "$activity" >| ${state}`,
        '    fi',
        '    return "$result"',
        '  }',
        '  if [[ $(declare -p PROMPT_COMMAND 2>/dev/null) == "declare -a "* ]]; then',
        '    PROMPT_COMMAND+=(__dsh_shell_idle)',
        '  else',
        '    PROMPT_COMMAND="${PROMPT_COMMAND}"$\'\\n\'"__dsh_shell_idle"',
        '  fi',
        `  PS0+=${quote(`$(builtin printf '%s:%s:busy' "$__dsh_shell_pid" "$__dsh_shell_sequence" >| ${state})`)}`,
        'fi',
        '',
      ].join('\n'), { mode: 0o600, flag: 'wx' })
      return new ShellActivity(directory, [spec.argv[0] as string, '--rcfile', rc, '-i'], env)
    }
    writeFileSync(join(directory, '.zshenv'), [
      env.ZDOTDIR === undefined ? 'unset ZDOTDIR' : `ZDOTDIR=${quote(env.ZDOTDIR)}`,
      '[[ ! -r ${ZDOTDIR:-$HOME}/.zshenv ]] || builtin source "${ZDOTDIR:-$HOME}/.zshenv"',
      'typeset -g __dsh_shell_pid=$$ __dsh_shell_sequence=0',
      '__dsh_shell_activity() {',
      '  (( ZSH_SUBSHELL == 0 && $$ == __dsh_shell_pid )) || return',
      '  (( ++__dsh_shell_sequence ))',
      `  builtin printf '%s:%s:%s\\n' "$$" "$__dsh_shell_sequence" "$1" >| ${state}`,
      '  return 0',
      '}',
      '__dsh_shell_idle() {',
      `  { builtin trap; zle -F; } >| ${guards}`,
      '  if [[ $CONTEXT != start || -n $BUFFER ]]; then __dsh_shell_activity busy',
      `  elif [[ -s ${guards}` + ' || -n ${(k)functions[(I)TRAP*]} ]]; then __dsh_shell_activity unknown',
      '  else __dsh_shell_activity idle; fi',
      '}',
      '__dsh_shell_busy() { __dsh_shell_activity busy }',
      '__dsh_shell_init() {',
      '  autoload -Uz add-zle-hook-widget add-zsh-hook',
      '  add-zle-hook-widget line-init __dsh_shell_idle',
      '  add-zle-hook-widget line-finish __dsh_shell_busy',
      '  add-zsh-hook preexec __dsh_shell_busy',
      '  precmd_functions=(${precmd_functions:#__dsh_shell_init})',
      '}',
      'typeset -ga precmd_functions',
      'precmd_functions+=(__dsh_shell_init)',
      '',
    ].join('\n'), { mode: 0o600, flag: 'wx' })
    return new ShellActivity(directory, spec.argv, { ...env, ZDOTDIR: directory })
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
}
