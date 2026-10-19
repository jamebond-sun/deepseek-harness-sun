/**
 * 配置界面在设置域各接缝之上的 Host Remote 拥有者。两个命名空间：`settings`，
 * 即 `ctx.settings` 的脱敏读写，由下方的类拥有；以及 `credentials`，从这里
 * 挂载为独立插件。
 *
 * @module @deepseek-ai/dsh-api-settings-controller
 */

import { Context } from '@deepseek-ai/cordis'
import {
  openNativeTextFile,
} from '@deepseek-ai/dsh-native-command'
import type { SettingsDescriptor, SettingsPathOp, SettingsForms } from '@deepseek-ai/dsh-settings'
import type {
  SettingsDescribeValue, SettingsNamespaceView, SettingsPathOpView,
} from '@deepseek-ai/dsh-settings/types'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { z } from 'zod'
import { CredentialsController } from './credentials.ts'
import type { SettingsDocumentOpenValue } from './types.ts'

export { CredentialsController } from './credentials.ts'
export type * from './types.ts'

const settingsNamespaceRequestSchema = z.object({ ns: z.string().min(1) })

/** 在等待的提供方或打开器调用之后重新读取中止状态。 */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

/** 可由直接单元测试替换的 Host 集成。 */
export interface SettingsControllerInternals {
  /** 用于打开设置文档的 Host 文本编辑器集成。 */
  readonly openTextFile?: (path: string, signal: AbortSignal) => Promise<void>
}

/**
 * 将一个脱敏描述符逐字段投影到其 wire 视图上。Gateway 返回业务结果时
 * 不做解码，因此若提供方的描述符携带额外的可枚举属性，它们就会
 * 被序列化给调用方。
 * @param descriptor - 在 `redactSecrets` 下读取的一个描述符。
 * @returns 相同的事实，不附加任何其他内容。
 */
function namespaceView(descriptor: SettingsDescriptor): SettingsNamespaceView {
  return {
    ns: String(descriptor.ns),
    autoGenerate: descriptor.autoGenerate,
    schema: descriptor.schema as JsonValue,
    value: descriptor.value as JsonValue,
    ...descriptor.base === undefined ? {} : { base: descriptor.base as JsonValue },
    ...descriptor.user === undefined ? {} : { user: descriptor.user as JsonValue },
    applies: descriptor.applies,
    secrets: (descriptor.secrets ?? []).map(secret => ({ path: [...secret.path], set: secret.set })),
    revision: descriptor.revision,
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** `settings` Remote 命名空间的 Host 拥有者。 */
    settingsController: SettingsController
  }
}

/**
 * 支撑生成的 `ctx.remote.settings` 命名空间的 Host 服务。每次远程读取都
 * 使用 `redactSecrets: true`，因此 `role('secret')` 字段无法随响应返回。
 * 写入暴露设置服务的合并、替换与按路径寻址的操作，并将每次提供方拒绝
 * 归类为 `settings/conflict` 或 `settings/rejected`，同时携带该服务的消息。
 */
export class SettingsController extends TypertRemoteService {
  private readonly openTextFile: (path: string, signal: AbortSignal) => Promise<void>

  /**
   * 注册 settings 命名空间，并在其旁挂载 credentials 命名空间。当提供方
   * 缺席时，两个命名空间都保持注册，使调用能够返回配置 API 中可指导
   * 补救的缺失提供方诊断。
   * @param ctx - 可挂载设置与凭据提供方的 Host 上下文。
   */
  constructor(ctx: Context, internals: SettingsControllerInternals = {}) {
    super(ctx, 'settingsController', { namespace: 'settings' })
    this.openTextFile = internals.openTextFile ?? openNativeTextFile
    ctx.plugin(CredentialsController)
  }

  /**
   * 为配置页描述每个已注册的命名空间：脱敏的分层取值，加上配置页
   * 渲染表单所用的序列化 schema。
   * @returns 提供方可写性、本地文档是否存在，以及每个命名空间一个视图。
   * @throws RemoteError 未挂载设置提供方时抛出。
   */
  @Remote
  describe(): SettingsDescribeValue {
    const settings = this.provider()
    return {
      writable: settings.writable,
      hasDocument: true,
      namespaces: settings.describe({ redactSecrets: true }).map(namespaceView),
    }
  }

  /**
   * 将一个补丁合并进某命名空间已存储的用户区。
   * @param ns - 要写入的命名空间键。
   * @param patch - 要合并进用户区的字段。
   * @param expectedRevision - 调用方读取到的修订号；`undefined` 表示无条件写入。
   * @returns 写入后该命名空间的脱敏视图。
   * @throws RemoteError 请求无效、未挂载提供方或提供方拒绝写入时抛出。
   */
  @Remote
  update(
    ns: string,
    patch: Record<string, JsonValue>,
    expectedRevision: number | undefined,
  ): Promise<SettingsNamespaceView> {
    return this.write(ns, 'update', patch, expectedRevision)
  }

  /**
   * 整体替换某命名空间已存储的用户区。
   * @param ns - 要写入的命名空间键。
   * @param section - 完整替换的用户区。
   * @param expectedRevision - 调用方读取到的修订号；`undefined` 表示无条件写入。
   * @returns 写入后该命名空间的脱敏视图。
   * @throws RemoteError 请求无效、未挂载提供方或提供方拒绝写入时抛出。
   */
  @Remote
  replace(
    ns: string,
    section: Record<string, JsonValue>,
    expectedRevision: number | undefined,
  ): Promise<SettingsNamespaceView> {
    return this.write(ns, 'replace', section, expectedRevision)
  }

  /**
   * 对某命名空间的用户区应用按路径寻址的编辑，解析依据是已存储的
   * 用户区，而非调用方最近读取到的内容，然后以该命名空间新的
   * 脱敏视图作答。
   * @param ns - 要写入的命名空间键。
   * @param ops - 要按顺序应用的编辑。
   * @param expectedRevision - 调用方读取到的修订号；`undefined` 表示无条件写入。
   * @returns 写入后该命名空间的脱敏视图。
   * @throws RemoteError 请求无效、未挂载提供方或提供方拒绝写入时抛出。
   */
  @Remote
  async mutate(
    ns: string,
    ops: SettingsPathOpView[],
    expectedRevision: number | undefined,
  ): Promise<SettingsNamespaceView> {
    return this.write(ns, 'mutate', ops, expectedRevision)
  }

  /**
   * 具现提供方拥有的设置文档，并在原生文本编辑器中打开它。
   * @param signal - 调用方生命周期；中止会终止准备阶段或原生命令。
   * @returns 原生打开器接受文档后的确认。
   * @throws RemoteError 文档不存在、准备失败或打开失败时抛出。
   */
  @Remote
  async openSettingsDocument(signal: AbortSignal): Promise<SettingsDocumentOpenValue> {
    const settings = this.provider()
    if (isAborted(signal)) throw new RemoteError('gateway/cancelled', 'settings document open was aborted', {})
    let path: string
    try {
      path = await settings.prepareDocument()
    } catch (error: unknown) {
      if (isAborted(signal)) throw new RemoteError('gateway/cancelled', 'settings document preparation was aborted', {})
      throw new RemoteError('gateway/internal', `settings document preparation failed: ${messageOf(error)}`, {}, { cause: error })
    }
    if (isAborted(signal)) throw new RemoteError('gateway/cancelled', 'settings document open was aborted', {})
    try {
      await this.openTextFile(path, signal)
      return { opened: true }
    } catch (error: unknown) {
      if (isAborted(signal)) throw new RemoteError('gateway/cancelled', 'settings document open was aborted', {})
      throw new RemoteError('gateway/internal', `path open failed: ${messageOf(error)}`, {}, { cause: error })
    }
  }

  private async write(
    ns: string,
    mode: 'update' | 'replace' | 'mutate',
    input: Record<string, JsonValue> | SettingsPathOpView[],
    expectedRevision: number | undefined,
  ): Promise<SettingsNamespaceView> {
    const parsed = settingsNamespaceRequestSchema.safeParse({ ns })
    if (!parsed.success) {
      throw new RemoteError('gateway/bad-request', `invalid payload for settings.${mode}`, { issues: parsed.error.issues })
    }
    const settings = this.provider()
    const namespace = parsed.data.ns
    try {
      if (mode === 'update') await settings.update(namespace, input, expectedRevision)
      else if (mode === 'replace') await settings.replace(namespace, input, expectedRevision)
      else await settings.mutate(namespace, input as SettingsPathOp[], expectedRevision)
    } catch (error: unknown) {
      throw rejected(ns, error)
    }
    const descriptor = settings.describe({ redactSecrets: true }).find(candidate => candidate.ns === namespace)
    if (descriptor === undefined) {
      // 写入已提交，但命名空间在此读取之前消失了：只有并发的注册方释放
      // 才能产生这种情况。
      throw new RemoteError('gateway/internal', `settings namespace "${ns}" was disposed after the ${mode}`, {})
    }
    return namespaceView(descriptor)
  }

  /** 解析可选的提供方，或报告如何提供它。 */
  private provider(): SettingsForms {
    const settings = this.ctx.get('settings')
    if (settings === undefined) {
      throw new RemoteError(
        'gateway/internal',
        'settings service is absent: mount @deepseek-ai/dsh-settings with @deepseek-ai/dsh-config-editor in the profile composition',
        {},
      )
    }
    return settings
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface SettingsConflict {
  readonly code: 'SETTINGS_CONFLICT'
  readonly message: string
  readonly expected: number
  readonly actual: number
}

function settingsConflictOf(error: unknown): SettingsConflict | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  if (Reflect.get(error, 'code') !== 'SETTINGS_CONFLICT'
    || typeof Reflect.get(error, 'message') !== 'string'
    || typeof Reflect.get(error, 'expected') !== 'number'
    || typeof Reflect.get(error, 'actual') !== 'number') return undefined
  return error as SettingsConflict
}

/**
 * 归类一次接缝拒绝。过期写入者是独立的一种结果，而不是畸形请求：
 * client 必须重新读取并重新应用，而不是把这次写入视为无效。
 * @param ns - 写入所针对的命名空间。
 * @param error - 接缝抛出的任何错误。
 * @returns 针对该拒绝应抛出的失败。
 */
function rejected(ns: string, error: unknown): RemoteError {
  const conflict = settingsConflictOf(error)
  if (conflict !== undefined) {
    return new RemoteError(
      'settings/conflict',
      conflict.message,
      { ns, expected: conflict.expected, actual: conflict.actual },
      { cause: error },
    )
  }
  return new RemoteError('settings/rejected', messageOf(error), { ns }, { cause: error })
}

export default SettingsController
