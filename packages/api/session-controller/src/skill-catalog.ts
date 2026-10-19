/** 按 Session 寻址、冷可读的技能目录 Remote。 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-preset-registry/types'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import { isUserInvocable } from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-working-directory'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { SkillListRequest, SkillListValue } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 按 Session 寻址的 `skills` Remote 命名空间的 Host 拥有者。 */
    sessionSkillCatalog: SessionSkillCatalog
  }
}

/** 在不激活冷 Agent 的情况下支撑 `ctx.remote.skills` 的 Host 服务。 */
export class SessionSkillCatalog extends TypertRemoteService {
  static inject = ['agents', 'sessionQuery', 'typert', 'workingDirectory']

  /** @param ctx - 携带 Session 读取与可选技能/预设服务的 Host 上下文。 */
  constructor(ctx: Context) {
    super(ctx, 'sessionSkillCatalog', { namespace: 'skills' })
  }

  /**
   * 列出一个 Session 组合可见的用户可调用技能。
   * @param request - Session 标识，其 cwd 与预设决定目录视图。
   * @param signal - 由 Remote 传输层携带的调用方生命周期；已接纳的目录读取保留其既有的完成语义。
   * @returns 用户可调用的技能元数据，不加载技能正文。
   * @throws RemoteError 当 Session 无法检查或没有注册表可为其服务时。
   */
  @Remote
  async list(request: SkillListRequest, signal: AbortSignal): Promise<SkillListValue> {
    const { sessionId } = request
    let cwd: string
    let agentPreset: string | undefined
    try {
      using observation = await this.ctx.sessionQuery.observeSession(sessionId)
      if (observation.projections === undefined) {
        throw new Error('skill catalog requires a projected Session observation')
      }
      cwd = observation.projections.values.workingDirectory
        ?? observation.header.cwd
        ?? this.ctx.workingDirectory.defaultDirectory
      agentPreset = observation.projections.values.agentPreset ?? undefined
      const live = this.ctx.agents.get(sessionId)
      if (live !== undefined) cwd = await this.ctx.workingDirectory.ensure(live, signal)
    } catch (error: unknown) {
      if (error instanceof SessionQueryError
        && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
        throw new RemoteError('session/not-found', `session "${sessionId}" not found`, { sessionId })
      }
      throw new RemoteError(
        'gateway/internal',
        `session "${sessionId}" could not be inspected: ${String(error)}`,
        {},
      )
    }

    const live = this.ctx.agents.get(sessionId)
    const presets = this.ctx.get('agentPresets')
    const scoped = live === undefined ? undefined : presets?.serviceFor(live, 'skills')
    const skillRegistry = scoped ?? this.ctx.get('skills')
    if (skillRegistry === undefined) {
      throw new RemoteError(
        'gateway/internal',
        'skill registry is absent: neither this session\'s agent preset nor the host composition mounts @deepseek-ai/dsh-skill',
        {},
      )
    }

    await using lease = live === undefined ? await this.scopeFor(agentPreset) : undefined
    const scope = live ?? lease?.key
    try {
      const skills = (await skillRegistry.list({ cwd, scope })).filter(isUserInvocable)
      return {
        skills: skills.map(skill => ({
          name: skill.name,
          ...skill.path === undefined ? {} : { path: skill.path },
          description: skill.description,
          ...skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse },
          modelInvocable: skill.invocation.modelInvocable,
        })),
      }
    } catch (error: unknown) {
      throw new RemoteError('gateway/internal', `skill listing failed: ${String(error)}`, {})
    }
  }

  /** 在不创建 Agent 的情况下解析活跃或常备的预设 scope。 */
  private async scopeFor(
    agentPreset: string | undefined,
  ): Promise<({ key: ScopeKey } & AsyncDisposable) | undefined> {
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined) return undefined
    try {
      return await presets.acquireScope(agentPreset)
    } catch {
      // 未知或不可用的已记录预设回退到全局注册表。
      return undefined
    }
  }
}

export default SessionSkillCatalog
