/**
 * 会话可见的、工作区指令状态与动态对账。
 *
 * @module @deepseek-ai/dsh-agent-instructions/state
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import type { FileSystem, FsVersion } from '@deepseek-ai/dsh-fs'
import type { ResolvedConfig } from './config.ts'
import { instructionContentSha1, trimmedInstructionDigest } from './digest.ts'
import {
  ancestorChain,
  descendantDirsBetween,
  findProjectRoot,
  probeScopeInstruction,
  readScopeInstruction,
  relativeDisplay,
  scopeInstructionFile,
  type LoadedInstructionFile,
} from './files.ts'
import {
  candidateScopeKey,
  decodeScopeKey,
  instructionCandidateGroup,
  instructionScopeKey,
  isUserGlobalDirectory,
  renderInstructionChanges,
  USER_GLOBAL_DIRECTORIES,
  USER_GLOBAL_FILE,
  type ChangeRenderItem,
  type AgentInstructionChange,
} from './render.ts'

export const name = 'agent-instructions'

/** 一个工作区上下文的持久化生产者、文件与对账事实。 */
export interface AgentInstructionSource {
  kind: 'agent-instructions'
  /** Every workspace context carries instructions read out of a file (the `instructions` context form). */
  form: 'instructions'
  /** Marks the complete startup/resume baseline rather than a later delta. */
  baseline?: true
  /** Discovery, precedence, and budget identity used to validate a resumed baseline. */
  baselineIdentity?: string
  changes: AgentInstructionChange[]
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'agent-instructions': AgentInstructionSource
  }
}

/** 按作用域的元数据缓存；指令正文被有意地不保留。 */
export interface InstructionVersionState {
  path: string
  version: FsVersion
  digest: string
  /**
   * 裁剪内容的标识（{@link trimmedInstructionDigest}），用于在元数据快速路径上
   * 抑制候选组的重复项，而无需重新读取兄弟文件。
   */
  trimmedDigest: string
}

/** 以逻辑指令作用域为键、会话隔离的快速路径状态。 */
export type InstructionVersionCache = WeakMap<Session, Map<string, InstructionVersionState>>

/** 与一次已渲染指令变更相关联的元数据缓存转场。 */
export interface InstructionVersionUpdate {
  change: AgentInstructionChange
  /** 重复的移除提示可以为它仍在的文件保留元数据。 */
  state?: InstructionVersionState
}

/** 已渲染的对账结果，及其元数据缓存转场。 */
export interface ReconciledInstructionContext {
  context: UserMessage
  versionUpdates: InstructionVersionUpdate[]
}

function agentInstructionsHook(text: string, changes: AgentInstructionChange[]): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'agent-instructions', form: 'instructions', changes },
  })
}

/**
 * 为已渲染的基线构建 user 角色消息。
 * @param text - 由插件拥有的、完整的 system-reminder 文本。
 * @returns 一个 user 角色前缀消息。
 */
export function agentInstructionsMessage(text: string): Message {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: name, form: 'instructions', changes: [] },
  })
}

function isAgentInstructionsSource(
  source: unknown,
): source is { kind: 'agent-instructions'; changes: unknown[] } {
  return typeof source === 'object' && source !== null
    && 'kind' in source && source.kind === 'agent-instructions'
    && 'changes' in source && Array.isArray(source.changes)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function workspaceInstructionChanges(source: { changes: unknown[] }): AgentInstructionChange[] {
  const changes: AgentInstructionChange[] = []
  for (const value of source.changes) {
    if (!isRecord(value)) continue
    if (value.action !== 'set' && value.action !== 'replace' && value.action !== 'remove') continue
    if (typeof value.scope !== 'string' || typeof value.path !== 'string') continue
    if (value.digest !== undefined && typeof value.digest !== 'string') continue
    changes.push({
      action: value.action,
      scope: value.scope,
      path: value.path,
      ...value.digest !== undefined ? { digest: value.digest } : {},
    })
  }
  return changes
}

function sameInstructionChange(a: AgentInstructionChange, b: AgentInstructionChange): boolean {
  return a.action === b.action
    && a.scope === b.scope
    && a.path === b.path
    && a.digest === b.digest
}

function visibleInstructionChanges(
  agent: Agent,
  authorityMessages: readonly UserMessage[],
): Map<string, AgentInstructionChange> {
  const visible = new Map<string, AgentInstructionChange>()
  for (const seq of agent.session.surface.nodes) {
    // oxlint-disable-next-line typescript/no-deprecated -- 既有 Session 历史读取；迁移暂缓。
    const event = agent.session.eventAt(seq)
    if (event?.type !== 'user/message' || !isAgentInstructionsSource(event.data.source)) continue
    const changes = workspaceInstructionChanges(event.data.source)
    for (const change of changes) {
      visible.set(change.scope, change)
    }
  }
  for (const message of authorityMessages) {
    if (!isAgentInstructionsSource(message.source)) continue
    for (const change of workspaceInstructionChanges(message.source)) {
      visible.set(change.scope, change)
    }
  }
  return visible
}

/**
 * 将保留的基线文件转换为比较与元数据缓存状态。
 * @param files - 通过渲染、得以保留的基线文件。
 * @returns 最新的基线变更，以及以逻辑作用域为键的提供方版本。
 */
export function baselineInstructionState(files: LoadedInstructionFile[]): {
  changes: Map<string, AgentInstructionChange>
  versions: Map<string, InstructionVersionState>
} {
  const changes = new Map<string, AgentInstructionChange>()
  const versions = new Map<string, InstructionVersionState>()
  for (const file of files) {
    const digest = instructionContentSha1(file.content)
    const change: AgentInstructionChange = {
      action: 'set',
      scope: instructionScopeKey(file.displayPath),
      path: file.displayPath,
      digest,
    }
    changes.set(change.scope, change)
    if (file.version !== undefined) {
      versions.set(change.scope, {
        path: file.displayPath,
        version: file.version,
        digest,
        trimmedDigest: trimmedInstructionDigest(file.content),
      })
    }
  }
  return { changes, versions }
}

function versionStatesFor(session: Session, cache: InstructionVersionCache): Map<string, InstructionVersionState> {
  let states = cache.get(session)
  if (states === undefined) {
    states = new Map()
    cache.set(session, states)
  }
  return states
}

/**
 * 仅保留被渲染变更所代表的缓存更新。
 * @param updates - 来自一次或多次对账的提议更新。
 * @param renderedChanges - 渲染器所保留的转场。
 * @returns 由某次确切保留转场所代表的更新。
 */
export function retainedInstructionVersionUpdates(
  updates: readonly InstructionVersionUpdate[],
  renderedChanges: readonly AgentInstructionChange[],
): InstructionVersionUpdate[] {
  return updates.filter(update => renderedChanges.some(change => sameInstructionChange(update.change, change)))
}

/**
 * 在不保留指令正文的情况下应用元数据缓存转场。
 * @param session - 拥有该缓存的会话。
 * @param updates - 有序的 set/delete 转场。
 * @param cache - 会话隔离的元数据缓存。
 */
export function applyInstructionVersionUpdates(
  session: Session,
  updates: readonly InstructionVersionUpdate[],
  cache: InstructionVersionCache,
): void {
  if (updates.length === 0) return
  const states = versionStatesFor(session, cache)
  for (const update of updates) {
    if (update.state === undefined) states.delete(update.change.scope)
    else states.set(update.change.scope, update.state)
  }
  if (states.size === 0) cache.delete(session)
}

function relativeScope(projectRoot: string, dir: string): string {
  const scope = relativeDisplay(projectRoot, dir)
  return scope.length === 0 ? '.' : scope
}

/**
 * 将可见状态与提供方可见的文件进行比较，并渲染转场。
 * @param agent - 其可见表层提供持久化状态的会话拥有者。
 * @param resolved - 归一化后的插件配置。
 * @param versionCache - 按会话的作用域元数据，用于跳过未变更的读取。
 * @param fileSystem - 用于当前文件探测的提供方。
 * @param options - 权威的已认领上下文、待定作用域提示、被触及路径，以及基线参与情况。
 * @returns 渲染后的上下文及被推迟的缓存更新；当未变更或不可用时为 undefined。
 */
export async function reconcileInstructionContext(
  agent: Agent,
  resolved: ResolvedConfig,
  versionCache: InstructionVersionCache,
  fileSystem: FileSystem,
  options: {
    cwd: string
    authorityMessages: readonly UserMessage[]
    scopeMessages: readonly UserMessage[]
    touchedPaths: readonly string[]
    includeBaselineScopes: boolean
    excludedBaselineScopes?: ReadonlySet<string>
    projectRoot?: string
    signal?: AbortSignal
  },
): Promise<ReconciledInstructionContext | undefined> {
  const session = agent.session
  const effective = visibleInstructionChanges(agent, options.authorityMessages)
  const cwd = options.cwd
  // TODO(frozen-project-root): 为循环实例保留基线根目录；
  // 在标记编辑之后重新计算它会重新解释既有的相对作用域键。
  const projectRoot = options.projectRoot
    ?? await findProjectRoot(cwd, resolved.projectRootMarkers, fileSystem, options.signal)
  const scopes = new Set<string>()
  const baselineScopes = new Set<string>()
  const addDirScopes = (target: Set<string>, directory: string): void => {
    for (const candidate of resolved.instructionFileCandidates) target.add(candidateScopeKey(directory, candidate))
    for (const candidate of resolved.localInstructionFileCandidates) target.add(candidateScopeKey(directory, candidate))
  }
  const addProjectScopes = (target: Set<string>, dir: string): void => {
    addDirScopes(target, relativeScope(projectRoot, dir))
  }
  for (const directory of USER_GLOBAL_DIRECTORIES) baselineScopes.add(candidateScopeKey(directory, USER_GLOBAL_FILE))
  for (const dir of ancestorChain(projectRoot, cwd)) addProjectScopes(baselineScopes, dir)
  if (options.includeBaselineScopes) {
    for (const scope of baselineScopes) scopes.add(scope)
  }
  for (const message of options.scopeMessages) {
    /* v8 ignore next -- the plugin passes its workspace-only pending projection. */
    if (!isAgentInstructionsSource(message.source)) continue
    for (const change of workspaceInstructionChanges(message.source)) {
      if (!options.includeBaselineScopes && baselineScopes.has(change.scope)) continue
      scopes.add(change.scope)
    }
  }
  for (const scope of effective.keys()) {
    if (!options.includeBaselineScopes && baselineScopes.has(scope)) continue
    const { directory } = decodeScopeKey(scope)
    if (isUserGlobalDirectory(directory)) scopes.add(candidateScopeKey(directory, USER_GLOBAL_FILE))
    else addDirScopes(scopes, directory)
  }
  for (const touchedPath of options.touchedPaths) {
    for (const dir of descendantDirsBetween(cwd, touchedPath)) addProjectScopes(scopes, dir)
  }

  const versions = versionStatesFor(session, versionCache)
  const seenAbsolutePaths = new Set<string>()
  // 本次遍历到目前为止、按组保留的裁剪内容标识，按候选顺序迭代
  // （基础先于本地，harness 主目录先于共享 agents 根目录）；
  // 一个与更早候选匹配的后续候选属于重复项，会被丢弃或移除，而非渲染两次。
  const keptTrimmedByGroup = new Map<string, Set<string>>()
  const hasKeptTrimmed = (group: string, digest: string): boolean => keptTrimmedByGroup.get(group)?.has(digest) ?? false
  const registerKeptTrimmed = (group: string, digest: string): boolean => {
    let digests = keptTrimmedByGroup.get(group)
    if (digests === undefined) {
      digests = new Set()
      keptTrimmedByGroup.set(group, digests)
    }
    if (digests.has(digest)) return true
    digests.add(digest)
    return false
  }
  const items: ChangeRenderItem[] = []
  const versionUpdates: InstructionVersionUpdate[] = []
  const pushRemoval = (scope: string, path: string, state?: InstructionVersionState): void => {
    const change: AgentInstructionChange = { action: 'remove', scope, path }
    items.push({ change, file: { absolutePath: `removed:${scope}`, displayPath: path, content: '' } })
    versionUpdates.push({ change, ...state === undefined ? {} : { state } })
  }
  const scopesByGroup = new Map<string, string[]>()
  for (const scope of scopes) {
    const { directory } = decodeScopeKey(scope)
    const group = instructionCandidateGroup(directory)
    const groupScopes = scopesByGroup.get(group)
    if (groupScopes === undefined) scopesByGroup.set(group, [scope])
    else groupScopes.push(scope)
  }
  for (const [group, groupScopes] of scopesByGroup) {
    const probedScopes: string[] = []
    for (const scope of groupScopes) {
      if (options.excludedBaselineScopes !== undefined
        && baselineScopes.has(scope)
        && options.excludedBaselineScopes.has(scope)) {
        const previous = effective.get(scope)
        if (previous === undefined || previous.action === 'remove') versions.delete(scope)
        else pushRemoval(scope, previous.path)
      } else {
        probedScopes.push(scope)
      }
    }
    const itemStart = items.length
    const versionUpdateStart = versionUpdates.length
    const priorVersions = new Map(probedScopes.map(scope => [scope, versions.get(scope)]))
    // 元数据与内容可用性适用于整个去重组，
    // 包括可能在兄弟文件编辑之后变为可见的隐藏候选。
    const rollbackGroup = (): void => {
      items.splice(itemStart)
      versionUpdates.splice(versionUpdateStart)
      for (const [candidateScope, prior] of priorVersions) {
        if (prior === undefined) versions.delete(candidateScope)
        else versions.set(candidateScope, prior)
      }
      // Project aliases must not publish content withheld by a failed group,
      // including candidates whose paths were never reached before the failure.
      for (const scope of probedScopes) {
        seenAbsolutePaths.add(scopeInstructionFile(scope, projectRoot, resolved).absolutePath)
      }
      keptTrimmedByGroup.delete(group)
    }
    for (const scope of probedScopes) {
      const previous = effective.get(scope)
      const probe = await probeScopeInstruction(scope, projectRoot, resolved, fileSystem, options.signal)
      if (probe.kind === 'unavailable') {
        rollbackGroup()
        break
      }
      if (probe.kind === 'absent') {
        if (previous === undefined || previous.action === 'remove') versions.delete(scope)
        else pushRemoval(scope, previous.path)
        continue
      }
      const { file: probedFile } = probe
      if (seenAbsolutePaths.has(probedFile.absolutePath)) continue
      seenAbsolutePaths.add(probedFile.absolutePath)
      const cached = versions.get(scope)
      const metadataUnchanged = cached !== undefined
        && cached.path === probedFile.displayPath
        && cached.version === probedFile.version
      if (metadataUnchanged) {
        const rendered = previous !== undefined
          && previous.action !== 'remove'
          && previous.path === cached.path
          && previous.digest === cached.digest
        if (rendered) {
          // 未变更且此前已渲染：保留它，但一个现在与其裁剪内容匹配的、更早的
          // 组成员，会使它成为需要被移除的重复项。
          if (registerKeptTrimmed(group, cached.trimmedDigest)) pushRemoval(scope, previous.path, cached)
          continue
        }
        // 隐藏的重复项包括成为重复项之后、从可见状态中被移除的文件。
        // 只有提升才需要另一次内容读取。
        if ((previous === undefined || previous.action === 'remove')
          && hasKeptTrimmed(group, cached.trimmedDigest)) continue
      }

      const file = await readScopeInstruction(probedFile, resolved.maxSourceBytes, fileSystem, options.signal)
      if (file === undefined) {
        rollbackGroup()
        break
      }
      const currentDigest = instructionContentSha1(file.content)
      const trimmedDigest = trimmedInstructionDigest(file.content)
      const nextVersion: InstructionVersionState = {
        path: file.displayPath,
        version: probedFile.version,
        digest: currentDigest,
        trimmedDigest,
      }
      if (registerKeptTrimmed(group, trimmedDigest)) {
        // 一个其裁剪内容已在本组更早起出现的、不同的文件：丢弃它，
        // 移除任何此前已渲染的副本，并保留其元数据，
        // 以便下一遍无需再次读取即可判定。
        if (previous !== undefined && previous.action !== 'remove') {
          pushRemoval(scope, previous.path, nextVersion)
        } else {
          versions.set(scope, nextVersion)
        }
        continue
      }
      if (previous !== undefined && previous.action !== 'remove' && previous.path === file.displayPath && previous.digest === currentDigest) {
        versions.set(scope, nextVersion)
        continue
      }
      const action = previous === undefined || previous.action === 'remove' ? 'set' : 'replace'
      const change: AgentInstructionChange = {
        action,
        scope,
        path: file.displayPath,
        digest: currentDigest,
      }
      items.push({ change, file })
      versionUpdates.push({ change, state: nextVersion })
    }
  }
  if (items.length === 0) return undefined
  const rendered = renderInstructionChanges(items, resolved.maxBytes)
  // 当没有任何转场在渲染中存活（极小预算只会渲染纯提示文本）时，
  // 既不发出也不提交任何内容——未提交的版本会使下一遍重试，
  // 而非反复刷出纯提示的上下文。
  if (rendered.text.length === 0 || rendered.changes.length === 0) return undefined
  return {
    context: agentInstructionsHook(rendered.text, rendered.changes),
    versionUpdates: retainedInstructionVersionUpdates(versionUpdates, rendered.changes),
  }
}
